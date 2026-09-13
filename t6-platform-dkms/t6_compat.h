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

/* devm_battery_hook_register() arrived in 6.10. */
#if LINUX_VERSION_CODE < KERNEL_VERSION(6, 10, 0)
#include <linux/device.h>

static inline void t6_battery_hook_unregister_action(void *hook)
{
	battery_hook_unregister(hook);
}

static inline int devm_battery_hook_register(struct device *dev,
					     struct acpi_battery_hook *hook)
{
	battery_hook_register(hook);
	return devm_add_action_or_reset(dev, t6_battery_hook_unregister_action,
					hook);
}
#endif

#endif
