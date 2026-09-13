#include <linux/acpi.h>
#include <linux/kernel.h>
#include <linux/module.h>

#include "t6_platform.h"

int t6_ec_read(struct t6_platform *priv, u8 address, u8 *value)
{
	int ret;

	mutex_lock(&priv->ec_lock);
	ret = ec_read(address, value);
	mutex_unlock(&priv->ec_lock);
	return ret;
}

int t6_ec_read_u16_le(struct t6_platform *priv, u8 address, u16 *value)
{
	u8 low, high;
	int ret;

	mutex_lock(&priv->ec_lock);
	ret = ec_read(address, &low);
	if (!ret)
		ret = ec_read(address + 1, &high);
	mutex_unlock(&priv->ec_lock);
	if (ret)
		return ret;
	*value = low | ((u16)high << 8);
	return 0;
}

int t6_ec_write(struct t6_platform *priv, u8 address, u8 value)
{
	int ret;

	mutex_lock(&priv->ec_lock);
	ret = ec_write(address, value);
	mutex_unlock(&priv->ec_lock);
	return ret;
}

int t6_ec_update_bits(struct t6_platform *priv, u8 address, u8 mask,
			      u8 value)
{
	u8 old_value;
	int ret;

	mutex_lock(&priv->ec_lock);
	ret = ec_read(address, &old_value);
	if (!ret)
		ret = ec_write(address, (old_value & ~mask) | (value & mask));
	mutex_unlock(&priv->ec_lock);
	return ret;
}

int t6_ec_set_beeper(struct t6_platform *priv, u8 mode)
{
	u8 old_control, old_mode, new_control, new_mode;
	int ret;

	if (mode != 0 && mode != 1 && mode != 2 && mode != 4 && mode != 8)
		return -EINVAL;

	mutex_lock(&priv->ec_lock);
	ret = ec_read(T6_EC_CTRL_REG, &old_control);
	if (ret)
		goto out;
	ret = ec_read(0x5b, &old_mode);
	if (ret)
		goto out;

	new_mode = (old_mode & 0xf0) | mode;
	new_control = mode ? (old_control | T6_EC_CTRL_BEEPER) :
			     (old_control & ~T6_EC_CTRL_BEEPER);
	ret = ec_write(0x5b, new_mode);
	if (ret)
		goto out;
	ret = ec_write(T6_EC_CTRL_REG, new_control);
	if (ret)
		ec_write(0x5b, old_mode);

out:
	mutex_unlock(&priv->ec_lock);
	return ret;
}

int t6_ec_set_host_control(struct t6_platform *priv, bool enable)
{
	return t6_ec_update_bits(priv, T6_EC_CTRL_REG, T6_EC_CTRL_HOST,
				 enable ? T6_EC_CTRL_HOST : 0);
}

int t6_ec_get_host_control(struct t6_platform *priv, bool *enabled)
{
	u8 control;
	int ret = t6_ec_read(priv, T6_EC_CTRL_REG, &control);

	if (ret)
		return ret;
	*enabled = !!(control & T6_EC_CTRL_HOST);
	return 0;
}

int t6_ec_read_rpm(struct t6_platform *priv, u8 low_address, long *value)
{
	u8 low, high_first, high_last;
	int ret = -EAGAIN;
	int attempt;

	mutex_lock(&priv->ec_lock);
	for (attempt = 0; attempt < 3; attempt++) {
		ret = ec_read(low_address + 1, &high_first);
		if (ret)
			break;
		ret = ec_read(low_address, &low);
		if (ret)
			break;
		ret = ec_read(low_address + 1, &high_last);
		if (ret)
			break;
		if (high_first == high_last)
			break;
		ret = -EAGAIN;
	}
	mutex_unlock(&priv->ec_lock);

	if (ret)
		return ret;
	if (high_first != high_last)
		return -EAGAIN;

	*value = low | ((long)high_last << 8);
	return 0;
}

MODULE_LICENSE("GPL");
