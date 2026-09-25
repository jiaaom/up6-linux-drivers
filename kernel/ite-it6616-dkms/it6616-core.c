// SPDX-License-Identifier: GPL-2.0
/*
 * ITE IT6616 HDMI-to-MIPI DSI bridge on the ZSpace T6/UP6/PA60 front panel.
 *
 * Firmware configures the bridge and the panel at boot.  This driver leaves
 * that configuration alone, reports live link state, and exposes the tested
 * controls needed by the front-panel power path.
 */
#include <linux/acpi.h>
#include <linux/debugfs.h>
#include <linux/device.h>
#include <linux/i2c.h>
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/pm.h>
#include <linux/regmap.h>
#include <linux/slab.h>

#include "it6616.h"

static const struct regmap_range_cfg it6616_hdmi_range = {
	.name = "hdmi-banks",
	.range_min = IT6616_HDMI(0, 0x00),
	.range_max = IT6616_HDMI(4, 0xff),
	.selector_reg = IT6616_BANK_REG,
	.selector_mask = 0x07,
	.selector_shift = 0,
	.window_start = 0x00,
	.window_len = 0x100,
};

/* LP FIFO and command registers are unsafe for an unsolicited dump. */
static bool it6616_mipi_precious_reg(struct device *dev, unsigned int reg)
{
	(void)dev;
	return reg >= IT6616_MIPI_LP_FIFO_CTL && reg <= 0x7a;
}

static const struct regmap_config it6616_hdmi_regmap_config = {
	.name = "hdmi",
	.reg_bits = 8,
	.val_bits = 8,
	.max_register = IT6616_HDMI(4, 0xff),
	.ranges = &it6616_hdmi_range,
	.num_ranges = 1,
	.cache_type = REGCACHE_NONE,
};

static const struct regmap_config it6616_mipi_regmap_config = {
	.name = "mipi",
	.reg_bits = 8,
	.val_bits = 8,
	.max_register = 0xff,
	.precious_reg = it6616_mipi_precious_reg,
	.cache_type = REGCACHE_NONE,
};

/*
 * Regmap's bank selector is not visible to the driver when regmap debugfs
 * performs a read. Give HDMI regmap its own lock and restore bank zero at
 * unlock, so both driver accesses and all-bank debugfs dumps are serialized
 * and leave the chip in firmware's bank. The restore is deliberately held
 * off until probe's read-only phase has completed.
 */
static void it6616_hdmi_force_bank_zero(struct it6616 *it)
{
	int bank, ret;

	bank = i2c_smbus_read_byte_data(it->hdmi_client, IT6616_BANK_REG);
	if (bank < 0) {
		WRITE_ONCE(it->hdmi_bank_zero, false);
		dev_dbg(it->dev, "failed to read HDMI bank selector: %d\n", bank);
		return;
	}
	if (!(bank & 0x07)) {
		WRITE_ONCE(it->hdmi_bank_zero, true);
		return;
	}

	/* Preserve unrelated selector bits; only clear the bank field. */
	ret = i2c_smbus_write_byte_data(it->hdmi_client, IT6616_BANK_REG,
					bank & ~0x07);
	if (ret < 0) {
		WRITE_ONCE(it->hdmi_bank_zero, false);
		dev_dbg(it->dev, "failed to restore HDMI bank 0: %d\n", ret);
	} else {
		WRITE_ONCE(it->hdmi_bank_zero, true);
	}
}

static void it6616_hdmi_regmap_lock(void *arg)
{
	struct it6616 *it = arg;

	mutex_lock(&it->hdmi_map_lock);
	if (READ_ONCE(it->hdmi_restore_bank) &&
	    !READ_ONCE(it->suspended) && !READ_ONCE(it->hdmi_bank_zero))
		it6616_hdmi_force_bank_zero(it);
}

static void it6616_hdmi_regmap_unlock(void *arg)
{
	struct it6616 *it = arg;

	if (READ_ONCE(it->hdmi_restore_bank) &&
	    !READ_ONCE(it->suspended))
		it6616_hdmi_force_bank_zero(it);

	mutex_unlock(&it->hdmi_map_lock);
}

static int it6616_hdmi_prepare(struct it6616 *it)
{
	if (!READ_ONCE(it->hdmi_restore_bank) ||
	    READ_ONCE(it->hdmi_bank_zero))
		return 0;
	if (READ_ONCE(it->suspended))
		return -EAGAIN;

	mutex_lock(&it->hdmi_map_lock);
	if (!READ_ONCE(it->hdmi_bank_zero))
		it6616_hdmi_force_bank_zero(it);
	mutex_unlock(&it->hdmi_map_lock);
	return READ_ONCE(it->hdmi_bank_zero) ? 0 : -EIO;
}

