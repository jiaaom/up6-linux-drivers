#include <linux/device.h>
#include <linux/kernel.h>
#include <linux/leds.h>
#include <linux/slab.h>

#include "t6_platform.h"

enum t6_led_mode {
	T6_LED_FULL_BYTE,
	T6_LED_MASKED,
};

struct t6_led {
	struct led_classdev cdev;
	struct t6_platform *priv;
	u8 address;
	u8 mask;
	u8 on_value;
	/* Tray RGB (0xa2): the write also forces the enable bit and the current
	 * speed nibble, so clearing every colour leaves 0x01 (off) at the
	 * chosen speed rather than 0x00 (the EC's own breathing). */
	bool is_tray;
	enum t6_led_mode mode;
};

static int t6_led_set_blocking(struct led_classdev *cdev,
			       enum led_brightness brightness)
{
	struct t6_led *led = container_of(cdev, struct t6_led, cdev);

	if (brightness > 1)
		return -ERANGE;
	if (led->mode == T6_LED_FULL_BYTE)
		return t6_ec_write(led->priv, led->address,
				   brightness ? led->on_value : 0);

	if (led->is_tray)
		/* colour bit + enable (0x01) + speed nibble (0xf0) */
		return t6_ec_update_bits(led->priv, led->address,
					 led->mask | 0x01 | 0xf0,
					 (brightness ? led->on_value : 0) | 0x01 |
					 led->priv->tray_speed);

	return t6_ec_update_bits(led->priv, led->address, led->mask,
				 brightness ? led->on_value : 0);
}

static int t6_led_init(struct t6_led *led, struct t6_platform *priv,
			       const char *name, u8 address, u8 mask, u8 on_value,
			       enum t6_led_mode mode)
{
	led->priv = priv;
	led->address = address;
	led->mask = mask;
	led->on_value = on_value;
	led->mode = mode;
	led->cdev.name = name;
	led->cdev.max_brightness = 1;
	led->cdev.brightness_set_blocking = t6_led_set_blocking;
	return devm_led_classdev_register(&priv->pdev->dev, &led->cdev);
}

/* Tray breathing speed, as the high nibble of 0xa2. */
static const struct {
	const char *name;
	u8 bits;
} t6_tray_speeds[] = {
	{ "slow",   0x30 },	/* 0x10|0x20, slowest */
	{ "normal", 0x00 },
	{ "fast",   0xc0 },	/* 0x40|0x80, fastest */
};

static ssize_t tray_speed_show(struct device *dev,
			       struct device_attribute *attr, char *buf)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	unsigned int i;

	for (i = 0; i < ARRAY_SIZE(t6_tray_speeds); i++)
		if (t6_tray_speeds[i].bits == priv->tray_speed)
			return sysfs_emit(buf, "%s\n", t6_tray_speeds[i].name);
	return sysfs_emit(buf, "0x%02x\n", priv->tray_speed);
}

static ssize_t tray_speed_store(struct device *dev,
				struct device_attribute *attr,
				const char *buf, size_t count)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	unsigned int i;
	int ret;

	for (i = 0; i < ARRAY_SIZE(t6_tray_speeds); i++) {
		if (sysfs_streq(buf, t6_tray_speeds[i].name)) {
			priv->tray_speed = t6_tray_speeds[i].bits;
			/* Re-apply the speed nibble to the live colour, if any. */
			ret = t6_ec_update_bits(priv, 0xa2, 0xf0, priv->tray_speed);
			return ret ? ret : count;
		}
	}
	return -EINVAL;
}

static DEVICE_ATTR_RW(tray_speed);

static struct attribute *t6_tray_attrs[] = {
	&dev_attr_tray_speed.attr,
	NULL,
};

static const struct attribute_group t6_tray_group = {
	.attrs = t6_tray_attrs,
};

int t6_leds_register(struct t6_platform *priv)
{
	struct t6_led *leds;
	unsigned int i, n = 0;
	int ret;

	leds = devm_kcalloc(&priv->pdev->dev, 21, sizeof(*leds), GFP_KERNEL);
	if (!leds)
		return -ENOMEM;

	ret = devm_device_add_group(&priv->pdev->dev, &t6_tray_group);
	if (ret)
		return ret;

	ret = t6_led_init(&leds[n++], priv, "t6:system:white", 0x50,
			  0xff, 0x01, T6_LED_FULL_BYTE);
	if (ret)
		return ret;
	ret = t6_led_init(&leds[n++], priv, "t6:system:red", 0x50,
			  0xff, 0x08, T6_LED_FULL_BYTE);
	if (ret)
		return ret;
	ret = t6_led_init(&leds[n++], priv, "t6:system:green", 0x50,
			  0xff, 0x40, T6_LED_FULL_BYTE);
	if (ret)
		return ret;

	for (i = 0; i < 6; i++) {
		char *white_name, *red_name;

		white_name = devm_kasprintf(&priv->pdev->dev, GFP_KERNEL,
					    "t6:bay%u:white", i);
		red_name = devm_kasprintf(&priv->pdev->dev, GFP_KERNEL,
					  "t6:bay%u:red", i);
		if (!white_name || !red_name)
			return -ENOMEM;
		ret = t6_led_init(&leds[n++], priv, white_name, 0x51 + i,
				  0xff, 0x01, T6_LED_FULL_BYTE);
		if (ret)
			return ret;
		ret = t6_led_init(&leds[n++], priv, red_name, 0x51 + i,
				  0xff, 0x08, T6_LED_FULL_BYTE);
		if (ret)
			return ret;
	}

	/*
	 * Tray RGB effect light (register 0xa2). Bit 0 is the host "enable"
	 * flag; bit 1 = blue, bit 2 = red, bit 3 = green. Colours only take
	 * effect while bit 0 is set: a single colour breathes, combinations
	 * cycle, all three is a rainbow. Enable with no colour (0x01) is off,
	 * so is_tray forces the enable bit and clearing every colour leaves
	 * 0x01 = off (0x00 is the EC's own breathing default, before the host
	 * takes over). The high nibble (0x10..0x80) is the breathing speed,
	 * applied from priv->tray_speed via the tray_speed sysfs attribute.
	 * (Verified live 2026-09-13.)
	 */
	{
		static const struct { const char *name; u8 mask; } rgb[] = {
			{ "t6:rgb:blue",  0x02 },
			{ "t6:rgb:red",   0x04 },
			{ "t6:rgb:green", 0x08 },
		};

		for (i = 0; i < ARRAY_SIZE(rgb); i++) {
			ret = t6_led_init(&leds[n], priv, rgb[i].name, 0xa2,
					  rgb[i].mask, rgb[i].mask, T6_LED_MASKED);
			if (ret)
				return ret;
			leds[n++].is_tray = true;
		}
	}

	/*
	 * Battery/UPS LED. The EC never drives it on its own; 0x00 is dark and
	 * bit 0 is the vendor "control enabled" flag, so a colour value carries
	 * it and off writes 0x00. Whole-byte writes, no wait on bit 0.
	 */
	ret = t6_led_init(&leds[n++], priv, "t6:battery:orange", 0xa1,
			  0xff, 0x03, T6_LED_FULL_BYTE);
	if (ret)
		return ret;
	ret = t6_led_init(&leds[n++], priv, "t6:battery:red", 0xa1,
			  0xff, 0x09, T6_LED_FULL_BYTE);
	if (ret)
		return ret;
	return t6_led_init(&leds[n], priv, "t6:battery:green", 0xa1,
			   0xff, 0x41, T6_LED_FULL_BYTE);
}
