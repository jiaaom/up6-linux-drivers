ite_it6616-objs := it6616-core.o it6616-status.o it6616-panel.o
obj-m += ite_it6616.o

KERNELRELEASE ?= $(shell uname -r)

all:
	$(MAKE) -C /lib/modules/$(KERNELRELEASE)/build M=$(CURDIR) modules

clean:
	$(MAKE) -C /lib/modules/$(KERNELRELEASE)/build M=$(CURDIR) clean
