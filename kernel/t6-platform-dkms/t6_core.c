#include <linux/acpi.h>
#include <linux/delay.h>
#include <linux/dmi.h>
#include <linux/init.h>
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/notifier.h>
#include <linux/reboot.h>
#include <linux/slab.h>
#include <linux/string.h>

#include "t6_compat.h"
#include "t6_platform.h"

#define T6_EC_PATH "\\_SB_.PC00.LPCB.H_EC"
#define T6_BIOS_PREFIX "T6MTLJKJBOXV"

unsigned int t6_min_pwm_percent;
module_param_named(min_pwm_percent, t6_min_pwm_percent, uint, 0444);
MODULE_PARM_DESC(min_pwm_percent,
		 "minimum EC PWM percentage (default: 0; permits fan off)");

unsigned int t6_init_pwm_percent = 50;
module_param_named(init_pwm_percent, t6_init_pwm_percent, uint, 0444);
MODULE_PARM_DESC(init_pwm_percent,
		 "PWM percentage written to all fans before taking host control (default: 50)");

bool t6_host_control = true;
module_param_named(host_control, t6_host_control, bool, 0444);
MODULE_PARM_DESC(host_control,
		 "start in manual host PWM mode (default: true; false starts shared full-speed safety mode)");

unsigned int t6_charge_start_default;
module_param_named(charge_start_threshold, t6_charge_start_default, uint, 0444);
MODULE_PARM_DESC(charge_start_threshold,
		 "initial BAT0 charge_control_start_threshold (default: 0)");

unsigned int t6_charge_end_default = 100;
module_param_named(charge_end_threshold, t6_charge_end_default, uint, 0444);
MODULE_PARM_DESC(charge_end_threshold,
		 "initial BAT0 charge_control_end_threshold (default: 100 = EC policy)");

static bool t6_force;
module_param_named(force, t6_force, bool, 0444);
MODULE_PARM_DESC(force,
		 "probe on machines that fail the T6 DMI check; writes EC registers blindly (default: false)");

static struct t6_platform *t6;

#define T6_EC_SETTLE_MS 2000
static const u8 t6_pwm_addresses[T6_FAN_COUNT] = { 0x0a, 0x0d, 0x5c };

int t6_platform_op_begin(struct t6_platform *priv)
{
	mutex_lock(&priv->op_lock);
	if (!priv->online) {
		mutex_unlock(&priv->op_lock);
		return -ENODEV;
	}
	return 0;
}

void t6_platform_op_end(struct t6_platform *priv)
{
	mutex_unlock(&priv->op_lock);
}

static int t6_write_all_pwm(struct t6_platform *priv, const u8 *percent)
{
	unsigned int i;
	int ret;

	for (i = 0; i < T6_FAN_COUNT; i++) {
		ret = t6_ec_write(priv, t6_pwm_addresses[i], percent[i]);
		if (ret)
			return ret;
	}
	return 0;
}

static int t6_read_all_pwm(struct t6_platform *priv, u8 *percent)
{
	unsigned int i;
	int ret;

	for (i = 0; i < T6_FAN_COUNT; i++) {
		ret = t6_ec_read(priv, t6_pwm_addresses[i], &percent[i]);
		if (ret)
			return ret;
	}
	return 0;
}

static bool t6_pwm_equal(const u8 *a, const u8 *b)
{
	return !memcmp(a, b, T6_FAN_COUNT);
}

static int t6_program_fans_locked(struct t6_platform *priv,
					const u8 *target, bool force)
{
	u8 reg_value[T6_FAN_COUNT], alternate[T6_FAN_COUNT];
	bool host, can_force = false;
	unsigned int i;
	int ret;

	ret = t6_ec_get_host_control(priv, &host);
	if (ret)
		return ret;

	if (!host) {
		/* Preload while the EC still owns the gate, then force one observed change. */
		ret = t6_write_all_pwm(priv, target);
		if (ret)
			return ret;
		ret = t6_ec_set_host_control(priv, true);
		if (ret)
			return ret;
		force = true;
	} else if (!force) {
		ret = t6_read_all_pwm(priv, reg_value);
		if (ret)
			return ret;
		if (t6_pwm_equal(reg_value, target))
			return 0;
	}

	if (!force)
		return t6_write_all_pwm(priv, target);

	for (i = 0; i < T6_FAN_COUNT; i++) {
		if (target[i] < 100) {
			alternate[i] = target[i] + 1;
			can_force = true;
		} else if (target[i] > 0) {
			/* Force an observable transition before committing the target. */
			alternate[i] = target[i] - 1;
			can_force = true;
		} else {
			alternate[i] = target[i];
		}
	}
	if (!can_force)
		return t6_write_all_pwm(priv, target);

	ret = t6_write_all_pwm(priv, alternate);
	if (ret)
		return ret;
	msleep(T6_EC_SETTLE_MS);
	return t6_write_all_pwm(priv, target);
}

