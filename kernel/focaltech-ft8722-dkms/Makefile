obj-m += ft8722_ts.o
ft8722_ts-y := ft8722_core.o ft8722_input.o

KERNELRELEASE ?= $(shell uname -r)

all:
	$(MAKE) -C /lib/modules/$(KERNELRELEASE)/build M=$(CURDIR) modules

clean:
	$(MAKE) -C /lib/modules/$(KERNELRELEASE)/build M=$(CURDIR) clean
