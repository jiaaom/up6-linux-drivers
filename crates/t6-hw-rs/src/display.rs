//! LCD backlight via the standard backlight class. Nothing is persisted
//! here: the screen always comes up lit and systemd-backlight restores the
//! level across reboots. Every level 1..=100 is visible (measured); 0 is
//! fully dark.
//!
//! On/off preserves the brightness with `bl_power` and, when the optional
//! IT6616 driver is present, switches the panel's display off/on (DCS 0x28 /
//! 0x29) behind a dark backlight. Never sleep-in (0x10): the panel is an
//! FT8722 TDDI, whose touch half stops scanning while asleep (no double-tap
//! wake) and often recalibrates badly on sleep-out, leaving it reporting
//! phantom multi-touch until the next sleep/wake (see docs/ft8722-touchscreen.md).
//! A runtime "off" lasts until the next reboot. All mutations share a
//! process-wide and cross-process advisory lock; callers must run them off
//! async workers.

use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const BACKLIGHT_ROOT: &str = "/sys/class/backlight";
const DEVICE: &str = "t6_ec_backlight";
const BRIDGE_DEVICE: &str = "/sys/bus/i2c/devices/i2c-ITE6616:00";
const LOCK: &str = "/run/t6-display/control.lock";
/// Lowest level the UI offers when on; 0 is reserved for "off".
pub const MIN_ON: u32 = 1;
/// Used when switching on from a level of 0.
const DEFAULT_ON: u32 = 20;

pub struct Display {
    dir: PathBuf,
    panel: PathBuf,
    lock: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct Info {
    pub present: bool,
    pub on: bool,
    pub brightness: Option<u32>,
    pub max_brightness: Option<u32>,
    pub min_on: u32,
}

/// `bl_power` values (the kernel's FB_BLANK_*): 0 = on, 4 = powered down.
const BL_ON: u32 = 0;
const BL_OFF: u32 = 4;

impl Display {
    pub fn new() -> Self {
        Display {
            dir: Path::new(BACKLIGHT_ROOT).join(DEVICE),
            panel: Path::new(BRIDGE_DEVICE).join("panel"),
            lock: PathBuf::from(LOCK),
        }
    }

    fn read_u32(&self, attr: &str) -> Option<u32> {
        std::fs::read_to_string(self.dir.join(attr)).ok()?.trim().parse().ok()
    }

    fn write_attr(&self, attr: &str, value: u32) -> Result<(), String> {
        std::fs::write(self.dir.join(attr), format!("{value}\n"))
            .map_err(|e| format!("cannot write {attr}: {e}"))
    }

    /// Each call opens its own file description, so flock serializes threads
    /// as well as webd, paneld and ledd. Closing the file releases the lock,
    /// including on error or process exit. Never unlink this shared inode.
    fn lock(&self) -> Result<File, String> {
        if let Some(parent) = self.lock.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create display lock directory {}: {e}", parent.display()))?;
        }
        let file = OpenOptions::new().write(true).create(true).truncate(false)
            .mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&self.lock)
            .map_err(|e| format!("cannot open display lock {}: {e}", self.lock.display()))?;
        loop {
            // SAFETY: file owns a valid descriptor for the duration of flock.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                return Ok(file);
            }
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::Interrupted {
                return Err(format!("cannot lock display controls: {e}"));
            }
        }
    }

    /// Only an absent attribute means the optional driver is unavailable.
    /// Open without create: permissions, I/O errors and driver errors must
    /// not be mistaken for a successful backlight-only transition.
    fn bridge_set_panel(&self, state: &str) -> Result<(), String> {
        let mut file = match OpenOptions::new().write(true).open(&self.panel) {
            Ok(file) => file,
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
            Err(e) => return Err(format!("cannot open {}: {e}", self.panel.display())),
        };
        file.write_all(state.as_bytes())
            .map_err(|e| format!("cannot set panel {state} via {}: {e}", self.panel.display()))
    }

    /// The screen is lit: backlight powered (`bl_power` 0) at a level above
    /// 0. Reads the backlight core's cached values (no EC access), so it is
    /// cheap enough to poll.
    pub fn is_on(&self) -> bool {
        matches!((self.read_u32("bl_power"), self.read_u32("brightness")), (Some(BL_ON), Some(b)) if b > 0)
    }

    pub fn info(&self) -> Info {
        Info {
            present: self.dir.is_dir(),
            on: self.is_on(),
            // The level, kept while the backlight is powered down.
            brightness: self.read_u32("brightness"),
            max_brightness: self.read_u32("max_brightness"),
            min_on: MIN_ON,
        }
    }

    fn write_brightness(&self, value: u32) -> Result<(), String> {
        let max = self.read_u32("max_brightness").ok_or("backlight not available (t6_platform loaded?)")?;
        if value > max {
            return Err(format!("brightness must be 0..={max}"));
        }
        self.write_attr("brightness", value)
    }

    /// Set the level. Does not switch a powered-down backlight on.
    pub fn set_brightness(&self, value: u32) -> Result<u32, String> {
        if value < MIN_ON {
            return Err(format!("brightness must be at least {MIN_ON} (use power off instead)"));
        }
        let _lock = self.lock()?;
        self.write_brightness(value)?;
        Ok(value)
    }

    /// Set the live display state.  When the IT6616 driver is present, the
    /// backlight is switched off before the panel display goes off and
    /// switched on only after it is back on, so DCS-induced flicker is hidden.
    pub fn set_power(&self, on: bool) -> Result<u32, String> {
        let _lock = self.lock()?;
        self.set_power_locked(on)
    }

    fn set_power_locked(&self, on: bool) -> Result<u32, String> {
        let level = self.read_u32("brightness").ok_or("backlight not available (t6_platform loaded?)")?;
        // Blank even when brightness was zero: restoring a nonzero level
        // before display-on would otherwise illuminate an off/uncertain panel.
        self.write_attr("bl_power", BL_OFF)?;
        self.bridge_set_panel(if on { "on" } else { "off" })
            .map_err(|e| format!("{e}; backlight remains off; retry screen on to recover"))?;
        let restored = if on && level == 0 { DEFAULT_ON } else { level };
        if restored != level {
            self.write_brightness(restored)?;
        }
        if on {
            self.write_attr("bl_power", BL_ON)?;
        }
        Ok(restored)
    }

    /// Flip the screen on/off (the front power button). Returns the new state.
    pub fn toggle(&self) -> Result<bool, String> {
        let _lock = self.lock()?;
        let on = !self.is_on();
        self.set_power_locked(on)?;
        Ok(on)
    }
}

