// SPDX-License-Identifier: GPL-2.0
/*
 * Front power button, from EC query event 0x40.
 *
 * The EC raises an SCI for every press of the front power button and
 * answers QR_EC with 0x40 - about 1.0 s after the button is *released*,
 * whether it was tapped or held (measured 2026-09-24). The firmware has no
 * _Q40 method, so without this handler the kernel drops the event. We claim
 * it and report one tap (down + up) per event: nothing is polled, at the
 * cost of that ~1 s delay and of not knowing how long the button was held.
 * The live button state is still in EC register 0x5f (bit 5, active-low;
 * bit 4 is the reset pinhole, which raises no event), should this ever need
 * to become a poll.
 *
 * The key is KEY_SCREENLOCK, not KEY_POWER: the button works like a phone's
 * side button (t6-ledd switches the screen on and off; a desktop locks its
 * session), and logind never treats it as a power switch, so a tap can not
 * power the NAS off.
 */
#include <linux/acpi.h>
#include <linux/input.h>
#include <linux/kernel.h>

#include "t6_platform.h"

#define T6_KEYS_QUERY		0x40

/*
 * EC query handlers (drivers/acpi/ec.c). Exported, but declared only in the
 * kernel-internal drivers/acpi/internal.h.
 */
struct acpi_ec;
typedef int (*acpi_ec_query_func)(void *data);
extern struct acpi_ec *first_ec;
int acpi_ec_add_query_handler(struct acpi_ec *ec, u8 query_bit,
			      acpi_handle handle, acpi_ec_query_func func,
			      void *data);
void acpi_ec_remove_query_handler(struct acpi_ec *ec, u8 query_bit);

/* Runs from the EC's query work item. */
static int t6_keys_query(void *data)
{
	struct input_dev *input = data;

	input_report_key(input, KEY_SCREENLOCK, 1);
	input_sync(input);
	input_report_key(input, KEY_SCREENLOCK, 0);
	input_sync(input);
	return 0;
}

int t6_keys_register(struct t6_platform *priv)
{
	struct input_dev *input;
	int ret;

	if (!first_ec) {
		dev_warn(&priv->pdev->dev, "no ACPI EC: front power button unavailable\n");
		return 0;
	}

	input = devm_input_allocate_device(&priv->pdev->dev);
	if (!input)
		return -ENOMEM;
	input->name = "T6 front-panel buttons";
	input->phys = "t6-platform/input0";
	input->id.bustype = BUS_HOST;
	input->dev.parent = &priv->pdev->dev;
	input_set_capability(input, EV_KEY, KEY_SCREENLOCK);
	ret = input_register_device(input);
	if (ret)
		return ret;

	ret = acpi_ec_add_query_handler(first_ec, T6_KEYS_QUERY, NULL,
					t6_keys_query, input);
	if (ret)
		return ret;
	priv->keys = input;
	return 0;
}

/* Before the input device goes away; waits for a running handler. */
void t6_keys_unregister(struct t6_platform *priv)
{
	if (!priv->keys)
		return;
	acpi_ec_remove_query_handler(first_ec, T6_KEYS_QUERY);
	priv->keys = NULL;
}
