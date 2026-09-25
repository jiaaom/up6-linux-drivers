// SPDX-License-Identifier: GPL-2.0
/* Live bridge status and panel/mute sysfs controls. */
#include <linux/capability.h>
#include <linux/device.h>
#include <linux/kernel.h>
#include <linux/regmap.h>
#include <linux/sysfs.h>

#include "it6616.h"

int it6616_read_link_locked(struct it6616 *it, struct it6616_link *link)
{
	unsigned int clk, lock, scdt, avmute, tx;
	int ret;

	ret = it6616_hdmi_read(it, IT6616_HDMI_STS_5V_CLK, &clk);
	if (ret)
		return ret;
	ret = it6616_hdmi_read(it, IT6616_HDMI_STS_LOCK, &lock);
	if (ret)
		return ret;
	ret = it6616_hdmi_read(it, IT6616_HDMI_STS_SCDT, &scdt);
	if (ret)
		return ret;
	ret = it6616_hdmi_read(it, IT6616_HDMI_RX_AVMUTE, &avmute);
	if (ret)
		return ret;
	ret = regmap_read(it->mipi, IT6616_MIPI_TX_STS, &tx);
	if (ret)
		return ret;

	link->hdmi_5v = clk & BIT(0);
	link->clock = clk & BIT(4);
	link->locked = (lock & GENMASK(5, 3)) == GENMASK(5, 3);
	link->sync = scdt & BIT(7);
	link->av_mute = avmute & BIT(3);
	link->mipi_video = tx & BIT(6);
	return 0;
}

int it6616_read_timing_locked(struct it6616 *it,
					     struct it6616_timing *timing)
{
	static const unsigned int regs[] = {
		IT6616_HDMI_TIMING_MODE,
		IT6616_HDMI_TIMING_HTOTAL_LO,
		IT6616_HDMI_TIMING_HTOTAL_HI,
		IT6616_HDMI_TIMING_HACTIVE_LO,
		IT6616_HDMI_TIMING_HACTIVE_HI,
		IT6616_HDMI_TIMING_HSYNC_LO,
		IT6616_HDMI_TIMING_HFP_LO,
		IT6616_HDMI_TIMING_HSYNC_HI,
		IT6616_HDMI_TIMING_VTOTAL_LO,
		IT6616_HDMI_TIMING_VTOTAL_HI,
		IT6616_HDMI_TIMING_VACTIVE_LO,
		IT6616_HDMI_TIMING_VACTIVE_HI,
		IT6616_HDMI_TIMING_VSYNC_LO,
		IT6616_HDMI_TIMING_VFP_LO,
		IT6616_HDMI_TIMING_VSYNC_HI,
		IT6616_HDMI_RX_AVMUTE,
	};
	unsigned int mode, htotal_lo, htotal_hi, hactive_lo, hactive_hi;
	unsigned int hsync_lo, hfp_lo, hsync_hi;
	unsigned int vtotal_lo, vtotal_hi, vactive_lo, vactive_hi;
	unsigned int vsync_lo, vfp_lo, vfp_hi, polarity;
	unsigned int *values[] = {
		&mode, &htotal_lo, &htotal_hi, &hactive_lo, &hactive_hi,
		&hsync_lo, &hfp_lo, &hsync_hi, &vtotal_lo, &vtotal_hi,
		&vactive_lo, &vactive_hi, &vsync_lo, &vfp_lo, &vfp_hi,
		&polarity,
	};
	int i, ret;

	for (i = 0; i < ARRAY_SIZE(regs); i++) {
		ret = it6616_hdmi_read(it, regs[i], values[i]);
		if (ret)
			return ret;
	}

	timing->htotal = htotal_lo | ((htotal_hi & 0x3f) << 8);
	timing->hactive = hactive_lo | ((hactive_hi & 0x3f) << 8);
	timing->hfp = hfp_lo | (((hsync_hi >> 4) & 0x0f) << 8);
	timing->hsync = hsync_lo | ((hsync_hi & BIT(0)) << 8);
	timing->vtotal = vtotal_lo | ((vtotal_hi & 0x3f) << 8);
	timing->vactive = vactive_lo | ((vactive_hi & 0x3f) << 8);
	timing->vfp = vfp_lo | (((vfp_hi >> 4) & 0x0f) << 8);
	timing->vsync = vsync_lo | ((vfp_hi & BIT(0)) << 8);
	timing->hpol = polarity & BIT(5);
	timing->vpol = polarity & BIT(6);
	timing->interlaced = mode & BIT(1);
	return 0;
}

static const char *it6616_mipi_format(unsigned int format)
{
	return format == 0xe0 ? "rgb888" : "unknown";
}

static ssize_t link_status_show(struct device *dev,
					struct device_attribute *attr, char *buf)
{
	struct it6616 *it = dev_get_drvdata(dev);
	struct it6616_link link;
	int ret;

	mutex_lock(&it->lock);
	if (it->suspended)
		ret = -EAGAIN;
	else
		ret = it6616_read_link_locked(it, &link);
	mutex_unlock(&it->lock);
	if (ret)
		return ret;

	return sysfs_emit(buf,
			  "hdmi_5v=%u clock=%u locked=%u sync=%u av_mute=%u mipi_video=%u\n",
			  link.hdmi_5v, link.clock, link.locked, link.sync,
			  link.av_mute, link.mipi_video);
}
static DEVICE_ATTR_RO(link_status);