int t6_fan_take_control(struct t6_platform *priv, bool force)
{
	int ret;

	mutex_lock(&priv->fan_lock);
	ret = t6_program_fans_locked(priv, priv->fan_pwm, force);
	if (!ret)
		priv->fan_manual = true;
	mutex_unlock(&priv->fan_lock);
	return ret;
}

int t6_fan_full_speed(struct t6_platform *priv)
{
	u8 full_speed[T6_FAN_COUNT] = { 100, 100, 100 };
	int ret;

	mutex_lock(&priv->fan_lock);
	ret = t6_program_fans_locked(priv, full_speed, false);
	if (!ret)
		priv->fan_manual = false;
	mutex_unlock(&priv->fan_lock);
	return ret;
}

int t6_fan_release_control(struct t6_platform *priv)
{
	u8 parked[T6_FAN_COUNT] = {
		t6_init_pwm_percent, t6_init_pwm_percent, t6_init_pwm_percent,
	};
	int ret, clear_ret;

	mutex_lock(&priv->fan_lock);
	/* Even a clear gate or an equal register value needs a real EC transition. */
	ret = t6_program_fans_locked(priv, parked, true);
	if (!ret)
		msleep(T6_EC_SETTLE_MS);
	clear_ret = t6_ec_set_host_control(priv, false);
	if (!ret)
		ret = clear_ret;
	mutex_unlock(&priv->fan_lock);
	return ret;
}

int t6_fan_suspend(struct t6_platform *priv)
{
	return t6_fan_release_control(priv);
}

int t6_fan_resume(struct t6_platform *priv)
{
	int ret;

	mutex_lock(&priv->fan_lock);
	if (priv->fan_manual) {
		ret = t6_program_fans_locked(priv, priv->fan_pwm, true);
	} else {
		u8 full_speed[T6_FAN_COUNT] = { 100, 100, 100 };

		ret = t6_program_fans_locked(priv, full_speed, true);
	}
	mutex_unlock(&priv->fan_lock);
	return ret;
}

static int t6_reboot_notify(struct notifier_block *nb, unsigned long action,
				void *data)
{
	struct t6_platform *priv = READ_ONCE(t6);

	if (!priv)
		return NOTIFY_DONE;

	mutex_lock(&priv->op_lock);
	if (!priv->online) {
		mutex_unlock(&priv->op_lock);
		return NOTIFY_DONE;
	}
	priv->online = false;
	mutex_unlock(&priv->op_lock);
	cancel_delayed_work_sync(&priv->charge_work);

	mutex_lock(&priv->op_lock);
	if (t6_charge_release(priv))
		dev_warn(&priv->pdev->dev, "failed to return charge control to EC\n");
	if (t6_fan_release_control(priv))
		dev_warn(&priv->pdev->dev, "failed to return fan control to EC\n");
	mutex_unlock(&priv->op_lock);
	return NOTIFY_DONE;
}

static struct notifier_block t6_reboot_nb = {
	.notifier_call = t6_reboot_notify,
};

static bool t6_machine_matches(void)
{
	const char *vendor = dmi_get_system_info(DMI_SYS_VENDOR);
	const char *product = dmi_get_system_info(DMI_PRODUCT_NAME);
	const char *bios = dmi_get_system_info(DMI_BIOS_VERSION);

	return vendor && !strcmp(vendor, "Insyde") &&
	       product && !strcmp(product, "MeteorLake") &&
	       bios && !strncmp(bios, T6_BIOS_PREFIX, strlen(T6_BIOS_PREFIX));
}

