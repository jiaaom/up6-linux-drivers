//! Local resource monitor — everything the fnOS "resource monitor" shows, read
//! straight from `/proc` and sysfs with no fnOS session. Rates and busy
//! percentages are deltas against the previous call, so the first call after
//! start returns them as `null`; the panel polls every ~2 s while its System
//! page is open, which makes the deltas meaningful.
//!
//! Sources (all verified on the T6 / Meteor Lake box):
//! - CPU: `/proc/loadavg`, `/proc/stat` (busy split), cpufreq `scaling_cur_freq`
//! - Memory: `/proc/meminfo` + ZFS ARC from `/proc/spl/kstat/zfs/arcstats`
//! - GPU (i915): `gt_act_freq_mhz`, `gt_max_freq_mhz`, `gt/gt0/rc6_residency_ms`
//!   (busy = time NOT in RC6), hwmon `i915` temp, `throttle_reason_*`
//! - NPU (intel_vpu): `/sys/class/accel/accel0/device/npu_busy_time_us`, freq
//! - Disks: `/proc/diskstats` (sectors, io ticks) + per-NVMe hwmon temps +
//!   `/sys/block/<dev>/device/model`
//! - Processes: `/proc/<pid>/{stat,statm,cmdline}` (kernel threads skipped)

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

fn read(p: impl AsRef<Path>) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}
fn read_u64(p: impl AsRef<Path>) -> Option<u64> { read(p)?.parse().ok() }

struct Prev {
    at: Instant,
    cpu: [u64; 8],                 // user nice system idle iowait irq softirq steal
    disks: HashMap<String, (u64, u64, u64)>, // sectors read, sectors written, io ticks ms
    rc6_ms: Option<u64>,
    gpu_pmu: Option<HashMap<&'static str, u64>>,
    npu_busy_us: Option<u64>,
    procs: HashMap<u32, u64>,      // pid -> utime+stime ticks
}
static PREV: Mutex<Option<Prev>> = Mutex::new(None);

fn clk_tck() -> f64 {
    let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if v > 0 { v as f64 } else { 100.0 }
}

/* ---------- CPU ---------- */
fn proc_stat_cpu() -> Option<[u64; 8]> {
    let s = read("/proc/stat")?;
    let line = s.lines().next()?;
    let mut it = line.split_whitespace().skip(1).map(|x| x.parse::<u64>().unwrap_or(0));
    let mut a = [0u64; 8];
    for v in a.iter_mut() { *v = it.next().unwrap_or(0); }
    Some(a)
}
fn cpu_section(prev: Option<&Prev>, now: &[u64; 8]) -> Value {
    let load = read("/proc/loadavg").map(|s| {
        let v: Vec<f64> = s.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
        json!(v)
    }).unwrap_or(Value::Null);
    let busy = prev.map(|p| {
        let d: Vec<u64> = now.iter().zip(p.cpu.iter()).map(|(a, b)| a.saturating_sub(*b)).collect();
        let total: u64 = d.iter().sum();
        if total == 0 { return Value::Null; }
        let pct = |x: u64| (x as f64 / total as f64 * 100.0 * 10.0).round() / 10.0;
        let idle = d[3] + d[4];
        json!({ "total": pct(total - idle), "user": pct(d[0] + d[1]), "system": pct(d[2] + d[5] + d[6]), "iowait": pct(d[4]) })
    }).unwrap_or(Value::Null);
    let freq_mhz = read_u64("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq").map(|k| k / 1000);
    let max_mhz = read_u64("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq").map(|k| k / 1000);
    let model = read("/proc/cpuinfo").and_then(|s| s.lines().find(|l| l.starts_with("model name")).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string()));
    let threads = read("/proc/cpuinfo").map(|s| s.lines().filter(|l| l.starts_with("processor")).count()).unwrap_or(0);
    json!({ "model": model, "threads": threads, "load": load, "busy": busy, "freq_mhz": freq_mhz, "max_freq_mhz": max_mhz, "temp_c": crate::sensors::cpu_temp_c().map(|t| t.round()) })
}

