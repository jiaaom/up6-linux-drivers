//! Storage pools: what each data volume is made of (the 存储池 page).
//!
//! For each volume (see [`crate::storage::volumes`]): its file system, how the
//! disks are put together (ZFS vdevs, or md/LVM under btrfs or ext4), how many
//! disks may fail, the pool's health, the last disk check (ZFS scrub or btrfs
//! scrub) and the disks themselves with temperature and power-on time (SMART).
//! Everything is read locally; SMART answers are cached, they change slowly.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ZPOOL: &str = "/usr/sbin/zpool";
const BTRFS: &str = "/usr/bin/btrfs";
const SMARTCTL: &str = "/usr/sbin/smartctl";
const SMART_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Serialize)]
pub struct Pool {
    /// Display name and mount, as in `storage::volumes`.
    pub name: String,
    pub mount: String,
    pub fs: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
    /// "stripe", "mirror", "raidz1", "raidz2", "raidz3", "linear", "raid1",
    /// "raid5", "raid6", "raid10", "single".
    pub layout: String,
    /// How many disks can fail without losing data.
    pub redundancy: u32,
    /// "ok", "degraded" or "faulted".
    pub health: String,
    pub check: Check,
    pub disks: Vec<Disk>,
}

#[derive(Serialize, Default)]
pub struct Check {
    pub running: bool,
    /// When the last check finished (unix s), if one ever ran.
    pub last: Option<i64>,
    /// Errors the last check found (None: unknown / never ran).
    pub errors: Option<u64>,
    /// Progress of a running check, 0..=100.
    pub progress: Option<f32>,
}

#[derive(Serialize, Clone)]
pub struct Disk {
    pub name: String,
    pub model: Option<String>,
    pub size_bytes: u64,
    pub ssd: bool,
    pub temp_c: Option<f64>,
    pub power_on_hours: Option<u64>,
    /// SMART's overall verdict (None: unknown).
    pub smart_ok: Option<bool>,
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(cmd).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

fn read(p: impl AsRef<Path>) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

/// The whole disk a block device lives on: nvme0n1p1 → nvme0n1, sda2 → sda.
fn disk_of(dev: &str) -> String {
    let link = PathBuf::from(format!("/sys/class/block/{dev}"));
    if link.join("partition").exists() {
        if let Ok(real) = std::fs::canonicalize(&link) {
            if let Some(parent) = real.parent().and_then(|p| p.file_name()) {
                return parent.to_string_lossy().into_owned();
            }
        }
    }
    dev.to_string()
}

/// The disks under a device-mapper / md stack, by following sysfs `slaves`.
fn disks_under(dev: &str, out: &mut Vec<String>) {
    let slaves = format!("/sys/class/block/{dev}/slaves");
    match std::fs::read_dir(&slaves) {
        Ok(entries) => {
            let mut any = false;
            for e in entries.flatten() {
                any = true;
                disks_under(&e.file_name().to_string_lossy(), out);
            }
            if !any {
                push_disk(dev, out);
            }
        }
        Err(_) => push_disk(dev, out),
    }
}

fn push_disk(dev: &str, out: &mut Vec<String>) {
    let d = disk_of(dev);
    if !out.contains(&d) {
        out.push(d);
    }
}

/// The kernel name of a /dev path (follows /dev/mapper and by-* links).
fn kname(path: &str) -> Option<String> {
    std::fs::canonicalize(path).ok()?.file_name().map(|n| n.to_string_lossy().into_owned())
}

// ---- SMART -----------------------------------------------------------------

#[derive(Clone)]
struct Smart {
    hours: Option<u64>,
    temp: Option<f64>,
    ok: Option<bool>,
}

static SMART: Mutex<Option<HashMap<String, (Instant, Smart)>>> = Mutex::new(None);

fn smart(disk: &str) -> Smart {
    let mut cache = SMART.lock().unwrap();
    let map = cache.get_or_insert_with(HashMap::new);
    if let Some((at, s)) = map.get(disk) {
        if at.elapsed() < SMART_TTL {
            return s.clone();
        }
    }
    // smartctl's exit status carries warning bits, so read its JSON whatever it returns
    let json = Command::new(SMARTCTL)
        .args(["-j", "-A", "-H", &format!("/dev/{disk}")])
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok());
    let s = Smart {
        hours: json.as_ref().and_then(|j| j["power_on_time"]["hours"].as_u64()),
        temp: json.as_ref().and_then(|j| j["temperature"]["current"].as_f64()),
        ok: json.as_ref().and_then(|j| j["smart_status"]["passed"].as_bool()),
    };
    map.insert(disk.to_string(), (Instant::now(), s.clone()));
    s
}

