# focaltech-ft8722 0.1.2

`ft8722_ts`: FocalTech FT8722 touchscreen and pen driver for the ZSpace
T6/UP6/PA60 front panel. Binds the ACPI `PFT8722` I²C device, takes its
interrupt from `INTC1083:00` GPIO 107, and reports a 10-slot multitouch
device plus a stylus device. Independent of `t6-platform`.

Touch is hardware-validated; pen support follows the vendor protocol but is
untested. See `../docs/ft8722-touchscreen.md` for the protocol, the
validation record, and what was deliberately left out.

Build: `make` (or install via DKMS with `dkms.conf`). Debug: `dump_frames=1`.
