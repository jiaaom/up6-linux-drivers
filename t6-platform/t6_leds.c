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

int t6_leds_register(struct t6_platform *priv)
{
	struct t6_led *leds;
	unsigned int i, n = 0;
	int ret;

	leds = devm_kcalloc(&priv->pdev->dev, 21, sizeof(*leds), GFP_KERNEL);
	if (!leds)
		return -ENOMEM;

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

	ret = t6_led_init(&leds[n++], priv, "t6:rgb:red", 0xa2,
			  0x08, 0x08, T6_LED_MASKED);
	if (ret)
		return ret;
	ret = t6_led_init(&leds[n++], priv, "t6:rgb:green", 0xa2,
			  0x40, 0x40, T6_LED_MASKED);
	if (ret)
		return ret;
	ret = t6_led_init(&leds[n++], priv, "t6:rgb:blue", 0xa2,
			  0x01, 0x01, T6_LED_MASKED);
	if (ret)
		return ret;

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