static int t6_check_ec(void)
{
	acpi_handle handle;

	return ACPI_FAILURE(acpi_get_handle(NULL, T6_EC_PATH, &handle)) ?
		-ENODEV : 0;
}

static int t6_platform_probe(struct platform_device *pdev)
{
	struct t6_platform *priv;
	u8 status;
	bool charge_registered = false;
	bool fan_started = false;
	int ret;

	priv = devm_kzalloc(&pdev->dev, sizeof(*priv), GFP_KERNEL);
	if (!priv)
		return -ENOMEM;
	priv->pdev = pdev;
	mutex_init(&priv->ec_lock);
	mutex_init(&priv->op_lock);
	mutex_init(&priv->fan_lock);
	mutex_init(&priv->led_lock);
	priv->tray_speed = 0;
	priv->fan_manual = t6_host_control;
	memset(priv->fan_pwm, t6_init_pwm_percent, sizeof(priv->fan_pwm));
	platform_set_drvdata(pdev, priv);

	ret = t6_hwmon_register(priv);
	if (ret)
		return ret;
	ret = t6_ec_read(priv, 0x57, &status);
	if (ret)
		return ret;
	ret = t6_backlight_register(priv);
	if (ret)
		return ret;
	ret = t6_leds_register(priv);
	if (ret)
		return ret;
	/* The PCH pinctrl driver is a module; missing GPIO LEDs must not cost the fans. */
	ret = t6_gpio_leds_register(priv);
	if (ret)
		dev_warn(&pdev->dev, "Bluetooth/Wi-Fi GPIO LEDs unavailable: %d\n", ret);
	ret = t6_beeper_register(priv);
	if (ret)
		goto err_charge;
	ret = t6_keys_register(priv);
	if (ret)
		goto err_charge;
	ret = t6_battery_register(priv);
	if (ret)
		goto err_charge;
	ret = t6_charge_register(priv);
	if (ret)
		goto err_charge;
	charge_registered = true;
	fan_started = true;
	if (t6_host_control)
		ret = t6_fan_take_control(priv, false);
	else
		ret = t6_fan_full_speed(priv);
	if (ret)
		goto err_charge;

	priv->online = true;
	WRITE_ONCE(t6, priv);
	ret = register_reboot_notifier(&t6_reboot_nb);
	if (ret)
		goto err_online;
	ret = t6_charge_resume(priv);
	if (ret)
		dev_warn(&pdev->dev, "initial charge policy apply failed: %d\n", ret);

	dev_info(&pdev->dev,
		 "probe succeeded: EC[0x57]=0x%02x, fan mode %s (init %u%%), charge thresholds %u/%u, backlight/LED/beeper/battery enabled, power button %s\n",
		 status, priv->fan_manual ? "manual" : "full-speed", t6_init_pwm_percent,
		 priv->charge_start, priv->charge_end,
		 priv->keys ? "enabled" : "unavailable");
	return 0;

err_online:
	WRITE_ONCE(t6, NULL);
	mutex_lock(&priv->op_lock);
	priv->online = false;
	mutex_unlock(&priv->op_lock);
err_charge:
	if (fan_started)
		t6_fan_release_control(priv);
	if (charge_registered) {
		t6_charge_release(priv);
		t6_charge_unregister(priv);
	}
	t6_keys_unregister(priv);
	return ret;
}

static T6_PLATFORM_REMOVE_RET t6_platform_remove(struct platform_device *pdev)
{
	struct t6_platform *priv = platform_get_drvdata(pdev);

	mutex_lock(&priv->op_lock);
	priv->online = false;
	mutex_unlock(&priv->op_lock);
	if (READ_ONCE(t6) == priv)
		unregister_reboot_notifier(&t6_reboot_nb);
	cancel_delayed_work_sync(&priv->charge_work);
	t6_charge_unregister(priv);

	if (t6_charge_release(priv))
		dev_warn(&pdev->dev, "failed to return charge policy to EC\n");
	if (t6_fan_release_control(priv))
		dev_warn(&pdev->dev, "failed to park fans before removal\n");
	t6_keys_unregister(priv);
	if (READ_ONCE(t6) == priv)
		WRITE_ONCE(t6, NULL);
	T6_PLATFORM_REMOVE_RETURN();
}

