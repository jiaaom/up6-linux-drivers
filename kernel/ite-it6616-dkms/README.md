# ite-it6616 0.1.1

`ite_it6616` is the Linux I2C driver for the ITE IT6616 HDMI-to-MIPI DSI bridge that feeds the ZSpace T6/UP6/PA60 front-panel LCD. It binds the ACPI `ITE6616` device at HDMI address `0x48`, creates a managed dummy client at `0x56`, and leaves the firmware's bridge and panel initialization untouched. The driver is built as a composite module from `it6616-core.c`, `it6616-status.c`, and `it6616-panel.c`, with shared declarations in the private `it6616.h` header.

The driver reports HDMI link status, measured timing, MIPI lane/format status, and the recorded panel state through sysfs. It supports bridge-level HDMI mute and all six tested DCS display/sleep transitions. A failed packet is never reported as successful: if the bridge may have accepted a command but completion is uncertain, `panel` reports `unknown` and the next explicit panel request performs a conservative wake/recovery sequence. DCS reads and DRM modeset integration are intentionally not implemented because this hardware does not return DCS read data and i915 does not call external bridges on this platform.

Build the module with:

```text
make
```

The DKMS package is installed together with the other T6 kernel modules by `packaging/install-dkms.sh`. The ACPI modalias autoloads `ite_it6616`; no `modules-load.d` entry is required for this module.

Useful runtime paths after binding:

```text
/sys/bus/i2c/devices/i2c-ITE6616:00/link_status
/sys/bus/i2c/devices/i2c-ITE6616:00/timings
/sys/bus/i2c/devices/i2c-ITE6616:00/mipi
/sys/bus/i2c/devices/i2c-ITE6616:00/panel
/sys/bus/i2c/devices/i2c-ITE6616:00/mute
```

The write-only debugfs DCS file is available at `/sys/kernel/debug/it6616/dcs` for hardware experiments only. It tracks the four power-state commands, rejects a raw sleep-out that would bypass the required delay, and stops accepting writes before removal/shutdown restoration. Regmap debugfs dumps are read-only; HDMI accesses are serialized and restore bank 0 after every operation, while MIPI LP FIFO/command registers are hidden as precious registers so a dump cannot consume or fire the command engine.

System suspend does not touch the bridge. On resume the panel state is reported as `unknown`, because this hardware has no usable DCS read path and PM may reset either block; an explicit `panel=on`, `off`, or `sleep` request recovers it conservatively.
