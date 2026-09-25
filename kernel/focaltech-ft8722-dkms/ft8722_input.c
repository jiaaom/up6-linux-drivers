// SPDX-License-Identifier: GPL-2.0
/*
 * FocalTech FT8722 frame parsing, validation, and input reporting.
 */
#include <linux/input/mt.h>
#include <linux/module.h>

#include "ft8722.h"
#include "ft8722_compat.h"

static void ft8722_release_touch(struct ft8722 *ts)
{
	unsigned int i;

	for (i = 0; i < FT8722_MAX_FINGERS; i++) {
		input_mt_slot(ts->touch, i);
		input_mt_report_slot_inactive(ts->touch);
	}
	input_mt_sync_frame(ts->touch);
	input_sync(ts->touch);
}

static void ft8722_release_pen(struct ft8722 *ts)
{
	ts->pen_in_range = false;
	input_report_key(ts->pen, BTN_TOUCH, 0);
	input_report_key(ts->pen, BTN_STYLUS, 0);
	input_report_key(ts->pen, BTN_STYLUS2, 0);
	input_report_key(ts->pen, BTN_TOOL_PEN, 0);
	input_sync(ts->pen);
}

void ft8722_input_release_all(struct ft8722 *ts)
{
	ft8722_release_touch(ts);
	ft8722_release_pen(ts);
}

static void ft8722_report_contacts(struct ft8722 *ts, unsigned int n)
{
	unsigned int i;

	for (i = 0; i < n; i++) {
		const struct ft8722_contact *c = &ts->contacts[i];
		bool active = c->flag != FT8722_FLAG_UP;

		input_mt_slot(ts->touch, c->id);
		input_mt_report_slot_state(ts->touch, MT_TOOL_FINGER, active);
		if (!active)
			continue;
		/* The controller's origin is opposite the panel's; the vendor flips both axes. */
		input_report_abs(ts->touch, ABS_MT_POSITION_X, FT8722_MAX_X - c->x);
		input_report_abs(ts->touch, ABS_MT_POSITION_Y, FT8722_MAX_Y - c->y);
		input_report_abs(ts->touch, ABS_MT_TOUCH_MAJOR, c->major);
		input_report_abs(ts->touch, ABS_MT_TOUCH_MINOR, c->minor);
		input_report_abs(ts->touch, ABS_MT_PRESSURE, c->weight);
	}
	input_mt_sync_frame(ts->touch);
	input_sync(ts->touch);
}

static int ft8722_validate_contact(const struct ft8722_contact *c,
				   unsigned int *seen)
{
	if (c->id >= FT8722_MAX_FINGERS || (*seen & BIT(c->id)))
		return -EINVAL;
	if (c->flag != FT8722_FLAG_DOWN && c->flag != FT8722_FLAG_UP &&
	    c->flag != FT8722_FLAG_CONTACT)
		return -EINVAL;
	/* Check controller coordinates before applying the axis inversion. */
	if (c->x > FT8722_MAX_X || c->y > FT8722_MAX_Y)
		return -ERANGE;
	*seen |= BIT(c->id);
	return 0;
}

static int ft8722_parse_v1(struct ft8722 *ts, unsigned int n)
{
	unsigned int i, seen = 0;

	if (n > FT8722_MAX_FINGERS)
		return -E2BIG;
	for (i = 0; i < n; i++) {
		const u8 *p = ts->buf + FT8722_V1_HDR + i * FT8722_V1_POINT;
		struct ft8722_contact *c = &ts->contacts[i];
		int ret;

		c->id = p[2] >> 4;
		c->flag = p[0] >> 6;
		c->x = ((p[0] & 0x0f) << 8) | p[1];
		c->y = ((p[2] & 0x0f) << 8) | p[3];
		c->weight = p[4] ? p[4] : 63;
		c->major = p[5] ? p[5] : 9;
		c->minor = c->major;
		ret = ft8722_validate_contact(c, &seen);
		if (ret)
			return ret;
	}
	return 0;
}

static int ft8722_parse_v2(struct ft8722 *ts, unsigned int n)
{
	unsigned int i, seen = 0;

	if (n > FT8722_MAX_FINGERS)
		return -E2BIG;
	for (i = 0; i < n; i++) {
		const u8 *p = ts->buf + FT8722_V2_HDR + i * FT8722_V2_POINT;
		struct ft8722_contact *c = &ts->contacts[i];
		int ret;

		c->id = p[2] >> 4;
		c->flag = p[0] >> 6;
		c->x = ((p[0] & 0x0f) << 8) | p[1];
		c->y = ((p[2] & 0x0f) << 8) | p[3];
		c->weight = 63;
		c->major = p[5] ? p[5] : 9;
		c->minor = p[6] ? p[6] : 9;
		ret = ft8722_validate_contact(c, &seen);
		if (ret)
			return ret;
	}
	return 0;
}

