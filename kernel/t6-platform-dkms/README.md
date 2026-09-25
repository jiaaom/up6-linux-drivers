# t6-platform 0.9.14

The module exposes three labelled fan RPM/PWM channels and four EC
temperature sensors through hwmon
(`fan1` SSD bays 1–2, `fan2` SSD bays 3–6, `fan3` CPU; `pwmN` 0–255,
`pwmN_enable` 1 = manual host PWM, 0 = shared full-speed safety mode), the LCD backlight `t6_ec_backlight`,
system/bay/RGB/battery EC LEDs, Bluetooth and Wi-Fi GPIO LEDs, a root-only `beep` attribute, the front power button (`KEY_SCREENLOCK` on the
"T6 front-panel buttons" input device, from EC query event `0x40`, about 1 s
after release; see `../docs/power-button-ec-event.md`), and read-only battery telemetry under the
platform device's `battery/` group.

Fan PWM, backlight and LED writes only take effect while EC register `0x59`
bit 3 is set. The driver owns that gate while loaded, serializes fan/LED
transactions, and parks every fan at `init_pwm_percent` (default 50 %) before
returning the gate to the EC on unload, reboot, suspend, or failed probe. A
userspace fan policy may use `pwmN_enable=1` and write PWM values; `0` forces
all channels to full speed and rejects lower PWM writes until manual mode is
re-enabled. There is no EC/automatic `pwmN_enable=2` mode. See
`../docs/ec-host-control-and-fans.md` for the mechanism, the apply-on-change
behaviour, the physical fan mapping, and the register bits that must never be
touched.

Battery fields use explicit units: deci-kelvin, mAh, mV, raw current, cell mV,
percent, and raw EC status bytes. The standard ACPI `BAT0` interface remains
the primary battery API. The driver adds the standard
`charge_control_start_threshold` / `charge_control_end_threshold` attributes
to `BAT0` (default `0/100` = EC policy; see
`../docs/battery-charge-control.md`). No other battery-control writes are
performed. The battery LED turns red on battery below 10 % (EC state of
charge), with or without a band, and goes back to the EC on AC.

All EC operations are mutex-protected and return transport errors. Probe
writes only the three fan PWM registers, `0x59` bit 3, and clears `0x57`
bits 5/6. Suspend and removal quiesce user operations before restoring EC
charge policy and parking fans.
