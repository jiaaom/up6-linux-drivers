#include <linux/device.h>
#include <linux/gpio/consumer.h>
#include <linux/gpio/machine.h>
#include <linux/kernel.h>
#include <linux/leds.h>

#include "t6_platform.h"

/*
 * Bluetooth and Wi-Fi tri-colour LEDs on the Meteor Lake PCH GPIO controller
 * (INTC1083:00). Offsets are controller-local, taken from the vendor
 * gpio_t6_leds lookup table and confirmed by eye on 2026-09-12: active-high.
 */
#define T6_GPIO_CHIP "INTC1083:00"
#define T6_GPIO_CON_ID "t6-led"

struct t6_gpio_led_desc {
	const char *name;
	unsigned int offset;
};

static const struct t6_gpio_led_desc t6_gpio_led_descs[] = {
	{ "t6:bt:blue", 164 },
	{ "t6:bt:green", 165 },
	{ "t6:bt:red", 181 },
	{ "t6:wifi:blue", 170 },
	{ "t6:wifi:green", 166 },
	{ "t6:wifi:red", 167 },
};

static struct gpiod_lookup_table t6_gpio_led_lookup = {
	.dev_id = "t6-platform",
	.table = {
		GPIO_LOOKUP_IDX(T6_GPIO_CHIP, 164, T6_GPIO_CON_ID, 0, GPIO_ACTIVE_HIGH),
		GPIO_LOOKUP_IDX(T6_GPIO_CHIP, 165, T6_GPIO_CON_ID, 1, GPIO_ACTIVE_HIGH),
		GPIO_LOOKUP_IDX(T6_GPIO_CHIP, 181, T6_GPIO_CON_ID, 2, GPIO_ACTIVE_HIGH),
		GPIO_LOOKUP_IDX(T6_GPIO_CHIP, 170, T6_GPIO_CON_ID, 3, GPIO_ACTIVE_HIGH),
		GPIO_LOOKUP_IDX(T6_GPIO_CHIP, 166, T6_GPIO_CON_ID, 4, GPIO_ACTIVE_HIGH),
		GPIO_LOOKUP_IDX(T6_GPIO_CHIP, 167, T6_GPIO_CON_ID, 5, GPIO_ACTIVE_HIGH),
		{ },
	},
};

struct t6_gpio_led {
	struct led_classdev cdev;
	struct gpio_desc *gpiod;
};

static int t6_gpio_led_set(struct led_classdev *cdev,
			   enum led_brightness brightness)
{
	struct t6_gpio_led *led = container_of(cdev, struct t6_gpio_led, cdev);

	gpiod_set_value_cansleep(led->gpiod, brightness ? 1 : 0);
	return 0;
}

static void t6_gpio_leds_remove_lookup(void *data)
{
	gpiod_remove_lookup_table(data);
}

int t6_gpio_leds_register(struct t6_platform *priv)
{
	struct device *dev = &priv->pdev->dev;
	struct t6_gpio_led *leds;
	unsigned int i;
	int ret;

	gpiod_add_lookup_table(&t6_gpio_led_lookup);
	ret = devm_add_action_or_reset(dev, t6_gpio_leds_remove_lookup,
				       &t6_gpio_led_lookup);
	if (ret)
		return ret;

	leds = devm_kcalloc(dev, ARRAY_SIZE(t6_gpio_led_descs), sizeof(*leds),
			    GFP_KERNEL);
	if (!leds)
		return -ENOMEM;

	for (i = 0; i < ARRAY_SIZE(t6_gpio_led_descs); i++) {
		/* GPIOD_ASIS: do not glitch a line that firmware or a previous load left lit. */
		leds[i].gpiod = devm_gpiod_get_index(dev, T6_GPIO_CON_ID, i,
						     GPIOD_ASIS);
		if (IS_ERR(leds[i].gpiod))
			return PTR_ERR(leds[i].gpiod);
		ret = gpiod_direction_output(leds[i].gpiod,
					     gpiod_get_value_cansleep(leds[i].gpiod) > 0);
		if (ret)
			return ret;
		leds[i].cdev.name = t6_gpio_led_descs[i].name;
		leds[i].cdev.max_brightness = 1;
		leds[i].cdev.brightness_set_blocking = t6_gpio_led_set;
		ret = devm_led_classdev_register(dev, &leds[i].cdev);
		if (ret)
			return ret;
	}
	return 0;
}
