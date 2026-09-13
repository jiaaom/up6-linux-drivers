//! Configuration file (`/etc/t6-fand.toml`).

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Poll period in seconds.
    #[serde(default = "default_interval")]
    pub interval_secs: u64,
    /// Profile used unless `/run/t6-fand/profile` overrides it.
    #[serde(default = "default_profile")]
    pub profile: String,
    /// Duty (percent) applied to a zone whose sensors cannot be read, and to
    /// every zone when the daemon exits.
    #[serde(default = "default_failsafe")]
    pub failsafe_pwm: u8,
    /// Name of the hwmon device that owns the fans.
    #[serde(default = "default_hwmon")]
    pub fan_hwmon: String,
    pub zones: BTreeMap<String, Zone>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Zone {
    /// `fanN_label` of the PWM channel to drive.
    pub fan: String,
    /// Temperature sources, aggregated as the maximum. Forms:
    /// `"<hwmon name>/<tempN_label>"`, `"<hwmon name>/tempN"`, `"bay/<1-6>"`.
    pub sensors: Vec<String>,
    /// Per-profile curves: `[[temp_c, pwm_percent], ...]`, ascending temps.
    pub curves: BTreeMap<String, Vec<[f64; 2]>>,
    /// Time constant (seconds) of the low-pass filter on the temperature;
    /// 0 disables it. Larger = calmer fans, slower reaction.
    #[serde(default)]
    pub tau_secs: f64,
    /// Raw temperature at or above which, once sustained for
    /// `emergency_secs`, filtering is bypassed and the fan ramps at
    /// `emergency_ramp` percent per second.
    #[serde(default = "default_emergency")]
    pub emergency_temp: f64,
    #[serde(default = "default_emergency_secs")]
    pub emergency_secs: f64,
    #[serde(default = "default_emergency_ramp")]
    pub emergency_ramp: f64,
    /// Degrees the temperature must fall below the last increase point
    /// before the duty is allowed to decrease.
    #[serde(default = "default_hysteresis")]
    pub hysteresis: f64,
    /// Maximum duty change per second, percent, going up / going down.
    #[serde(default = "default_ramp_up")]
    pub ramp_up: f64,
    #[serde(default = "default_ramp_down")]
    pub ramp_down: f64,
    /// Lowest duty while running. A curve value of 0 stops the fan.
    #[serde(default = "default_min_pwm")]
    pub min_pwm: u8,
    /// Duty used to start a stopped fan, and how long to hold it.
    #[serde(default = "default_start_pwm")]
    pub start_pwm: u8,
    #[serde(default = "default_kick_secs")]
    pub kick_secs: f64,
}

fn default_interval() -> u64 { 2 }
fn default_profile() -> String { "balance".into() }
fn default_failsafe() -> u8 { 70 }
fn default_hwmon() -> String { "t6_ec".into() }
fn default_emergency() -> f64 { 90.0 }
fn default_emergency_secs() -> f64 { 8.0 }
fn default_emergency_ramp() -> f64 { 15.0 }
fn default_hysteresis() -> f64 { 3.0 }
fn default_min_pwm() -> u8 { 8 }
fn default_start_pwm() -> u8 { 12 }
fn default_kick_secs() -> f64 { 3.0 }
fn default_ramp_up() -> f64 { 25.0 }
fn default_ramp_down() -> f64 { 5.0 }

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let cfg: Config = toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> Result<(), String> {
        if self.interval_secs == 0 {
            return Err("interval_secs must be > 0".into());
        }
        if self.failsafe_pwm > 100 {
            return Err("failsafe_pwm must be 0..=100".into());
        }
        if self.zones.is_empty() {
            return Err("no zones defined".into());
        }
        for (name, z) in &self.zones {
            if z.sensors.is_empty() {
                return Err(format!("zone {name}: no sensors"));
            }
            if z.min_pwm > 100 || z.start_pwm > 100 {
                return Err(format!("zone {name}: min_pwm/start_pwm must be 0..=100"));
            }
            if z.tau_secs < 0.0 || z.kick_secs < 0.0 {
                return Err(format!("zone {name}: tau_secs/kick_secs must be >= 0"));
            }
            if !z.curves.contains_key(&self.profile) {
                return Err(format!("zone {name}: no curve for profile {:?}", self.profile));
            }
            for (profile, curve) in &z.curves {
                if curve.is_empty() {
                    return Err(format!("zone {name}/{profile}: empty curve"));
                }
                for w in curve.windows(2) {
                    if w[1][0] <= w[0][0] {
                        return Err(format!("zone {name}/{profile}: temperatures must ascend"));
                    }
                }
                if curve.iter().any(|p| !(0.0..=100.0).contains(&p[1])) {
                    return Err(format!("zone {name}/{profile}: pwm must be 0..=100"));
                }
            }
        }
        Ok(())
    }
}
