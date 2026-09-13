// SPDX-License-Identifier: GPL-2.0
/*
 * FocalTech FT8722 touchscreen and pen driver for the ZSpace T6/UP6/PA60.
 *
 * Minimal, clean-room: binds the ACPI PFT8722 I2C device, reads the native
 * FocalTech event frames on interrupt, and reports a 10-slot multitouch
 * device plus a stylus device. No firmware flashing, no gesture mode, no
 * controller reset (the board has no reset line for it).
 */
#include <linux/acpi.h>
#include <linux/dmi.h>
#include <linux/gpio/consumer.h>
#include <linux/gpio/machine.h>
#include <linux/i2c.h>
#include <linux/input.h>
#include <linux/input/mt.h>
#include <linux/interrupt.h>
#include <linux/module.h>
#include <linux/pm.h>

#include "ft8722_compat.h"
#include "ft8722_proto.h"

#define FT8722_DEV_NAME	"i2c-PFT8722:00"
#define FT8722_IRQ_CHIP	"INTC1083:00"
#define FT8722_IRQ_OFFSET	107

static bool dump_frames;
module_param(dump_frames, bool, 0644);
MODULE_PARM_DESC(dump_frames, "log every raw event frame (default: false)");

static bool force;
module_param(force, bool, 0444);
MODULE_PARM_DESC(force,
		 "bind on boards not in the DMI table, using the ACPI-provided IRQ only (default: false)");

struct ft8722_contact {
	u8 id;
	u8 flag;
	u16 x, y;
	u8 major, minor, weight;
};

struct ft8722 {
	struct i2c_client *client;
	struct input_dev *touch;
	struct input_dev *pen;
	int irq;
	u8 buf[FT8722_BUF_LEN];
	struct ft8722_contact contacts[FT8722_MAX_FINGERS];
	bool pen_in_range;
};

/*
 * The interrupt wiring below is board knowledge, and the ACPI ID alone would
 * also match other machines with a FocalTech HID-over-I2C panel where the
 * generic i2c_hid driver is the right owner. Only bind on boards listed here.
 */
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

/*
 * ACPI's GpioInt for this device is a placeholder; the interrupt line the
 * vendor uses is INTC1083:00 offset 107 (input, active low).
 */
static bool ft8722_lookup_added;
static struct gpiod_lookup_table ft8722_irq_lookup = {
	.dev_id = FT8722_DEV_NAME,
	.table = {
		GPIO_LOOKUP(FT8722_IRQ_CHIP, FT8722_IRQ_OFFSET, "irq",
			    GPIO_ACTIVE_LOW),
		{ },
	},
};

static int ft8722_read(struct ft8722 *ts, u8 reg, u8 *buf, size_t len)
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

/* Fetch the part of the frame beyond the first FT8722_FRAME_LEN bytes. */
static int ft8722_read_rest(struct ft8722 *ts, size_t need)
{
	if (need <= FT8722_FRAME_LEN)
		return 0;
	if (need > sizeof(ts->buf))
		return -EINVAL;
	return ft8722_read(ts, FT8722_REG_TOUCH + FT8722_FRAME_LEN,
			   ts->buf + FT8722_FRAME_LEN, need - FT8722_FRAME_LEN);
}

static void ft8722_release_all(struct ft8722 *ts)
{
	unsigned int i;

	for (i = 0; i < FT8722_MAX_FINGERS; i++) {
		input_mt_slot(ts->touch, i);
		input_mt_report_slot_inactive(ts->touch);
	}
	input_mt_sync_frame(ts->touch);
	input_sync(ts->touch);

	if (ts->pen_in_range) {
		ts->pen_in_range = false;
		input_report_key(ts->pen, BTN_TOUCH, 0);
		input_report_key(ts->pen, BTN_STYLUS, 0);
		input_report_key(ts->pen, BTN_STYLUS2, 0);
		input_report_key(ts->pen, BTN_TOOL_PEN, 0);
		input_sync(ts->pen);
	}
}