fn disk(name: &str) -> Disk {
    let sys = PathBuf::from(format!("/sys/class/block/{name}"));
    let s = smart(name);
    Disk {
        name: name.to_string(),
        model: read(sys.join("device/model")).filter(|m| !m.is_empty()),
        size_bytes: read(sys.join("size")).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) * 512,
        ssd: read(sys.join("queue/rotational")).as_deref() == Some("0"),
        temp_c: s.temp,
        power_on_hours: s.hours,
        smart_ok: s.ok,
    }
}

// ---- ZFS -------------------------------------------------------------------

/// Layout, disks and health from `zpool status -P`.
fn zfs_pool(pool: &str) -> (String, u32, String, Vec<String>, Check) {
    let text = run(ZPOOL, &["status", "-P", pool]).unwrap_or_default();
    let mut layouts: Vec<(String, u32)> = Vec::new();
    let mut disks = Vec::new();
    let mut health = "ok".to_string();
    let mut in_config = false;
    for line in text.lines() {
        let t = line.trim();
        if let Some(state) = t.strip_prefix("state:") {
            health = match state.trim() {
                "ONLINE" => "ok",
                "DEGRADED" => "degraded",
                _ => "faulted",
            }
            .to_string();
        }
        if t.starts_with("NAME") {
            in_config = true;
            continue;
        }
        if t.starts_with("errors:") || t.is_empty() && in_config && !disks.is_empty() {
            in_config = false;
        }
        if !in_config {
            continue;
        }
        let name = t.split_whitespace().next().unwrap_or("");
        if let Some(kind) = ["mirror", "raidz1", "raidz2", "raidz3", "raidz"].iter().find(|k| name.starts_with(*k)) {
            let tolerate = match *kind { "raidz2" => 2, "raidz3" => 3, _ => 1 };
            layouts.push((if *kind == "raidz" { "raidz1".into() } else { kind.to_string() }, tolerate));
        } else if name.starts_with('/') {
            if let Some(k) = kname(name) {
                push_disk(&k, &mut disks);
            }
        } else if matches!(name, "logs" | "cache" | "spares" | "special") {
            break; // support devices: not part of the data layout
        }
    }
    let (layout, redundancy) = match layouts.first() {
        Some(l) => l.clone(),
        None if disks.len() > 1 => ("stripe".into(), 0),
        None => ("single".into(), 0),
    };
    (layout, redundancy, health, disks, zfs_check(&text))
}

/// "scan: scrub repaired 0B in 00:10:02 with 0 errors on Sun Oct 12 03:00:01 2026"
/// or "scan: scrub in progress since …\n … 45.67% done".
fn zfs_check(status: &str) -> Check {
    let mut c = Check::default();
    let Some(scan) = status.lines().position(|l| l.trim_start().starts_with("scan:")) else { return c };
    let lines: Vec<&str> = status.lines().skip(scan).take(4).collect();
    let first = lines[0];
    if first.contains("in progress") {
        c.running = true;
        c.progress = lines.iter().find_map(|l| {
            let i = l.find("% done")?;
            l[..i].rsplit(|ch: char| ch.is_whitespace() || ch == ',').next()?.parse().ok()
        });
    } else if first.contains("scrub repaired") {
        c.errors = first.split(" with ").nth(1).and_then(|r| r.split_whitespace().next()).and_then(|n| n.parse().ok());
        c.last = first.split(" on ").last().and_then(|d| parse_date(d.trim()));
    }
    c
}

/// "Sun Oct 12 03:00:01 2026" → unix seconds (local time, as `date` reads it).
fn parse_date(s: &str) -> Option<i64> {
    run("date", &["-d", s, "+%s"])?.trim().parse().ok()
}

// ---- md / LVM / btrfs --------------------------------------------------------

