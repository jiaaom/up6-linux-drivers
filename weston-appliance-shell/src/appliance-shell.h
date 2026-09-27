/*
 * Copyright 2010-2012 Intel Corporation
 * Copyright 2013 Raspberry Pi Foundation
 * Copyright 2011-2012,2020 Collabora, Ltd.
 * Copyright 2026 weston-appliance-shell contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice (including the next
 * paragraph) shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

#ifndef APPLIANCE_SHELL_H
#define APPLIANCE_SHELL_H

#include <stdbool.h>
#include <stdint.h>

#include <libweston/libweston.h>
#include <libweston/desktop.h>
#include <libweston/config-parser.h>

/* One [appliance-rule] section of weston.ini, matched by app-id. */
struct ash_rule {
	struct wl_list link;		/* ash_shell::rule_list */
	char *app_id;
	int layer;			/* higher stacks above lower */
	int rotation;			/* initial rotation: 0/90/180/270 */
	bool focusable;			/* may take keyboard focus */
	char *output;			/* output name to open on, or NULL */
};

struct ash_shell {
	struct weston_compositor *compositor;
	struct weston_desktop *desktop;
	struct weston_config *config;

	struct wl_listener destroy_listener;
	struct wl_listener output_created_listener;
	struct wl_listener output_resized_listener;
	struct wl_listener output_moved_listener;
	struct wl_listener seat_created_listener;
	struct wl_listener session_listener;

	struct weston_layer background_layer;
	struct weston_layer normal_layer;
	struct weston_layer hidden_layer;

	/* All shell surfaces, topmost first. The shell owns this order; it
	 * only changes on map, on control commands and on unmap. */
	struct wl_list stack;

	struct wl_list output_list;
	struct wl_list rule_list;

	struct weston_seat *seat;
	struct weston_surface *focused_surface;

	uint32_t next_id;

	/* control socket */
	char *socket_path;
	int listen_fd;
	struct wl_event_source *listen_source;
	struct wl_list client_list;
};

struct ash_output {
	struct ash_shell *shell;
	struct weston_output *output;
	struct wl_listener output_destroy_listener;
	struct weston_curtain *curtain;
	struct wl_list link;
};

struct ash_surface {
	struct ash_shell *shell;
	struct weston_desktop_surface *desktop_surface;
	struct weston_view *view;
	uint32_t id;

	struct wl_list link;		/* ash_shell::stack */

	struct ash_surface *parent;
	struct wl_listener parent_destroy_listener;
	struct wl_signal parent_destroy_signal;

	struct weston_output *output;
	struct wl_listener output_destroy_listener;

	bool rule_applied;
	int layer;
	bool focusable;
	bool hidden;

	int rotation;			/* 0/90/180/270, clockwise */
	struct weston_transform rotate;

	int32_t last_width, last_height;
};

/* control.c */
int
ash_control_init(struct ash_shell *shell);
void
ash_control_fini(struct ash_shell *shell);

/* appliance-shell.c, used by control.c */
void
ash_restack(struct ash_shell *shell);
void
ash_surface_set_rotation(struct ash_surface *shsurf, int rotation);
void
ash_surface_raise(struct ash_surface *shsurf);
void
ash_surface_lower(struct ash_surface *shsurf);
void
ash_surface_set_hidden(struct ash_surface *shsurf, bool hidden);
void
ash_surface_set_layer(struct ash_surface *shsurf, int layer);
void
ash_surface_focus(struct ash_surface *shsurf);
const char *
ash_surface_app_id(struct ash_surface *shsurf);
const char *
ash_surface_title(struct ash_surface *shsurf);
bool
ash_surface_is_focused(struct ash_surface *shsurf);

#endif
