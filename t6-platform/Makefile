obj-m += t6_platform.o
t6_platform-y := t6_core.o t6_ec.o t6_hwmon.o t6_backlight.o t6_leds.o t6_gpio_leds.o t6_beeper.o t6_keys.o t6_battery.o t6_charge.o

KERNELRELEASE ?= $(shell uname -r)

all:
	$(MAKE) -C /lib/modules/$(KERNELRELEASE)/build M=$(CURDIR) modules

clean:
	$(MAKE) -C /lib/modules/$(KERNELRELEASE)/build M=$(CURDIR) clean
