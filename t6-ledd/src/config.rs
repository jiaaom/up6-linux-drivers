//! Configuration file (`/etc/t6-ledd.toml`). The daemon is its only
//! writer: the web UI changes settings through the control socket and the
//! daemon persists them.

use crate::devices::{self, Device};
use crate::schedule::Window;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

const HEADER: &str = "# t6-ledd configuration. Managed by t6-ledd (T6 Control Center);\n\
                      # hand edits are kept but reformatted on the next change.\n\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Master switch for the six bay LEDs.
    #[serde(default = "yes")]
    pub bays_enabled: bool,
    /// Tray light breathing speed: "slow" | "normal" | "fast".
    #[serde(default = "default_tray_speed")]
    pub tray_speed: String,
    /// Event beeps (see [`BeepConfig`]).
    #[serde(default)]
    pub beep: BeepConfig,
    #[serde(default)]
    pub night: Night,
    /// Per-device setting, keyed by device id (see `devices::CATALOG`).
    #[serde(default)]
    pub devices: BTreeMap<String, DeviceSetting>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Night {
    /// Night mode switched on by hand (until switched off).
    #[serde(default)]
    pub manual: bool,
    /// Daily window `"HH:MM-HH:MM"` during which night mode is active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DeviceSetting {
    #[serde(default)]
    pub mode: Mode,
    /// Colour name for `manual` mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Auto,
    Manual,
}

fn yes() -> bool {
    true
}

fn default_tray_speed() -> String {
    "normal".into()
}

pub const TRAY_SPEEDS: [&str; 3] = ["slow", "normal", "fast"];

/// Which events make a sound. All default on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BeepConfig {
    /// Short beep once per boot (like the stock firmware).
    #[serde(default = "yes")]
    pub startup: bool,
    /// Two beeps when AC power is unplugged (running on battery).
    #[serde(default = "yes")]
    pub ac_loss: bool,
    /// A long beep when a RAID array becomes degraded (drive failed).
    #[serde(default = "yes")]
    pub drive_fault: bool,
}

impl Default for BeepConfig {
    fn default() -> Self {
        BeepConfig { startup: true, ac_loss: true, drive_fault: true }
    }
}

impl BeepConfig {
    /// Set one event by name; returns false for an unknown name.
    pub fn set(&mut self, event: &str, on: bool) -> bool {
        match event {
            "startup" => self.startup = on,
            "ac_loss" => self.ac_loss = on,
            "drive_fault" => self.drive_fault = on,
            _ => return false,
        }
        true
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            bays_enabled: true,
            tray_speed: default_tray_speed(),
            beep: BeepConfig::default(),
            night: Night::default(),
            devices: BTreeMap::new(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let cfg: Config = toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Written in place: the systemd unit only grants write access to this
    /// one path, so a temporary sibling file is not an option. The content
    /// is validated before the write and is a few hundred bytes.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let body = toml::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, format!("{HEADER}{body}")).map_err(|e| format!("cannot write {}: {e}", path.display()))
    }

    pub fn validate(&self) -> Result<(), String> {
        if !TRAY_SPEEDS.contains(&self.tray_speed.as_str()) {
            return Err(format!("tray_speed must be one of {TRAY_SPEEDS:?}"));
        }
        if let Some(s) = &self.night.schedule {
            Window::parse(s)?;
        }
        for (id, s) in &self.devices {
            let dev = devices::by_id(id).ok_or_else(|| format!("unknown device {id:?}"))?;
            s.validate_for(dev)?;
        }
        Ok(())
    }

    pub fn setting(&self, id: &str) -> DeviceSetting {
        self.devices.get(id).cloned().unwrap_or_default()
    }
}

impl DeviceSetting {
    pub fn validate_for(&self, dev: &Device) -> Result<(), String> {
        match self.mode {
            Mode::Auto => {
                if dev.auto.is_none() {
                    return Err(format!("{}: no automatic mode", dev.id));
                }
            }
            Mode::Manual => {
                let c = self.color.as_deref().ok_or_else(|| format!("{}: manual mode needs a colour", dev.id))?;
                if !dev.colors.iter().any(|(name, _)| *name == c) {
                    return Err(format!("{}: unknown colour {c:?}", dev.id));
                }
            }
        }
        Ok(())
    }
}
