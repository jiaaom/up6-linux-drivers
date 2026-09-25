/* SPDX-License-Identifier: GPL-2.0 */
/*
 * FocalTech FT8722 I2C touch protocol.
 *
 * Recovered from the vendor focaltech_tp.ko (BTF + disassembly of
 * fts_irq_handler / fts_input_report_b) and validated on hardware.
 * Nothing here is copied from any driver source.
 */
#ifndef FT8722_PROTO_H
#define FT8722_PROTO_H

#include <linux/types.h>

/* Registers */
#define FT8722_REG_TOUCH	0x01	/* start of the event frame */
#define FT8722_REG_CHIP_ID_H	0xa3
#define FT8722_REG_CHIP_ID_L	0x9f
#define FT8722_REG_FW_VER	0xa6
#define FT8722_REG_VENDOR_ID	0xa8

/* Panel geometry the controller reports in (portrait 1080x2160, 68x136 mm active area measured on the T6) */
#define FT8722_MAX_X		1079
#define FT8722_MAX_Y		2159
#define FT8722_WIDTH_MM		68
#define FT8722_HEIGHT_MM	136
#define FT8722_RES_PX_PER_MM	((FT8722_MAX_X + 1) / FT8722_WIDTH_MM)	/* 15 */
#define FT8722_MAX_FINGERS	10

/*
 * Frame: the vendor reads FT8722_FRAME_LEN bytes from FT8722_REG_TOUCH and
 * fetches the remainder (starting at FT8722_REG_TOUCH + FT8722_FRAME_LEN)
 * when the type/count say the frame is longer.
 *
 *   buf[0]   status / mode (unused)
 *   buf[1]   bits 7:4 event type (FT8722_EV_*), bits 3:0 contact count
 *            (for FT8722_EV_DEFAULT the whole byte is the count)
 */
#define FT8722_FRAME_LEN	21
#define FT8722_BUF_LEN		(4 + FT8722_MAX_FINGERS * 8)

#define FT8722_EV_DEFAULT	0x0	/* 6-byte points from buf[2] */
#define FT8722_EV_V2		0x2	/* 8-byte points from buf[4] */
#define FT8722_EV_EXTRA		0x8	/* v1 points + trailing blob; not supported */
#define FT8722_EV_PEN		0xb	/* 15-byte stylus frame */
/* whole-byte values of buf[1] the vendor special-cases */
#define FT8722_EV_BYTE_FW_INIT	0x81	/* controller (re)initialised */
#define FT8722_EV_BYTE_ERROR	0xff	/* with buf[2..4] also 0xff: IC fault */

/* Per-contact event flag (bits 7:6 of the first point byte) */
#define FT8722_FLAG_DOWN	0
#define FT8722_FLAG_UP		1
#define FT8722_FLAG_CONTACT	2

/*
 * v1 point (FT8722_EV_DEFAULT), 6 bytes at buf[2 + 6*i]:
 *   [0] flag<<6 | x[11:8]   [1] x[7:0]
 *   [2] id<<4   | y[11:8]   [3] y[7:0]
 *   [4] weight (0 -> 63)    [5] area (0 -> 9)
 */
#define FT8722_V1_HDR		2
#define FT8722_V1_POINT		6

/*
 * v2 point (FT8722_EV_V2), 8 bytes at buf[4 + 8*i]:
 *   [0] flag<<6 | x[11:8]   [1] x[7:0]
 *   [2] id<<4   | y[11:8]   [3] y[7:0]
 *   [4] x_frac<<4 | y_frac  (sub-pixel, dropped by the vendor)
 *   [5] major (0 -> 9)      [6] minor (0 -> 9)   [7] unused
 *   pressure is not transmitted; the vendor reports a constant 63.
 */
#define FT8722_V2_HDR		4
#define FT8722_V2_POINT		8

/*
 * Pen frame (FT8722_EV_PEN), 15 bytes:
 *   [2] bit0 tip, bit1 barrel button, bit3 second button, bit5 in-range
 *   [3] bits 7:6 stylus event, bits 3:0 x[15:12]
 *   [4] x[11:4]              [5] x[3:0]<<4 | y[15:12]
 *   [6] y[11:4]              [7] y[3:0]<<4 | p[11:8]
 *   [8] p[7:0]
 *   [9..10]  tilt x, s16 big-endian     [11..12] tilt y, s16 big-endian
 *   [13..14] azimuth, u16 big-endian
 * x/y are 1/16 px; the vendor scales by 5/8 to 1/10 px (0..10799 / 0..21599).
 */
#define FT8722_PEN_LEN		15
#define FT8722_PEN_MAX_X	((FT8722_MAX_X + 1) * 10 - 1)
#define FT8722_PEN_MAX_Y	((FT8722_MAX_Y + 1) * 10 - 1)
#define FT8722_PEN_RES_PER_MM	(FT8722_RES_PX_PER_MM * 10)
#define FT8722_PEN_MAX_P	4095
#define FT8722_PEN_MAX_TILT	9000
#define FT8722_PEN_MAX_AZIMUTH	36000

#endif
