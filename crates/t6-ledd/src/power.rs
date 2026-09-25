//! Power button LED: a "screen is off, but the machine is on" light, and an
//! overheat alarm.
//!
//!   screen (LCD backlight) on   dark (the screen already shows it is on)
//!   screen off                  white
//!   overheating                 red blink, whatever the screen does (and
//!                               in night mode too)
//!
//! Overheat: the CPU package at `CPU_HOT` for `HOT_FOR`, or at `CPU_CRIT`
//! at once; an NVMe drive over its own warning temperature (`temp1_max`)
//! for `HOT_FOR`, or at its critical temperature (`temp1_crit`) at once.
//! It clears once every sensor is `HYSTERESIS` below its threshold.

use crate::leds::Effect;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const CPU_HOT: f64 = 95.0;
const CPU_CRIT: f64 = 105.0;
/// NVMe drives without their own thresholds use these.
const NVME_HOT: f64 = 80.0;
const NVME_CRIT: f64 = 85.0;
const HOT_FOR: Duration = Duration::from_secs(30);
const HYSTERESIS: f64 = 5.0;

/// The screen is on: backlight powered and brightness above 0. Reads the
/// backlight core's cached values (no EC access), so it is cheap to poll.
/// No backlight device counts as off (headless: the LED shows power).
pub fn screen_on() -> bool {
    t6_hw_rs::display::Display::new().is_on()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hot {
    /// Sensor that is too hot, e.g. "CPU" or "bay 3".
    pub sensor: String,
    pub temp_c: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub screen_on: bool,
    pub overheat: Option<Hot>,
}

impl Report {
    pub fn effect(&self) -> Effect {
        if self.overheat.is_some() {
            Effect::Blink { color: "red".into(), period_ms: 500 }
        } else if self.screen_on {
            Effect::off()
        } else {
            Effect::Solid("white".into())
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "screen_on": self.screen_on,
            "overheat": self.overheat.as_ref().map(|h| serde_json::json!({ "sensor": h.sensor, "temp_c": h.temp_c })),
        })
    }
}

/// One temperature reading with its thresholds.
#[derive(Debug, Clone)]
struct Reading {
    sensor: String,
    temp_c: f64,
    hot: f64,
    crit: f64,
}

#[derive(Default)]
pub struct Monitor {
    /// Since when each sensor has been at or above its warning threshold.
    hot_since: Vec<(String, Instant)>,
    /// Sensor currently raising the alarm.
    alarm: Option<Hot>,
}

impl Monitor {
    pub fn sample(&mut self, now: Instant) -> Report {
        // Debug hook: T6_LEDD_FAKE_OVERHEAT=1 raises the alarm.
        let readings = if std::env::var_os("T6_LEDD_FAKE_OVERHEAT").is_some() {
            vec![Reading { sensor: "CPU".into(), temp_c: 106.0, hot: CPU_HOT, crit: CPU_CRIT }]
        } else {
            read_temps()
        };
        self.update(&readings, now);
        Report { screen_on: screen_on(), overheat: self.alarm.clone() }
    }

    fn update(&mut self, readings: &[Reading], now: Instant) {
        self.hot_since.retain(|(s, _)| readings.iter().any(|r| r.sensor == *s && r.temp_c >= r.hot));
        let mut alarm: Option<Hot> = None;
        for r in readings {
            let since = if r.temp_c >= r.hot {
                match self.hot_since.iter().find(|(s, _)| *s == r.sensor) {
                    Some((_, t)) => Some(*t),
                    None => {
                        self.hot_since.push((r.sensor.clone(), now));
                        Some(now)
                    }
                }
            } else {
                None
            };
            let raising = r.temp_c >= r.crit || since.is_some_and(|t| now.duration_since(t) >= HOT_FOR);
            // An alarm already raised holds until the sensor has cooled off.
            let holding = self.alarm.as_ref().is_some_and(|a| a.sensor == r.sensor) && r.temp_c > r.hot - HYSTERESIS;
            if (raising || holding) && alarm.as_ref().is_none_or(|a| r.temp_c > a.temp_c) {
                alarm = Some(Hot { sensor: r.sensor.clone(), temp_c: r.temp_c });
            }
        }
        self.alarm = alarm;
    }
}

// --- sensors -------------------------------------------------------------------

fn read_milli(p: PathBuf) -> Option<f64> {
    std::fs::read_to_string(p).ok()?.trim().parse::<f64>().ok().map(|m| m / 1000.0)
}