static void ft8722_report_pen(struct ft8722 *ts)
{
	const u8 *b = ts->buf;
	bool tip = b[2] & BIT(0);
	bool in_range = b[2] & BIT(5);
	u32 x = ((b[3] & 0x0f) << 12) | (b[4] << 4) | (b[5] >> 4);
	u32 y = ((b[5] & 0x0f) << 12) | (b[6] << 4) | (b[7] >> 4);
	u16 pressure = ((b[7] & 0x0f) << 8) | b[8];

	/* 1/16 px -> 1/10 px, as the vendor does; pen axes remain unverified. */
	x = x * 5 / 8;
	y = y * 5 / 8;

	ts->pen_in_range = in_range || tip;
	input_report_key(ts->pen, BTN_TOOL_PEN, ts->pen_in_range);
	input_report_key(ts->pen, BTN_TOUCH, tip);
	input_report_key(ts->pen, BTN_STYLUS, b[2] & BIT(1));
	input_report_key(ts->pen, BTN_STYLUS2, b[2] & BIT(3));
	if (ts->pen_in_range) {
		input_report_abs(ts->pen, ABS_X, min_t(u32, x, FT8722_PEN_MAX_X));
		input_report_abs(ts->pen, ABS_Y, min_t(u32, y, FT8722_PEN_MAX_Y));
		input_report_abs(ts->pen, ABS_PRESSURE, pressure);
		input_report_abs(ts->pen, ABS_TILT_X, (s16)get_unaligned_be16(b + 9));
		input_report_abs(ts->pen, ABS_TILT_Y, (s16)get_unaligned_be16(b + 11));
		input_report_abs(ts->pen, ABS_Z, get_unaligned_be16(b + 13));
	}
	input_sync(ts->pen);
}

static int ft8722_read_rest(struct ft8722 *ts, size_t need)
{
	if (need <= FT8722_FRAME_LEN)
		return 0;
	if (need > sizeof(ts->buf))
		return -EINVAL;
	return ft8722_read(ts, FT8722_REG_TOUCH + FT8722_FRAME_LEN,
			   ts->buf + FT8722_FRAME_LEN, need - FT8722_FRAME_LEN);
}

irqreturn_t ft8722_input_irq(int irq, void *data)
{
	struct ft8722 *ts = data;
	struct device *dev = &ts->client->dev;
	unsigned int type, n;
	int ret;

	(void)irq;

	ret = ft8722_read(ts, FT8722_REG_TOUCH, ts->buf, FT8722_FRAME_LEN);
	if (ret) {
		dev_err_ratelimited(dev, "frame read failed: %d\n", ret);
		ft8722_input_release_all(ts);
		return IRQ_HANDLED;
	}

	if (ts->buf[1] == FT8722_EV_BYTE_ERROR) {
		if (ts->buf[2] == 0xff && ts->buf[3] == 0xff && ts->buf[4] == 0xff)
			dev_warn_ratelimited(dev, "controller reports a fault\n");
		ft8722_input_release_all(ts);
		return IRQ_HANDLED;
	}
	if (ts->buf[1] == FT8722_EV_BYTE_FW_INIT) {
		dev_info(dev, "controller re-initialised\n");
		ft8722_input_release_all(ts);
		return IRQ_HANDLED;
	}

	type = ts->buf[1] >> 4;
	n = ts->buf[1] & 0x0f;

	switch (type) {
	case FT8722_EV_DEFAULT:
		if (n > FT8722_MAX_FINGERS)
			goto bad;
		ret = ft8722_read_rest(ts, FT8722_V1_HDR + n * FT8722_V1_POINT);
		if (ret)
			goto bad;
		if (ft8722_dump_frames)
			dev_info(dev, "v1 n=%u %*ph\n", n,
				 min(FT8722_V1_HDR + n * FT8722_V1_POINT, 64u), ts->buf);
		if (ft8722_parse_v1(ts, n))
			goto bad;
		if (n)
			ft8722_report_contacts(ts, n);
		else
			ft8722_release_touch(ts);
		break;
	case FT8722_EV_V2:
		/* Count zero has no documented meaning for v2; reject it. */
		if (!n || n > FT8722_MAX_FINGERS)
			goto bad;
		ret = ft8722_read_rest(ts, FT8722_V2_HDR + n * FT8722_V2_POINT);
		if (ret)
			goto bad;
		if (ft8722_dump_frames)
			dev_info(dev, "v2 n=%u %*ph\n", n,
				 min(FT8722_V2_HDR + n * FT8722_V2_POINT, 64u), ts->buf);
		if (ft8722_parse_v2(ts, n))
			goto bad;
		ft8722_report_contacts(ts, n);
		break;
	case FT8722_EV_PEN:
		if (ft8722_dump_frames)
			dev_info(dev, "pen %*ph\n", FT8722_PEN_LEN, ts->buf);
		ft8722_report_pen(ts);
		break;
	default:
		dev_warn_ratelimited(dev, "unsupported frame type 0x%x: %*ph\n",
				     type, FT8722_FRAME_LEN, ts->buf);
		goto bad;
	}
	return IRQ_HANDLED;

bad:
	dev_warn_ratelimited(dev, "bad frame: %*ph\n", FT8722_FRAME_LEN, ts->buf);
	ft8722_input_release_all(ts);
	return IRQ_HANDLED;
}
