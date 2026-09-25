#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0
"""Run production control functions against a deterministic EC register model.

The selected C sections are compiled verbatim, not reimplemented in the tests.
Kernel registration and hardware access still require separate Kbuild/live checks.
Temporary generated sources and executables are removed even on failure.
"""
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

TESTS = Path(__file__).resolve().parent
SOURCE = TESTS.parent
NAMES = ("t6_platform.h", "t6_core.c", "t6_ec.c", "t6_charge.c", "t6_leds.c", "t6_hwmon.c")
files = {name: (SOURCE / name).read_text() for name in NAMES}


def section(name, first, last):
    text = files[name]
    start = text.index(first)
    return text[start:text.index(last, start)]


def include(path):
    return "#include " + json.dumps(str(path)) + "\n"


code = include(TESTS / "model.h")
code += "\n".join(line for name in ("t6_platform.h", "t6_core.c", "t6_charge.c")
                  for line in files[name].splitlines()
                  if line.startswith("#define T6_") and not line.endswith("\\")) + "\n"
code += section("t6_platform.h", "struct t6_platform {", "\n};") + "\n};\n"
code += section("t6_ec.c", "int t6_ec_read(", "MODULE_LICENSE")
code += section("t6_core.c", "static const u8 t6_pwm_addresses", "static int t6_reboot_notify")
code += section("t6_charge.c", "static bool t6_charge_host_active", "static ssize_t charge_control_start_threshold_show")
code += section("t6_hwmon.c", "static int t6_write_pwm(", "static int t6_hwmon_read(")
code += section("t6_leds.c", "enum t6_led_mode", "static int t6_led_init")
code += section("t6_leds.c", "/* Tray breathing speed", "static DEVICE_ATTR_RW(tray_speed)")
code += include(TESTS / "regressions.c")

with TemporaryDirectory(prefix="t6-platform-tests-") as temporary:
    root = Path(temporary)
    source, executable = root / "regressions.c", root / "regressions"
    source.write_text(code)
    subprocess.run(["cc", "-std=gnu11", "-pthread", str(source), "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
