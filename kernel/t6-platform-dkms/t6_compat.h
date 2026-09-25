/* SPDX-License-Identifier: GPL-2.0 */
/*
 * Kernel-version shims. Verified build targets: 6.1 (Debian 12), 6.12
 * (Debian 13), 6.18 (fnOS). Boundaries for intermediate versions follow the
 * upstream commits and are not individually tested.
 */
#ifndef T6_COMPAT_H
#define T6_COMPAT_H

#include <linux/version.h>
#include <acpi/battery.h>

/* ACPI battery hook callbacks gained the hook argument in 6.9. */
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 9, 0)
#define T6_BATTERY_HOOK_ARG , struct acpi_battery_hook *hook
#else
#define T6_BATTERY_HOOK_ARG
#endif


/* platform_driver.remove became void in the 6.11 driver-core API. */
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 11, 0)
#define T6_PLATFORM_REMOVE_RET void
#define T6_PLATFORM_REMOVE_RETURN() return
#else
#define T6_PLATFORM_REMOVE_RET int
#define T6_PLATFORM_REMOVE_RETURN() return 0
#endif
#endif
