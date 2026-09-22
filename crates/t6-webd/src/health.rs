//! Driver and service health for the dashboard: are the T6 kernel modules
//! built for (and loaded in) the running kernel, are the T6 services up, and
//! the state of the on-demand repair unit installed by the T6 Drivers package.
//!
//! A kernel update on fnOS installs the image before the headers and the
//! headers package runs no hooks, so DKMS never builds for the new kernel.
//! T6 Drivers checks this at every boot (`t6-drivers-check`); the repair
//! unit is the manual fallback. Building needs the kernel headers, which we
//! only report: installing packages is left to the administrator.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::process::Command;

/// Kernel module and the DKMS package that builds it.
const MODULES: [(&str, &str); 2] = [("t6_platform", "t6-platform"), ("ft8722_ts", "focaltech-ft8722")];
/// Services that depend on the modules; those not installed are skipped.
const SERVICES: [&str; 5] = ["t6-fand", "t6-ledd", "t6-paneld", "t6-panel-kiosk", "t6-webd"];
const REPAIR_UNIT: &str = "t6-drivers-repair.service";
/// Lines of the last repair run shown on the dashboard.
const LOG_LINES: usize = 40;

#[derive(Serialize)]
pub struct Health {
    kernel: String,
    /// Headers for the running kernel (needed only to build).
    headers: bool,
    /// dpkg is installing packages, possibly the kernel itself.
    dpkg_busy: bool,
    modules: Vec<ModuleHealth>,
    services: Vec<ServiceHealth>,
    repair: Repair,
    /// Human-readable list of what is wrong; empty when healthy.
    problems: Vec<String>,
    can_repair: bool,
}

#[derive(Serialize)]
struct ModuleHealth {
    name: &'static str,
    package: &'static str,
    built: bool,
    loaded: bool,
}

#[derive(Serialize)]
struct ServiceHealth {
    name: &'static str,
    /// systemd ActiveState / SubState, e.g. "activating" / "auto-restart".
    state: String,
    sub: String,
    enabled: bool,
    restarts: u32,
}

#[derive(Serialize)]
struct Repair {
    /// The T6 Drivers package installed the repair unit (0.2.0 and later).
    available: bool,
    running: bool,
    last: Option<RepairRun>,
}

#[derive(Serialize)]
struct RepairRun {
    /// None while running.
    ok: Option<bool>,
    /// Microseconds since the epoch of the last line.
    time_us: Option<u64>,
    log: Vec<String>,
}

impl Health {
    pub fn collect() -> Health {
        let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default().trim().to_string();
        let headers = std::path::Path::new(&format!("/lib/modules/{kernel}/build/include")).exists();
        let built = built_modules(&kernel);
        let modules: Vec<ModuleHealth> = MODULES
            .iter()
            .map(|&(name, package)| ModuleHealth {
                name,
                package,
                built: built.iter().any(|m| m == name),
                loaded: std::path::Path::new(&format!("/sys/module/{name}")).is_dir(),
            })
            .collect();

        let mut units: Vec<String> = SERVICES.iter().map(|s| format!("{s}.service")).collect();
        units.push(REPAIR_UNIT.into());
        let mut props = systemctl_show(&units);
        let services: Vec<ServiceHealth> = SERVICES
            .iter()
            .filter_map(|&name| {
                let p = props.remove(&format!("{name}.service"))?;
                (p.get("LoadState").map(String::as_str) == Some("loaded")).then(|| ServiceHealth {
                    name,
                    state: p.get("ActiveState").cloned().unwrap_or_default(),
                    sub: p.get("SubState").cloned().unwrap_or_default(),
                    enabled: p.get("UnitFileState").map(String::as_str) == Some("enabled"),
                    restarts: p.get("NRestarts").and_then(|v| v.parse().ok()).unwrap_or(0),
                })
            })
            .collect();
        let rp = props.remove(REPAIR_UNIT).unwrap_or_default();
        let available = rp.get("LoadState").map(String::as_str) == Some("loaded");
        let running = matches!(rp.get("ActiveState").map(String::as_str), Some("activating" | "deactivating"));
        let repair = Repair { available, running, last: available.then(|| last_repair(running)).flatten() };

        let dpkg_busy = dpkg_busy();
        let needs_build = modules.iter().any(|m| !m.built);
        let mut problems = Vec::new();
        for m in &modules {
            if !m.built {
                problems.push(format!("{} is not built for kernel {kernel} (usually after a system update).", m.name));
            } else if !m.loaded {
                problems.push(format!("{} is built but not loaded.", m.name));
            }
        }
        if needs_build && !headers {
            problems.push(format!(
                "Kernel headers for {kernel} are missing, so the drivers cannot be built. \
                 Install them with `apt install linux-headers-{kernel}`, then repair."
            ));
        }
        for s in &services {
            if s.enabled && s.state != "active" {
                let restarts = if s.restarts > 0 { format!(", restarted {} times", s.restarts) } else { String::new() };
                problems.push(format!("{} is {} ({}{restarts}).", s.name, s.state, s.sub));
            }
        }
        let can_repair = available && !running && !dpkg_busy && !(needs_build && !headers) && !problems.is_empty();
        Health { kernel, headers, dpkg_busy, modules, services, repair, problems, can_repair }
    }
}

