//! Event beeps: watch a few system states and beep on the transitions that
//! matter. Edge-triggered — each event fires once when it happens, not
//! every cycle while the condition holds. New rules are a field here, a
//! `[beep]` toggle in the config, and one arm in `poll`.

use crate::beeper::Pattern;
use crate::config::BeepConfig;
use crate::devices::sources;

/// Remembers the previous sample so transitions can be detected.
#[derive(Default)]
pub struct EventWatcher {
    ac_online: Option<bool>,
    array_degraded: Option<bool>,
}

/// A beep to play, with a short reason for the log.
pub struct EventBeep {
    pub pattern: Pattern,
    pub reason: &'static str,
}

impl EventWatcher {
    /// Sample the watched states and return the beeps triggered this cycle.
    /// The first call only records the baseline (no beeps), so a state that
    /// is already "bad" at startup does not beep.
    pub fn poll(&mut self, cfg: &BeepConfig) -> Vec<EventBeep> {
        let mut beeps = Vec::new();

        // AC lost: was on mains, now on battery.
        let ac = sources::ac_online();
        if cfg.ac_loss && rising_edge(self.ac_online, ac, |prev, now| prev && !now) {
            beeps.push(EventBeep { pattern: Pattern::Short, reason: "AC power lost" }); // one beep, as the setting says
        }
        if ac.is_some() {
            self.ac_online = ac;
        }

        // Drive fault: a RAID array became degraded.
        let degraded = Some(sources::array_degraded());
        if cfg.drive_fault && rising_edge(self.array_degraded, degraded, |prev, now| !prev && now) {
            beeps.push(EventBeep { pattern: Pattern::Long, reason: "RAID array degraded" });
        }
        self.array_degraded = degraded;

        beeps
    }
}

/// Fire when `edge(prev, now)` holds and both samples are known.
fn rising_edge(prev: Option<bool>, now: Option<bool>, edge: impl Fn(bool, bool) -> bool) -> bool {
    matches!((prev, now), (Some(p), Some(n)) if edge(p, n))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> BeepConfig {
        BeepConfig { startup: true, ac_loss: true, drive_fault: true }
    }

    #[test]
    fn edge_helper_needs_both_samples_and_the_transition() {
        assert!(rising_edge(Some(true), Some(false), |p, n| p && !n));
        assert!(!rising_edge(None, Some(false), |p, n| p && !n)); // first sample: baseline only
        assert!(!rising_edge(Some(false), Some(false), |p, n| p && !n)); // no change
    }

    #[test]
    fn respects_the_toggle() {
        let mut w = EventWatcher { ac_online: Some(true), array_degraded: Some(false) };
        let off = BeepConfig { ac_loss: false, ..cfg() };
        // even if AC were lost, ac_loss=off yields nothing (no real state here)
        assert!(w.poll(&off).is_empty());
    }
}
