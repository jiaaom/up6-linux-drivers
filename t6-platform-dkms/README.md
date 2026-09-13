# t6-platform 0.9.8

The module exposes three labelled fan RPM/PWM channels and four EC
temperature sensors through hwmon
(`fan1` SSD bays 1–2, `fan2` SSD bays 3–6, `fan3` CPU; `pwmN` 0–255,
`pwmN_enable` 1 = host, 2 = EC), the LCD backlight `t6_ec_backlight`,
system/bay/RGB/battery EC LEDs, Bluetooth and Wi-Fi GPIO LEDs, a root-only `beep` attribute, optional front-panel buttons (power → `KEY_POWER`, reset pinhole →
`KEY_PROG1`; `enable_keys=1`), and read-only battery telemetry under the platform device's
`battery/` group.

Fan PWM, backlight and LED writes only take effect while EC register `0x59`
bit 3 is set. The driver sets it at probe (after parking all fans at
`init_pwm_percent`, default 50 %) and clears it again on unload, reboot, and
poweroff. While the module is loaded the EC performs no thermal management;
a userspace fan policy is required for sustained load. See
`../docs/ec-host-control-and-fans.md` for the mechanism, the apply-on-change
behaviour, the physical fan mapping, and the register bits that must never
be touched.

Battery fields use explicit units: deci-kelvin, mAh, mV, raw current, cell mV,
percent, and raw EC status bytes. The standard ACPI `BAT0` interface remains
the primary battery API. The driver adds the standard
`charge_control_start_threshold` / `charge_control_end_threshold` attributes
to `BAT0` (default `0/100` = EC policy; see
`../docs/battery-charge-control.md`). No other battery-control writes are
performed.

All EC operations are mutex-protected and return transport errors. Probe
writes only the three fan PWM registers, `0x59` bit 3, and clears `0x57`
bits 5/6.
