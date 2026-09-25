/* SPDX-License-Identifier: GPL-2.0 */
/* Compile the production parser/IRQ path against a small input-state model. */
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

#include "../ft8722.h"

bool ft8722_dump_frames;
bool ft8722_deghost = true;
static unsigned int read_calls;
static unsigned int fail_on_call;
static u32 now_ms;
static unsigned int detected_calls;
static u32 detected_run_ms;

u32 ft8722_now_ms(void)
{
	return now_ms;
}

void ft8722_phantom_detected(struct ft8722 *ts, u32 run_ms)
{
	(void)ts;
	detected_calls++;
	detected_run_ms = run_ms;
}

int ft8722_read(struct ft8722 *ts, u8 reg, u8 *buf, size_t len)
{
	(void)ts;
	(void)reg;
	(void)buf;
	(void)len;
	return ++read_calls == fail_on_call ? -EIO : 0;
}

static void set_point(u8 *p, u8 flag, u8 id, unsigned int x, unsigned int y)
{
	p[0] = (flag << 6) | ((x >> 8) & 0x0f);
	p[1] = x;
	p[2] = (id << 4) | ((y >> 8) & 0x0f);
	p[3] = y;
	p[4] = 20;
	p[5] = 12;
}

static void report_down(struct ft8722 *ts)
{
	read_calls = 0;
	fail_on_call = 0;
	memset(ts->buf, 0, sizeof(ts->buf));
	ts->buf[1] = 1;
	set_point(&ts->buf[FT8722_V1_HDR], FT8722_FLAG_DOWN, 0, 100, 200);
	ft8722_input_irq(0, ts);
	assert(ts->touch->active_slots == BIT(0));
	assert(ts->touch->axes[ABS_MT_POSITION_X] == FT8722_MAX_X - 100);
	assert(ts->touch->axes[ABS_MT_POSITION_Y] == FT8722_MAX_Y - 200);
}

static void test_initial_read_failure(void)
{
	struct input_dev touch = { 0 }, pen = { 0 };
	struct i2c_client client = { 0 };
	struct ft8722 ts = { .client = &client, .touch = &touch, .pen = &pen };

	report_down(&ts);
	/* A barrel button must be released even if the last range flag was clear. */
	pen.keys = BIT(BTN_STYLUS);
	fail_on_call = read_calls + 1;
	ft8722_input_irq(0, &ts);
	assert(touch.active_slots == 0);
	assert(pen.keys == 0);
}

static void test_continuation_failure(void)
{
	struct input_dev touch = { 0 }, pen = { 0 };
	struct i2c_client client = { 0 };
	struct ft8722 ts = { .client = &client, .touch = &touch, .pen = &pen };

	report_down(&ts);
	ts.pen_in_range = true;
	pen.keys = BIT(BTN_TOUCH) | BIT(BTN_TOOL_PEN);
	read_calls = 0;
	fail_on_call = 2;
	ts.buf[1] = (FT8722_EV_V2 << 4) | 3;
	ft8722_input_irq(0, &ts);
	assert(touch.active_slots == 0);
	assert(pen.keys == 0);
	assert(!ts.pen_in_range);
}

static void test_malformed_frame_is_atomic(void)
{
	struct input_dev touch = { 0 }, pen = { 0 };
	struct i2c_client client = { 0 };
	struct ft8722 ts = { .client = &client, .touch = &touch, .pen = &pen };

	report_down(&ts);
	ts.buf[1] = 2;
	set_point(&ts.buf[FT8722_V1_HDR], FT8722_FLAG_CONTACT, 0, 10, 10);
	set_point(&ts.buf[FT8722_V1_HDR + FT8722_V1_POINT],
		  FT8722_FLAG_CONTACT, 1, 4095, 10);
	ft8722_input_irq(0, &ts);
	assert(touch.active_slots == 0);
	/* Neither the valid prefix nor the invalid coordinate reached the consumer. */
	assert(touch.axes[ABS_MT_POSITION_X] == FT8722_MAX_X - 100);
	assert(touch.axes[ABS_MT_POSITION_Y] == FT8722_MAX_Y - 200);
}

