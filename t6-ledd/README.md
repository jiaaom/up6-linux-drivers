# t6-ledd 0.1.0

Indicator daemon for the T6: the single owner of the `t6:*` LEDs and the
beeper. Rust, no runtime dependencies.

## Behaviour

- Devices: power button, bays 1–6, tray light (RGB), Bluetooth, Wi-Fi,
  battery. Each is `auto` (a rule evaluated every 2 s) or `manual` (a
  fixed colour). Auto rules: power white; bay white while a drive is
  installed (PCIe root-port presence); Bluetooth blue while an adapter is
  present and not rfkill-blocked; Wi-Fi blue while a wireless link is up;
  tray light breathing (EC pattern); battery left to the driver's charge
  control (dark on mains, orange on battery).
- `bays_enabled = false` switches the six bay LEDs off regardless of mode.
- Night mode (manual, or a daily `HH:MM-HH:MM` schedule) switches every
  LED off except the battery LED.
- Control socket `/run/t6-ledd/ctl`: one line per connection, e.g.
  `set rgb blue`, `set bay6 auto`, `bays off`, `night on`,
  `schedule 23:00-07:00`, `schedule off`, `beep 1`, `reload`, `status`.
  Settings changed this way are saved to `/etc/t6-ledd.toml`, the only
  writer of which is the daemon. Live state: `/run/t6-ledd/status.json`.
- On exit the LEDs are left in their automatic state and the beeper is
  silenced.

## Install

```
cargo build --release
sudo install -m 755 target/release/t6-ledd /usr/sbin/t6-ledd
sudo install -m 644 t6-ledd.toml /etc/t6-ledd.toml
sudo install -m 644 t6-ledd.service /etc/systemd/system/t6-ledd.service
sudo systemctl daemon-reload && sudo systemctl enable --now t6-ledd
```