int it6616_hdmi_read(struct it6616 *it, unsigned int reg,
				    unsigned int *val)
{
	int ret;

	ret = it6616_hdmi_prepare(it);
	if (ret)
		return ret;
	ret = regmap_read(it->hdmi, reg, val);
	if (!ret && READ_ONCE(it->hdmi_restore_bank) &&
	    !READ_ONCE(it->hdmi_bank_zero))
		ret = -EIO;
	return ret;
}

int it6616_hdmi_update_bits(struct it6616 *it, unsigned int reg,
					   unsigned int mask, unsigned int val)
{
	int ret;

	ret = it6616_hdmi_prepare(it);
	if (ret)
		return ret;
	ret = regmap_update_bits(it->hdmi, reg, mask, val);
	if (!ret && READ_ONCE(it->hdmi_restore_bank) &&
	    !READ_ONCE(it->hdmi_bank_zero))
		ret = -EIO;
	return ret;
}

static int it6616_read_id(struct regmap *map, u8 id[4])
{
	unsigned int value;
	int i, ret;

	for (i = 0; i < 4; i++) {
		ret = regmap_read(map, i, &value);
		if (ret)
			return ret;
		id[i] = value;
	}
	return 0;
}

static bool it6616_id_matches(const u8 id[4], const u8 expected[4])
{
	return !memcmp(id, expected, 4);
}

static void it6616_restore_on(struct it6616 *it)
{
	struct dentry *dir;
	int panel_ret = 0, mute_ret = 0;

	/* Stop new DCS writes before attempting any restore operation. */
	mutex_lock(&it->lock);
	it->debugfs_stopped = true;
	it->tearing_down = true;
	dir = it->debugfs_dir;
	it->debugfs_dir = NULL;
	mutex_unlock(&it->lock);
	debugfs_remove_recursive(dir);

	mutex_lock(&it->lock);
	if (it->suspended) {
		panel_ret = -EHOSTDOWN;
		mute_ret = -EHOSTDOWN;
	} else {
		if (it->mipi_compatible)
			panel_ret = it6616_set_panel_state_locked(it,
								 IT6616_PANEL_ON);
		else
			panel_ret = -ENODEV;
		mute_ret = it6616_hdmi_update_bits(it, IT6616_HDMI_MUTE_CTL,
						   BIT(5), 0);
	}
	mutex_unlock(&it->lock);

	if (panel_ret && panel_ret != -ENODEV)
		dev_warn(it->dev, "failed to restore panel on removal: %d\n",
			 panel_ret);
	if (mute_ret)
		dev_warn(it->dev, "failed to clear HDMI mute on removal: %d\n",
			 mute_ret);
}

static int it6616_suspend(struct device *dev)
{
	struct it6616 *it = dev_get_drvdata(dev);

	mutex_lock(&it->lock);
	if (!it->tearing_down) {
		it->suspended = true;
		/* Bank restoration is skipped during PM; force it after resume. */
		WRITE_ONCE(it->hdmi_bank_zero, false);
	}
	mutex_unlock(&it->lock);
	return 0;
}

static int it6616_resume(struct device *dev)
{
	struct it6616 *it = dev_get_drvdata(dev);

	mutex_lock(&it->lock);
	if (!it->tearing_down) {
		it->suspended = false;
		WRITE_ONCE(it->hdmi_bank_zero, false);
		/* PM may have reset either block; no DCS read can disambiguate it. */
		it->panel_state = IT6616_PANEL_UNKNOWN;
		it->sleep_in_time = ktime_get();
	}
	mutex_unlock(&it->lock);
	return 0;
}

static const struct dev_pm_ops it6616_pm_ops = {
	.suspend = it6616_suspend,
	.resume = it6616_resume,
};

