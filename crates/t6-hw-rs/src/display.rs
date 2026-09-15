//! LCD backlight via the standard backlight class, with persistent settings
//! in `/etc/t6-display.conf`:
//!   - `on_level`: the brightness (10..100) used when the screen is on;
//!     remembered across reboots and across an off/on toggle.
//!   - `off_after_boot`: if true, the screen is left off at boot; otherwise
//!     it always comes up on at `on_level` (so a runtime "off" never looks
//!     like a dead panel after a reboot).
//!
//! The runtime on/off toggle is live only — it never changes what happens
//! at the next boot. t6-ledd reads this file once per boot and sets the
//! backlight, so the screen always comes up correctly.

use serde::Serialize;
use std::path::{Path, PathBuf};

const BACKLIGHT_ROOT: &str = "/sys/class/backlight";
const DEVICE: &str = "t6_ec_backlight";
const CONF: &str = "/etc/t6-display.conf";
/// Lowest level the UI offers when on; 0 is reserved for "off".
pub const MIN_ON: u32 = 10;
const DEFAULT_ON: u32 = 20;

pub struct Display {
    dir: PathBuf,
    conf: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Settings {
    on_level: u32,
    off_after_boot: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { on_level: DEFAULT_ON, off_after_boot: false }
    }
}

/// Parse the tiny `key=value` settings file (unknown keys and malformed lines
/// ignored, so a partly written or future-extended file still yields a sane
/// result). `on_level` is clamped to the UI's on-range.
fn parse_settings(text: &str) -> Settings {
    let mut s = Settings::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        match k.trim() {
            "on_level" => {
                if let Ok(n) = v.trim().parse::<u32>() {
                    s.on_level = n.clamp(MIN_ON, 100);
                }
            }
            "off_after_boot" => s.off_after_boot = matches!(v.trim(), "true" | "1" | "yes"),
            _ => {}
        }
    }
    s
}

fn format_settings(s: Settings) -> String {
    format!(
        "# T6 built-in display settings, managed by T6 Control Center.\n\
         on_level={}\noff_after_boot={}\n",
        s.on_level, s.off_after_boot
    )
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
    /// Leave the display off at boot.
    pub off_after_boot: bool,
}

impl Display {
    pub fn new() -> Self {
        Display { dir: Path::new(BACKLIGHT_ROOT).join(DEVICE), conf: PathBuf::from(CONF) }
    }

    fn read_u32(&self, attr: &str) -> Option<u32> {
        std::fs::read_to_string(self.dir.join(attr)).ok()?.trim().parse().ok()
    }

    fn brightness(&self) -> Option<u32> {
        self.read_u32("actual_brightness").or_else(|| self.read_u32("brightness"))
    }

    fn settings(&self) -> Settings {
        std::fs::read_to_string(&self.conf).map(|t| parse_settings(&t)).unwrap_or_default()
    }

    fn save(&self, s: Settings) -> Result<(), String> {
        let text = format_settings(s);
        let tmp = self.conf.with_extension("conf.tmp");
        std::fs::write(&tmp, text)
            .and_then(|_| std::fs::rename(&tmp, &self.conf))
            .map_err(|e| format!("cannot write {}: {e}", self.conf.display()))
    }

    pub fn info(&self) -> Info {
        let b = self.brightness();
        let s = self.settings();
        Info {
            present: self.dir.is_dir(),
            on: b.map_or(false, |v| v > 0),
            brightness: b,
            max_brightness: self.read_u32("max_brightness"),
            on_level: s.on_level,
            min_on: MIN_ON,
            off_after_boot: s.off_after_boot,
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
        let mut s = self.settings();
        s.on_level = value.clamp(MIN_ON, 100);
        self.save(s)?;
        Ok(value)
    }

    /// Live on/off. Does not change the boot behaviour.
    pub fn set_power(&self, on: bool) -> Result<u32, String> {
        let v = if on { self.settings().on_level } else { 0 };
        self.write(v)?;
        Ok(v)
    }

    pub fn set_off_after_boot(&self, off: bool) -> Result<(), String> {
        let mut s = self.settings();
        s.off_after_boot = off;
        self.save(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_empty_or_unknown() {
        assert_eq!(parse_settings(""), Settings::default());
        assert_eq!(parse_settings("# just a comment\nfuture_key=1\n"), Settings::default());
    }

    #[test]
    fn parses_and_clamps() {
        assert_eq!(parse_settings("on_level=55\noff_after_boot=true\n"), Settings { on_level: 55, off_after_boot: true });
        // below MIN_ON and above 100 are clamped
        assert_eq!(parse_settings("on_level=3\n").on_level, MIN_ON);
        assert_eq!(parse_settings("on_level=200\n").on_level, 100);
        // off_after_boot accepts several truthy spellings; anything else is false
        assert!(parse_settings("off_after_boot=1\n").off_after_boot);
        assert!(parse_settings("off_after_boot=yes\n").off_after_boot);
        assert!(!parse_settings("off_after_boot=no\n").off_after_boot);
    }

    #[test]
    fn format_then_parse_roundtrips() {
        let s = Settings { on_level: 42, off_after_boot: true };
        assert_eq!(parse_settings(&format_settings(s)), s);
    }
}
