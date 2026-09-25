#include <linux/hwmon.h>
#include <linux/kernel.h>

#include "t6_platform.h"

/* Physical mapping confirmed by hand on 2026-09-12: 0x0a = SSD bays 1-2, 0x0d = SSD bays 3-6, 0x5c = CPU. */
static const u8 t6_rpm_addresses[] = { 0x0b, 0x0e, 0x5d };
static const u8 t6_pwm_addresses[] = { 0x0a, 0x0d, 0x5c };
static const char * const t6_fan_labels[] = {
	"SSD bay 1-2 fan",
	"SSD bay 3-6 fan",
	"CPU fan",
};

/*
 * EC thermistors, whole degrees C. Register 0x1d is unpopulated (always 0)
 * and not exposed. Sensor placement is inferred from the 2026-09-11 load
 * correlation: 0x1c follows the CPU package with no lag, the others are
 * board thermistors with 20-50 s lag.
 */
static const u8 t6_temp_addresses[] = { 0x1c, 0x1a, 0x1b, 0x1e };
static const char * const t6_temp_labels[] = {
	"CPU (EC)",
	"Board thermistor 1",
	"Board thermistor 2",
	"Board thermistor 3",
};

static int t6_read_temp(struct t6_platform *priv, u8 address, long *value)
{
	u8 raw;
	int ret = t6_ec_read(priv, address, &raw);

	if (ret)
		return ret;
	/* The EC zeroes every thermistor when its sensor task is not running. */
	if (!raw)
		return -ENODATA;
	*value = (long)raw * 1000;
	return 0;
}

static int t6_read_pwm(struct t6_platform *priv, u8 address, long *value)
{
	u8 raw;
	int ret = t6_ec_read(priv, address, &raw);

	if (ret)
		return ret;
	if (raw > 100)
		return -ERANGE;
	*value = DIV_ROUND_CLOSEST((unsigned int)raw * 255, 100);
	return 0;
}

static int t6_write_pwm(struct t6_platform *priv, int channel, long value)
{
	u8 percent;
	bool host;
	int ret;

	if (value < 0 || value > 255)
		return -ERANGE;
	percent = DIV_ROUND_CLOSEST((unsigned int)value * 100, 255);
	if (percent < t6_min_pwm_percent)
		return -ERANGE;
	if (!priv->fan_manual)
		return -EBUSY;
	ret = t6_ec_get_host_control(priv, &host);
	if (ret)
		return ret;
	if (!host) {
		ret = t6_fan_take_control(priv, false);
		if (ret)
			return ret;
	}
	mutex_lock(&priv->fan_lock);
	if (!priv->fan_manual) {
		ret = -EBUSY;
		goto out;
	}
	ret = t6_ec_write(priv, t6_pwm_addresses[channel], percent);
	if (!ret)
		priv->fan_pwm[channel] = percent;
out:
	mutex_unlock(&priv->fan_lock);
	return ret;
}

/* The EC has no automatic curve mode exposed by this driver: 1 is manual,
 * while 0 is the safe full-speed fallback shared by all three channels. */
static int t6_read_pwm_enable(struct t6_platform *priv, long *value)
{
	bool host;
	int ret = t6_ec_get_host_control(priv, &host);

	if (ret)
		return ret;
	*value = host && priv->fan_manual ? 1 : 0;
	return 0;
}

static int t6_write_pwm_enable(struct t6_platform *priv, long value)
{
	if (value == 1)
		return t6_fan_take_control(priv, false);
	if (value == 0)
		return t6_fan_full_speed(priv);
	return -EINVAL;
}
static int t6_hwmon_read(struct device *dev, enum hwmon_sensor_types type,
				 u32 attr, int channel, long *value)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	int ret;

	ret = t6_platform_op_begin(priv);
	if (ret)
		return ret;
	if (type == hwmon_temp && attr == hwmon_temp_input) {
		if (channel < 0 || channel >= ARRAY_SIZE(t6_temp_addresses))
			ret = -EOPNOTSUPP;
		else
			ret = t6_read_temp(priv, t6_temp_addresses[channel], value);
		goto out;
	}
	if (channel < 0 || channel >= T6_FAN_COUNT) {
		ret = -EOPNOTSUPP;
		goto out;
	}
	if (type == hwmon_fan && attr == hwmon_fan_input) {
		mutex_lock(&priv->fan_lock);
		ret = t6_ec_read_rpm(priv, t6_rpm_addresses[channel], value);
		mutex_unlock(&priv->fan_lock);
		goto out;
	}
	if (type == hwmon_pwm && attr == hwmon_pwm_input) {
		mutex_lock(&priv->fan_lock);
		ret = t6_read_pwm(priv, t6_pwm_addresses[channel], value);
		mutex_unlock(&priv->fan_lock);
		goto out;
	}
	if (type == hwmon_pwm && attr == hwmon_pwm_enable)
		ret = t6_read_pwm_enable(priv, value);
	else
		ret = -EOPNOTSUPP;
