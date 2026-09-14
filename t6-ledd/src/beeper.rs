//! EC beeper. The `t6_platform` driver exposes a single `beep` sysfs
//! attribute; writing a pattern byte plays it and 0 silences it.
//!
//! Everything that wants to make a sound goes through [`Beeper`] so the
//! sysfs path, the pattern values and the retry-at-startup behaviour live
//! in one place. Future event beeps (charge full, AC loss, ...) just call
//! `beeper.short()` and friends, the same way the LED auto rules are wired.

use std::path::{Path, PathBuf};
use std::time::Duration;

const BEEP_ATTR: &str = "/sys/devices/platform/t6-platform/beep";

/// A beep pattern. The named variants are the vendor set; `Raw` is an
/// escape hatch for any other byte the driver accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pattern {
    Off,
    Short,
    Long,
    Double,
    Continuous,
    Raw(u8),
}

impl Pattern {
    /// The byte the driver expects.
    pub fn value(self) -> u8 {
        match self {
            Pattern::Off => 0,
            Pattern::Short => 1,
            Pattern::Long => 2,
            Pattern::Double => 4,
            Pattern::Continuous => 8,
            Pattern::Raw(v) => v,
        }
    }

    /// Parse a control-command token: a name (`short`) or a raw byte (`4`).
    /// Known bytes map to their named variant so status stays readable.
    pub fn parse(token: &str) -> Result<Pattern, String> {
        match token {
            "off" | "stop" | "silence" => Ok(Pattern::Off),
            "short" => Ok(Pattern::Short),
            "long" => Ok(Pattern::Long),
            "double" => Ok(Pattern::Double),
            "continuous" => Ok(Pattern::Continuous),
            _ => match token.parse::<u8>() {
                Ok(v) => Ok(Pattern::from_value(v)),
                Err(_) => Err(format!(
                    "unknown beep pattern {token:?} (off/short/long/double/continuous or a byte 0..=255)"
                )),
            },
        }
    }

    fn from_value(v: u8) -> Pattern {
        match v {
            0 => Pattern::Off,
            1 => Pattern::Short,
            2 => Pattern::Long,
            4 => Pattern::Double,
            8 => Pattern::Continuous,
            other => Pattern::Raw(other),
        }
    }
}

pub struct Beeper {
    attr: PathBuf,
}

impl Beeper {
    pub fn new() -> Self {
        Beeper { attr: PathBuf::from(BEEP_ATTR) }
    }

    #[allow(dead_code)]
    pub fn available(&self) -> bool {
        self.attr.exists()
    }

    /// Play a pattern. Retries briefly, so a beep issued the moment the
    /// daemon starts still lands if `t6_platform` is a step behind.
    pub fn play(&self, pattern: Pattern) -> Result<(), String> {
        let value = pattern.value();
        let mut last = String::new();
        for attempt in 0..3 {
            match std::fs::write(&self.attr, format!("{value}\n")) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last = e.to_string();
                    if attempt < 2 {
                        std::thread::sleep(Duration::from_millis(300));
                    }
                }
            }
        }
        Err(format!("beeper: {last}"))
    }

    pub fn short(&self) -> Result<(), String> {
        self.play(Pattern::Short)
    }
    #[allow(dead_code)]
    pub fn long(&self) -> Result<(), String> {
        self.play(Pattern::Long)
    }
    #[allow(dead_code)]
    pub fn double(&self) -> Result<(), String> {
        self.play(Pattern::Double)
    }
    #[allow(dead_code)]
    pub fn continuous(&self) -> Result<(), String> {
        self.play(Pattern::Continuous)
    }
    pub fn silence(&self) -> Result<(), String> {
        self.play(Pattern::Off)
    }

    #[allow(dead_code)]
    pub fn attr(&self) -> &Path {
        &self.attr
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_names_and_bytes() {
        assert_eq!(Pattern::parse("short").unwrap(), Pattern::Short);
        assert_eq!(Pattern::parse("stop").unwrap(), Pattern::Off);
        assert_eq!(Pattern::parse("4").unwrap(), Pattern::Double);
        assert_eq!(Pattern::parse("7").unwrap(), Pattern::Raw(7));
        assert!(Pattern::parse("meep").is_err());
    }

    #[test]
    fn values_match_the_vendor_set() {
        assert_eq!(Pattern::Short.value(), 1);
        assert_eq!(Pattern::Long.value(), 2);
        assert_eq!(Pattern::Double.value(), 4);
        assert_eq!(Pattern::Continuous.value(), 8);
        assert_eq!(Pattern::Raw(42).value(), 42);
    }
}
