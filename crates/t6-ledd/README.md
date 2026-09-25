# t6-ledd

Indicator daemon for the T6: the single owner of the `t6:*` LEDs and the
beeper. Rust, no runtime dependencies.

## Behaviour

- Devices: power button, bays 1–6, tray light (RGB), Bluetooth, Wi-Fi,
  battery. Each is `auto` (a rule evaluated every 2 s) or `manual` (a
  fixed colour). Auto rules: power button dark while the screen is on,
  white while it is off, red blink when overheating (below); bay white while a drive is
  installed (PCIe root-port presence); Bluetooth and Wi-Fi show their
  status (below);
  tray light: manual only, off by default (a colour breathes, two cycle,
  all three is a rainbow; its speed is slow/normal/fast via `tray_speed`); battery left to
  the driver's charge control (dark on mains, orange on battery, red on
  battery below 10 %; shown in night mode too).
- Wi-Fi LED (`src/wifi.rs`), for whichever Wi-Fi card is fitted (no
  interface name or PCI address is assumed; the card is replaceable):

  | LED | state |
  |---|---|
  | blue | connected, internet reachable |
  | cyan | connected, signal below -75 dBm (blue again above -70) |
  | cyan, slow blink | NetworkManager is connecting (at most 60 s) |
  | blue heartbeat | this machine is a Wi-Fi hotspot |
  | yellow | connected but not usable: no IP, captive portal, no internet |
  | red | fault: card without driver, driver without interface (firmware), hard-blocked, card unavailable, NetworkManager down for 20 s |
  | off | switched off, no Wi-Fi card, no Wi-Fi network saved, or no saved network in range |

  Sources: sysfs (interfaces, PCI class 0x0280 controllers, rfkill,
  `/proc/net/wireless`) and NetworkManager (`nmcli`, queried every 10 s
  and on every `nmcli monitor` event). Working states show at once;
  yellow waits 5 s and red 10 s (and never in the first 60 s after boot),
  so scans and blips do not flash the LED. `wifi_hotspot = false` keeps
  the LED dark while this machine is a hotspot. The reason is in `status.json` (`wifi`) and in the Control
  Center. `T6_LEDD_FAKE_WIFI=<state>` forces a state for testing.
- Power button LED (`src/power.rs`): dark while the LCD backlight is on
  (the screen already shows the machine is on), white while it is off or
  when there is no backlight; red blink (1 Hz) when overheating, over the
  screen rule and in night mode. Overheat: CPU package ≥ 95 °C for 30 s or
  ≥ 105 °C at once; an NVMe drive over its own `temp1_max` for 30 s or at
  its `temp1_crit` at once (80/85 °C when a drive reports none); clears
  5 °C under the threshold. The backlight is checked every 250 ms (cached
  sysfs values, no EC access). `T6_LEDD_FAKE_OVERHEAT=1` forces the alarm.
  White is what the LED is left at when the daemon exits.
- Bluetooth LED (`src/bluetooth.rs`), from the kernel only (works with
  or without BlueZ; any adapter, no USB port assumed):

  | LED | state |
  |---|---|
  | blue heartbeat | discoverable (pairing) |
  | blue | at least one device connected |
  | red | fault: USB Bluetooth device without driver, driver without adapter (firmware), hard-blocked |
  | off | idle, adapter powered off (no BlueZ), switched off, or no adapter |

  Sources: `/sys/class/bluetooth` (adapters `hciN`, connections
  `hciN:handle`), the HCIGETDEVINFO ioctl (up/discoverable flags), USB
  interfaces of class e0/01/01, rfkill. Red waits 10 s (never in the first
  60 s after boot). `T6_LEDD_FAKE_BT=<state>` forces a state for testing.
- Wi-Fi and Bluetooth LED modes: `auto` (every state), `quiet` (alerts
  only: dark while online / weak signal, or while a Bluetooth device is
  connected; every other state as in `auto`) and `off` (manual). A fault
  is red in every mode, night mode included. Fresh installs use `quiet`;
  a configuration without an entry (an upgrade) keeps `auto`.
- Status LEDs (power, Wi-Fi, Bluetooth) offer only `off` as a manual
  setting; a fixed colour saved by an older version goes back to `auto`.
  The tray light has no automatic mode; `auto` saved by an older version
  becomes off.
- `bays_enabled = false` switches the six bay LEDs off regardless of mode.
- Night mode (manual, or a daily `HH:MM-HH:MM` schedule) switches every
  LED off except the battery LED and alarms (overheat, drive, Wi-Fi,
  Bluetooth faults).
- Control socket `/run/t6-ledd/ctl`: one line per connection, e.g.
  `set rgb blue`, `set bay6 auto`, `set wifi quiet`, `wifi-hotspot off`,
  `bays off`, `tray-speed fast`, `night on`,
  `schedule 23:00-07:00`, `schedule off`, `beep 1`, `reload`, `status`.
  Settings changed this way are saved to `/etc/t6-ledd.toml`, the only
  writer of which is the daemon. Live state: `/run/t6-ledd/status.json`.
- A short beep sounds once per boot (`startup_beep`, default on), matching
  the stock firmware; upgrades and reloads are silent (a `/run` marker,
  cleared only on reboot). Control command: `startup-beep on|off`.
- On exit the LEDs are left in their automatic state and the beeper is
  silenced.

## Install

```
cargo build --release
sudo install -m 755 ../target/release/t6-ledd /usr/sbin/t6-ledd
sudo install -m 644 t6-ledd.toml /etc/t6-ledd.toml
sudo install -m 644 t6-ledd.service /etc/systemd/system/t6-ledd.service
sudo systemctl daemon-reload && sudo systemctl enable --now t6-ledd
```
