//! Battery telemetry and charge thresholds via the standard power-supply
//! class (`t6_platform` adds the `charge_control_*_threshold` attributes to
//! BAT0 through the ACPI battery hook).

use serde::Serialize;
use std::path::{Path, PathBuf};

const POWER_SUPPLY: &str = "/sys/class/power_supply";
const BATTERY: &str = "BAT0";
/// Boot-time persistence of the thresholds (module parameters).
const MODPROBE_CONF: &str = "/etc/modprobe.d/t6-platform.conf";
const MODULE: &str = "t6_platform";

pub struct Battery {
    dir: PathBuf,
    conf: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct Info {
    pub present: bool,
    /// State of charge, percent.
    pub capacity: Option<u32>,
    /// `Charging`, `Discharging`, `Not charging`, `Full`, `Unknown`.
    pub status: Option<String>,
    pub ac_online: Option<bool>,
    pub voltage_v: Option<f64>,
    /// Charge/discharge power, watts (0 when idle on AC).
    pub power_w: Option<f64>,
    pub energy_now_wh: Option<f64>,
    pub energy_full_wh: Option<f64>,
    pub energy_full_design_wh: Option<f64>,
    /// `energy_full / energy_full_design`, percent.
    pub health_percent: Option<f64>,
    pub cycle_count: Option<u32>,
    pub model: Option<String>,
    pub manufacturer: Option<String>,
    pub technology: Option<String>,
    pub thresholds: Option<Thresholds>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Thresholds {
    pub start: u32,
    pub end: u32,
}

impl Thresholds {
    /// 0/100 hands charging back to the EC's own policy.
    pub fn is_ec_policy(&self) -> bool {
        self.start == 0 && self.end == 100
    }
}

impl Battery {
    pub fn new() -> Self {
        Battery { dir: Path::new(POWER_SUPPLY).join(BATTERY), conf: PathBuf::from(MODPROBE_CONF) }
    }

    fn read(&self, attr: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join(attr)).ok().map(|s| s.trim().to_string())
    }

    fn read_u64(&self, attr: &str) -> Option<u64> {
        self.read(attr)?.parse().ok()
    }

    fn micro(&self, attr: &str) -> Option<f64> {
        self.read_u64(attr).map(|v| v as f64 / 1e6)
    }

    pub fn thresholds(&self) -> Option<Thresholds> {
        Some(Thresholds {
            start: self.read_u64("charge_control_start_threshold")? as u32,
            end: self.read_u64("charge_control_end_threshold")? as u32,
        })
    }

    pub fn info(&self) -> Info {
        let ac = std::fs::read_dir(POWER_SUPPLY).ok().and_then(|it| {
            it.flatten()
                .filter(|e| std::fs::read_to_string(e.path().join("type")).map(|t| t.trim() == "Mains").unwrap_or(false))
                .find_map(|e| std::fs::read_to_string(e.path().join("online")).ok())
                .map(|s| s.trim() == "1")
        });
        let full = self.micro("energy_full");
        let design = self.micro("energy_full_design");
        Info {
            present: self.read("present").as_deref() == Some("1"),
            capacity: self.read_u64("capacity").map(|v| v as u32),
            status: self.read("status"),
            ac_online: ac,
            voltage_v: self.micro("voltage_now"),
            power_w: self.micro("power_now"),
            energy_now_wh: self.micro("energy_now"),
            energy_full_wh: full,
            energy_full_design_wh: design,
            health_percent: match (full, design) {
                (Some(f), Some(d)) if d > 0.0 => Some(f / d * 100.0),
                _ => None,
            },
            cycle_count: self.read_u64("cycle_count").map(|v| v as u32),
            model: self.read("model_name"),
            manufacturer: self.read("manufacturer"),
            technology: self.read("technology"),
            thresholds: self.thresholds(),
        }
    }

    /// Apply thresholds now and persist them for the next boot.
    pub fn set_thresholds(&self, t: Thresholds) -> Result<(), String> {
        if t.end > 100 || t.start >= t.end {
            return Err("thresholds must satisfy 0 <= start < end <= 100".into());
        }
        let cur = self.thresholds().ok_or("charge thresholds not available (t6_platform loaded?)")?;
        // Each attribute is validated against the other's current value, so
        // the write order depends on the direction of the change.
        let (first, second) = if t.start < cur.end {
            (("charge_control_start_threshold", t.start), ("charge_control_end_threshold", t.end))
        } else {
            (("charge_control_end_threshold", t.end), ("charge_control_start_threshold", t.start))
        };
        for (attr, value) in [first, second] {
            std::fs::write(self.dir.join(attr), format!("{value}\n"))
                .map_err(|e| format!("cannot write {attr}: {e}"))?;
        }
        self.persist(t)
    }

    /// Update `options t6_platform charge_start_threshold=… charge_end_threshold=…`
    /// in the modprobe config, keeping any other options on that line.
    fn persist(&self, t: Thresholds) -> Result<(), String> {
        let text = std::fs::read_to_string(&self.conf).unwrap_or_default();
        let new_text = update_options(&text, MODULE, &[("charge_start_threshold", t.start), ("charge_end_threshold", t.end)]);
        let tmp = self.conf.with_extension("tmp");
        std::fs::write(&tmp, new_text)
            .and_then(|_| std::fs::rename(&tmp, &self.conf))
            .map_err(|e| format!("cannot write {}: {e}", self.conf.display()))
    }
}

/// Rewrite the first `options <module> ...` line so the given keys have the
/// given values (other keys untouched); append the line if there is none.
fn update_options(text: &str, module: &str, keys: &[(&str, u32)]) -> String {
    let prefix = format!("options {module}");
    let mut out = String::with_capacity(text.len() + 64);
    let mut done = false;
    for line in text.lines() {
        let l = line.trim();
        if !done && l.starts_with(&prefix) && l[prefix.len()..].starts_with(char::is_whitespace) {
            let mut opts: Vec<String> = l[prefix.len()..]
                .split_whitespace()
                .filter(|o| !keys.iter().any(|(k, _)| o.starts_with(&format!("{k}="))))
                .map(str::to_string)
                .collect();
            opts.extend(keys.iter().map(|(k, v)| format!("{k}={v}")));
            out.push_str(&format!("{prefix} {}\n", opts.join(" ")));
            done = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !done {
        let opts: Vec<String> = keys.iter().map(|(k, v)| format!("{k}={v}")).collect();
        out.push_str(&format!("{prefix} {}\n", opts.join(" ")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_existing_line_keeping_other_options() {
        let t = "# comment\noptions t6_platform min_pwm_percent=5 charge_start_threshold=75 charge_end_threshold=85\n";
        let out = update_options(t, "t6_platform", &[("charge_start_threshold", 60), ("charge_end_threshold", 80)]);
        assert_eq!(out, "# comment\noptions t6_platform min_pwm_percent=5 charge_start_threshold=60 charge_end_threshold=80\n");
    }

    #[test]
    fn appends_when_missing() {
        let out = update_options("options other x=1\n", "t6_platform", &[("charge_end_threshold", 90)]);
        assert_eq!(out, "options other x=1\noptions t6_platform charge_end_threshold=90\n");
        assert_eq!(update_options("", "t6_platform", &[("a", 1)]), "options t6_platform a=1\n");
    }
}
