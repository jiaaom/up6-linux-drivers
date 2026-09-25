// SPDX-License-Identifier: GPL-2.0
/*
 * FocalTech FT8722 lifecycle, ACPI matching, and input-device setup.
 */
#include <linux/acpi.h>
#include <linux/dmi.h>
#include <linux/gpio/consumer.h>
#include <linux/gpio/machine.h>
#include <linux/i2c.h>
#include <linux/input/mt.h>
#include <linux/module.h>
#include <linux/pm.h>

#include "ft8722.h"
#include "ft8722_compat.h"

#define FT8722_DEV_NAME	"i2c-PFT8722:00"
#define FT8722_IRQ_CHIP	"INTC1083:00"
#define FT8722_IRQ_OFFSET	107

bool ft8722_dump_frames;
module_param_named(dump_frames, ft8722_dump_frames, bool, 0644);
MODULE_PARM_DESC(dump_frames, "log every raw event frame (default: false)");

static bool force;
module_param(force, bool, 0444);
MODULE_PARM_DESC(force,
		 "bind on boards not in the DMI table, using the ACPI-provided IRQ only (default: false)");

static const struct dmi_system_id ft8722_boards[] = {
	{
		.ident = "ZSpace T6 / UP6 / PA60",
		.matches = {
			DMI_MATCH(DMI_SYS_VENDOR, "Insyde"),
			DMI_MATCH(DMI_PRODUCT_NAME, "MeteorLake"),
			DMI_MATCH(DMI_BIOS_VERSION, "T6MTLJKJBOXV"),
		},
	},
	{ }
};

static bool ft8722_lookup_added;
static struct gpiod_lookup_table ft8722_irq_lookup = {
	.dev_id = FT8722_DEV_NAME,
	.table = {
		GPIO_LOOKUP(FT8722_IRQ_CHIP, FT8722_IRQ_OFFSET, "irq",
			    GPIO_ACTIVE_LOW),
		{ },
	},
};

int ft8722_read(struct ft8722 *ts, u8 reg, u8 *buf, size_t len)
{
	struct i2c_msg msgs[] = {
		{ .addr = ts->client->addr, .len = 1, .buf = &reg },
		{ .addr = ts->client->addr, .flags = I2C_M_RD, .len = len,
		  .buf = buf },
	};
	int ret = i2c_transfer(ts->client->adapter, msgs, ARRAY_SIZE(msgs));

	if (ret < 0)
		return ret;
	return ret == ARRAY_SIZE(msgs) ? 0 : -EIO;
}

static int ft8722_identify(struct ft8722 *ts)
{
	struct device *dev = &ts->client->dev;
	u8 idh, idl, fw, vendor;
	int ret;

	ret = ft8722_read(ts, FT8722_REG_CHIP_ID_H, &idh, 1);
	if (ret)
		return dev_err_probe(dev, ret, "controller does not answer\n");
	ret = ft8722_read(ts, FT8722_REG_CHIP_ID_L, &idl, 1);
	if (ret)
		return ret;
	if (idh != 0x87 || idl != 0x2a)
		return dev_err_probe(dev, -ENODEV,
				    "unsupported chip id %02x%02x\n", idh, idl);
	ret = ft8722_read(ts, FT8722_REG_FW_VER, &fw, 1);
	if (ret)
		return ret;
	ret = ft8722_read(ts, FT8722_REG_VENDOR_ID, &vendor, 1);
	if (ret)
		return ret;
	dev_info(dev, "chip id %02x%02x, firmware %u, vendor %02x\n",
		 idh, idl, fw, vendor);
	return 0;
}

static int ft8722_get_irq(struct ft8722 *ts)
{
	struct device *dev = &ts->client->dev;
	struct gpio_desc *gpiod;
	int irq;

	if (ts->client->irq > 0)
		return ts->client->irq;
	if (!dmi_check_system(ft8722_boards))
		return dev_err_probe(dev, -ENODEV,
				     "unknown board and ACPI provides no IRQ\n");

	gpiod = devm_gpiod_get(dev, "irq", GPIOD_IN);
	if (IS_ERR(gpiod))
		return dev_err_probe(dev, PTR_ERR(gpiod), "no interrupt line\n");
	irq = gpiod_to_irq(gpiod);
	if (irq < 0)
		return dev_err_probe(dev, irq, "interrupt line has no IRQ\n");
	return irq;
}

static int ft8722_register_touch(struct ft8722 *ts)
{
	struct input_dev *input;
	int ret;

	input = devm_input_allocate_device(&ts->client->dev);
	if (!input)
		return -ENOMEM;
	input->name = "FT8722 Touchscreen";
	input->phys = "i2c-PFT8722/input0";
	input->id.bustype = BUS_I2C;
	input_set_abs_params(input, ABS_MT_POSITION_X, 0, FT8722_MAX_X, 0, 0);
	input_set_abs_params(input, ABS_MT_POSITION_Y, 0, FT8722_MAX_Y, 0, 0);
	input_abs_set_res(input, ABS_MT_POSITION_X, FT8722_RES_PX_PER_MM);
	input_abs_set_res(input, ABS_MT_POSITION_Y, FT8722_RES_PX_PER_MM);
	input_set_abs_params(input, ABS_MT_TOUCH_MAJOR, 0, 255, 0, 0);
	input_set_abs_params(input, ABS_MT_TOUCH_MINOR, 0, 255, 0, 0);
	input_set_abs_params(input, ABS_MT_PRESSURE, 0, 255, 0, 0);
	ret = input_mt_init_slots(input, FT8722_MAX_FINGERS,
				  INPUT_MT_DIRECT | INPUT_MT_DROP_UNUSED);
	if (ret)
		return ret;
	ret = input_register_device(input);
	if (ret)
		return ret;
	ts->touch = input;
	return 0;
}

