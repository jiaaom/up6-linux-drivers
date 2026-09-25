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
	bool is_tray;
	enum t6_led_mode mode;
};

static int t6_led_set_blocking(struct led_classdev *cdev,
				       enum led_brightness brightness)
{
	struct t6_led *led = container_of(cdev, struct t6_led, cdev);
	struct t6_platform *priv = led->priv;
	u8 reg_value, value;
	int ret;

	if (brightness > 1)
		return -ERANGE;
	ret = t6_platform_op_begin(priv);
	if (ret)
		return ret;
	mutex_lock(&priv->led_lock);
	if (led->address == 0xa1 && t6_charge_owns_battery_led(priv)) {
		/* Charge policy owns the byte: reject colour changes, but make the
		 * common all-LEDs-off park operation a harmless no-op. */
		ret = brightness ? -EBUSY : 0;
		goto out;
	}
	ret = t6_ec_read(priv, led->address, &reg_value);
	if (ret)
		goto out;
	if (led->mode == T6_LED_FULL_BYTE) {
		/* Whole-byte hardware is last-on-wins; a sibling's off must not clear it. */
		if (!brightness && reg_value != led->on_value) {
			ret = 0;
			goto out;
		}
		value = brightness ? led->on_value : 0;
		ret = t6_ec_write(priv, led->address, value);
		goto out;
	}

	value = (reg_value & ~(led->mask | 0x01 | 0xf0)) |
		(brightness ? led->on_value : 0) | 0x01 | priv->tray_speed;
	ret = t6_ec_write(priv, led->address, value);
out:
	mutex_unlock(&priv->led_lock);
	t6_platform_op_end(priv);
	return ret;
}

static enum led_brightness t6_led_get(struct led_classdev *cdev)
{
	struct t6_led *led = container_of(cdev, struct t6_led, cdev);
	struct t6_platform *priv = led->priv;
	u8 value;
	int ret;

	ret = t6_platform_op_begin(priv);
	if (ret)
		return ret;
	mutex_lock(&priv->led_lock);
	ret = t6_ec_read(priv, led->address, &value);
	mutex_unlock(&priv->led_lock);
	t6_platform_op_end(priv);
	if (ret)
		return ret;
	if (led->mode == T6_LED_FULL_BYTE)
		return value == led->on_value;
	return !!(value & led->mask);
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
	led->cdev.brightness_get = t6_led_get;
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
	ssize_t ret;

	if (t6_platform_op_begin(priv))
		return -ENODEV;
	mutex_lock(&priv->led_lock);
	for (i = 0; i < ARRAY_SIZE(t6_tray_speeds); i++)
		if (t6_tray_speeds[i].bits == priv->tray_speed) {
			ret = sysfs_emit(buf, "%s\n", t6_tray_speeds[i].name);
			goto out;
		}
	ret = sysfs_emit(buf, "0x%02x\n", priv->tray_speed);
out:
	mutex_unlock(&priv->led_lock);
	t6_platform_op_end(priv);
	return ret;
}

static ssize_t tray_speed_store(struct device *dev,
					struct device_attribute *attr,
					const char *buf, size_t count)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	u8 reg_value, value, speed;
	unsigned int i;
	int ret;

	for (i = 0; i < ARRAY_SIZE(t6_tray_speeds); i++)
		if (sysfs_streq(buf, t6_tray_speeds[i].name))
			break;
	if (i == ARRAY_SIZE(t6_tray_speeds))
		return -EINVAL;
	speed = t6_tray_speeds[i].bits;
	ret = t6_platform_op_begin(priv);
	if (ret)
		return ret;
	mutex_lock(&priv->led_lock);
	ret = t6_ec_read(priv, 0xa2, &reg_value);
	if (!ret) {
		value = (reg_value & ~0xf0) | speed;
		ret = t6_ec_write(priv, 0xa2, value);
		if (!ret)
			priv->tray_speed = speed;
	}
	mutex_unlock(&priv->led_lock);
	t6_platform_op_end(priv);
	return ret ? ret : count;
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
			leds[n].is_tray = true;
			ret = t6_led_init(&leds[n], priv, rgb[i].name, 0xa2,
					  rgb[i].mask, rgb[i].mask, T6_LED_MASKED);
			if (ret)
				return ret;
			n++;
		}
	}

/* Battery/UPS LED. In EC policy 0x00 hands the byte back to firmware;
 * colour values are whole-byte host values. While charge thresholds are
 * active, t6_charge.c owns this register: colour writes fail and off is a
 * no-op so LED teardown cannot undo the charge indication.
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
