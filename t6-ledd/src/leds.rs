//! LED hardware access: the `t6:*` brightness class devices and the tray
//! speed attribute. `LedBank` is to the LEDs what `Beeper` is to the
//! beeper — the one place that touches the sysfs, and the write-order rule
//! that a full-byte LED register imposes.

use crate::devices::Device;
use std::collections::HashMap;
use std::path::PathBuf;

const LEDS_ROOT: &str = "/sys/class/leds";
const TRAY_SPEED_ATTR: &str = "/sys/devices/platform/t6-platform/tray_speed";

/// Write the tray breathing speed ("slow"|"normal"|"fast") to the driver.
pub fn set_tray_speed(speed: &str) -> Result<(), String> {
    std::fs::write(TRAY_SPEED_ATTR, format!("{speed}\n"))
        .map_err(|e| format!("{TRAY_SPEED_ATTR}: {e}"))
}

/// Writes LED brightness values, skipping writes that would not change
/// anything.
pub struct LedBank {
    root: PathBuf,
    state: HashMap<&'static str, bool>,
}

impl LedBank {
    pub fn new() -> Self {
        LedBank { root: PathBuf::from(LEDS_ROOT), state: HashMap::new() }
    }

    pub fn available(&self, led: &str) -> bool {
        self.root.join(led).join("brightness").exists()
    }

    /// Set a device to a colour (every LED not in the colour goes off).
    ///
    /// The "off" LEDs are written before the "on" LEDs. The EC LEDs of one
    /// device (power button, each bay) share a single register in full-byte
    /// mode, so a colour's off-write zeroes the whole byte; doing the offs
    /// first means the final write is the colour we want, not a stray zero.
    pub fn set(&mut self, dev: &Device, color: &str) -> Result<(), String> {
        let on = dev.leds_for(color).ok_or_else(|| format!("{}: unknown colour {color:?}", dev.id))?;
        for led in dev.leds {
            if !on.contains(led) {
                self.write(led, false)?;
            }
        }
        for led in dev.leds {
            if on.contains(led) {
                self.write(led, true)?;
            }
        }
        Ok(())
    }

    fn write(&mut self, led: &'static str, on: bool) -> Result<(), String> {
        if self.state.get(led) == Some(&on) {
            return Ok(());
        }
        let path = self.root.join(led).join("brightness");
        std::fs::write(&path, if on { "1\n" } else { "0\n" }).map_err(|e| format!("{}: {e}", path.display()))?;
        self.state.insert(led, on);
        Ok(())
    }

    /// Forget what was written so the next pass rewrites everything.
    pub fn invalidate(&mut self) {
        self.state.clear();
    }
}

// --- effects -------------------------------------------------------------

use std::time::Duration;

/// What a device should display. The policy layer picks an effect; the
/// render loop turns it into the colour to show this frame.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// A steady colour (an LED-bank colour name, e.g. "white", "off").
    Solid(String),
    /// Alternate `color` and off every half `period_ms` (drive fault, ...).
    Blink { color: String, period_ms: u64 },
}

impl Effect {
    pub fn off() -> Self {
        Effect::Solid("off".into())
    }

    /// Colour to show `elapsed` into the daemon's run.
    pub fn frame_color(&self, elapsed: Duration) -> &str {
        match self {
            Effect::Solid(c) => c,
            Effect::Blink { color, period_ms } => {
                let period = (*period_ms).max(1) as u128;
                if (elapsed.as_millis() / period) % 2 == 0 { color } else { "off" }
            }
        }
    }

    /// Short human description for status.json.
    pub fn describe(&self) -> String {
        match self {
            Effect::Solid(c) => c.clone(),
            Effect::Blink { color, .. } => format!("blink {color}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blink_alternates_each_half_period() {
        let b = Effect::Blink { color: "red".into(), period_ms: 500 };
        assert_eq!(b.frame_color(Duration::from_millis(0)), "red");
        assert_eq!(b.frame_color(Duration::from_millis(499)), "red");
        assert_eq!(b.frame_color(Duration::from_millis(500)), "off");
        assert_eq!(b.frame_color(Duration::from_millis(999)), "off");
        assert_eq!(b.frame_color(Duration::from_millis(1000)), "red");
    }

    #[test]
    fn solid_is_constant() {
        let s = Effect::Solid("white".into());
        assert_eq!(s.frame_color(Duration::from_millis(0)), "white");
        assert_eq!(s.frame_color(Duration::from_millis(9999)), "white");
        assert_eq!(s.describe(), "white");
    }
}
