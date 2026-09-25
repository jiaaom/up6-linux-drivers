/* SPDX-License-Identifier: GPL-2.0 */
#ifndef FT8722_H
#define FT8722_H

#include <linux/interrupt.h>
#include <linux/i2c.h>
#include <linux/input.h>
#include <linux/types.h>

#include "ft8722_proto.h"

struct ft8722_contact {
	u8 id;
	u8 flag;
	u16 x;
	u16 y;
	u8 major;
	u8 minor;
	u8 weight;
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

extern bool ft8722_dump_frames;

int ft8722_read(struct ft8722 *ts, u8 reg, u8 *buf, size_t len);
void ft8722_input_release_all(struct ft8722 *ts);
irqreturn_t ft8722_input_irq(int irq, void *data);

#endif
