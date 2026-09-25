// SPDX-License-Identifier: GPL-2.0
/* Tested DCS command engine, panel state transitions and raw debugfs access. */
#include <linux/capability.h>
#include <linux/debugfs.h>
#include <linux/delay.h>
#include <linux/device.h>
#include <linux/fs.h>
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/regmap.h>
#include <linux/slab.h>
#include <linux/uaccess.h>

#include "it6616.h"

const char *it6616_panel_state_name(enum it6616_panel_state state)
{
	switch (state) {
	case IT6616_PANEL_ON:
		return "on";
	case IT6616_PANEL_OFF:
		return "off";
	case IT6616_PANEL_SLEEP:
		return "sleep";
	default:
		return "unknown";
	}
}

static const u32 it6616_ecc_masks[6] = {
	BIT(0) | BIT(1) | BIT(2) | BIT(4) | BIT(5) | BIT(7) |
	BIT(10) | BIT(11) | BIT(13) | BIT(16) | BIT(20) | BIT(21) |
	BIT(22) | BIT(23),
	BIT(0) | BIT(1) | BIT(3) | BIT(4) | BIT(6) | BIT(8) |
	BIT(10) | BIT(12) | BIT(14) | BIT(17) | BIT(20) | BIT(21) |
	BIT(22) | BIT(23),
	BIT(0) | BIT(2) | BIT(3) | BIT(5) | BIT(6) | BIT(9) |
	BIT(11) | BIT(12) | BIT(15) | BIT(18) | BIT(20) | BIT(21) |
	BIT(22),
	BIT(1) | BIT(2) | BIT(3) | BIT(7) | BIT(8) | BIT(9) |
	BIT(13) | BIT(14) | BIT(15) | BIT(19) | BIT(20) | BIT(21) |
	BIT(23),
	BIT(4) | BIT(5) | BIT(6) | BIT(7) | BIT(8) | BIT(9) |
	BIT(16) | BIT(17) | BIT(18) | BIT(19) | BIT(20) | BIT(22) |
	BIT(23),
	BIT(10) | BIT(11) | BIT(12) | BIT(13) | BIT(14) | BIT(15) |
	BIT(16) | BIT(17) | BIT(18) | BIT(19) | BIT(21) | BIT(22) |
	BIT(23),
};

static u8 it6616_dcs_ecc(u32 header)
{
	u8 ecc = 0;
	int i;

	for (i = 0; i < ARRAY_SIZE(it6616_ecc_masks); i++)
		ecc |= (hweight32(header & it6616_ecc_masks[i]) & 1) << i;
	return ecc;
}

/*
 * Send one packet.  @may_have_sent is set before FIRE, because an I2C error
 * on FIRE or any later poll cannot prove that the panel did not accept it.
 */
