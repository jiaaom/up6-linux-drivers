/* SPDX-License-Identifier: GPL-2.0 */
/*
 * Kernel-version shims. Verified build targets: 6.1 (Debian 12), 6.12
 * (Debian 13), 6.18 (fnOS).
 */
#ifndef FT8722_COMPAT_H
#define FT8722_COMPAT_H

#include <linux/version.h>

/* <asm/unaligned.h> became <linux/unaligned.h> in 6.12. */
#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 12, 0)
#include <linux/unaligned.h>
#else
#include <asm/unaligned.h>
#endif

/* i2c_driver.probe took the (client, id) signature before 6.3; probe_new is the modern one there. */
#if LINUX_VERSION_CODE < KERNEL_VERSION(6, 3, 0)
#define FT8722_I2C_PROBE .probe_new
#else
#define FT8722_I2C_PROBE .probe
#endif

#endif
