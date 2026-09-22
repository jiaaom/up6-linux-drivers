// SPDX-License-Identifier: GPL-2.0
/*
 * Host-side charge thresholds for the T6 UPS pack.
 *
 * EC register 0x57: bit 5 = host owns charging, bit 6 = charge enable. With
 * bit 5 set the EC charges exactly when bit 6 is set and reacts within one
 * EC cycle; with bit 5 clear the EC runs its own policy (stop ~97 %, top up
 * below ~95 %). Neither bit affects the UPS path (verified through AC loss
 * in every bit state). Validated on hardware 2026-09-12.
 *
 * Exposed as the standard charge_control_{start,end}_threshold attributes on
 * the ACPI BAT0 power supply through the ACPI battery hook API, so existing
 * tools (upower, tlp) understand them. Thresholds start=0/end=100 mean "EC
 * policy" and leave the bits clear. Anything else hands charging to this
 * driver: a periodic poll of the EC state of charge (0x7c) sets bit 6 when
 * SoC <= start and clears it when SoC >= end.
 */
#include <acpi/battery.h>
#include <linux/bitfield.h>
#include <linux/device.h>
#include <linux/notifier.h>
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/power_supply.h>
#include <linux/workqueue.h>

#include "t6_compat.h"
#include "t6_platform.h"

#define T6_CHG_REG 0x57
#define T6_CHG_OWNER BIT(5)
#define T6_CHG_ENABLE BIT(6)
#define T6_CHG_STATUS_MASK GENMASK(3, 2)
#define T6_CHG_STATUS_BATTERY 2
#define T6_SOC_REG 0x7c
#define T6_CHG_POLL_MS (30 * 1000)

/*
 * Battery LED. While the host inhibits charging the EC blinks this LED green
 * on its own; taking host control (bit 0) stops that but also stops the
 * EC's orange-on-battery indication, so the driver renders that itself
 * while a band is active and hands the LED back (0x00) otherwise.
 */
#define T6_BATLED_REG 0xa1
#define T6_BATLED_EC 0x00
#define T6_BATLED_DARK 0x01
#define T6_BATLED_ORANGE 0x03

/* One pack, one platform device; the battery attributes have no other way back to priv. */
static struct t6_platform *t6_chg;

static bool t6_charge_host_active(const struct t6_platform *priv)
{
	return priv->charge_start != 0 || priv->charge_end != 100;
}

static int t6_charge_set_led(struct t6_platform *priv, u8 ctrl)
{
	u8 want, cur;
	int ret;

	if (!t6_charge_host_active(priv))
		want = T6_BATLED_EC;
	else if (FIELD_GET(T6_CHG_STATUS_MASK, ctrl) == T6_CHG_STATUS_BATTERY)
		want = T6_BATLED_ORANGE;
	else
		want = T6_BATLED_DARK;

	ret = t6_ec_read(priv, T6_BATLED_REG, &cur);
	if (ret)
		return ret;
	return cur == want ? 0 : t6_ec_write(priv, T6_BATLED_REG, want);
}

/* Runs from the poll work, power-supply events and threshold writes; serialised by charge_lock. */
static int t6_charge_apply(struct t6_platform *priv)
{
	u8 soc, ctrl;
	int ret;

	lockdep_assert_held(&priv->charge_lock);

	ret = t6_ec_read(priv, T6_CHG_REG, &ctrl);
	if (ret)
		return ret;

	if (!t6_charge_host_active(priv)) {
		ret = t6_ec_update_bits(priv, T6_CHG_REG,
					T6_CHG_OWNER | T6_CHG_ENABLE, 0);
		return ret ? ret : t6_charge_set_led(priv, ctrl);
	}

	ret = t6_ec_read(priv, T6_SOC_REG, &soc);
	if (ret)
		return ret;

	/* Between the thresholds keep whatever we were doing (hysteresis). */
	if (soc >= priv->charge_end)
		ctrl &= ~T6_CHG_ENABLE;
	else if (soc <= priv->charge_start)
		ctrl |= T6_CHG_ENABLE;
	ctrl |= T6_CHG_OWNER;

	ret = t6_ec_update_bits(priv, T6_CHG_REG, T6_CHG_OWNER | T6_CHG_ENABLE,
				ctrl);
	return ret ? ret : t6_charge_set_led(priv, ctrl);
}

/* AC plug/unplug reaches us through the ACPI battery/adapter drivers within a second. */
static int t6_charge_psy_notify(struct notifier_block *nb, unsigned long event,
				void *data)
{
	struct t6_platform *priv = container_of(nb, struct t6_platform,
						charge_psy_nb);

	if (event == PSY_EVENT_PROP_CHANGED && t6_charge_host_active(priv))
		mod_delayed_work(system_wq, &priv->charge_work, 0);
	return NOTIFY_OK;
}

static void t6_charge_work(struct work_struct *work)
{
	struct t6_platform *priv = container_of(work, struct t6_platform,
						charge_work.work);
	int ret;

	mutex_lock(&priv->charge_lock);
	ret = t6_charge_apply(priv);
	if (ret)
		dev_warn_ratelimited(&priv->pdev->dev,
				     "charge control update failed: %d\n", ret);
	if (t6_charge_host_active(priv))
		schedule_delayed_work(&priv->charge_work,
				      msecs_to_jiffies(T6_CHG_POLL_MS));
	mutex_unlock(&priv->charge_lock);
}