/// CPU package (coretemp) and every NVMe drive (hwmon `nvme`, composite
/// temperature `temp1`).
fn read_temps() -> Vec<Reading> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir("/sys/class/hwmon") else { return out };
    for e in rd.flatten() {
        let dir = e.path();
        let name = std::fs::read_to_string(dir.join("name")).map(|s| s.trim().to_string()).unwrap_or_default();
        match name.as_str() {
            "coretemp" => {
                if let Some(t) = cpu_package(&dir) {
                    out.push(Reading { sensor: "CPU".into(), temp_c: t, hot: CPU_HOT, crit: CPU_CRIT });
                }
            }
            "nvme" => {
                let Some(t) = read_milli(dir.join("temp1_input")) else { continue };
                // Some drives report 0 or absurd thresholds: fall back then.
                let sane = |v: Option<f64>| v.filter(|v| (50.0..=120.0).contains(v));
                let crit = sane(read_milli(dir.join("temp1_crit"))).unwrap_or(NVME_CRIT);
                let hot = sane(read_milli(dir.join("temp1_max"))).unwrap_or(NVME_HOT).min(crit);
                out.push(Reading { sensor: nvme_label(&dir), temp_c: t, hot, crit });
            }
            _ => {}
        }
    }
    out
}

/// "Package id 0", or the hottest core if the package sensor is missing.
fn cpu_package(dir: &Path) -> Option<f64> {
    let mut hottest: Option<f64> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let f = e.file_name().to_string_lossy().to_string();
        let Some(idx) = f.strip_prefix("temp").and_then(|s| s.strip_suffix("_label")) else { continue };
        let label = std::fs::read_to_string(e.path()).unwrap_or_default();
        let t = read_milli(dir.join(format!("temp{idx}_input")));
        if label.trim().starts_with("Package") {
            return t;
        }
        if let Some(t) = t {
            hottest = Some(hottest.map_or(t, |h| h.max(t)));
        }
    }
    hottest
}

/// "bay 3" when the drive sits in a front bay, else the controller name.
fn nvme_label(hwmon: &Path) -> String {
    let dev = std::fs::canonicalize(hwmon.join("device")).unwrap_or_default();
    if let Some(bay) = crate::devices::sources::bay_of_path(&dev.to_string_lossy()) {
        return format!("bay {bay}");
    }
    dev.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "NVMe".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cpu(t: f64) -> Reading {
        Reading { sensor: "CPU".into(), temp_c: t, hot: CPU_HOT, crit: CPU_CRIT }
    }

    #[test]
    fn hot_must_last_crit_is_immediate() {
        let mut m = Monitor::default();
        let t = Instant::now();
        let s = |x| t + Duration::from_secs(x);
        m.update(&[cpu(96.0)], s(0));
        assert!(m.alarm.is_none());
        m.update(&[cpu(97.0)], s(29));
        assert!(m.alarm.is_none());
        m.update(&[cpu(97.0)], s(31));
        assert_eq!(m.alarm.as_ref().map(|a| a.sensor.as_str()), Some("CPU"));
        // Holds until 5 degrees under the threshold.
        m.update(&[cpu(91.0)], s(40));
        assert!(m.alarm.is_some());
        m.update(&[cpu(89.0)], s(42));
        assert!(m.alarm.is_none());
        // Critical: at once.
        m.update(&[cpu(106.0)], s(50));
        assert!(m.alarm.is_some());
    }

    #[test]
    fn a_dip_restarts_the_hot_timer() {
        let mut m = Monitor::default();
        let t = Instant::now();
        let s = |x| t + Duration::from_secs(x);
        m.update(&[cpu(96.0)], s(0));
        m.update(&[cpu(90.0)], s(20));
        m.update(&[cpu(96.0)], s(25));
        m.update(&[cpu(96.0)], s(45));
        assert!(m.alarm.is_none());
        m.update(&[cpu(96.0)], s(56));
        assert!(m.alarm.is_some());
    }

    #[test]
    fn effect_follows_screen_and_alarm() {
        let r = |screen_on, hot: bool| Report { screen_on, overheat: hot.then(|| Hot { sensor: "CPU".into(), temp_c: 106.0 }) };
        assert_eq!(r(true, false).effect(), Effect::off());
        assert_eq!(r(false, false).effect(), Effect::Solid("white".into()));
        assert_eq!(r(true, true).effect(), Effect::Blink { color: "red".into(), period_ms: 500 });
    }
}
