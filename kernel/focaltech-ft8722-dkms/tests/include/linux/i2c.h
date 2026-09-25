#ifndef FT8722_TEST_I2C_H
#define FT8722_TEST_I2C_H
#include <linux/types.h>
struct device { int unused; };
struct i2c_adapter { int unused; };
struct i2c_client {
	struct device dev;
	struct i2c_adapter *adapter;
	unsigned short addr;
	int irq;
};
struct i2c_msg {
	unsigned short addr;
	unsigned short flags;
	unsigned short len;
	unsigned char *buf;
};
#define I2C_M_RD 0x0001
#endif
