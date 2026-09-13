# Linux Driver for UnifyDrive UP6

Drivers for UnifyDrive UP6 (also labeled as T6 or PA60).
Allows you to run generic Linux kernel on it.

This package contains Dynamic Kernel Module Support (DKMS) out-of-tree modules including LED, button, beeper, backlight, fan, and touch screen support.

Tested on x86-64 Debian 12.

## Two DKMS packages

| package | module | covers |
|---|---|---|
| [`t6-platform-dkms/`](t6-platform-dkms/) | `t6_platform` | EC: fans and temperatures (hwmon), LCD backlight, all LEDs (EC + GPIO), beeper, front-panel keys, battery telemetry and charge thresholds |
| [`focaltech-ft8722-dkms/`](focaltech-ft8722-dkms/) | `ft8722_ts` | front-panel touchscreen |


## Optional userspace helpers

| package | module | covers |
|---|---|---|
| [`t6-fand/`](t6-fand/) | `t6 fan daemon` | fan policy daemon on top of the hwmon interface: profiles, curves, fail-safe |


## Dependencies

For DKMS:

```bash
sudo apt install dkms build-essential linux-headers-$(uname -r)
```
For userspace daemon:

`t6-fand` needs a Rust toolchain to build (`cargo`, via [rustup](https://rustup.rs)).

## Installation (DKMS)

```bash
sudo ./install-dkms.sh
```

## Notes

### Safety for other machines

- **Kernels**: both packages build warning-free against 6.1 (Debian 12), 6.12 (Debian 13) and 6.18 (fnOS).
- **Hardware gate**: both modules refuse to load unless DMI reports `Insyde` / `MeteorLake` / BIOS version `T6MTLJKJBOXV*`. The global UP6/PA60 ships the same BIOS image, so it is covered. Other boards can be added to its DMI table together with their IRQ line.
- Both accept `force=1` to bypass the gate for testing an unknown board.

--------

<p align="center"><img src="assets/product-up6.jpg" alt="UnifyDrive UP6" width="320"></p>
