#ifndef T6_PLATFORM_H
#define T6_PLATFORM_H

#include <linux/backlight.h>
#include <linux/hwmon.h>
#include <linux/input.h>
#include <linux/leds.h>
#include <linux/mutex.h>
#include <linux/notifier.h>
#include <linux/platform_device.h>
#include <linux/workqueue.h>

struct t6_platform {
	struct platform_device *pdev;
	struct device *hwmon;
	struct backlight_device *backlight;
	struct input_dev *keys;
	struct mutex ec_lock;
	/* Serialises every externally-triggered EC transaction with remove/PM. */
	struct mutex op_lock;
	struct mutex fan_lock;
	struct mutex led_lock;
	bool online;
	bool fan_manual;
	u8 fan_pwm[3];

	/* charge thresholds (t6_charge.c); start=0/end=100 means EC policy */
	struct mutex charge_lock;
	struct delayed_work charge_work;
	struct notifier_block charge_psy_nb;
	unsigned int charge_start;
	unsigned int charge_end;
	bool charge_enabled;
	bool charge_recovery_pending;
	/* Tray RGB (0xa2) breathing-speed nibble applied with every colour. */
	u8 tray_speed;
};

#define T6_EC_CTRL_REG 0x59
#define T6_EC_CTRL_HOST BIT(3)	/* host owns fan PWM (0x0a/0x0d/0x5c), backlight (0xa3), LEDs (0x50-0x56) */
#define T6_EC_CTRL_BEEPER BIT(4)
/* 0x59 bit 2 arms a 30 s EC power-off timer (0x5a); never set it. */

extern unsigned int t6_min_pwm_percent;
extern unsigned int t6_init_pwm_percent;
extern bool t6_host_control;
#define T6_FAN_COUNT 3

int t6_platform_op_begin(struct t6_platform *priv);
void t6_platform_op_end(struct t6_platform *priv);

int t6_fan_take_control(struct t6_platform *priv, bool force);
int t6_fan_full_speed(struct t6_platform *priv);
int t6_fan_release_control(struct t6_platform *priv);
int t6_fan_suspend(struct t6_platform *priv);
int t6_fan_resume(struct t6_platform *priv);

bool t6_charge_owns_battery_led(struct t6_platform *priv);
int t6_charge_suspend(struct t6_platform *priv);
int t6_charge_resume(struct t6_platform *priv);
extern unsigned int t6_charge_start_default;
extern unsigned int t6_charge_end_default;

int t6_ec_read(struct t6_platform *priv, u8 address, u8 *value);
int t6_ec_read_u16_le(struct t6_platform *priv, u8 address, u16 *value);
int t6_ec_write(struct t6_platform *priv, u8 address, u8 value);
int t6_ec_update_bits(struct t6_platform *priv, u8 address, u8 mask,
			      u8 value);
int t6_ec_set_beeper(struct t6_platform *priv, u8 mode);
int t6_ec_set_host_control(struct t6_platform *priv, bool enable);
int t6_ec_get_host_control(struct t6_platform *priv, bool *enabled);
int t6_ec_read_rpm(struct t6_platform *priv, u8 low_address, long *value);

int t6_hwmon_register(struct t6_platform *priv);
int t6_backlight_register(struct t6_platform *priv);
int t6_leds_register(struct t6_platform *priv);
int t6_gpio_leds_register(struct t6_platform *priv);
int t6_beeper_register(struct t6_platform *priv);
int t6_keys_register(struct t6_platform *priv);
void t6_keys_unregister(struct t6_platform *priv);
int t6_battery_register(struct t6_platform *priv);
int t6_charge_register(struct t6_platform *priv);
void t6_charge_unregister(struct t6_platform *priv);
int t6_charge_release(struct t6_platform *priv);

#endif