static void ft8722_report_contacts(struct ft8722 *ts, unsigned int n)
{
	unsigned int i;

	for (i = 0; i < n; i++) {
		const struct ft8722_contact *c = &ts->contacts[i];
		bool active = c->flag != FT8722_FLAG_UP;

		input_mt_slot(ts->touch, c->id);
		input_mt_report_slot_state(ts->touch, MT_TOOL_FINGER, active);
		if (!active)
			continue;
		/* The controller's origin is opposite the panel's; the vendor flips both axes. */
		input_report_abs(ts->touch, ABS_MT_POSITION_X, FT8722_MAX_X - c->x);
		input_report_abs(ts->touch, ABS_MT_POSITION_Y, FT8722_MAX_Y - c->y);
		input_report_abs(ts->touch, ABS_MT_TOUCH_MAJOR, c->major);
		input_report_abs(ts->touch, ABS_MT_TOUCH_MINOR, c->minor);
		input_report_abs(ts->touch, ABS_MT_PRESSURE, c->weight);
	}
	input_mt_sync_frame(ts->touch);
	input_sync(ts->touch);
}

static int ft8722_parse_v1(struct ft8722 *ts, unsigned int n)
{
	unsigned int i;

	for (i = 0; i < n; i++) {
		const u8 *p = ts->buf + FT8722_V1_HDR + i * FT8722_V1_POINT;
		struct ft8722_contact *c = &ts->contacts[i];

		c->id = p[2] >> 4;
		if (c->id >= FT8722_MAX_FINGERS)
			return -EINVAL;
		c->flag = p[0] >> 6;
		c->x = ((p[0] & 0x0f) << 8) | p[1];
		c->y = ((p[2] & 0x0f) << 8) | p[3];
		c->weight = p[4] ? p[4] : 63;
		c->major = p[5] ? p[5] : 9;
		c->minor = c->major;
	}
	return 0;
}

static int ft8722_parse_v2(struct ft8722 *ts, unsigned int n)
{
	unsigned int i;

	for (i = 0; i < n; i++) {
		const u8 *p = ts->buf + FT8722_V2_HDR + i * FT8722_V2_POINT;
		struct ft8722_contact *c = &ts->contacts[i];

		c->id = p[2] >> 4;
		if (c->id >= FT8722_MAX_FINGERS)
			return -EINVAL;
		c->flag = p[0] >> 6;
		c->x = ((p[0] & 0x0f) << 8) | p[1];
		c->y = ((p[2] & 0x0f) << 8) | p[3];
		c->weight = 63;
		c->major = p[5] ? p[5] : 9;
		c->minor = p[6] ? p[6] : 9;
	}
	return 0;
}

static void ft8722_report_pen(struct ft8722 *ts)
{
	const u8 *b = ts->buf;
	bool tip = b[2] & BIT(0);
	bool in_range = b[2] & BIT(5);
	u32 x = ((b[3] & 0x0f) << 12) | (b[4] << 4) | (b[5] >> 4);
	u32 y = ((b[5] & 0x0f) << 12) | (b[6] << 4) | (b[7] >> 4);
	u16 pressure = ((b[7] & 0x0f) << 8) | b[8];

	/* 1/16 px -> 1/10 px, as the vendor does */
	x = x * 5 / 8;
	y = y * 5 / 8;

	ts->pen_in_range = in_range || tip;
	input_report_key(ts->pen, BTN_TOOL_PEN, ts->pen_in_range);
	input_report_key(ts->pen, BTN_TOUCH, tip);
	input_report_key(ts->pen, BTN_STYLUS, b[2] & BIT(1));
	input_report_key(ts->pen, BTN_STYLUS2, b[2] & BIT(3));
	if (ts->pen_in_range) {
		input_report_abs(ts->pen, ABS_X, min_t(u32, x, FT8722_PEN_MAX_X));
		input_report_abs(ts->pen, ABS_Y, min_t(u32, y, FT8722_PEN_MAX_Y));
		input_report_abs(ts->pen, ABS_PRESSURE, pressure);
		input_report_abs(ts->pen, ABS_TILT_X, (s16)get_unaligned_be16(b + 9));
		input_report_abs(ts->pen, ABS_TILT_Y, (s16)get_unaligned_be16(b + 11));
		input_report_abs(ts->pen, ABS_Z, get_unaligned_be16(b + 13));
	}
	input_sync(ts->pen);
}