static ssize_t timings_show(struct device *dev,
				   struct device_attribute *attr, char *buf)
{
	struct it6616 *it = dev_get_drvdata(dev);
	struct it6616_timing timing;
	int ret;

	mutex_lock(&it->lock);
	if (it->suspended)
		ret = -EAGAIN;
	else
		ret = it6616_read_timing_locked(it, &timing);
	mutex_unlock(&it->lock);
	if (ret)
		return ret;

	return sysfs_emit(buf,
			  "%ux%u htotal=%u vtotal=%u hfp=%u hsync=%u vfp=%u vsync=%u hpol=%c vpol=%c %s\n",
			  timing.hactive, timing.vactive, timing.htotal,
			  timing.vtotal, timing.hfp, timing.hsync, timing.vfp,
			  timing.vsync, timing.hpol ? '+' : '-',
			  timing.vpol ? '+' : '-',
			  timing.interlaced ? "interlaced" : "progressive");
}
static DEVICE_ATTR_RO(timings);

static ssize_t mipi_show(struct device *dev,
				struct device_attribute *attr, char *buf)
{
	struct it6616 *it = dev_get_drvdata(dev);
	unsigned int bus, format, reset, status;
	const char *tx;
	int ret;

	mutex_lock(&it->lock);
	if (it->suspended)
		ret = -EAGAIN;
	else {
		ret = regmap_read(it->mipi, IT6616_MIPI_BUS, &bus);
		if (!ret)
			ret = regmap_read(it->mipi, IT6616_MIPI_FORMAT, &format);
		if (!ret)
			ret = regmap_read(it->mipi, IT6616_MIPI_TX_RESET, &reset);
		if (!ret)
			ret = regmap_read(it->mipi, IT6616_MIPI_TX_STS, &status);
	}
	mutex_unlock(&it->lock);
	if (ret)
		return ret;

	if (reset != 0)
		tx = "reset";
	else if (status & BIT(6))
		tx = "running";
	else
		tx = "unstable";
	return sysfs_emit(buf, "dsi lanes=%u format=%s tx=%s\n",
			  ((bus >> 4) & 0x3) + 1, it6616_mipi_format(format), tx);
}
static DEVICE_ATTR_RO(mipi);

static ssize_t panel_show(struct device *dev,
				 struct device_attribute *attr, char *buf)
{
	struct it6616 *it = dev_get_drvdata(dev);
	enum it6616_panel_state state;

	mutex_lock(&it->lock);
	state = it->panel_state;
	mutex_unlock(&it->lock);
	return sysfs_emit(buf, "%s\n", it6616_panel_state_name(state));
}

static ssize_t panel_store(struct device *dev,
				  struct device_attribute *attr,
				  const char *buf, size_t count)
{
	struct it6616 *it = dev_get_drvdata(dev);
	enum it6616_panel_state target;
	int ret;

	if (!capable(CAP_SYS_ADMIN))
		return -EPERM;
	if (sysfs_streq(buf, "on"))
		target = IT6616_PANEL_ON;
	else if (sysfs_streq(buf, "off"))
		target = IT6616_PANEL_OFF;
	else if (sysfs_streq(buf, "sleep"))
		target = IT6616_PANEL_SLEEP;
	else
		return -EINVAL;

	mutex_lock(&it->lock);
	if (it->suspended || it->tearing_down)
		ret = -EAGAIN;
	else if (!it->mipi_compatible)
		ret = -ENODEV;
	else
		ret = it6616_set_panel_state_locked(it, target);
	mutex_unlock(&it->lock);
	return ret ? ret : count;
}
static DEVICE_ATTR_RW(panel);

static ssize_t mute_show(struct device *dev,
				struct device_attribute *attr, char *buf)
{
	struct it6616 *it = dev_get_drvdata(dev);
	unsigned int value;
	int ret;

	mutex_lock(&it->lock);
	if (it->suspended)
		ret = -EAGAIN;
	else
		ret = it6616_hdmi_read(it, IT6616_HDMI_MUTE_CTL, &value);
	mutex_unlock(&it->lock);
	if (ret)
		return ret;
	return sysfs_emit(buf, "%u\n", !!(value & BIT(5)));
}

static ssize_t mute_store(struct device *dev,
				 struct device_attribute *attr,
				 const char *buf, size_t count)
{
	struct it6616 *it = dev_get_drvdata(dev);
	unsigned int value;
	int ret;

	if (!capable(CAP_SYS_ADMIN))
		return -EPERM;
	ret = kstrtouint(buf, 0, &value);
	if (ret || value > 1)
		return -EINVAL;

	mutex_lock(&it->lock);
	if (it->suspended || it->tearing_down)
		ret = -EAGAIN;
	else
		ret = it6616_hdmi_update_bits(it, IT6616_HDMI_MUTE_CTL, BIT(5),
					      value ? BIT(5) : 0);
	mutex_unlock(&it->lock);
	return ret ? ret : count;
}
static DEVICE_ATTR_RW(mute);

static struct attribute *it6616_attrs[] = {
	&dev_attr_link_status.attr,
	&dev_attr_timings.attr,
	&dev_attr_mipi.attr,
	&dev_attr_panel.attr,
	&dev_attr_mute.attr,
	NULL,
};

static const struct attribute_group it6616_attr_group = {
	.attrs = it6616_attrs,
};

const struct attribute_group *it6616_attr_groups[] = {
	&it6616_attr_group,
	NULL,
};

