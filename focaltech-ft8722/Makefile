obj-m += ft8722_ts.o

KERNELRELEASE ?= $(shell uname -r)

all:
	$(MAKE) -C /lib/modules/$(KERNELRELEASE)/build M=$(CURDIR) modules

clean:
	$(MAKE) -C /lib/modules/$(KERNELRELEASE)/build M=$(CURDIR) clean
