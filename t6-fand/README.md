# t6-fand 0.1.0

Userspace fan policy daemon, in Rust with no runtime
dependencies. It drives the `t6_platform` hwmon PWM channels from
temperature curves and works on any board whose fans and sensors follow the
standard hwmon layout.

## Behaviour

- Three zones by default: `cpu` (CPU fan ← `coretemp` package), `ssd12`
  (bay 1–2 fan ← NVMe in bays 1–2), `ssd36` (bay 3–6 fan ← NVMe in bays
  3–6). Fans are matched by `fanN_label`, sensors by `tempN_label`, NVMe
  bays by their PCIe root port; empty bays are skipped.
- Per zone: piecewise-linear curve per profile (`silent`, `balance`,
  `performance`), low-pass filtered temperature (`tau_secs`), hysteresis on
  the way down, ramp-rate limits, running floor (`min_pwm`).
- Zero-RPM: a curve value of 0 stops the fan; it restarts with a
  `start_pwm` kick for `kick_secs` (measured on the T6: fans run down to
  6 %, stop at 4 %, start at 8–10 %; the EC does not object to 0 rpm). A
  fan commanded to run but reading 0 rpm for three cycles is re-kicked.
- Emergency path: once the raw temperature has stayed at or above
  `emergency_temp` for `emergency_secs`, the filter is bypassed and the fan
  ramps at `emergency_ramp` %/s. Meteor Lake turbos to its 100 °C limit
  within seconds of any load and throttles itself there, so this is a
  safety net for sustained heat, not the normal path.
- Fail-safe: a zone whose sensors cannot be read gets `failsafe_pwm`; on
  exit every fan is parked at `failsafe_pwm`; if the daemon is not running at
  all the driver's own 50 % default applies.
- Runtime: `echo silent > /run/t6-fand/profile` switches profile until the
  file is removed; `systemctl reload t6-fand` re-reads the config; live
  state is in `/run/t6-fand/status.json` (JSON, rewritten every cycle) for
  any UI to consume. `t6-fand --check` validates a config against the
  running system without touching a fan.

## Install

```
cargo build --release
sudo install -m 755 target/release/t6-fand /usr/sbin/t6-fand
sudo install -m 644 t6-fand.toml /etc/t6-fand.toml
sudo install -m 644 t6-fand.service /etc/systemd/system/t6-fand.service
sudo systemctl daemon-reload && sudo systemctl enable --now t6-fand
```

## Measured on the T6 (2026-09-13, `balance`)

Idle: CPU 49 °C → 8 % / 474 rpm; bays ~40 °C → 8 % / ~850 rpm (they stop
below 38 °C, or 42 °C on `silent`). A 4-thread load pins the die at 100 °C
within 3 s; the fan ramps 8 → 14 → 23 → 30 → 51 → 80 → 100 % over ~20 s
and returns 100 → 76 → 53 → 9 → 8 % over ~90 s after the load ends. The
curves in `t6-fand.toml` are a starting point, not a tuned result.