/* ---------- memory ---------- */
fn mem_section() -> Value {
    let s = match read("/proc/meminfo") { Some(s) => s, None => return Value::Null };
    let mut m: HashMap<&str, u64> = HashMap::new();
    for l in s.lines() {
        let mut it = l.split_whitespace();
        if let (Some(k), Some(v)) = (it.next(), it.next()) { m.insert(k.trim_end_matches(':'), v.parse::<u64>().unwrap_or(0) * 1024); }
    }
    let g = |k: &str| m.get(k).copied().unwrap_or(0);
    let total = g("MemTotal"); let avail = g("MemAvailable"); let free = g("MemFree");
    let cached = g("Cached") + g("Buffers");
    let arc = read("/proc/spl/kstat/zfs/arcstats").and_then(|s| s.lines().find(|l| l.starts_with("size ")).and_then(|l| l.split_whitespace().nth(2)).and_then(|v| v.parse::<u64>().ok()));
    // "apps" = everything not reclaimable, minus the ARC (which lives outside
    // the page cache and is not counted in MemAvailable's reclaimable set).
    let used = total.saturating_sub(avail);
    let apps = used.saturating_sub(arc.unwrap_or(0));
    json!({ "total": total, "used": used, "apps": apps, "zfs_arc": arc, "cached": cached, "free": free, "available": avail,
            "swap_total": g("SwapTotal"), "swap_used": g("SwapTotal").saturating_sub(g("SwapFree")),
            "used_pct": if total > 0 { (used as f64 / total as f64 * 100.0).round() } else { 0.0 } })
}