out:
	t6_platform_op_end(priv);
	return ret;
}

static int t6_hwmon_read_string(struct device *dev,
				enum hwmon_sensor_types type, u32 attr,
				int channel, const char **str)
{
	if (type == hwmon_fan && attr == hwmon_fan_label && channel >= 0 &&
	    channel < ARRAY_SIZE(t6_fan_labels)) {
		*str = t6_fan_labels[channel];
		return 0;
	}
	if (type == hwmon_temp && attr == hwmon_temp_label && channel >= 0 &&
	    channel < ARRAY_SIZE(t6_temp_labels)) {
		*str = t6_temp_labels[channel];
		return 0;
	}
	return -EOPNOTSUPP;
}

static int t6_hwmon_write(struct device *dev, enum hwmon_sensor_types type,
				u32 attr, int channel, long value)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	int ret;

	ret = t6_platform_op_begin(priv);
	if (ret)
		return ret;
	if (type != hwmon_pwm || channel < 0 || channel >= T6_FAN_COUNT) {
		ret = -EOPNOTSUPP;
		goto out;
	}
	if (attr == hwmon_pwm_input)
		ret = t6_write_pwm(priv, channel, value);
	else if (attr == hwmon_pwm_enable)
		ret = t6_write_pwm_enable(priv, value);
	else
		ret = -EOPNOTSUPP;
out:
	t6_platform_op_end(priv);
	return ret;
}

static umode_t t6_hwmon_is_visible(const void *data,
				   enum hwmon_sensor_types type, u32 attr,
				   int channel)
{
	if (type == hwmon_temp &&
	    (attr == hwmon_temp_input || attr == hwmon_temp_label))
		return channel >= 0 && channel < ARRAY_SIZE(t6_temp_addresses) ?
		       0444 : 0;
	if (channel < 0 || channel >= 3)
		return 0;
	if (type == hwmon_fan &&
	    (attr == hwmon_fan_input || attr == hwmon_fan_label))
		return 0444;
	if (type == hwmon_pwm &&
	    (attr == hwmon_pwm_input || attr == hwmon_pwm_enable))
		return 0644;
	return 0;
}

static const struct hwmon_ops t6_hwmon_ops = {
	.is_visible = t6_hwmon_is_visible,
	.read = t6_hwmon_read,
	.read_string = t6_hwmon_read_string,
	.write = t6_hwmon_write,
};

static const struct hwmon_channel_info *t6_hwmon_info[] = {
	HWMON_CHANNEL_INFO(temp, HWMON_T_INPUT | HWMON_T_LABEL,
			   HWMON_T_INPUT | HWMON_T_LABEL,
			   HWMON_T_INPUT | HWMON_T_LABEL,
			   HWMON_T_INPUT | HWMON_T_LABEL),
	HWMON_CHANNEL_INFO(fan, HWMON_F_INPUT | HWMON_F_LABEL,
			   HWMON_F_INPUT | HWMON_F_LABEL,
			   HWMON_F_INPUT | HWMON_F_LABEL),
	HWMON_CHANNEL_INFO(pwm, HWMON_PWM_INPUT | HWMON_PWM_ENABLE,
			   HWMON_PWM_INPUT | HWMON_PWM_ENABLE,
			   HWMON_PWM_INPUT | HWMON_PWM_ENABLE),
	NULL,
};

static const struct hwmon_chip_info t6_hwmon_chip_info = {
	.ops = &t6_hwmon_ops,
	.info = t6_hwmon_info,
};

int t6_hwmon_register(struct t6_platform *priv)
{
	priv->hwmon = devm_hwmon_device_register_with_info(&priv->pdev->dev,
							  "t6_ec", priv,
							  &t6_hwmon_chip_info, NULL);
	return IS_ERR(priv->hwmon) ? PTR_ERR(priv->hwmon) : 0;
}