#[cfg(test)]
struct TestDisplay {
    display: Display,
    root: PathBuf,
}

#[cfg(test)]
impl TestDisplay {
    fn new() -> Self {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!("t6-display-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&root).unwrap();
        let dir = root.join("backlight");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("brightness"), "42\n").unwrap();
        std::fs::write(dir.join("max_brightness"), "100\n").unwrap();
        std::fs::write(dir.join("bl_power"), "0\n").unwrap();
        Self {
            display: Display { dir, panel: root.join("panel"), lock: root.join("display.lock") },
            root,
        }
    }
}

#[cfg(test)]
impl Drop for TestDisplay {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]

mod tests {
    use super::*;

    #[test]
    fn missing_bridge_preserves_backlight_only_power() {
        let fixture = TestDisplay::new();
        let d = &fixture.display;
        assert_eq!(d.set_power(false).unwrap(), 42);
        assert!(!d.is_on());
        assert_eq!(d.set_power(true).unwrap(), 42);
        assert!(d.is_on());
        assert!(!d.panel.exists(), "optional attribute must not be created");
    }

    #[test]
    fn failed_sleep_keeps_backlight_off() {
        let fixture = TestDisplay::new();
        let d = &fixture.display;
        // EISDIR, unlike ENOENT, is a real failure even when running as root.
        std::fs::create_dir(&d.panel).unwrap();
        assert!(d.set_power(false).is_err());
        assert_eq!(d.read_u32("bl_power"), Some(BL_OFF));
        assert_eq!(d.read_u32("brightness"), Some(42));
    }

    #[test]
    fn failed_wake_does_not_restore_zero_brightness() {
        let fixture = TestDisplay::new();
        let d = &fixture.display;
        std::fs::write(d.dir.join("brightness"), "0\n").unwrap();
        std::fs::create_dir(&d.panel).unwrap();
        assert!(d.set_power(true).is_err());
        assert_eq!(d.read_u32("bl_power"), Some(BL_OFF));
        assert_eq!(d.read_u32("brightness"), Some(0));
        std::fs::remove_dir(&d.panel).unwrap();
        assert_eq!(d.set_power(true).unwrap(), DEFAULT_ON);
        assert!(d.is_on());
    }

    #[test]
    fn invalid_bridge_parent_is_not_optional() {
        let mut fixture = TestDisplay::new();
        std::fs::write(&fixture.display.panel, "not a directory").unwrap();
        fixture.display.panel = fixture.display.panel.join("panel");
        assert!(fixture.display.set_power(true).is_err());
        assert_eq!(fixture.display.read_u32("bl_power"), Some(BL_OFF));
    }
}
