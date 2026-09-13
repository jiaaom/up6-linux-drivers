//! LCD backlight via the standard backlight class. The level itself
//! persists across reboots through systemd-backlight; the last "on" level
//! is kept in the state directory so switching off and on restores it.

use serde::Serialize;
use std::path::{Path, PathBuf};

const BACKLIGHT_ROOT: &str = "/sys/class/backlight";
const DEVICE: &str = "t6_ec_backlight";
/// Lowest level the UI offers when on; 0 is reserved for "off".
pub const MIN_ON: u32 = 10;
const DEFAULT_ON: u32 = 20;

pub struct Display {
    dir: PathBuf,
    on_level_file: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct Info {
    pub present: bool,
    pub on: bool,
    pub brightness: Option<u32>,
    pub max_brightness: Option<u32>,
    /// Level restored when switched on.
    pub on_level: u32,
    pub min_on: u32,
}

impl Display {
    pub fn new(state_dir: &Path) -> Self {
        Display { dir: Path::new(BACKLIGHT_ROOT).join(DEVICE), on_level_file: state_dir.join("display-on-level") }
    }

    fn read_u32(&self, attr: &str) -> Option<u32> {
        std::fs::read_to_string(self.dir.join(attr)).ok()?.trim().parse().ok()
    }

    fn brightness(&self) -> Option<u32> {
        self.read_u32("actual_brightness").or_else(|| self.read_u32("brightness"))
    }

    fn on_level(&self) -> u32 {
        std::fs::read_to_string(&self.on_level_file)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .filter(|v| *v >= MIN_ON)
            .unwrap_or(DEFAULT_ON)
    }

    pub fn info(&self) -> Info {
        let b = self.brightness();
        Info {
            present: self.dir.is_dir(),
            on: b.map_or(false, |v| v > 0),
            brightness: b,
            max_brightness: self.read_u32("max_brightness"),
            on_level: self.on_level(),
            min_on: MIN_ON,
        }
    }

    fn write(&self, value: u32) -> Result<(), String> {
        let max = self.read_u32("max_brightness").ok_or("backlight not available (t6_platform loaded?)")?;
        if value > max {
            return Err(format!("brightness must be 0..={max}"));
        }
        std::fs::write(self.dir.join("brightness"), format!("{value}\n")).map_err(|e| format!("cannot write brightness: {e}"))
    }

    /// Set the level while on; remembered as the level to restore.
    pub fn set_brightness(&self, value: u32) -> Result<u32, String> {
        if value < MIN_ON {
            return Err(format!("brightness must be at least {MIN_ON} (use power off instead)"));
        }
        self.write(value)?;
        if let Some(dir) = self.on_level_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&self.on_level_file, format!("{value}\n")).map_err(|e| format!("cannot save level: {e}"))?;
        Ok(value)
    }

    pub fn set_power(&self, on: bool) -> Result<u32, String> {
        let v = if on { self.on_level() } else { 0 };
        self.write(v)?;
        Ok(v)
    }
}