static int it6616_probe(struct i2c_client *client)
{
	static const u8 expected_hdmi[4] = { 0x54, 0x49, 0x16, 0x66 };
	static const u8 expected_mipi[4] = { 0x54, 0x49, 0x10, 0x65 };
	struct device *dev = &client->dev;
	struct regmap_config hdmi_config = it6616_hdmi_regmap_config;
	struct it6616 *it;
	u8 hdmi_id[4], mipi_id[4];
	unsigned int revision, bus;
	struct it6616_link link;
	struct it6616_timing timing;
	int ret;

	it = devm_kzalloc(dev, sizeof(*it), GFP_KERNEL);
	if (!it)
		return -ENOMEM;
	it->dev = dev;
	it->hdmi_client = client;
	it->panel_state = IT6616_PANEL_ON;
	it->hdmi_bank_zero = true;
	mutex_init(&it->lock);
	mutex_init(&it->hdmi_map_lock);
	i2c_set_clientdata(client, it);

	hdmi_config.lock = it6616_hdmi_regmap_lock;
	hdmi_config.unlock = it6616_hdmi_regmap_unlock;
	hdmi_config.lock_arg = it;
	it->hdmi = devm_regmap_init_i2c(client, &hdmi_config);
	if (IS_ERR(it->hdmi))
		return dev_err_probe(dev, PTR_ERR(it->hdmi),
				     "failed to create HDMI regmap\n");

	/* Probe is intentionally read-only: this ID is in bank zero. */
	ret = it6616_read_id(it->hdmi, hdmi_id);
	if (ret)
		return dev_err_probe(dev, ret, "failed to read HDMI ID\n");
	if (!it6616_id_matches(hdmi_id, expected_hdmi)) {
		dev_err(dev, "unexpected HDMI ID %*ph\n", 4, hdmi_id);
		return -ENODEV;
	}

	/* Refuse a surprising firmware bank rather than repairing it during probe. */
	ret = i2c_smbus_read_byte_data(client, IT6616_BANK_REG);
	if (ret < 0)
		return dev_err_probe(dev, ret,
				     "failed to read HDMI bank selector\n");
	if (ret & 0x07) {
		dev_err(dev,
			"HDMI bank %u selected before probe; refusing to write\n",
			ret & 0x07);
		return -EINVAL;
	}
	it->hdmi_bank_zero = true;

	it->mipi_client = devm_i2c_new_dummy_device(dev, client->adapter,
						    IT6616_MIPI_ADDR);
	if (IS_ERR(it->mipi_client))
		return dev_err_probe(dev, PTR_ERR(it->mipi_client),
				     "failed to create MIPI client\n");
	it->mipi = devm_regmap_init_i2c(it->mipi_client,
					&it6616_mipi_regmap_config);
	if (IS_ERR(it->mipi))
		return dev_err_probe(dev, PTR_ERR(it->mipi),
				     "failed to create MIPI regmap\n");

	ret = it6616_read_id(it->mipi, mipi_id);
	if (ret)
		return dev_err_probe(dev, ret, "failed to read MIPI ID\n");
	it->mipi_compatible = it6616_id_matches(mipi_id, expected_mipi);
	if (!it->mipi_compatible)
		dev_warn(dev, "unexpected MIPI ID %*ph; DCS controls disabled\n",
			 4, mipi_id);

	mutex_lock(&it->lock);
	ret = it6616_hdmi_read(it, IT6616_HDMI_REV, &revision);
	if (!ret)
		ret = it6616_read_link_locked(it, &link);
	if (!ret)
		ret = it6616_read_timing_locked(it, &timing);
	if (!ret)
		ret = regmap_read(it->mipi, IT6616_MIPI_BUS, &bus);
	mutex_unlock(&it->lock);
	if (ret)
		return dev_err_probe(dev, ret, "failed to read initial status\n");

	/* All probe accesses above are bank zero; enable post-probe restoration. */
	WRITE_ONCE(it->hdmi_bank_zero, true);
	WRITE_ONCE(it->hdmi_restore_bank, true);

	dev_info(dev,
		 "IT6616 rev 0x%02x: link %s%s%s%s, mode %ux%u, DSI %u lanes\n",
		 revision, link.hdmi_5v ? "+5V " : "", link.clock ? "clock " : "",
		 link.locked ? "lock " : "", link.sync ? "sync" : "no-sync",
		 timing.hactive, timing.vactive, ((bus >> 4) & 0x3) + 1);

	ret = it6616_debugfs_init(it);
	if (ret)
		return ret;

	dev_info(dev, "bound to HDMI 0x%02x and MIPI 0x%02x\n",
		 client->addr, it->mipi_client->addr);
	return 0;
}

static void it6616_remove(struct i2c_client *client)
{
	struct it6616 *it = i2c_get_clientdata(client);

	it6616_restore_on(it);
}

static void it6616_shutdown(struct i2c_client *client)
{
	struct it6616 *it = i2c_get_clientdata(client);

	it6616_restore_on(it);
}

static const struct acpi_device_id it6616_acpi_ids[] = {
	{ "ITE6616" },
	{ }
};
MODULE_DEVICE_TABLE(acpi, it6616_acpi_ids);

static struct i2c_driver it6616_driver = {
	.driver = {
		.name = "ite_it6616",
		.acpi_match_table = it6616_acpi_ids,
		.dev_groups = it6616_attr_groups,
		.pm = &it6616_pm_ops,
	},
	.probe = it6616_probe,
	.remove = it6616_remove,
	.shutdown = it6616_shutdown,
};
module_i2c_driver(it6616_driver);

MODULE_DESCRIPTION("ITE IT6616 HDMI-to-DSI bridge (T6 front panel)");
MODULE_LICENSE("GPL");
MODULE_VERSION("0.1.1");