static int it6616_dcs_short_locked(struct it6616 *it, u8 dt, u8 p0, u8 p1,
				   bool *may_have_sent)
{
	unsigned int tx, fifo, error;
	unsigned int saved[3];
	ktime_t deadline, now;
	s64 remaining;
	u32 header;
	u8 packet[4];
	int i, ret, restore_ret = 0;

	*may_have_sent = false;
	if (dt != 0x05 && dt != 0x15)
		return -EINVAL;

	ret = regmap_read(it->mipi, IT6616_MIPI_TX_STS, &tx);
	if (ret)
		return ret;
	if (!(tx & BIT(6)))
		return -EBUSY;

	for (i = 0; i < ARRAY_SIZE(saved); i++) {
		ret = regmap_read(it->mipi, IT6616_MIPI_LP_CFG0 + i, &saved[i]);
		if (ret)
			return ret;
	}

	ret = regmap_update_bits(it->mipi, IT6616_MIPI_LP_FIFO_CTL,
				 BIT(0) | BIT(1), BIT(0) | BIT(1));
	if (ret)
		goto restore;
	ret = regmap_update_bits(it->mipi, IT6616_MIPI_LP_FIFO_CTL,
				 BIT(0) | BIT(1), 0);
	if (ret)
		goto restore;
	ret = regmap_write(it->mipi, IT6616_MIPI_LP_CFG0, 0x00);
	if (ret)
		goto restore;
	ret = regmap_write(it->mipi, IT6616_MIPI_LP_CFG1, 0x10);
	if (ret)
		goto restore;
	ret = regmap_write(it->mipi, IT6616_MIPI_LP_CFG2, 0x90);
	if (ret)
		goto restore;

	header = dt | ((u32)p0 << 8) | ((u32)p1 << 16);
	packet[0] = dt;
	packet[1] = p0;
	packet[2] = p1;
	packet[3] = it6616_dcs_ecc(header);
	for (i = 0; i < ARRAY_SIZE(packet); i++) {
		ret = regmap_write(it->mipi, IT6616_MIPI_LP_CMD, packet[i]);
		if (ret)
			goto restore;
	}
	ret = regmap_write(it->mipi, IT6616_MIPI_LP_COUNT, 4);
	if (ret)
		goto restore;

	/* FIRE may have reached the bridge even if the transfer reports an error. */
	*may_have_sent = true;
	ret = regmap_write(it->mipi, IT6616_MIPI_LP_FIRE, 0x87);
	if (ret)
		goto restore;

	deadline = ktime_add_ms(ktime_get(), IT6616_DCS_TIMEOUT_MS);
	for (;;) {
		ret = regmap_read(it->mipi, IT6616_MIPI_LP_FIFO_STS, &fifo);
		if (ret)
			goto restore;
		ret = regmap_read(it->mipi, IT6616_MIPI_LP_FIFO_ERR, &error);
		if (ret)
			goto restore;
		if (!(fifo & GENMASK(3, 0)) && !error) {
			ret = 0;
			break;
		}

		now = ktime_get();
		if (ktime_compare(now, deadline) >= 0) {
			ret = -ETIMEDOUT;
			goto restore;
		}
		remaining = ktime_ms_delta(deadline, now);
		if (remaining <= 0) {
			ret = -ETIMEDOUT;
			goto restore;
		}
		msleep((unsigned int)min_t(s64, remaining, IT6616_DCS_POLL_MS));
	}

restore:
	for (i = 0; i < ARRAY_SIZE(saved); i++) {
		int current_ret;

		current_ret = regmap_write(it->mipi, IT6616_MIPI_LP_CFG0 + i,
					   saved[i]);
		if (current_ret && !restore_ret)
			restore_ret = current_ret;
	}
	if (ret)
		return ret;
	return restore_ret;
}

static void it6616_panel_unknown_locked(struct it6616 *it)
{
	it->panel_state = IT6616_PANEL_UNKNOWN;
	/* A failed packet may have been sleep-in; make the next wake conservative. */
	it->sleep_in_time = ktime_get();
}

static int it6616_send_dcs_locked(struct it6616 *it, u8 dt, u8 p0, u8 p1,
				  bool *may_have_sent)
{
	int ret;

	ret = it6616_dcs_short_locked(it, dt, p0, p1, may_have_sent);
	if (ret && *may_have_sent)
		it6616_panel_unknown_locked(it);
	return ret;
}

static int it6616_wait_after_sleep_locked(struct it6616 *it)
{
	s64 elapsed, remaining;

	if (!it->sleep_in_time)
		return 0;
	elapsed = ktime_ms_delta(ktime_get(), it->sleep_in_time);
	remaining = IT6616_SLEEP_MIN_MS - elapsed;
	if (remaining > 0)
		msleep(remaining);
	return 0;
}

static int it6616_wake_from_sleep_locked(struct it6616 *it)
{
	bool sent;
	int ret;

	ret = it6616_wait_after_sleep_locked(it);
	if (ret)
		return ret;
	ret = it6616_send_dcs_locked(it, 0x05, 0x11, 0, &sent);
	if (ret)
		return ret;
	msleep(IT6616_WAKE_SETTLE_MS);
	it->sleep_in_time = 0;
	it->panel_state = IT6616_PANEL_OFF;
	return 0;
}

