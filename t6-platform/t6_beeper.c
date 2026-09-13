// SPDX-License-Identifier: GPL-2.0
/*
 * EC beeper. Two interfaces over the same locked EC sequence:
 *  - a standard input device with EV_SND (SND_BELL = one short beep,
 *    SND_TONE nonzero = continuous, 0 = off), so the console bell and the
 *    `beep` utility work like they do with pcspkr;
 *  - a root-only sysfs `beep` attribute exposing every vendor pattern
 *    (0 off, 1 short 500 ms, 2 long 1 s, 4 double, 8 continuous).
 *
 * EV_SND events arrive in atomic context, so the EC write is deferred to a
 * work item.
 */
#include <linux/device.h>
#include <linux/input.h>
#include <linux/kernel.h>
#include <linux/workqueue.h>

#include "t6_platform.h"

#define T6_BEEP_OFF		0
#define T6_BEEP_SHORT		1
#define T6_BEEP_CONTINUOUS	8

struct t6_beeper {
	struct t6_platform *priv;
	struct input_dev *input;
	struct work_struct work;
	atomic_t pending;
};

static void t6_beeper_work(struct work_struct *work)
{
	struct t6_beeper *beeper = container_of(work, struct t6_beeper, work);
	int mode = atomic_read(&beeper->pending);
	int ret = t6_ec_set_beeper(beeper->priv, mode);

	if (ret)
		dev_warn_ratelimited(&beeper->priv->pdev->dev,
				     "beeper mode %d failed: %d\n", mode, ret);
}

static int t6_beeper_event(struct input_dev *input, unsigned int type,
			   unsigned int code, int value)
{
	struct t6_beeper *beeper = input_get_drvdata(input);
	int mode;

	if (type != EV_SND)
		return -EINVAL;
	switch (code) {
	case SND_BELL:
		mode = value ? T6_BEEP_SHORT : T6_BEEP_OFF;
		break;
	case SND_TONE:
		/* The EC has one fixed pitch; any frequency means "on". */
		mode = value ? T6_BEEP_CONTINUOUS : T6_BEEP_OFF;
		break;
	default:
		return -EINVAL;
	}
	atomic_set(&beeper->pending, mode);
	schedule_work(&beeper->work);
	return 0;
}

static ssize_t beep_store(struct device *dev, struct device_attribute *attr,
			  const char *buf, size_t count)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	unsigned int mode;
	int ret;

	ret = kstrtouint(buf, 0, &mode);
	if (ret)
		return ret;
	if (mode > U8_MAX)
		return -ERANGE;

	ret = t6_ec_set_beeper(priv, mode);
	return ret ? ret : count;
}

static DEVICE_ATTR_WO(beep);

static struct attribute *t6_beeper_attrs[] = {
	&dev_attr_beep.attr,
	NULL,
};

static const struct attribute_group t6_beeper_group = {
	.attrs = t6_beeper_attrs,
};

static void t6_beeper_silence(void *data)
{
	struct t6_beeper *beeper = data;

	cancel_work_sync(&beeper->work);
	t6_ec_set_beeper(beeper->priv, T6_BEEP_OFF);
}

int t6_beeper_register(struct t6_platform *priv)
{
	struct device *dev = &priv->pdev->dev;
	struct t6_beeper *beeper;
	int ret;

	ret = devm_device_add_group(dev, &t6_beeper_group);
	if (ret)
		return ret;

	beeper = devm_kzalloc(dev, sizeof(*beeper), GFP_KERNEL);
	if (!beeper)
		return -ENOMEM;
	beeper->priv = priv;
	INIT_WORK(&beeper->work, t6_beeper_work);

	beeper->input = devm_input_allocate_device(dev);
	if (!beeper->input)
		return -ENOMEM;
	beeper->input->name = "T6 EC Beeper";
	beeper->input->phys = "t6-platform/beeper";
	beeper->input->id.bustype = BUS_HOST;
	beeper->input->event = t6_beeper_event;
	input_set_capability(beeper->input, EV_SND, SND_BELL);
	input_set_capability(beeper->input, EV_SND, SND_TONE);
	input_set_drvdata(beeper->input, beeper);

	/* Never leave a continuous beep running past the driver. */
	ret = devm_add_action_or_reset(dev, t6_beeper_silence, beeper);
	if (ret)
		return ret;
	return input_register_device(beeper->input);
}
