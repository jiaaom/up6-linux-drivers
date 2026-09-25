/* SPDX-License-Identifier: GPL-2.0 */
#ifndef ITE_IT6616_H
#define ITE_IT6616_H

#include <linux/ktime.h>
#include <linux/mutex.h>
#include <linux/types.h>

struct attribute_group;
struct dentry;
struct device;
struct i2c_client;
struct regmap;

#define IT6616_HDMI_ADDR		0x48
#define IT6616_MIPI_ADDR		0x56

#define IT6616_HDMI(bank, reg)		(0x100 * (bank) + (reg))
#define IT6616_BANK_REG			0x0f

#define IT6616_HDMI_ID0			0x00
#define IT6616_HDMI_REV			0x04
#define IT6616_HDMI_STS_5V_CLK		0x13
#define IT6616_HDMI_STS_LOCK		0x14
#define IT6616_HDMI_STS_SCDT		0x19
#define IT6616_HDMI_MUTE_CTL		0x4f
#define IT6616_HDMI_CSC			0x6b
#define IT6616_HDMI_RX_AVMUTE		0xaa
#define IT6616_HDMI_TIMING_MODE		0x98
#define IT6616_HDMI_TIMING_PCLK_LO	0x99
#define IT6616_HDMI_TIMING_PCLK_HI	0x9a
#define IT6616_HDMI_TIMING_HTOTAL_LO	0x9b
#define IT6616_HDMI_TIMING_HTOTAL_HI	0x9c
#define IT6616_HDMI_TIMING_VSYNC_HI	0xa8
#define IT6616_HDMI_TIMING_HACTIVE_LO	0x9d
#define IT6616_HDMI_TIMING_HACTIVE_HI	0x9e
#define IT6616_HDMI_TIMING_HSYNC_LO	0x9f
#define IT6616_HDMI_TIMING_HFP_LO	0xa0
#define IT6616_HDMI_TIMING_HSYNC_HI	0xa1
#define IT6616_HDMI_TIMING_VTOTAL_LO	0xa2
#define IT6616_HDMI_TIMING_VTOTAL_HI	0xa3
#define IT6616_HDMI_TIMING_VACTIVE_LO	0xa4
#define IT6616_HDMI_TIMING_VACTIVE_HI	0xa5
#define IT6616_HDMI_TIMING_VSYNC_LO	0xa6
#define IT6616_HDMI_TIMING_VFP_LO	0xa7

#define IT6616_MIPI_ID0			0x00
#define IT6616_MIPI_TX_RESET		0x05
#define IT6616_MIPI_TX_STS		0x09
#define IT6616_MIPI_LP_FIFO_STS		0x71
#define IT6616_MIPI_LP_FIFO_ERR		0x72
#define IT6616_MIPI_LP_CMD		0x73
#define IT6616_MIPI_LP_COUNT		0x74
#define IT6616_MIPI_LP_FIRE		0x75
#define IT6616_MIPI_LP_CFG0		0x3d
#define IT6616_MIPI_LP_CFG1		0x3e
#define IT6616_MIPI_LP_CFG2		0x3f
#define IT6616_MIPI_LP_FIFO_CTL		0x70
#define IT6616_MIPI_BUS			0x21
#define IT6616_MIPI_FORMAT		0x5c

#define IT6616_SLEEP_MIN_MS		120
#define IT6616_WAKE_SETTLE_MS		150
#define IT6616_DCS_TIMEOUT_MS		100
#define IT6616_DCS_POLL_MS		5

struct it6616_timing {
	u16 hactive;
	u16 htotal;
	u16 hfp;
	u16 hsync;
	u16 vactive;
	u16 vtotal;
	u16 vfp;
	u16 vsync;
	bool hpol;
	bool vpol;
	bool interlaced;
};

struct it6616_link {
	bool hdmi_5v;
	bool clock;
	bool locked;
	bool sync;
	bool av_mute;
	bool mipi_video;
};

enum it6616_panel_state {
	IT6616_PANEL_ON,
	IT6616_PANEL_OFF,
	IT6616_PANEL_SLEEP,
	IT6616_PANEL_UNKNOWN,
};

struct it6616 {
	struct device *dev;
	struct i2c_client *hdmi_client;
	struct i2c_client *mipi_client;
	struct regmap *hdmi;
	struct regmap *mipi;
	struct mutex lock;
	/* Separate from lock because regmap debugfs has no driver context. */
	struct mutex hdmi_map_lock;
	enum it6616_panel_state panel_state;
	ktime_t sleep_in_time;
	struct dentry *debugfs_dir;
	bool mipi_compatible;
	bool hdmi_restore_bank;
	bool hdmi_bank_zero;
	bool debugfs_stopped;
	bool tearing_down;
	bool suspended;
};

/*
 * Driver operations hold lock before entering regmap; the HDMI map callbacks
 * take hdmi_map_lock independently, including for regmap debugfs accesses.
 * The map callbacks must never acquire lock.
 */
int it6616_hdmi_read(struct it6616 *it, unsigned int reg, unsigned int *val);
int it6616_hdmi_update_bits(struct it6616 *it, unsigned int reg,
			    unsigned int mask, unsigned int val);

/* Caller holds it->lock for status reads and panel transitions. */
int it6616_read_link_locked(struct it6616 *it, struct it6616_link *link);
int it6616_read_timing_locked(struct it6616 *it, struct it6616_timing *timing);
int it6616_set_panel_state_locked(struct it6616 *it,
				enum it6616_panel_state target);
const char *it6616_panel_state_name(enum it6616_panel_state state);
int it6616_debugfs_init(struct it6616 *it);

extern const struct attribute_group *it6616_attr_groups[];

#endif /* ITE_IT6616_H */
