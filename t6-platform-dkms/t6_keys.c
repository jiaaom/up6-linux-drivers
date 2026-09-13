// SPDX-License-Identifier: GPL-2.0
/*
 * Front-panel buttons, polled from EC register 0x5f.
 *
 * Confirmed on hardware 2026-09-12: bit 5 = power button, bit 4 = reset
 * pinhole, both active-low (idle value 0xf2). Bits 1, 6 and 7 are the
 * vendor's board-internal test buttons and are not exposed. Taps are as
 * short as ~110 ms, so the register is sampled every 20 ms and a change
 * must be seen twice in a row.
 *
 * Keycodes: the front button is KEY_POWER, so systemd-logind applies its
 * HandlePowerKey policy (poweroff by default) to a tap - the standard
 * semantics of a power button, and the reason the device is opt-in
 * (enable_keys=1). The reset pinhole is deliberately KEY_PROG1, a neutral
 * user-defined code: KEY_RESTART would make logind reboot on a tap, while
 * the vendor's meaning is "reset password / network after a long hold",
 * which belongs in a userspace policy.
 */
#include <linux/input.h>
#include <linux/kernel.h>

#include "t6_platform.h"

#define T6_KEYS_REG		0x5f
#define T6_KEYS_POLL_MS		20

struct t6_key_desc {
	u8 mask;
	u16 code;
};

static const struct t6_key_desc t6_keymap[] = {
	{ BIT(5), KEY_POWER },		/* front power button */
	{ BIT(4), KEY_PROG1 },		/* reset pinhole: neutral, policy in userspace */
};

struct t6_keys_state {
	struct t6_platform *priv;
	u8 stable;
	u8 candidate;
	bool initialized;
};

static void t6_keys_poll(struct input_dev *input)
{
	struct t6_keys_state *state = input_get_drvdata(input);
	u8 raw, logical;
	unsigned int i;
	int ret;

	ret = t6_ec_read(state->priv, T6_KEYS_REG, &raw);
	if (ret) {
		dev_err_ratelimited(&input->dev, "EC key read failed: %d\n", ret);
		return;
	}

	/* logical: bit set = pressed */
	logical = t6_keys_active_low ? (u8)~raw : raw;
	if (!state->initialized) {
		state->stable = logical;
		state->candidate = logical;
		state->initialized = true;
		return;
	}
	if (logical != state->candidate) {
		state->candidate = logical;
		return;
	}
	if (logical == state->stable)
		return;

	state->stable = logical;
	for (i = 0; i < ARRAY_SIZE(t6_keymap); i++)
		input_report_key(input, t6_keymap[i].code,
				 !!(logical & t6_keymap[i].mask));
	input_sync(input);
}

int t6_keys_register(struct t6_platform *priv)
{
	struct t6_keys_state *state;
	struct input_dev *input;
	unsigned int i;
	int ret;

	if (!t6_keys_enabled)
		return 0;

	input = devm_input_allocate_device(&priv->pdev->dev);
	if (!input)
		return -ENOMEM;
	state = devm_kzalloc(&priv->pdev->dev, sizeof(*state), GFP_KERNEL);
	if (!state)
		return -ENOMEM;

	state->priv = priv;
	input_set_drvdata(input, state);
	input->name = "T6 front-panel buttons";
	input->phys = "t6-platform/input0";
	input->id.bustype = BUS_HOST;
	input->dev.parent = &priv->pdev->dev;
	for (i = 0; i < ARRAY_SIZE(t6_keymap); i++)
		input_set_capability(input, EV_KEY, t6_keymap[i].code);

	ret = input_setup_polling(input, t6_keys_poll);
	if (ret)
		return ret;
	input_set_poll_interval(input, T6_KEYS_POLL_MS);
	input_set_min_poll_interval(input, T6_KEYS_POLL_MS);
	input_set_max_poll_interval(input, 100);

	ret = input_register_device(input);
	if (ret)
		return ret;
	priv->keys = input;
	return 0;
}