/* ---------- GPU (i915) ---------- */
fn drm_card() -> Option<PathBuf> {
    let it = std::fs::read_dir("/sys/class/drm").ok()?;
    for e in it.flatten() {
        let p = e.path();
        let n = p.file_name()?.to_string_lossy().to_string();
        if n.starts_with("card") && !n.contains('-') && p.join("gt_act_freq_mhz").exists() { return Some(p); }
    }
    None
}
fn gpu_section(prev: Option<&Prev>, rc6_now: Option<u64>, pmu_now: Option<&HashMap<&'static str, u64>>, dt_s: f64) -> Value {
    let card = match drm_card() { Some(c) => c, None => return Value::Null };
    // "awake" = time not in RC6 sleep (what a naive metric shows); "busy" and
    // the per-engine split come from the PMU and are the real utilization.
    let awake = match (prev.and_then(|p| p.rc6_ms), rc6_now) {
        (Some(a), Some(b)) if dt_s > 0.0 => {
            let idle_ms = b.saturating_sub(a) as f64;
            json!(((100.0 - idle_ms / (dt_s * 1000.0) * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0)
        }
        _ => Value::Null,
    };
    let mut engines = serde_json::Map::new();
    let mut busy = Value::Null;
    if let (Some(prevp), Some(now)) = (prev.and_then(|p| p.gpu_pmu.as_ref()), pmu_now) {
        if dt_s > 0.0 {
            let pct = |k: &str| -> Option<f64> {
                let a = *prevp.get(k)?; let b = *now.get(k)?;
                Some(((b.saturating_sub(a) as f64 / (dt_s * 1e9) * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0)
            };
            let render = pct("render"); let video = pct("video").map(|v| v + pct("video1").unwrap_or(0.0));
            let compute = pct("compute"); let blit = pct("blit");
            if let Some(r) = render { engines.insert("render".into(), json!(r)); busy = json!(r); }
            if let Some(v) = video { engines.insert("video".into(), json!((v * 10.0).round() / 10.0)); }
            if let Some(c) = compute { engines.insert("compute".into(), json!(c)); }
            if let Some(b) = blit { engines.insert("blit".into(), json!(b)); }
        }
    }
    if busy.is_null() { busy = awake.clone(); } // fallback when the PMU isn't available
    let mut throttle: Vec<String> = Vec::new();
    for r in ["pl1", "pl2", "pl4", "prochot", "thermal", "ratl", "vr_tdc", "vr_thermalert"] {
        if read(card.join(format!("throttle_reason_{r}"))).as_deref() == Some("1") { throttle.push(r.to_string()); }
    }
    json!({
        "name": crate::hwinfo::gpu_name(),
        "busy": busy,
        "freq_mhz": read_u64(card.join("gt_act_freq_mhz")),
        "max_freq_mhz": read_u64(card.join("gt_max_freq_mhz")),
        "temp_c": crate::sensors::gpu_temp_c().map(|t| t.round()),
        "throttle": throttle,
        "awake": awake,
        "engines": engines,
        "pmu": pmu_now.is_some(),
    })
}
fn rc6_ms() -> Option<u64> { read_u64(drm_card()?.join("gt/gt0/rc6_residency_ms")) }


/* ---------- GPU engine busy via the i915 perf PMU ----------
   RC6 residency only says how long the GPU was *awake*; a compositor that
   repaints keeps it awake at idle clocks, which read as "50% busy". The i915
   PMU exposes per-engine busy time (ns) — the same source intel_gpu_top
   uses. Counters are cumulative; we delta them against the previous sample. */
struct GpuPmu { fds: Vec<(&'static str, i32)> }
static GPU_PMU: Mutex<Option<GpuPmu>> = Mutex::new(None);
const PMU_ENGINES: [(&str, &str); 5] = [("render", "rcs0-busy"), ("video", "vcs0-busy"), ("video1", "vcs1-busy"), ("compute", "ccs0-busy"), ("blit", "bcs0-busy")];
fn pmu_event_config(name: &str) -> Option<u64> {
    let s = read(format!("/sys/bus/event_source/devices/i915/events/{name}"))?;
    let hex = s.strip_prefix("config=0x")?;
    u64::from_str_radix(hex, 16).ok()
}
/// Minimal `struct perf_event_attr` (kernel ABI, PERF_ATTR_SIZE_VER8 = 136 B):
/// only type/size/config are set; everything else stays zero.
#[repr(C)]
struct PerfAttr { type_: u32, size: u32, config: u64, rest: [u64; 15] }
fn pmu_open(ty: u32, cfg: u64) -> Option<i32> {
    let attr = PerfAttr { type_: ty, size: std::mem::size_of::<PerfAttr>() as u32, config: cfg, rest: [0; 15] };
    // uncore PMU: any task (-1), one cpu (0)
    let fd = unsafe { libc::syscall(libc::SYS_perf_event_open, &attr as *const PerfAttr, -1 as libc::pid_t, 0 as libc::c_int, -1 as libc::c_int, 0 as libc::c_ulong) };
    if fd < 0 { None } else { Some(fd as i32) }
}
fn pmu_read(fd: i32) -> Option<u64> {
    let mut b = [0u8; 8];
    let n = unsafe { libc::read(fd, b.as_mut_ptr() as *mut libc::c_void, 8) };
    if n == 8 { Some(u64::from_ne_bytes(b)) } else { None }
}
/// Current cumulative busy-ns per engine (opens the PMU on first use).
fn gpu_pmu_counters() -> Option<HashMap<&'static str, u64>> {
    let mut g = GPU_PMU.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        let ty: u32 = read("/sys/bus/event_source/devices/i915/type")?.parse().ok()?;
        let mut fds = Vec::new();
        for (key, ev) in PMU_ENGINES {
            if let Some(cfg) = pmu_event_config(ev) { if let Some(fd) = pmu_open(ty, cfg) { fds.push((key, fd)); } }
        }
        if fds.is_empty() { return None; }
        *g = Some(GpuPmu { fds });
    }
    let p = g.as_ref()?;
    let mut out = HashMap::new();
    for (key, fd) in &p.fds { if let Some(v) = pmu_read(*fd) { out.insert(*key, v); } }
    Some(out)
}

/* ---------- NPU (intel_vpu) ---------- */
const NPU: &str = "/sys/class/accel/accel0/device";
fn npu_busy_us() -> Option<u64> { read_u64(format!("{NPU}/npu_busy_time_us")) }
fn npu_section(prev: Option<&Prev>, busy_now: Option<u64>, dt_s: f64) -> Value {
    if !Path::new(NPU).exists() { return Value::Null; }
    let busy = match (prev.and_then(|p| p.npu_busy_us), busy_now) {
        (Some(a), Some(b)) if dt_s > 0.0 => json!(((b.saturating_sub(a) as f64 / (dt_s * 1e6) * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0),
        _ => Value::Null,
    };
    json!({ "name": "Intel AI Boost", "busy": busy, "freq_mhz": read_u64(format!("{NPU}/npu_current_frequency_mhz")), "max_freq_mhz": read_u64(format!("{NPU}/npu_max_frequency_mhz")), "power_state": read(format!("{NPU}/power_state")) })
}

/* ---------- disks ---------- */
fn diskstats() -> HashMap<String, (u64, u64, u64)> {
    let mut out = HashMap::new();
    if let Some(s) = read("/proc/diskstats") {
        for l in s.lines() {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 14 { continue; }
            let name = f[2];
            // whole devices only: nvmeXn1, sdX (skip partitions and loop/dm)
            let whole = (name.starts_with("nvme") && name.ends_with("n1") && !name.contains('p'))
                || (name.starts_with("sd") && name.len() == 3);
            if !whole { continue; }
            let p = |i: usize| f[i].parse::<u64>().unwrap_or(0);
            out.insert(name.to_string(), (p(5), p(9), p(12)));
        }
    }
    out
}
fn nvme_temps() -> HashMap<String, f64> {
    // hwmon entries named "nvme": their `device` symlink resolves to the
    // controller (…/nvme/nvme0) → block device nvme0n1.
    let mut out = HashMap::new();
    if let Ok(it) = std::fs::read_dir("/sys/class/hwmon") {
        for e in it.flatten() {
            let h = e.path();
            if read(h.join("name")).as_deref() != Some("nvme") { continue; }
            let ctrl = match std::fs::read_link(h.join("device")).ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())) { Some(c) => c, None => continue };
            if let Some(t) = read_u64(h.join("temp1_input")) { out.insert(format!("{ctrl}n1"), t as f64 / 1000.0); }
        }
    }
    out
}
fn disks_section(prev: Option<&Prev>, now: &HashMap<String, (u64, u64, u64)>, dt_s: f64) -> Value {
    let temps = nvme_temps();
    let mut names: Vec<&String> = now.keys().collect(); names.sort();
    let list: Vec<Value> = names.into_iter().map(|n| {
        let (rs, ws, ticks) = now[n];
        let rates = prev.and_then(|p| p.disks.get(n)).map(|&(prs, pws, pticks)| {
            if dt_s <= 0.0 { return Value::Null; }
            json!({
                "read_bps": (rs.saturating_sub(prs) * 512) as f64 / dt_s,
                "write_bps": (ws.saturating_sub(pws) * 512) as f64 / dt_s,
                "busy": ((ticks.saturating_sub(pticks) as f64 / (dt_s * 1000.0) * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0,
            })
        }).unwrap_or(Value::Null);
        let model = read(format!("/sys/block/{n}/device/model")).unwrap_or_default();
        let size = read_u64(format!("/sys/block/{n}/size")).map(|s| s * 512).unwrap_or(0);
        if size == 0 { return Value::Null; } // empty card-reader slots
        let rot = read(format!("/sys/block/{n}/queue/rotational")).as_deref() == Some("1");
        json!({ "name": n, "model": model, "size_bytes": size, "ssd": !rot, "temp_c": temps.get(n).map(|t| t.round()), "io": rates })
    }).filter(|v| !v.is_null()).collect();
    json!(list)
}

/* ---------- processes ---------- */
struct ProcNow { pid: u32, name: String, ticks: u64, rss: u64 }
fn procs_now() -> Vec<ProcNow> {
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
    let mut out = Vec::new();
    let it = match std::fs::read_dir("/proc") { Ok(i) => i, Err(_) => return out };
    for e in it.flatten() {
        let pid: u32 = match e.file_name().to_string_lossy().parse() { Ok(p) => p, Err(_) => continue };
        // kernel threads have an empty cmdline — skip them like top does by default
        let cmd = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        if cmd.is_empty() { continue; }
        let stat = match read(format!("/proc/{pid}/stat")) { Some(s) => s, None => continue };
        // comm may contain spaces/parens: take what's after the last ')'
        let (head, rest) = match stat.rsplit_once(')') { Some(x) => x, None => continue };
        let name = head.split_once('(').map(|x| x.1).unwrap_or("").to_string();
        let f: Vec<&str> = rest.split_whitespace().collect();
        if f.len() < 22 { continue; }
        let utime: u64 = f[11].parse().unwrap_or(0); // fields after ')' start at state(0): utime is index 11, stime 12
        let stime: u64 = f[12].parse().unwrap_or(0);
        let rss_pages: u64 = f[21].parse().unwrap_or(0);
        out.push(ProcNow { pid, name, ticks: utime + stime, rss: rss_pages * page });
    }
    out
}
fn procs_section(prev: Option<&Prev>, now: &[ProcNow], dt_s: f64) -> Value {
    let ncpu = read("/proc/cpuinfo").map(|s| s.lines().filter(|l| l.starts_with("processor")).count()).unwrap_or(1).max(1) as f64;
    let tck = clk_tck();
    let mut rows: Vec<(f64, &ProcNow)> = now.iter().map(|p| {
        let cpu = prev.and_then(|pr| pr.procs.get(&p.pid)).map(|&t0| {
            if dt_s <= 0.0 { return 0.0; }
            (p.ticks.saturating_sub(t0) as f64 / tck / dt_s / ncpu * 100.0 * 10.0).round() / 10.0
        }).unwrap_or(0.0);
        (cpu, p)
    }).collect();
    let mut by_cpu = rows.clone(); by_cpu.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    rows.sort_by(|a, b| b.1.rss.cmp(&a.1.rss));
    let mk = |v: &[(f64, &ProcNow)]| -> Vec<Value> { v.iter().take(6).map(|(c, p)| json!({ "pid": p.pid, "name": p.name, "cpu": c, "rss": p.rss })).collect() };
    json!({ "count": now.len(), "top_cpu": mk(&by_cpu), "top_mem": mk(&rows) })
}

/// One full snapshot. Call repeatedly (~2 s) for rates/busy to populate.
pub fn snapshot() -> Value {
    let now_at = Instant::now();
    let cpu_now = proc_stat_cpu().unwrap_or([0; 8]);
    let disks_now = diskstats();
    let rc6_now = rc6_ms();
    let pmu_now = gpu_pmu_counters();
    let npu_now = npu_busy_us();
    let procs = procs_now();

    let mut guard = PREV.lock().unwrap_or_else(|e| e.into_inner());
    let dt_s = guard.as_ref().map(|p| now_at.duration_since(p.at).as_secs_f64()).unwrap_or(0.0);
    let prev = guard.as_ref();

    let out = json!({
        "uptime_s": crate::sensors::uptime_s(),
        "cpu": cpu_section(prev, &cpu_now),
        "mem": mem_section(),
        "gpu": gpu_section(prev, rc6_now, pmu_now.as_ref(), dt_s),
        "npu": npu_section(prev, npu_now, dt_s),
        "disks": disks_section(prev, &disks_now, dt_s),
        "procs": procs_section(prev, &procs, dt_s),
        "fans": crate::fans::fans(),
        "sample_dt_s": if dt_s > 0.0 { json!((dt_s * 100.0).round() / 100.0) } else { Value::Null },
    });

    *guard = Some(Prev {
        at: now_at,
        cpu: cpu_now,
        disks: disks_now,
        rc6_ms: rc6_now,
        gpu_pmu: pmu_now,
        npu_busy_us: npu_now,
        procs: procs.iter().map(|p| (p.pid, p.ticks)).collect(),
    });
    out
}
