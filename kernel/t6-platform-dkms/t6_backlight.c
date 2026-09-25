#include <linux/backlight.h>

#include "t6_platform.h"

static int t6_backlight_update_status(struct backlight_device *backlight)
{
	struct t6_platform *priv = bl_get_data(backlight);
	int brightness = backlight_get_brightness(backlight);
	int ret;

	if (brightness < 0 || brightness > 100)
		return -ERANGE;
	ret = t6_platform_op_begin(priv);
	if (ret)
		return ret;
	ret = t6_ec_write(priv, 0xa3, brightness);
	t6_platform_op_end(priv);
	return ret;
}

static int t6_backlight_get_brightness(struct backlight_device *backlight)
{
	struct t6_platform *priv = bl_get_data(backlight);
	u8 raw;
	int ret;

	ret = t6_platform_op_begin(priv);
	if (ret)
		return ret;
	ret = t6_ec_read(priv, 0xa3, &raw);
	t6_platform_op_end(priv);
	if (ret)
		return ret;
	if (raw > 100)
		return -ERANGE;
	return raw;
}

static const struct backlight_ops t6_backlight_ops = {
	.options = BL_CORE_SUSPENDRESUME,
	.update_status = t6_backlight_update_status,
	.get_brightness = t6_backlight_get_brightness,
};

int t6_backlight_register(struct t6_platform *priv)
{
	struct backlight_properties props = {
		.type = BACKLIGHT_PLATFORM,
		.scale = BACKLIGHT_SCALE_LINEAR,
		.max_brightness = 100,
	};
	u8 brightness;
	int ret;

	ret = t6_ec_read(priv, 0xa3, &brightness);
	if (ret || brightness > 100)
		return ret ? ret : -ERANGE;
	props.brightness = brightness;
	priv->backlight = devm_backlight_device_register(&priv->pdev->dev,
							"t6_ec_backlight",
							&priv->pdev->dev, priv,
							&t6_backlight_ops, &props);
	if (IS_ERR_OR_NULL(priv->backlight))
		return priv->backlight ? PTR_ERR(priv->backlight) : -ENODEV;
	return 0;
}
