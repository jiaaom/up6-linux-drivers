//! Per-zone control: temperature filtering, piecewise-linear curve,
//! hysteresis, ramp limiting, zero-RPM stop/start and stall recovery.

/// Interpolate `temp` on a curve of `[temp_c, pwm_percent]` points sorted by
/// temperature; clamps to the end points outside the range.
pub fn interpolate(curve: &[[f64; 2]], temp: f64) -> f64 {
    let first = curve[0];
    let last = curve[curve.len() - 1];
    if temp <= first[0] {
        return first[1];
    }
    if temp >= last[0] {
        return last[1];
    }
    for w in curve.windows(2) {
        let (t0, p0, t1, p1) = (w[0][0], w[0][1], w[1][0], w[1][1]);
        if temp >= t0 && temp <= t1 {
            return p0 + (p1 - p0) * (temp - t0) / (t1 - t0);
        }
    }
    last[1]
}

/// Tuning knobs, all per zone.
#[derive(Debug, Clone, Copy)]
pub struct Params {
    /// Time constant (s) of the exponential filter on the temperature;
    /// 0 disables filtering.
    pub tau: f64,
    /// Raw temperature at or above which, once sustained for
    /// `emergency_secs`, the filter is bypassed and the fan ramps at
    /// `emergency_ramp` instead of `ramp_up`.
    pub emergency_temp: f64,
    pub emergency_secs: f64,
    pub emergency_ramp: f64,
    /// Degrees the temperature must fall below the last increase point
    /// before the duty may decrease.
    pub hysteresis: f64,
    /// Max duty change per second, percent.
    pub ramp_up: f64,
    pub ramp_down: f64,
    /// Lowest duty while running (a curve value of 0 means "stop").
    pub min_pwm: f64,
    /// Duty applied to start a stopped fan, and for how long.
    pub start_pwm: f64,
    pub kick_secs: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Event {
    None,
    Started,
    Stopped,
    StallRecovery,
}

#[derive(Debug, Default, Clone)]
pub struct Controller {
    /// Duty currently applied (percent).
    pub output: f64,
    /// Filtered temperature.
    pub filtered: Option<f64>,
    anchor: Option<f64>,
    kick_left: f64,
    zero_rpm_cycles: u32,
    hot_secs: f64,
}

impl Controller {
    /// One control step. `rpm` is the tachometer reading, if available.
    pub fn step(&mut self, curve: &[[f64; 2]], p: &Params, temp: f64, rpm: Option<u32>, dt: f64) -> (u8, Event) {
        let mut event = Event::None;

        // Temperature filtering, with an emergency bypass for sustained heat
        // (a turbo spike to the thermal limit lasts seconds and is ignored).
        self.hot_secs = if temp >= p.emergency_temp { self.hot_secs + dt } else { 0.0 };
        let emergency = temp >= p.emergency_temp && self.hot_secs >= p.emergency_secs;
        let t = if p.tau > 0.0 && !emergency {
            let f = self.filtered.unwrap_or(temp);
            let alpha = 1.0 - (-dt / p.tau).exp();
            let f = f + (temp - f) * alpha;
            self.filtered = Some(f);
            f
        } else {
            self.filtered = Some(temp);
            temp
        };

        let raw_target = interpolate(curve, t);
        let running = self.output > 0.0;
        let mut target = if raw_target <= 0.0 { 0.0 } else { raw_target.max(p.min_pwm) };

        // Hysteresis: after a rise, hold until the temperature has clearly
        // come back down from where the rise happened.
        if target > self.output {
            self.anchor = Some(t);
        } else if target < self.output {
            match self.anchor {
                Some(a) if t > a - p.hysteresis => target = self.output,
                _ => self.anchor = None,
            }
        }

        // Starting from standstill needs a kick above the running floor.
        if !running && target > 0.0 {
            self.kick_left = p.kick_secs;
            self.output = target.max(p.start_pwm);
            self.zero_rpm_cycles = 0;
            return (self.output.round() as u8, Event::Started);
        }
        if self.kick_left > 0.0 {
            self.kick_left -= dt;
            if self.kick_left <= 0.0 {
                // The kick is not a temperature-driven rise; let it decay.
                self.anchor = None;
            }
            if target > self.output {
                self.output = target.min(100.0);
            }
            return (self.output.round() as u8, Event::None);
        }

        // Stall recovery: commanded to run but the tach says otherwise.
        if running && self.output >= p.min_pwm {
            match rpm {
                Some(0) => self.zero_rpm_cycles += 1,
                _ => self.zero_rpm_cycles = 0,
            }
            if self.zero_rpm_cycles >= 3 {
                self.zero_rpm_cycles = 0;
                self.kick_left = p.kick_secs;
                self.output = self.output.max(p.start_pwm);
                return (self.output.round() as u8, Event::StallRecovery);
            }
        }

        let next = if target > self.output {
            let rate = if emergency { p.emergency_ramp } else { p.ramp_up };
            (self.output + rate * dt).min(target)
        } else {
            (self.output - p.ramp_down * dt).max(target)
        };
        // Do not linger below the running floor on the way to a stop.
        let next = if target <= 0.0 && next < p.min_pwm { 0.0 } else { next };
        if running && next <= 0.0 {
            event = Event::Stopped;
        }
        self.output = next.clamp(0.0, 100.0);
        (self.output.round() as u8, event)
    }