/* Recover only on an explicit new panel request; never roll back a failed step. */
static int it6616_recover_unknown_locked(struct it6616 *it,
					 enum it6616_panel_state target)
{
	bool sent;
	int ret;

	ret = it6616_wait_after_sleep_locked(it);
	if (ret)
		return ret;
	ret = it6616_send_dcs_locked(it, 0x05, 0x11, 0, &sent);
	if (ret)
		return ret;
	msleep(IT6616_WAKE_SETTLE_MS);
	it->sleep_in_time = 0;

	/* Sleep-out does not prove the display bit; explicitly turn it off. */
	ret = it6616_send_dcs_locked(it, 0x05, 0x28, 0, &sent);
	if (ret)
		return ret;
	it->panel_state = IT6616_PANEL_OFF;
	if (target == IT6616_PANEL_OFF)
		return 0;
	if (target == IT6616_PANEL_ON) {
		ret = it6616_send_dcs_locked(it, 0x05, 0x29, 0, &sent);
		if (!ret)
			it->panel_state = IT6616_PANEL_ON;
		return ret;
	}

	msleep(20);
	ret = it6616_send_dcs_locked(it, 0x05, 0x10, 0, &sent);
	if (!ret) {
		it->sleep_in_time = ktime_get();
		it->panel_state = IT6616_PANEL_SLEEP;
	}
	return ret;
}

int it6616_set_panel_state_locked(struct it6616 *it,
					 enum it6616_panel_state target)
{
	bool sent;
	int ret;

	if (target == it->panel_state)
		return 0;
	if (it->panel_state == IT6616_PANEL_UNKNOWN)
		return it6616_recover_unknown_locked(it, target);

	switch (it->panel_state) {
	case IT6616_PANEL_ON:
		if (target == IT6616_PANEL_OFF) {
			ret = it6616_send_dcs_locked(it, 0x05, 0x28, 0, &sent);
			if (!ret)
				it->panel_state = IT6616_PANEL_OFF;
			return ret;
		}
		ret = it6616_send_dcs_locked(it, 0x05, 0x28, 0, &sent);
		if (ret)
			return ret;
		it->panel_state = IT6616_PANEL_OFF;
		msleep(20);
		ret = it6616_send_dcs_locked(it, 0x05, 0x10, 0, &sent);
		if (!ret) {
			it->sleep_in_time = ktime_get();
			it->panel_state = IT6616_PANEL_SLEEP;
		}
		return ret;

	case IT6616_PANEL_OFF:
		if (target == IT6616_PANEL_ON) {
			ret = it6616_send_dcs_locked(it, 0x05, 0x29, 0, &sent);
			if (!ret)
				it->panel_state = IT6616_PANEL_ON;
			return ret;
		}
		ret = it6616_send_dcs_locked(it, 0x05, 0x10, 0, &sent);
		if (!ret) {
			it->sleep_in_time = ktime_get();
			it->panel_state = IT6616_PANEL_SLEEP;
		}
		return ret;

	case IT6616_PANEL_SLEEP:
		ret = it6616_wake_from_sleep_locked(it);
		if (ret)
			return ret;
		if (target == IT6616_PANEL_OFF)
			return 0;
		ret = it6616_send_dcs_locked(it, 0x05, 0x29, 0, &sent);
		if (!ret)
			it->panel_state = IT6616_PANEL_ON;
		return ret;

	default:
		return -EINVAL;
	}
}

