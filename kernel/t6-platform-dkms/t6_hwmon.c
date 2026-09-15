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

static int t6_write_pwm(struct t6_platform *priv, u8 address, long value)
{
	u8 percent;

	if (value < 0 || value > 255)
		return -ERANGE;
	percent = DIV_ROUND_CLOSEST((unsigned int)value * 100, 255);
	if (percent < t6_min_pwm_percent)
		return -ERANGE;
	return t6_ec_write(priv, address, percent);
}

/*
 * EC 0x59 bit 3 is one global switch: 1 = host PWM values apply (manual),
 * 2 = EC-owned. All three pwmN_enable nodes report the same bit, and the
 * same bit gates the LCD backlight and LEDs, so pwmN_enable=2 freezes those too.
 * The EC does not recompute a duty when the bit is cleared; fans hold the
 * last PWM value.
 */
static int t6_read_pwm_enable(struct t6_platform *priv, long *value)
{
	bool host;
	int ret = t6_ec_get_host_control(priv, &host);

	if (ret)
		return ret;
	*value = host ? 1 : 2;
	return 0;
}

static int t6_write_pwm_enable(struct t6_platform *priv, long value)
{
	if (value != 1 && value != 2)
		return -EINVAL;
	return t6_ec_set_host_control(priv, value == 1);
}

static int t6_hwmon_read(struct device *dev, enum hwmon_sensor_types type,
			 u32 attr, int channel, long *value)
{
	struct t6_platform *priv = dev_get_drvdata(dev);

	if (type == hwmon_temp && attr == hwmon_temp_input) {
		if (channel < 0 || channel >= ARRAY_SIZE(t6_temp_addresses))
			return -EOPNOTSUPP;
		return t6_read_temp(priv, t6_temp_addresses[channel], value);
	}
	if (channel < 0 || channel >= 3)
		return -EOPNOTSUPP;
	if (type == hwmon_fan && attr == hwmon_fan_input)
		return t6_ec_read_rpm(priv, t6_rpm_addresses[channel], value);
	if (type == hwmon_pwm && attr == hwmon_pwm_input)
		return t6_read_pwm(priv, t6_pwm_addresses[channel], value);
	if (type == hwmon_pwm && attr == hwmon_pwm_enable)
		return t6_read_pwm_enable(priv, value);
	return -EOPNOTSUPP;
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

	if (type != hwmon_pwm || channel < 0 || channel >= 3)
		return -EOPNOTSUPP;
	if (attr == hwmon_pwm_input)
		return t6_write_pwm(priv, t6_pwm_addresses[channel], value);
	if (attr == hwmon_pwm_enable)
		return t6_write_pwm_enable(priv, value);
	return -EOPNOTSUPP;
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