static irqreturn_t ft8722_irq(int irq, void *data)
{
	struct ft8722 *ts = data;
	struct device *dev = &ts->client->dev;
	unsigned int type, n;
	int ret;

	ret = ft8722_read(ts, FT8722_REG_TOUCH, ts->buf, FT8722_FRAME_LEN);
	if (ret) {
		dev_err_ratelimited(dev, "frame read failed: %d\n", ret);
		return IRQ_HANDLED;
	}

	if (ts->buf[1] == FT8722_EV_BYTE_ERROR) {
		if (ts->buf[2] == 0xff && ts->buf[3] == 0xff && ts->buf[4] == 0xff)
			dev_warn_ratelimited(dev, "controller reports a fault\n");
		return IRQ_HANDLED;
	}
	if (ts->buf[1] == FT8722_EV_BYTE_FW_INIT) {
		dev_info(dev, "controller re-initialised\n");
		ft8722_release_all(ts);
		return IRQ_HANDLED;
	}

	type = ts->buf[1] >> 4;
	n = ts->buf[1] & 0x0f;

	switch (type) {
	case FT8722_EV_DEFAULT:
		if (n > FT8722_MAX_FINGERS)
			goto bad;
		ret = ft8722_read_rest(ts, FT8722_V1_HDR + n * FT8722_V1_POINT);
		if (ret)
			goto bad;
		if (dump_frames)
			dev_info(dev, "v1 n=%u %*ph\n", n,
				 min(FT8722_V1_HDR + n * FT8722_V1_POINT, 64u), ts->buf);
		if (ft8722_parse_v1(ts, n))
			goto bad;
		ft8722_report_contacts(ts, n);
		break;
	case FT8722_EV_V2:
		if (!n || n > FT8722_MAX_FINGERS)
			goto bad;
		ret = ft8722_read_rest(ts, FT8722_V2_HDR + n * FT8722_V2_POINT);
		if (ret)
			goto bad;
		if (dump_frames)
			dev_info(dev, "v2 n=%u %*ph\n", n,
				 min(FT8722_V2_HDR + n * FT8722_V2_POINT, 64u), ts->buf);
		if (ft8722_parse_v2(ts, n))
			goto bad;
		ft8722_report_contacts(ts, n);
		break;
	case FT8722_EV_PEN:
		if (dump_frames)
			dev_info(dev, "pen %*ph\n", FT8722_PEN_LEN, ts->buf);
		ft8722_report_pen(ts);
		break;
	default:
		dev_warn_ratelimited(dev, "unsupported frame type 0x%x: %*ph\n",
				     type, FT8722_FRAME_LEN, ts->buf);
		break;
	}
	return IRQ_HANDLED;

bad:
	dev_warn_ratelimited(dev, "bad frame: %*ph\n", FT8722_FRAME_LEN, ts->buf);
	return IRQ_HANDLED;
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
	/* libinput refuses a tablet without a physical resolution */
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

	ret = devm_request_threaded_irq(dev, ts->irq, NULL, ft8722_irq,
					IRQF_TRIGGER_FALLING | IRQF_ONESHOT,
					dev_name(dev), ts);
	if (ret)
		return dev_err_probe(dev, ret, "cannot request IRQ %d\n", ts->irq);

	dev_info(dev, "touch and pen registered, IRQ %d\n", ts->irq);
	return 0;
}

/*
 * The stock system never sleeps this controller and the board has no reset
 * line to wake it with, so suspend only quiesces reporting.
 */
static int ft8722_suspend(struct device *dev)
{
	struct ft8722 *ts = i2c_get_clientdata(to_i2c_client(dev));

	disable_irq(ts->irq);
	ft8722_release_all(ts);
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
MODULE_VERSION("0.1.2");
