/* SPDX-License-Identifier: GPL-2.0 */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <sys/types.h>
typedef uint8_t u8;
typedef uint16_t u16;
#define BIT(n) (1U<<(n))
#define GENMASK(h,l) (((1U<<((h)+1))-1)&~((1U<<(l))-1))
#define FIELD_GET(m,v) (((v)&(m))>>__builtin_ctz(m))
#define ARRAY_SIZE(a) (sizeof(a)/sizeof((a)[0]))
#define DIV_ROUND_CLOSEST(n,d) (((n)+(d)/2)/(d))
#define READ_ONCE(v) (v)
#define WRITE_ONCE(v,n) ((v)=(n))
#define container_of(p,t,m) ((t *)((char *)(p)-offsetof(t,m)))
#define lockdep_assert_held(p) ((void)(p))
#define msecs_to_jiffies(n) (n)
#define NOTIFY_OK 1
#define PSY_EVENT_PROP_CHANGED 1
#define dev_warn_ratelimited(...) ((void)0)
#define dev_warn(...) ((void)0)
#define dev_err(...) ((void)0)
struct mutex { pthread_mutex_t value; };
static void mutex_init(struct mutex *m) { assert(!pthread_mutex_init(&m->value,NULL)); }
static void mutex_lock(struct mutex *m) { assert(!pthread_mutex_lock(&m->value)); }
static void mutex_unlock(struct mutex *m) { assert(!pthread_mutex_unlock(&m->value)); }
struct work_struct { unsigned int unused; };
struct delayed_work { struct work_struct work; bool pending; };
struct notifier_block { unsigned int unused; };
struct device { void *data; };
struct platform_device { struct device dev; };
struct device_attribute { unsigned int unused; };
enum led_brightness { LED_OFF, LED_FULL=255 };
struct led_classdev { unsigned int unused; };
static int system_freezable_wq;
static void mod_delayed_work(int wq, struct delayed_work *w, unsigned long n) { (void)wq;(void)n; w->pending=true; }
static void cancel_delayed_work(struct delayed_work *w) { w->pending=false; }
static void *dev_get_drvdata(struct device *dev) { return dev->data; }
static bool sysfs_streq(const char *a,const char *b) { return !strcmp(a,b); }
static int sysfs_emit(char *buf,const char *fmt,...) { va_list a;va_start(a,fmt);int n=vsnprintf(buf,4096,fmt,a);va_end(a);return n; }
static u8 registers[256], applied[3], observed[3];
static const u8 fan_addresses[3]={0x0a,0x0d,0x5c};
static int fail_read=-1, fail_write=-1;
static int ec_read(u8 a,u8 *v) { if(a==fail_read) {fail_read=-1;return -EIO;} *v=registers[a];return 0; }
static int ec_write(u8 a,u8 v) { if(a==fail_write) {fail_write=-1;return -EIO;} registers[a]=v;return 0; }
static unsigned long elapsed_ms, next_sample_ms = 1000;
static void msleep(unsigned int ms)
{
	elapsed_ms += ms;
	while (next_sample_ms <= elapsed_ms) {
		for (unsigned int i = 0; i < 3; i++) {
			u8 value = registers[fan_addresses[i]];
			if ((registers[0x59] & 8) && value != observed[i])
				applied[i] = value;
			observed[i] = value;
		}
		next_sample_ms += 1000;
	}
}
unsigned int t6_init_pwm_percent=50, t6_min_pwm_percent;