static void test_duplicate_contacts_and_zero_count(void)
{
	struct input_dev touch = { 0 }, pen = { 0 };
	struct i2c_client client = { 0 };
	struct ft8722 ts = { .client = &client, .touch = &touch, .pen = &pen };

	report_down(&ts);
	ts.buf[1] = 2;
	set_point(&ts.buf[FT8722_V1_HDR], FT8722_FLAG_CONTACT, 1, 10, 10);
	set_point(&ts.buf[FT8722_V1_HDR + FT8722_V1_POINT],
		  FT8722_FLAG_DOWN, 1, 20, 20);
	ft8722_input_irq(0, &ts);
	assert(touch.active_slots == 0);
	assert(touch.axes[ABS_MT_POSITION_X] == FT8722_MAX_X - 100);
	report_down(&ts);
	ts.buf[1] = 0;
	ft8722_input_irq(0, &ts);
	assert(touch.active_slots == 0);
}

/* One frame of `n` distinct, in-range contacts, as the phantom state sends. */
static void phantom_frame(struct ft8722 *ts, unsigned int n, u32 at_ms)
{
	unsigned int i;

	now_ms = at_ms;
	read_calls = 0;
	fail_on_call = 0;
	memset(ts->buf, 0, sizeof(ts->buf));
	ts->buf[1] = n;
	for (i = 0; i < n; i++)
		set_point(&ts->buf[FT8722_V1_HDR + i * FT8722_V1_POINT],
			  FT8722_FLAG_CONTACT, i, 300 + i, 400 + i);
	ft8722_input_irq(0, ts);
}

static void test_phantom_frames_dropped(void)
{
	struct input_dev touch = { 0 }, pen = { 0 };
	struct i2c_client client = { 0 };
	struct ft8722 ts = { .client = &client, .touch = &touch, .pen = &pen };

	detected_calls = 0;
	report_down(&ts);
	phantom_frame(&ts, 9, 1000);
	assert(touch.active_slots == 0);	/* the real contact is released */
	/* Only the header is read: nothing of the phantom frame is reported. */
	assert(read_calls == 1);
	assert(touch.axes[ABS_MT_POSITION_X] == FT8722_MAX_X - 100);
	phantom_frame(&ts, 10, 1016);
	assert(touch.active_slots == 0);
	assert(detected_calls == 0);
	/* Six contacts are still a hand. */
	phantom_frame(&ts, 6, 3000);
	assert(touch.active_slots == 0x3f);
}

static void test_phantom_run_triggers_recovery(void)
{
	struct input_dev touch = { 0 }, pen = { 0 };
	struct i2c_client client = { 0 };
	struct ft8722 ts = { .client = &client, .touch = &touch, .pen = &pen };
	u32 t;

	detected_calls = 0;
	for (t = 1000; t < 1480; t += 16)
		phantom_frame(&ts, 9, t);
	/* A small frame inside the run does not restart it... */
	phantom_frame(&ts, 1, 1485);
	assert(detected_calls == 0);
	phantom_frame(&ts, 9, 1500);
	assert(detected_calls == 1 && detected_run_ms == 500);
	/* ...but a pause longer than the gap does. */
	detected_calls = 0;
	phantom_frame(&ts, 9, 1500 + FT8722_PHANTOM_GAP_MS + 1);
	phantom_frame(&ts, 9, 1900);
	assert(detected_calls == 0);
}

static void test_deghost_off_reports_everything(void)
{
	struct input_dev touch = { 0 }, pen = { 0 };
	struct i2c_client client = { 0 };
	struct ft8722 ts = { .client = &client, .touch = &touch, .pen = &pen };

	detected_calls = 0;
	ft8722_deghost = false;
	phantom_frame(&ts, 9, 1000);
	phantom_frame(&ts, 9, 2000);
	ft8722_deghost = true;
	assert(touch.active_slots == 0x1ff);
	assert(detected_calls == 0);
}

int main(void)
{
	test_initial_read_failure();
	test_continuation_failure();
	test_malformed_frame_is_atomic();
	test_duplicate_contacts_and_zero_count();
	test_phantom_frames_dropped();
	test_phantom_run_triggers_recovery();
	test_deghost_off_reports_everything();
	puts("ft8722 regressions: PASS");
	return 0;
}