static int t6_charge_set_thresholds(struct t6_platform *priv,
				    unsigned int start, unsigned int end)
{
	int ret;

	if (end > 100 || start >= end)
		return -EINVAL;

	mutex_lock(&priv->charge_lock);
	priv->charge_start = start;
	priv->charge_end = end;
	cancel_delayed_work(&priv->charge_work);
	ret = t6_charge_apply(priv);
	if (!ret && t6_charge_host_active(priv))
		schedule_delayed_work(&priv->charge_work,
				      msecs_to_jiffies(T6_CHG_POLL_MS));
	mutex_unlock(&priv->charge_lock);
	return ret;
}

/* Called from module exit and the reboot notifier: EC policy must own the pack when we are gone. */
int t6_charge_release(struct t6_platform *priv)
{
	int ret;

	mutex_lock(&priv->charge_lock);
	cancel_delayed_work(&priv->charge_work);
	priv->charge_start = 0;
	priv->charge_end = 100;
	ret = t6_charge_apply(priv);
	mutex_unlock(&priv->charge_lock);
	return ret;
}

static ssize_t charge_control_start_threshold_show(struct device *dev,
						   struct device_attribute *attr,
						   char *buf)
{
	return sysfs_emit(buf, "%u\n", t6_chg->charge_start);
}

static ssize_t charge_control_start_threshold_store(struct device *dev,
						    struct device_attribute *attr,
						    const char *buf, size_t count)
{
	unsigned int value;
	int ret;

	ret = kstrtouint(buf, 10, &value);
	if (ret)
		return ret;
	ret = t6_charge_set_thresholds(t6_chg, value, t6_chg->charge_end);
	return ret ? ret : count;
}

static ssize_t charge_control_end_threshold_show(struct device *dev,
						 struct device_attribute *attr,
						 char *buf)
{
	return sysfs_emit(buf, "%u\n", t6_chg->charge_end);
}

static ssize_t charge_control_end_threshold_store(struct device *dev,
						  struct device_attribute *attr,
						  const char *buf, size_t count)
{
	unsigned int value;
	int ret;

	ret = kstrtouint(buf, 10, &value);
	if (ret)
		return ret;
	ret = t6_charge_set_thresholds(t6_chg, t6_chg->charge_start, value);
	return ret ? ret : count;
}

static DEVICE_ATTR_RW(charge_control_start_threshold);
static DEVICE_ATTR_RW(charge_control_end_threshold);

static struct attribute *t6_charge_attrs[] = {
	&dev_attr_charge_control_start_threshold.attr,
	&dev_attr_charge_control_end_threshold.attr,
	NULL,
};

static const struct attribute_group t6_charge_group = {
	.attrs = t6_charge_attrs,
};

static int t6_charge_add_battery(struct power_supply *battery
				 T6_BATTERY_HOOK_ARG)
{
	/* Only the EC-backed pack; ignore anything else that might appear (USB PD, ...). */
	if (strcmp(battery->desc->name, "BAT0"))
		return -ENODEV;
	return device_add_group(&battery->dev, &t6_charge_group);
}

static int t6_charge_remove_battery(struct power_supply *battery
				    T6_BATTERY_HOOK_ARG)
{
	device_remove_group(&battery->dev, &t6_charge_group);
	return 0;
}

static struct acpi_battery_hook t6_charge_hook = {
	.name = "T6 EC charge thresholds",
	.add_battery = t6_charge_add_battery,
	.remove_battery = t6_charge_remove_battery,
};

int t6_charge_register(struct t6_platform *priv)
{
	int ret;

	mutex_init(&priv->charge_lock);
	INIT_DELAYED_WORK(&priv->charge_work, t6_charge_work);
	priv->charge_start = 0;
	priv->charge_end = 100;
	t6_chg = priv;

	/* Start from EC policy regardless of what a previous owner left behind. */
	ret = t6_charge_release(priv);
	if (ret)
		return ret;

	/*
	 * Not devm: the attributes must be gone before t6_charge_unregister()
	 * hands the pack back to the EC and clears t6_chg, while devres would
	 * remove them only later, from platform_device_unregister().
	 */
	battery_hook_register(&t6_charge_hook);
	priv->charge_psy_nb.notifier_call = t6_charge_psy_notify;
	ret = power_supply_reg_notifier(&priv->charge_psy_nb);
	if (ret) {
		battery_hook_unregister(&t6_charge_hook);
		return ret;
	}

	if (t6_charge_end_default != 100 || t6_charge_start_default != 0) {
		ret = t6_charge_set_thresholds(priv, t6_charge_start_default,
					       t6_charge_end_default);
		if (ret)
			dev_warn(&priv->pdev->dev,
				 "ignoring invalid charge threshold defaults %u/%u\n",
				 t6_charge_start_default, t6_charge_end_default);
	}
	return 0;
}

void t6_charge_unregister(struct t6_platform *priv)
{
	/*
	 * Remove the threshold attributes first; this waits for readers and
	 * writers already inside them. A read racing module unload used to
	 * find t6_chg NULL, and the resulting oops left rmmod stuck forever.
	 */
	battery_hook_unregister(&t6_charge_hook);
	power_supply_unreg_notifier(&priv->charge_psy_nb);
	t6_charge_release(priv);
	cancel_delayed_work_sync(&priv->charge_work);
	t6_chg = NULL;
}