static int ft8722_register_pen(struct ft8722 *ts)
{
	struct input_dev *input;
	int ret;

	input = devm_input_allocate_device(&ts->client->dev);
	if (!input)
		return -ENOMEM;
	input->name = "FT8722 Pen";
	input->phys = "i2c-PFT8722/input1";
	input->id.bustype = BUS_I2C;
	__set_bit(INPUT_PROP_DIRECT, input->propbit);
	input_set_capability(input, EV_KEY, BTN_TOOL_PEN);
	input_set_capability(input, EV_KEY, BTN_TOUCH);
	input_set_capability(input, EV_KEY, BTN_STYLUS);
	input_set_capability(input, EV_KEY, BTN_STYLUS2);
	input_set_abs_params(input, ABS_X, 0, FT8722_PEN_MAX_X, 0, 0);
	input_set_abs_params(input, ABS_Y, 0, FT8722_PEN_MAX_Y, 0, 0);
	input_abs_set_res(input, ABS_X, FT8722_PEN_RES_PER_MM);
	input_abs_set_res(input, ABS_Y, FT8722_PEN_RES_PER_MM);
	input_set_abs_params(input, ABS_PRESSURE, 0, FT8722_PEN_MAX_P, 0, 0);
	input_set_abs_params(input, ABS_TILT_X, -FT8722_PEN_MAX_TILT,
			     FT8722_PEN_MAX_TILT, 0, 0);
	input_set_abs_params(input, ABS_TILT_Y, -FT8722_PEN_MAX_TILT,
			     FT8722_PEN_MAX_TILT, 0, 0);
	input_set_abs_params(input, ABS_Z, 0, FT8722_PEN_MAX_AZIMUTH, 0, 0);
	ret = input_register_device(input);
	if (ret)
		return ret;
	ts->pen = input;
	return 0;
}

static int ft8722_probe(struct i2c_client *client)
{
	struct device *dev = &client->dev;
	struct ft8722 *ts;
	int ret;

	if (!i2c_check_functionality(client->adapter, I2C_FUNC_I2C))
		return dev_err_probe(dev, -ENXIO, "adapter lacks plain I2C\n");

	ts = devm_kzalloc(dev, sizeof(*ts), GFP_KERNEL);
	if (!ts)
		return -ENOMEM;
	ts->client = client;
	i2c_set_clientdata(client, ts);

	ret = ft8722_identify(ts);
	if (ret)
		return ret;
	ret = ft8722_get_irq(ts);
	if (ret < 0)
		return ret;
	ts->irq = ret;

	ret = ft8722_register_touch(ts);
	if (ret)
		return ret;
	ret = ft8722_register_pen(ts);
	if (ret)
		return ret;

	/* Keep IRQ devres after input devres: IRQ teardown must run first. */
	ret = devm_request_threaded_irq(dev, ts->irq, NULL, ft8722_input_irq,
					IRQF_TRIGGER_FALLING | IRQF_ONESHOT,
					dev_name(dev), ts);
	if (ret)
		return dev_err_probe(dev, ret, "cannot request IRQ %d\n", ts->irq);

	dev_info(dev, "touch and pen registered, IRQ %d\n", ts->irq);
	return 0;
}

static int ft8722_suspend(struct device *dev)
{
	struct ft8722 *ts = i2c_get_clientdata(to_i2c_client(dev));

	disable_irq(ts->irq);
	ft8722_input_release_all(ts);
	return 0;
}

static int ft8722_resume(struct device *dev)
{
	struct ft8722 *ts = i2c_get_clientdata(to_i2c_client(dev));

	enable_irq(ts->irq);
	return 0;
}

static DEFINE_SIMPLE_DEV_PM_OPS(ft8722_pm_ops, ft8722_suspend, ft8722_resume);

static const struct acpi_device_id ft8722_acpi_ids[] = {
	{ "PFT8722" },
	{ }
};
MODULE_DEVICE_TABLE(acpi, ft8722_acpi_ids);

static const struct i2c_device_id ft8722_i2c_ids[] = {
	{ "ft8722" },
	{ }
};
MODULE_DEVICE_TABLE(i2c, ft8722_i2c_ids);

static struct i2c_driver ft8722_driver = {
	.driver = {
		.name = "ft8722_ts",
		.acpi_match_table = ft8722_acpi_ids,
		.pm = pm_sleep_ptr(&ft8722_pm_ops),
	},
	FT8722_I2C_PROBE = ft8722_probe,
	.id_table = ft8722_i2c_ids,
};

static int __init ft8722_init(void)
{
	int ret;

	if (dmi_check_system(ft8722_boards)) {
		gpiod_add_lookup_table(&ft8722_irq_lookup);
		ft8722_lookup_added = true;
	} else if (force) {
		pr_warn("ft8722_ts: unknown board, binding anyway (force=1)\n");
	} else {
		return -ENODEV;
	}
	ret = i2c_add_driver(&ft8722_driver);
	if (ret && ft8722_lookup_added)
		gpiod_remove_lookup_table(&ft8722_irq_lookup);
	return ret;
}
module_init(ft8722_init);

static void __exit ft8722_exit(void)
{
	i2c_del_driver(&ft8722_driver);
	if (ft8722_lookup_added)
		gpiod_remove_lookup_table(&ft8722_irq_lookup);
}
module_exit(ft8722_exit);

MODULE_DESCRIPTION("FocalTech FT8722 touchscreen and pen (ZSpace T6)");
MODULE_AUTHOR("T6 driver project");
MODULE_LICENSE("GPL");
MODULE_VERSION("0.1.3");
