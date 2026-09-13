#include <linux/device.h>
#include <linux/kernel.h>

#include "t6_platform.h"

static ssize_t t6_battery_u16(struct device *dev, u8 address, char *buf)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	u16 value;
	int ret = t6_ec_read_u16_le(priv, address, &value);

	return ret ? ret : sysfs_emit(buf, "%u\n", value);
}

static ssize_t t6_battery_u8(struct device *dev, u8 address, char *buf)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	u8 value;
	int ret = t6_ec_read(priv, address, &value);

	return ret ? ret : sysfs_emit(buf, "%u\n", value);
}

#define T6_BATTERY_U16_ATTR(_name, _address) \
static ssize_t _name##_show(struct device *dev, \
				struct device_attribute *attr, char *buf) \
{ \
	return t6_battery_u16(dev, (_address), buf); \
} \
static DEVICE_ATTR_RO(_name)

#define T6_BATTERY_U8_ATTR(_name, _address) \
static ssize_t _name##_show(struct device *dev, \
				struct device_attribute *attr, char *buf) \
{ \
	return t6_battery_u8(dev, (_address), buf); \
} \
static DEVICE_ATTR_RO(_name)

T6_BATTERY_U16_ATTR(temperature_deci_kelvin, 0x7a);
T6_BATTERY_U16_ATTR(full_charge_capacity_mah, 0x68);
T6_BATTERY_U16_ATTR(remaining_capacity_mah, 0x6e);
T6_BATTERY_U16_ATTR(pack_voltage_mv, 0x70);
T6_BATTERY_U16_ATTR(charging_current_raw, 0x6c);
T6_BATTERY_U16_ATTR(cell1_voltage_mv, 0x7d);
T6_BATTERY_U16_ATTR(cell2_voltage_mv, 0x7f);
T6_BATTERY_U16_ATTR(cell3_voltage_mv, 0x81);
T6_BATTERY_U16_ATTR(cell4_voltage_mv, 0x83);
T6_BATTERY_U8_ATTR(state_of_charge_percent, 0x7c);
T6_BATTERY_U8_ATTR(charge_status_raw, 0x57);
T6_BATTERY_U8_ATTR(battery_status_flags, 0x60);

static struct attribute *t6_battery_attrs[] = {
	&dev_attr_temperature_deci_kelvin.attr,
	&dev_attr_full_charge_capacity_mah.attr,
	&dev_attr_remaining_capacity_mah.attr,
	&dev_attr_pack_voltage_mv.attr,
	&dev_attr_charging_current_raw.attr,
	&dev_attr_cell1_voltage_mv.attr,
	&dev_attr_cell2_voltage_mv.attr,
	&dev_attr_cell3_voltage_mv.attr,
	&dev_attr_cell4_voltage_mv.attr,
	&dev_attr_state_of_charge_percent.attr,
	&dev_attr_charge_status_raw.attr,
	&dev_attr_battery_status_flags.attr,
	NULL,
};

static const struct attribute_group t6_battery_group = {
	.name = "battery",
	.attrs = t6_battery_attrs,
};

int t6_battery_register(struct t6_platform *priv)
{
	return devm_device_add_group(&priv->pdev->dev, &t6_battery_group);
}