/// Start the repair unit without waiting for it (a build takes ~30 s).
pub fn start_repair() -> Result<(), String> {
    let h = Health::collect();
    if !h.repair.available {
        return Err("repair needs T6 Drivers 0.2.0 or later".into());
    }
    if h.repair.running {
        return Err("a repair is already running".into());
    }
    if h.problems.is_empty() {
        return Err("drivers and services are healthy; nothing to repair".into());
    }
    if h.dpkg_busy {
        return Err("a system update is in progress; try again once it has finished".into());
    }
    if h.modules.iter().any(|m| !m.built) && !h.headers {
        return Err(format!("kernel headers for {} are missing (apt install linux-headers-{})", h.kernel, h.kernel));
    }
    let out = Command::new("systemctl")
        .args(["start", "--no-block", REPAIR_UNIT])
        .output()
        .map_err(|e| format!("systemctl: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("systemctl start {REPAIR_UNIT}: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Module names modprobe can find for `kernel`, from its modules.dep.
fn built_modules(kernel: &str) -> Vec<String> {
    let dep = std::fs::read_to_string(format!("/lib/modules/{kernel}/modules.dep")).unwrap_or_default();
    dep.lines()
        .filter_map(|l| {
            let path = l.split(':').next()?;
            let file = path.rsplit('/').next()?;
            Some(file.split(".ko").next()?.to_string())
        })
        .filter(|m| MODULES.iter().any(|&(name, _)| name == m))
        .collect()
}

/// `systemctl show` for several units, keyed by unit then property.
fn systemctl_show(units: &[String]) -> HashMap<String, HashMap<String, String>> {
    let out = Command::new("systemctl")
        .args(["show", "--property=Id,LoadState,ActiveState,SubState,UnitFileState,NRestarts", "--"])
        .args(units)
        .output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    // One block per unit, in order, separated by blank lines.
    text.split("\n\n")
        .zip(units)
        .map(|(block, unit)| {
            let props = block.lines().filter_map(|l| l.split_once('=')).map(|(k, v)| (k.into(), v.into())).collect();
            (unit.clone(), props)
        })
        .collect()
}

/// Output and outcome of the most recent repair run, from the journal. The
/// unit is a oneshot that systemd unloads once it finishes, so its own
/// Result/InvocationID properties are not reliable afterwards.
fn last_repair(running: bool) -> Option<RepairRun> {
    let out = Command::new("journalctl")
        .args(["--unit", REPAIR_UNIT, "--output=json", "--no-pager", "--lines", "200"])
        .output()
        .ok()?;
    let entries: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    // systemd's own messages carry INVOCATION_ID, the script's output
    // _SYSTEMD_INVOCATION_ID.
    let invocation = |e: &Value| e.get("_SYSTEMD_INVOCATION_ID").or_else(|| e.get("INVOCATION_ID")).and_then(Value::as_str).map(str::to_string);
    let last_id = entries.iter().rev().find_map(invocation)?;
    let run: Vec<&Value> = entries.iter().filter(|e| invocation(e).as_deref() == Some(last_id.as_str())).collect();
    let from_systemd = |e: &Value| e.get("_PID").and_then(Value::as_str) == Some("1");
    let message = |e: &Value| e.get("MESSAGE").and_then(Value::as_str).map(str::to_string);

    let ok = if running {
        None
    } else {
        // "Finished ..." on success; "Failed with result ..." / "Failed to start ..." otherwise.
        let sys: Vec<String> = run.iter().filter(|e| from_systemd(e)).filter_map(|e| message(e)).collect();
        if sys.iter().any(|m| m.contains("Failed")) {
            Some(false)
        } else if sys.iter().any(|m| m.starts_with("Finished")) {
            Some(true)
        } else {
            None
        }
    };
    let log: Vec<String> = run.iter().filter(|e| !from_systemd(e)).filter_map(|e| message(e)).collect();
    let log = log[log.len().saturating_sub(LOG_LINES)..].to_vec();
    let time_us = run.last().and_then(|e| e.get("__REALTIME_TIMESTAMP")?.as_str()?.parse().ok());
    Some(RepairRun { ok, time_us, log })
}

/// dpkg holds POSIX locks on these while it installs packages.
fn dpkg_busy() -> bool {
    let Ok(locks) = std::fs::read_to_string("/proc/locks") else { return false };
    ["/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock"]
        .iter()
        .filter_map(|f| std::fs::metadata(f).ok())
        .any(|m| locks.contains(&format!(":{} ", m.ino())))
}
