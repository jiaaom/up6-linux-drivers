//! LED hardware access: the `t6:*` brightness class devices and tray speed.
//! `LedBank` centralizes colour updates and suppresses redundant writes.

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
    /// Switch old channels off before selecting the new colour. System and
    /// bay LEDs select one hardware colour; tray RGB channels can combine.
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
    /// Two short pulses, then a pause (Wi-Fi hotspot).
    Heartbeat { color: String },
}

/// Heartbeat cycle: on 100 ms, off 100 ms, on 100 ms, off 900 ms.
const HEARTBEAT_CYCLE_MS: u128 = 1200;
const HEARTBEAT_ON_MS: [(u128, u128); 2] = [(0, 100), (200, 300)];

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
            Effect::Heartbeat { color } => {
                let t = elapsed.as_millis() % HEARTBEAT_CYCLE_MS;
                if HEARTBEAT_ON_MS.iter().any(|(a, b)| (*a..*b).contains(&t)) { color } else { "off" }
            }
        }
    }

    /// The colour an animated effect shows when lit.
    pub fn base_color(&self) -> &str {
        match self {
            Effect::Solid(c) | Effect::Blink { color: c, .. } | Effect::Heartbeat { color: c } => c,
        }
    }

    /// Short human description for status.json.
    pub fn describe(&self) -> String {
        match self {
            Effect::Solid(c) => c.clone(),
            Effect::Blink { color, .. } => format!("blink {color}"),
            Effect::Heartbeat { color } => format!("heartbeat {color}"),
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
    fn heartbeat_is_two_pulses_then_a_pause() {
        let h = Effect::Heartbeat { color: "blue".into() };
        let at = |ms| h.frame_color(Duration::from_millis(ms));
        assert_eq!([at(0), at(99), at(100), at(199), at(200), at(299)], ["blue", "blue", "off", "off", "blue", "blue"]);
        assert_eq!([at(300), at(1199), at(1200), at(1350)], ["off", "off", "blue", "off"]);
        assert_eq!(h.describe(), "heartbeat blue");
    }

    #[test]
    fn solid_is_constant() {
        let s = Effect::Solid("white".into());
        assert_eq!(s.frame_color(Duration::from_millis(0)), "white");
        assert_eq!(s.frame_color(Duration::from_millis(9999)), "white");
        assert_eq!(s.describe(), "white");
    }
}