fn md_layout(disks_root: &str) -> (String, u32) {
    // the first md device in the stack decides the layout
    fn find_md(dev: &str) -> Option<String> {
        if dev.starts_with("md") {
            return Some(dev.to_string());
        }
        let entries = std::fs::read_dir(format!("/sys/class/block/{dev}/slaves")).ok()?;
        entries.flatten().find_map(|e| find_md(&e.file_name().to_string_lossy()))
    }
    let Some(md) = find_md(disks_root) else { return ("single".into(), 0) };
    let level = read(format!("/sys/class/block/{md}/md/level")).unwrap_or_default();
    let n = std::fs::read_dir(format!("/sys/class/block/{md}/slaves")).map(|d| d.count() as u32).unwrap_or(1);
    let redundancy = match level.as_str() {
        "raid1" => n.saturating_sub(1),
        "raid5" | "raid10" => 1,
        "raid6" => 2,
        _ => 0,
    };
    (if level.is_empty() { "single".into() } else { level }, redundancy)
}

/// `btrfs scrub status <mount>`.
fn btrfs_check(mount: &str) -> Check {
    let mut c = Check::default();
    let Some(text) = run(BTRFS, &["scrub", "status", mount]) else { return c };
    for line in text.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("Status:") {
            c.running = v.trim() == "running";
        } else if let Some(v) = t.strip_prefix("Scrub started:") {
            c.last = parse_date(v.trim());
        } else if let Some(v) = t.strip_prefix("Error summary:") {
            c.errors = Some(if v.contains("no errors found") { 0 } else { v.split_whitespace().filter_map(|w| w.split('=').nth(1)?.parse::<u64>().ok()).sum() });
        }
    }
    if c.running {
        c.last = None;
    }
    c
}

// ---- pools -----------------------------------------------------------------

/// Every data volume as a pool.
pub fn pools() -> Vec<Pool> {
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    crate::storage::volumes()
        .into_iter()
        .map(|v| {
            let (source, fs) = mounts
                .lines()
                .map(|l| l.split_whitespace().collect::<Vec<_>>())
                .find(|f| f.len() > 2 && f[1] == v.mount)
                .map(|f| (f[0].to_string(), f[2].to_string()))
                .unwrap_or_default();
            let (layout, redundancy, health, names, check) = if fs == "zfs" {
                zfs_pool(source.split('/').next().unwrap_or(&source))
            } else {
                let root = kname(&source).unwrap_or_default();
                let mut names = Vec::new();
                disks_under(&root, &mut names);
                let (layout, redundancy) = md_layout(&root);
                let check = if fs == "btrfs" { btrfs_check(&v.mount) } else { Check::default() };
                (layout, redundancy, "ok".to_string(), names, check)
            };
            Pool {
                name: v.name,
                mount: v.mount,
                fs,
                used_bytes: v.used_bytes,
                total_bytes: v.total_bytes,
                layout,
                redundancy,
                health,
                check,
                disks: names.iter().map(|n| disk(n)).collect(),
            }
        })
        .collect()
}

/// Start a disk check (scrub) on the pool mounted at `mount`.
pub fn start_check(mount: &str) -> Result<(), String> {
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    let (source, fs) = mounts
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>())
        .find(|f| f.len() > 2 && f[1] == mount)
        .map(|f| (f[0].to_string(), f[2].to_string()))
        .ok_or("no such volume")?;
    let out = match fs.as_str() {
        "zfs" => Command::new(ZPOOL).args(["scrub", source.split('/').next().unwrap_or(&source)]).output(),
        "btrfs" => Command::new(BTRFS).args(["scrub", "start", mount]).output(),
        _ => return Err(format!("{fs} has no disk check")),
    }
    .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zfs_scan_lines() {
        let done = "  pool: p\n state: ONLINE\n  scan: scrub repaired 0B in 00:10:02 with 3 errors on Sun Oct 12 03:00:01 2025\n";
        let c = zfs_check(done);
        assert!(!c.running);
        assert_eq!(c.errors, Some(3));
        let running = "  scan: scrub in progress since Sun Oct 12 03:00:01 2025\n\t1.2T scanned at 1G/s, 600G issued at 500M/s, 2T total\n\t0B repaired, 45.67% done, 00:30:00 to go\n";
        let c = zfs_check(running);
        assert!(c.running);
        assert_eq!(c.progress, Some(45.67));
    }
}
