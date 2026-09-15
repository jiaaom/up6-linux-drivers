//! Temperatures, memory, uptime and hostname from sysfs and `/proc`.
//!
//! Temperatures come from the hwmon class, located by chip `name` so we do
//! not depend on hwmon numbering (which is not stable across boots):
//!   - CPU package:  `coretemp`
//!   - iGPU:         `i915`
//!   - NVMe drives:  `nvme` (one hwmon per drive; we report the hottest)
//!
//! The parsing of each `/proc` file is split into a pure `*_from(&str)`
//! function so it can be unit-tested without touching the real filesystem.

use std::path::{Path, PathBuf};

const HWMON_ROOT: &str = "/sys/class/hwmon";

fn read_trim(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

/// All hwmon directories whose `name` equals `name`.
fn hwmon_by_name(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(it) = std::fs::read_dir(HWMON_ROOT) {
        for e in it.flatten() {
            let p = e.path();
            if read_trim(&p.join("name")).as_deref() == Some(name) {
                out.push(p);
            }
        }
    }
    out
}

/// milli-degrees C at `<dir>/temp1_input` -> degrees C.
fn temp_input_c(dir: &Path) -> Option<f64> {
    read_trim(&dir.join("temp1_input"))?.parse::<i64>().ok().map(|m| m as f64 / 1000.0)
}

pub fn cpu_temp_c() -> Option<f64> {
    hwmon_by_name("coretemp").first().and_then(|d| temp_input_c(d))
}

pub fn gpu_temp_c() -> Option<f64> {
    hwmon_by_name("i915").first().and_then(|d| temp_input_c(d))
}

/// Hottest NVMe drive, degrees C.
pub fn drives_temp_c() -> Option<f64> {
    hwmon_by_name("nvme")
        .iter()
        .filter_map(|d| temp_input_c(d))
        .fold(None, |acc, t| Some(acc.map_or(t, |m: f64| m.max(t))))
}

/// Memory in use, percent, computed as `(MemTotal - MemAvailable) / MemTotal`.
fn mem_used_pct_from(meminfo: &str) -> Option<u32> {
    let mut total = None;
    let mut avail = None;
    for line in meminfo.lines() {
        let mut it = line.split_whitespace();
        match it.next() {
            Some("MemTotal:") => total = it.next().and_then(|v| v.parse::<u64>().ok()),
            Some("MemAvailable:") => avail = it.next().and_then(|v| v.parse::<u64>().ok()),
            _ => {}
        }
    }
    match (total, avail) {
        (Some(t), Some(a)) if t > 0 => Some((((t - a.min(t)) as f64 / t as f64) * 100.0).round() as u32),
        _ => None,
    }
}

pub fn mem_used_pct() -> Option<u32> {
    mem_used_pct_from(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

/// First field of `/proc/uptime` (seconds, a float) truncated to whole seconds.
fn uptime_from(proc_uptime: &str) -> Option<u64> {
    proc_uptime.split_whitespace().next()?.parse::<f64>().ok().map(|f| f as u64)
}

pub fn uptime_s() -> Option<u64> {
    uptime_from(&std::fs::read_to_string("/proc/uptime").ok()?)
}

pub fn hostname() -> Option<String> {
    read_trim(Path::new("/proc/sys/kernel/hostname")).or_else(|| read_trim(Path::new("/etc/hostname")))
}

/// `PRETTY_NAME` from an `/etc/os-release`-format string.
fn os_pretty_from(os_release: &str) -> Option<String> {
    for line in os_release.lines() {
        if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
            return Some(v.trim_matches('"').to_string());
        }
    }
    None
}

pub fn os_pretty_name() -> Option<String> {
    os_pretty_from(&std::fs::read_to_string("/etc/os-release").ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mem_used_pct_basic() {
        // 32 GiB total, 8 GiB available -> 75% used.
        let s = "MemTotal:       33554432 kB\nMemFree: 100 kB\nMemAvailable:    8388608 kB\n";
        assert_eq!(mem_used_pct_from(s), Some(75));
    }

    #[test]
    fn mem_used_pct_missing_fields() {
        assert_eq!(mem_used_pct_from("MemTotal: 1000 kB\n"), None);
        assert_eq!(mem_used_pct_from(""), None);
        assert_eq!(mem_used_pct_from("MemTotal: 0 kB\nMemAvailable: 0 kB\n"), None);
    }

    #[test]
    fn mem_used_pct_clamps_avail_over_total() {
        // Available should never exceed total, but never return >100 if it does.
        assert_eq!(mem_used_pct_from("MemTotal: 100 kB\nMemAvailable: 500 kB\n"), Some(0));
    }

    #[test]
    fn uptime_truncates() {
        assert_eq!(uptime_from("83005.64 250000.10"), Some(83005));
        assert_eq!(uptime_from("12.0"), Some(12));
        assert_eq!(uptime_from(""), None);
        assert_eq!(uptime_from("garbage"), None);
    }

    #[test]
    fn os_pretty_parsing() {
        assert_eq!(os_pretty_from("NAME=\"fnOS\"\nPRETTY_NAME=\"fnOS 0.9.18\"\n").as_deref(), Some("fnOS 0.9.18"));
        assert_eq!(os_pretty_from("ID=debian\n"), None);
    }
}
