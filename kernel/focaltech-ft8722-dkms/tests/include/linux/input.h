#ifndef FT8722_TEST_INPUT_H
#define FT8722_TEST_INPUT_H
#include <linux/types.h>
struct input_dev {
	unsigned int slot;
	unsigned int active_slots;
	unsigned int seen_slots;
	unsigned int keys;
	int axes[11];
};
#define ABS_MT_POSITION_X 0
#define ABS_MT_POSITION_Y 1
#define ABS_MT_TOUCH_MAJOR 2
#define ABS_MT_TOUCH_MINOR 3
#define ABS_MT_PRESSURE 4
#define ABS_X 5
#define ABS_Y 6
#define ABS_PRESSURE 7
#define ABS_TILT_X 8
#define ABS_TILT_Y 9
#define ABS_Z 10
#define BTN_TOOL_PEN 20
#define BTN_TOUCH 21
#define BTN_STYLUS 22
#define BTN_STYLUS2 23
#define MT_TOOL_FINGER 1
#define BIT(n) (1U << (n))
#define min_t(type, a, b) ((type)(a) < (type)(b) ? (type)(a) : (type)(b))
static inline void input_mt_slot(struct input_dev *d, unsigned int slot)
{
	d->slot = slot;
}
static inline void input_mt_report_slot_state(struct input_dev *d, int tool, bool active)
{
	(void)tool;
	d->seen_slots |= BIT(d->slot);
	if (active)
		d->active_slots |= BIT(d->slot);
	else
		d->active_slots &= ~BIT(d->slot);
}
static inline void input_mt_report_slot_inactive(struct input_dev *d)
{
	input_mt_report_slot_state(d, MT_TOOL_FINGER, false);
}
static inline void input_mt_sync_frame(struct input_dev *d)
{
	d->active_slots &= d->seen_slots;
	d->seen_slots = 0;
}
static inline void input_sync(struct input_dev *d) { (void)d; }
static inline void input_report_abs(struct input_dev *d, int axis, int value)
{
	d->axes[axis] = value;
}
static inline void input_report_key(struct input_dev *d, int key, int value)
{
	if (value)
		d->keys |= BIT(key);
	else
		d->keys &= ~BIT(key);
}
#endif