static int t6_platform_suspend(struct device *dev)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	int charge_ret, fan_ret, restore_ret;

	mutex_lock(&priv->op_lock);
	if (!priv->online) {
		mutex_unlock(&priv->op_lock);
		return 0;
	}
	priv->online = false;
	mutex_unlock(&priv->op_lock);
	cancel_delayed_work_sync(&priv->charge_work);

	mutex_lock(&priv->op_lock);
	charge_ret = t6_charge_suspend(priv);
	fan_ret = t6_fan_suspend(priv);
	if (!charge_ret && !fan_ret) {
		mutex_unlock(&priv->op_lock);
		return 0;
	}
	dev_err(dev, "failed to quiesce EC ownership on suspend: charge=%d fan=%d\n",
		charge_ret, fan_ret);
	/* Do not leave the machine suspended with host charging or low fans. */
	restore_ret = t6_fan_resume(priv);
	if (restore_ret)
		dev_err(dev, "failed to restore fan control after aborted suspend: %d\n",
			restore_ret);
	restore_ret = t6_charge_resume(priv);
	if (restore_ret)
		dev_err(dev, "failed to restore charge policy after aborted suspend: %d\n",
			restore_ret);
	priv->online = true;
	mutex_unlock(&priv->op_lock);
	return charge_ret ? charge_ret : fan_ret;
}

static int t6_platform_resume(struct device *dev)
{
	struct t6_platform *priv = dev_get_drvdata(dev);
	int ret, charge_ret;

	mutex_lock(&priv->op_lock);
	if (priv->online) {
		mutex_unlock(&priv->op_lock);
		return 0;
	}
	ret = t6_fan_resume(priv);
	if (ret) {
		dev_err(dev, "failed to restore fan control on resume: %d\n", ret);
		t6_fan_release_control(priv);
		mutex_unlock(&priv->op_lock);
		return ret;
	}
	charge_ret = t6_charge_resume(priv);
	priv->online = true;
	mutex_unlock(&priv->op_lock);
	if (charge_ret)
		dev_warn(dev, "failed to restore charge policy on resume: %d\n",
			 charge_ret);
	return charge_ret;
}

static const struct dev_pm_ops t6_platform_pm_ops = {
	.suspend = t6_platform_suspend,
	.resume = t6_platform_resume,
};

static struct platform_driver t6_platform_driver = {
	.probe = t6_platform_probe,
	.remove = t6_platform_remove,
	.driver = {
		.name = "t6-platform",
		.pm = &t6_platform_pm_ops,
	},
};

static struct platform_device *t6_pdev;

static int __init t6_platform_init(void)
{
	int ret;

	if (t6_min_pwm_percent > 100 || t6_init_pwm_percent > 100 ||
	    t6_init_pwm_percent < t6_min_pwm_percent ||
	    (t6_min_pwm_percent == 100 && t6_init_pwm_percent == 100))
		return -EINVAL;
	if (!t6_machine_matches()) {
		if (!t6_force)
			return -ENODEV;
		pr_warn("t6-platform: DMI does not match a T6; probing anyway (force=1)\n");
	}
	ret = t6_check_ec();
	if (ret)
		return ret;

	ret = platform_driver_register(&t6_platform_driver);
	if (ret)
		return ret;
	t6_pdev = platform_device_register_simple("t6-platform", -1, NULL, 0);
	if (IS_ERR(t6_pdev)) {
		ret = PTR_ERR(t6_pdev);
		t6_pdev = NULL;
		platform_driver_unregister(&t6_platform_driver);
		return ret;
	}
	if (!READ_ONCE(t6)) {
		platform_device_unregister(t6_pdev);
		t6_pdev = NULL;
		platform_driver_unregister(&t6_platform_driver);
		return -ENODEV;
	}
	return 0;
}

static void __exit t6_platform_exit(void)
{
	if (t6_pdev)
		platform_device_unregister(t6_pdev);
	platform_driver_unregister(&t6_platform_driver);
	pr_info("t6-platform: unloaded\n");
}

module_init(t6_platform_init);
module_exit(t6_platform_exit);

MODULE_DESCRIPTION("ZSpace T6 EC platform driver");
MODULE_AUTHOR("T6 driver project");
MODULE_LICENSE("GPL");
MODULE_SOFTDEP("pre: pinctrl_meteorlake");
MODULE_VERSION("0.9.13");