/* Keep the software state coherent for raw DCS experiments as well. */
static int it6616_debugfs_dcs_locked(struct it6616 *it, u8 dt, u8 p0, u8 p1)
{
	enum it6616_panel_state old = it->panel_state;
	bool sent;
	int ret;

	if (dt != 0x05) {
		if (p0 == 0x10 || p0 == 0x11 || p0 == 0x28 || p0 == 0x29)
			return -EINVAL;
		return it6616_send_dcs_locked(it, dt, p0, p1, &sent);
	}

	switch (p0) {
	case 0x28:
		ret = it6616_send_dcs_locked(it, dt, p0, p1, &sent);
		if (!ret && old != IT6616_PANEL_UNKNOWN &&
		    old != IT6616_PANEL_SLEEP)
			it->panel_state = IT6616_PANEL_OFF;
		return ret;
	case 0x29:
		if (old == IT6616_PANEL_SLEEP)
			return -EPERM;
		if (old == IT6616_PANEL_UNKNOWN)
			return -EAGAIN;
		ret = it6616_send_dcs_locked(it, dt, p0, p1, &sent);
		if (!ret)
			it->panel_state = IT6616_PANEL_ON;
		return ret;
	case 0x10:
		if (old == IT6616_PANEL_ON)
			return -EINVAL;
		if (old == IT6616_PANEL_SLEEP)
			return -EALREADY;
		if (old == IT6616_PANEL_UNKNOWN)
			return -EAGAIN;
		ret = it6616_send_dcs_locked(it, dt, p0, p1, &sent);
		if (!ret) {
			it->sleep_in_time = ktime_get();
			it->panel_state = IT6616_PANEL_SLEEP;
		}
		return ret;
	case 0x11:
		if (old != IT6616_PANEL_SLEEP)
			return -EINVAL;
		return it6616_wake_from_sleep_locked(it);
	default:
		return it6616_send_dcs_locked(it, dt, p0, p1, &sent);
	}
}

static ssize_t it6616_debugfs_dcs_write(struct file *file,
					const char __user *user_buf, size_t count,
					loff_t *ppos)
{
	struct it6616 *it = file_inode(file)->i_private;
	char *buf;
	unsigned int dt, p0, p1 = 0;
	int fields, ret;

	if (!capable(CAP_SYS_ADMIN))
		return -EPERM;
	if (!count || count > 32)
		return -EINVAL;
	buf = memdup_user_nul(user_buf, count);
	if (IS_ERR(buf))
		return PTR_ERR(buf);

	fields = sscanf(buf, "%x %x %x", &dt, &p0, &p1);
	kfree(buf);
	if (fields != 2 && fields != 3)
		return -EINVAL;
	if (dt > 0xff || p0 > 0xff || p1 > 0xff)
		return -EINVAL;
	if (dt == 0x05 && fields != 2)
		return -EINVAL;
	if (dt == 0x15 && fields != 3)
		return -EINVAL;
	if (dt != 0x05 && dt != 0x15)
		return -EINVAL;

	mutex_lock(&it->lock);
	if (it->debugfs_stopped || it->tearing_down || it->suspended)
		ret = -EAGAIN;
	else if (!it->mipi_compatible)
		ret = -ENODEV;
	else
		ret = it6616_debugfs_dcs_locked(it, dt, p0, p1);
	mutex_unlock(&it->lock);
	return ret ? ret : count;
}

static const struct file_operations it6616_debugfs_dcs_fops = {
	.owner = THIS_MODULE,
	.open = simple_open,
	.write = it6616_debugfs_dcs_write,
	.llseek = noop_llseek,
};

static void it6616_debugfs_remove(void *data)
{
	struct it6616 *it = data;
	struct dentry *dir;

	mutex_lock(&it->lock);
	it->debugfs_stopped = true;
	dir = it->debugfs_dir;
	it->debugfs_dir = NULL;
	mutex_unlock(&it->lock);
	debugfs_remove_recursive(dir);
}

int it6616_debugfs_init(struct it6616 *it)
{
	struct device *dev = it->dev;
	int ret;

	it->debugfs_dir = debugfs_create_dir("it6616", NULL);
	if (!IS_ERR_OR_NULL(it->debugfs_dir)) {
		debugfs_create_file("dcs", 0200, it->debugfs_dir, it,
				   &it6616_debugfs_dcs_fops);
		ret = devm_add_action_or_reset(dev, it6616_debugfs_remove, it);
		if (ret)
			return ret;
	} else {
		it->debugfs_dir = NULL;
	}
	return 0;
}