    /// Jump straight to `percent` (fail-safe), resetting state.
    pub fn force(&mut self, percent: u8) -> u8 {
        self.output = f64::from(percent);
        self.anchor = None;
        self.kick_left = 0.0;
        self.zero_rpm_cycles = 0;
        self.hot_secs = 0.0;
        percent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Params {
        Params { tau: 0.0, emergency_temp: 90.0, emergency_secs: 2.0, emergency_ramp: 1000.0, hysteresis: 3.0, ramp_up: 1000.0, ramp_down: 1000.0, min_pwm: 8.0, start_pwm: 12.0, kick_secs: 2.0 }
    }

    #[test]
    fn interpolates_and_clamps() {
        let c = [[40.0, 20.0], [60.0, 40.0], [80.0, 100.0]];
        assert_eq!(interpolate(&c, 30.0), 20.0);
        assert_eq!(interpolate(&c, 50.0), 30.0);
        assert_eq!(interpolate(&c, 70.0), 70.0);
        assert_eq!(interpolate(&c, 90.0), 100.0);
    }

    #[test]
    fn hysteresis_holds_then_releases() {
        let c = [[40.0, 20.0], [80.0, 100.0]];
        let p = params();
        let mut k = Controller::default();
        k.force(20);
        assert_eq!(k.step(&c, &p, 60.0, Some(1000), 1.0).0, 60);
        assert_eq!(k.step(&c, &p, 58.0, Some(1000), 1.0).0, 60); // small dip: hold
        assert_eq!(k.step(&c, &p, 56.0, Some(1000), 1.0).0, 52); // past hysteresis: follow
        assert_eq!(k.step(&c, &p, 55.0, Some(1000), 1.0).0, 50);
        assert_eq!(k.step(&c, &p, 55.0, Some(1000), 1.0).0, 50);
    }

    #[test]
    fn ramp_limits_apply() {
        let c = [[0.0, 0.0], [100.0, 100.0]];
        let p = Params { ramp_up: 10.0, ramp_down: 5.0, min_pwm: 0.0, ..params() };
        let mut k = Controller::default();
        k.force(10);
        assert_eq!(k.step(&c, &p, 80.0, Some(1000), 2.0).0, 30);
        assert_eq!(k.step(&c, &p, 80.0, Some(1000), 2.0).0, 50);
        assert_eq!(k.step(&c, &p, 20.0, Some(1000), 2.0).0, 40);
    }

    #[test]
    fn stops_kicks_and_runs_at_floor() {
        let c = [[40.0, 0.0], [45.0, 8.0], [80.0, 100.0]];
        let p = Params { ramp_down: 4.0, ..params() };
        let mut k = Controller::default();
        k.force(30);
        // cool: ramps down, then snaps to 0 instead of lingering under the floor
        assert_eq!(k.step(&c, &p, 30.0, Some(900), 1.0), (26, Event::None));
        for _ in 0..4 { k.step(&c, &p, 30.0, Some(900), 1.0); }
        assert_eq!(k.step(&c, &p, 30.0, Some(900), 1.0), (0, Event::Stopped));
        assert_eq!(k.step(&c, &p, 30.0, Some(0), 1.0), (0, Event::None));
        // warm: kick at start_pwm, hold through the kick, then settle on the curve floor
        assert_eq!(k.step(&c, &p, 45.0, Some(0), 1.0), (12, Event::Started));
        assert_eq!(k.step(&c, &p, 45.0, Some(0), 1.0).0, 12);
        assert_eq!(k.step(&c, &p, 45.0, Some(500), 1.0).0, 12);
        assert_eq!(k.step(&c, &p, 45.0, Some(500), 1.0).0, 8);
    }

    #[test]
    fn filter_delays_and_emergency_bypasses() {
        let c = [[40.0, 10.0], [90.0, 100.0]];
        let p = Params { tau: 10.0, ramp_up: 2.0, ..params() };
        let mut k = Controller::default();
        k.force(10);
        // a spike to 70 barely moves the filtered temperature in one second
        let (out, _) = k.step(&c, &p, 70.0, Some(500), 1.0);
        assert!(out <= 13, "got {out}");
        // a one-second spike to 95 is still just a spike...
        let (out, _) = k.step(&c, &p, 95.0, Some(500), 1.0);
        assert!(out <= 16, "got {out}");
        // ...but sustained, it bypasses the filter and ramps at the emergency rate
        let p2 = Params { emergency_ramp: 30.0, ..p };
        let before = k.output;
        let (o1, _) = k.step(&c, &p2, 95.0, Some(500), 1.0);
        assert_eq!(f64::from(o1), (before + 30.0).round());
        let (o2, _) = k.step(&c, &p2, 95.0, Some(500), 1.0);
        assert_eq!(f64::from(o2), (before + 60.0).round());
    }

    #[test]
    fn stall_recovery_rekicks() {
        let c = [[0.0, 20.0], [100.0, 20.0]];
        let p = params();
        let mut k = Controller::default();
        k.force(20);
        assert_eq!(k.step(&c, &p, 50.0, Some(0), 1.0).1, Event::None);
        assert_eq!(k.step(&c, &p, 50.0, Some(0), 1.0).1, Event::None);
        assert_eq!(k.step(&c, &p, 50.0, Some(0), 1.0).1, Event::StallRecovery);
    }
}
