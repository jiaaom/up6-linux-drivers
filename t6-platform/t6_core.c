#include <linux/acpi.h>
#include <linux/delay.h>
#include <linux/dmi.h>
#include <linux/init.h>
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/notifier.h>
#include <linux/reboot.h>
#include <linux/slab.h>

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
		 "take fan control from the EC at probe (default: true; otherwise the EC ignores PWM writes until pwmN_enable=1)");

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

bool t6_keys_enabled;
module_param_named(enable_keys, t6_keys_enabled, bool, 0444);
MODULE_PARM_DESC(enable_keys,
		 "register the front-panel buttons as KEY_POWER (power) and KEY_PROG1 (reset pinhole) (default: false; a power tap then triggers logind's HandlePowerKey policy)");

bool t6_keys_active_low = true;
module_param_named(keys_active_low, t6_keys_active_low, bool, 0444);
MODULE_PARM_DESC(keys_active_low,
		 "front-panel EC key bits are active-low (default: true; confirmed on hardware)");

static struct t6_platform *t6;

static const u8 t6_pwm_addresses[] = { 0x0a, 0x0d, 0x5c };

static int t6_write_all_pwm(struct t6_platform *priv, u8 percent)
{
	unsigned int i;
	int ret;

	for (i = 0; i < ARRAY_SIZE(t6_pwm_addresses); i++) {
		ret = t6_ec_write(priv, t6_pwm_addresses[i], percent);
		if (ret)
			return ret;
	}
	return 0;
}

/*
 * The EC applies a PWM register only when it sees the value change while the
 * host bit is set, picking changes up at roughly 1 s cadence; rewriting the
 * current value or merely setting the bit does nothing. Write the duty before
 * taking control (registers read 0 at boot), then force one observed change
 * (stepping up, so it never dips below min_pwm_percent) ending at the
 * requested duty.
 */
#define T6_EC_SETTLE_MS 2000

static int t6_take_fan_control(struct t6_platform *priv)
{
	u8 init = t6_init_pwm_percent;
	u8 alt = init < 100 ? init + 1 : init - 1;
	int ret;

	ret = t6_write_all_pwm(priv, init);
	if (ret)
		return ret;
	ret = t6_ec_set_host_control(priv, true);
	if (ret)
		return ret;
	ret = t6_write_all_pwm(priv, alt);
	if (ret)
		return ret;
	msleep(T6_EC_SETTLE_MS);
	return t6_write_all_pwm(priv, init);
}

/*
 * Clearing the host bit does not make the EC recompute a duty; the fans keep
 * the last applied PWM. Park them at init_pwm_percent (and give the EC time to
 * apply it) so an unload or a reboot never leaves a low policy value in force
 * with nobody adjusting it.
 */
static int t6_release_fan_control(struct t6_platform *priv)
{
	int ret = t6_write_all_pwm(priv, t6_init_pwm_percent);

	if (ret)
		return ret;
	msleep(T6_EC_SETTLE_MS);
	return t6_ec_set_host_control(priv, false);
}

static int t6_reboot_notify(struct notifier_block *nb, unsigned long action,
			    void *data)
{
	struct t6_platform *priv = t6;
	int ret;

	if (!priv)
		return NOTIFY_DONE;
	ret = t6_charge_release(priv);
	if (ret)
		dev_warn(&priv->pdev->dev,
			 "failed to return charge control to EC: %d\n", ret);
	ret = t6_release_fan_control(priv);
	if (ret)
		dev_warn(&priv->pdev->dev,
			 "failed to return fan control to EC: %d\n", ret);
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

static int __init t6_platform_init(void)
{
	struct t6_platform *priv;
	u8 status;
	int ret;

	if (t6_min_pwm_percent > 100 || t6_init_pwm_percent > 100 ||
	    t6_init_pwm_percent < t6_min_pwm_percent)
		return -EINVAL;
	if (!t6_machine_matches()) {
		if (!t6_force)
			return -ENODEV;
		pr_warn("t6-platform: DMI does not match a T6; probing anyway (force=1)\n");
	}
	ret = t6_check_ec();
	if (ret)
		return ret;

	priv = kzalloc(sizeof(*priv), GFP_KERNEL);
	if (!priv)
		return -ENOMEM;
	mutex_init(&priv->ec_lock);
	priv->pdev = platform_device_register_simple("t6-platform", -1,
							     NULL, 0);
	if (IS_ERR(priv->pdev)) {
		ret = PTR_ERR(priv->pdev);
		goto err_free;
	}
	platform_set_drvdata(priv->pdev, priv);

	ret = t6_hwmon_register(priv);
	if (ret)
		goto err_unregister;
	ret = t6_ec_read(priv, 0x57, &status);
	if (ret)
		goto err_unregister;
	ret = t6_backlight_register(priv);
	if (ret)
		goto err_unregister;
	ret = t6_leds_register(priv);
	if (ret)
		goto err_unregister;
	/* The PCH pinctrl driver is a module; missing GPIO LEDs must not cost the fans. */
	ret = t6_gpio_leds_register(priv);
	if (ret)
		dev_warn(&priv->pdev->dev,
			 "Bluetooth/Wi-Fi GPIO LEDs unavailable: %d\n", ret);
	ret = t6_beeper_register(priv);
	if (ret)
		goto err_unregister;
	ret = t6_keys_register(priv);
	if (ret)
		goto err_unregister;
	ret = t6_battery_register(priv);
	if (ret)
		goto err_unregister;
	ret = t6_charge_register(priv);
	if (ret)
		goto err_unregister;

	t6 = priv;
	ret = register_reboot_notifier(&t6_reboot_nb);
	if (ret)
		goto err_clear;
	if (t6_host_control) {
		ret = t6_take_fan_control(priv);
		if (ret)
			goto err_notifier;
	}

	dev_info(&priv->pdev->dev,
		 "probe succeeded: EC[0x57]=0x%02x, fan control %s (init %u%%), charge thresholds %u/%u, backlight/LED/beeper/battery enabled, keys %s\n",
		 status, t6_host_control ? "host" : "EC", t6_init_pwm_percent,
		 priv->charge_start, priv->charge_end,
		 t6_keys_enabled ? "enabled" : "disabled");
	return 0;

err_notifier:
	unregister_reboot_notifier(&t6_reboot_nb);
err_clear:
	t6 = NULL;
err_unregister:
	platform_device_unregister(priv->pdev);
err_free:
	kfree(priv);
	return ret;
}

static void __exit t6_platform_exit(void)
{
	struct t6_platform *priv = t6;

	if (!priv)
		return;
	unregister_reboot_notifier(&t6_reboot_nb);
	t6_charge_unregister(priv);
	if (t6_release_fan_control(priv))
		pr_warn("t6-platform: failed to return fan control to EC\n");
	t6 = NULL;
	platform_device_unregister(priv->pdev);
	kfree(priv);
	pr_info("t6-platform: unloaded, fans parked at %u%% under EC control\n",
		t6_init_pwm_percent);
}

module_init(t6_platform_init);
module_exit(t6_platform_exit);

MODULE_DESCRIPTION("ZSpace T6 EC platform driver");
MODULE_AUTHOR("T6 driver project");
MODULE_LICENSE("GPL");
MODULE_SOFTDEP("pre: pinctrl_meteorlake");
MODULE_VERSION("0.9.8");
