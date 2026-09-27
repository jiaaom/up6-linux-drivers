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

/*
 * weston-appliance-shell: a weston shell for single-purpose screens
 * (front panels, TVs, kiosks) where software, not the user, decides what is
 * on screen.
 *
 * Derived from weston's kiosk-shell. Differences:
 *  - every top-level window stays mapped; windows are stacked by a
 *    configured layer number and then by open/raise order, so a window can
 *    sit on top of another one (including a translucent overlay);
 *  - touching or clicking a window never changes the stacking order;
 *  - no interactive move/resize;
 *  - a window can be rotated by 90/180/270 degrees; it is configured with
 *    the rotated size and input is mapped back by the compositor;
 *  - a control socket (see control.c) to list, raise, lower, hide, show,
 *    focus, rotate and close windows.
 */

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include <libweston/libweston.h>
#include <libweston/desktop.h>
#include <libweston/shell-utils.h>
#include <libweston/zalloc.h>
#include <weston.h>

#include "appliance-shell.h"

#ifndef container_of
#define container_of wl_container_of
#endif

static struct ash_surface *
get_ash_surface(struct weston_surface *surface)
{
	struct weston_desktop_surface *desktop_surface =
		weston_surface_get_desktop_surface(surface);

	if (desktop_surface)
		return weston_desktop_surface_get_user_data(desktop_surface);

	return NULL;
}

const char *
ash_surface_app_id(struct ash_surface *shsurf)
{
	const char *id = weston_desktop_surface_get_app_id(shsurf->desktop_surface);
	return id ? id : "";
}

const char *
ash_surface_title(struct ash_surface *shsurf)
{
	const char *t = weston_desktop_surface_get_title(shsurf->desktop_surface);
	return t ? t : "";
}

static struct ash_surface *
ash_surface_root(struct ash_surface *shsurf)
{
	while (shsurf->parent)
		shsurf = shsurf->parent;
	return shsurf;
}

static bool
ash_surface_is_descendant_of(struct ash_surface *shsurf,
			     struct ash_surface *ancestor)
{
	for (; shsurf; shsurf = shsurf->parent)
		if (shsurf == ancestor)
			return true;
	return false;
}

static bool
ash_surface_is_mapped(struct ash_surface *shsurf)
{
	return weston_surface_is_mapped(
		weston_desktop_surface_get_surface(shsurf->desktop_surface));
}

bool
ash_surface_is_focused(struct ash_surface *shsurf)
{
	return shsurf->shell->focused_surface ==
		weston_desktop_surface_get_surface(shsurf->desktop_surface);
}

/*
 * rules
 */

static void
ash_load_rules(struct ash_shell *shell)
{
	struct weston_config_section *section = NULL;
	const char *name;

	wl_list_init(&shell->rule_list);
	if (!shell->config)
		return;

	while (weston_config_next_section(shell->config, &section, &name)) {
		struct ash_rule *rule;
		int32_t rotation;

		if (strcmp(name, "appliance-rule") != 0)
			continue;

		rule = zalloc(sizeof *rule);
		if (!rule)
			return;

		weston_config_section_get_string(section, "app-id",
						 &rule->app_id, NULL);
		if (!rule->app_id) {
			weston_log("appliance-shell: [appliance-rule] without "
				   "app-id ignored\n");
			free(rule);
			continue;
		}
		weston_config_section_get_int(section, "layer", &rule->layer, 0);
		weston_config_section_get_int(section, "rotation", &rotation, 0);
		rule->rotation = ((rotation % 360) + 360) % 360 / 90 * 90;
		weston_config_section_get_bool(section, "focusable",
					       &rule->focusable, true);
		weston_config_section_get_string(section, "output",
						 &rule->output, NULL);

		wl_list_insert(shell->rule_list.prev, &rule->link);
	}
}

static struct ash_rule *
ash_find_rule(struct ash_shell *shell, const char *app_id)
{
	struct ash_rule *rule;

	if (!app_id)
		return NULL;
	wl_list_for_each(rule, &shell->rule_list, link)
		if (strcmp(rule->app_id, app_id) == 0)
			return rule;
	return NULL;
}

/*
 * outputs
 */

static struct ash_output *
ash_find_output(struct ash_shell *shell, struct weston_output *output)
{
	struct ash_output *shoutput;

	wl_list_for_each(shoutput, &shell->output_list, link)
		if (shoutput->output == output)
			return shoutput;
	return NULL;
}

static struct weston_output *
ash_output_by_name(struct ash_shell *shell, const char *name)
{
	struct ash_output *shoutput;

	wl_list_for_each(shoutput, &shell->output_list, link)
		if (strcmp(shoutput->output->name, name) == 0)
			return shoutput->output;
	return NULL;
}

static int
ash_background_get_label(struct weston_surface *surface, char *buf, size_t len)
{
	return snprintf(buf, len, "appliance shell background");
}

static void
ash_output_recreate_background(struct ash_output *shoutput)
{
	struct ash_shell *shell = shoutput->shell;
	struct weston_output *output = shoutput->output;
	struct weston_config_section *section = NULL;
	struct weston_curtain_params params = {};
	uint32_t bg_color = 0;

	if (shoutput->curtain)
		weston_shell_utils_curtain_destroy(shoutput->curtain);
	shoutput->curtain = NULL;

	if (!output)
		return;

	if (shell->config)
		section = weston_config_get_section(shell->config, "shell",
						    NULL, NULL);
	if (section)
		weston_config_section_get_color(section, "background-color",
						&bg_color, 0x00000000);

	params.r = ((bg_color >> 16) & 0xff) / 255.0;
	params.g = ((bg_color >> 8) & 0xff) / 255.0;
	params.b = ((bg_color >> 0) & 0xff) / 255.0;
	params.a = 1.0;
	params.pos = output->pos;
	params.width = output->width;
	params.height = output->height;
	params.capture_input = true;
	params.get_label = ash_background_get_label;

	shoutput->curtain = weston_shell_utils_curtain_create(shell->compositor,
							       &params);
	weston_surface_set_role(shoutput->curtain->view->surface,
				"appliance-shell-background", NULL, 0);
	shoutput->curtain->view->surface->output = output;
	weston_view_move_to_layer(shoutput->curtain->view,
				  &shell->background_layer.view_list);
	weston_view_set_output(shoutput->curtain->view, output);
}

static void
ash_output_destroy(struct ash_output *shoutput)
{
	if (shoutput->curtain)
		weston_shell_utils_curtain_destroy(shoutput->curtain);
	wl_list_remove(&shoutput->output_destroy_listener.link);
	wl_list_remove(&shoutput->link);
	free(shoutput);
}

static void
ash_output_handle_destroy(struct wl_listener *listener, void *data)
{
	struct ash_output *shoutput =
		container_of(listener, shoutput, output_destroy_listener);

	ash_output_destroy(shoutput);
}

static void
ash_output_create(struct ash_shell *shell, struct weston_output *output)
{
	struct ash_output *shoutput = zalloc(sizeof *shoutput);

	if (!shoutput)
		return;

	shoutput->shell = shell;
	shoutput->output = output;
	shoutput->output_destroy_listener.notify = ash_output_handle_destroy;
	wl_signal_add(&output->destroy_signal,
		      &shoutput->output_destroy_listener);
	wl_list_insert(shell->output_list.prev, &shoutput->link);

	ash_output_recreate_background(shoutput);
}

/*
 * geometry: fullscreen size, rotation
 */

static void
ash_surface_output_destroyed(struct wl_listener *listener, void *data)
{
	struct ash_surface *shsurf =
		container_of(listener, shsurf, output_destroy_listener);

	wl_list_remove(&shsurf->output_destroy_listener.link);
	wl_list_init(&shsurf->output_destroy_listener.link);
	shsurf->output = NULL;
}

static void
ash_surface_set_output(struct ash_surface *shsurf, struct weston_output *output)
{
	wl_list_remove(&shsurf->output_destroy_listener.link);
	wl_list_init(&shsurf->output_destroy_listener.link);

	shsurf->output = output;
	if (output)
		wl_signal_add(&output->destroy_signal,
			      &shsurf->output_destroy_listener);
}

static struct weston_output *
ash_surface_pick_output(struct ash_surface *shsurf, struct ash_rule *rule)
{
	struct weston_compositor *ec = shsurf->shell->compositor;
	struct weston_output *output = NULL;

	if (shsurf->parent)
		return ash_surface_root(shsurf)->output;

	if (rule && rule->output)
		output = ash_output_by_name(shsurf->shell, rule->output);
	if (!output)
		output = weston_shell_utils_get_default_output(ec);
	return output;
}

/* Ask a top-level window for the full output size, swapped when it is
 * rotated by 90/270 degrees. */
static void
ash_surface_configure_fullscreen(struct ash_surface *shsurf)
{
	struct weston_output *output = shsurf->output;
	bool swap = shsurf->rotation == 90 || shsurf->rotation == 270;

	weston_desktop_surface_set_fullscreen(shsurf->desktop_surface, true);
	if (output)
		weston_desktop_surface_set_size(shsurf->desktop_surface,
						swap ? output->height : output->width,
						swap ? output->width : output->height);
}

static void
ash_surface_configure_normal(struct ash_surface *shsurf)
{
	weston_desktop_surface_set_fullscreen(shsurf->desktop_surface, false);
	weston_desktop_surface_set_maximized(shsurf->desktop_surface, false);
	weston_desktop_surface_set_size(shsurf->desktop_surface, 0, 0);
}

/* Centre the view on its output and apply the rotation about the surface
 * centre, so a rotated fullscreen surface covers the output exactly. */
static void
ash_surface_place(struct ash_surface *shsurf)
{
	struct weston_surface *surface =
		weston_desktop_surface_get_surface(shsurf->desktop_surface);
	struct weston_matrix *m = &shsurf->rotate.matrix;
	float cx, cy, c, s;

	if (!wl_list_empty(&shsurf->rotate.link)) {
		weston_view_remove_transform(shsurf->view, &shsurf->rotate);
		wl_list_init(&shsurf->rotate.link);
	}

	if (shsurf->rotation && !shsurf->parent) {
		cx = 0.5f * surface->width;
		cy = 0.5f * surface->height;
		switch (shsurf->rotation) {
		case 90:  c = 0.0f;  s = 1.0f;  break;
		case 180: c = -1.0f; s = 0.0f;  break;
		default:  c = 0.0f;  s = -1.0f; break;	/* 270 */
		}
		weston_matrix_init(m);
		weston_matrix_translate(m, -cx, -cy, 0.0f);
		weston_matrix_rotate_xy(m, c, s);
		weston_matrix_translate(m, cx, cy, 0.0f);
		weston_view_add_transform(shsurf->view,
					  &shsurf->view->geometry.transformation_list,
					  &shsurf->rotate);
	}

	weston_shell_utils_center_on_output(shsurf->view, shsurf->output);
	weston_view_update_transform(shsurf->view);
}

void
ash_surface_set_rotation(struct ash_surface *shsurf, int rotation)
{
	shsurf = ash_surface_root(shsurf);
	rotation = ((rotation % 360) + 360) % 360 / 90 * 90;
	if (rotation == shsurf->rotation)
		return;

	shsurf->rotation = rotation;
	ash_surface_configure_fullscreen(shsurf);
	/* The new size arrives with the client's next commit; placing now
	 * keeps the old buffer visible, rotated, until then. */
	if (ash_surface_is_mapped(shsurf))
		ash_surface_place(shsurf);
	weston_compositor_schedule_repaint(shsurf->shell->compositor);
}

/*
 * stacking and focus
 */

/* Move a root and its descendants, keeping their relative order, to just
 * above the first stack entry (topmost first) that satisfies 'below'. */
static void
ash_stack_move_group(struct ash_shell *shell, struct ash_surface *root,
		     bool to_top)
{
	struct wl_list group;
	struct ash_surface *s, *tmp, *pos = NULL;

	wl_list_init(&group);
	wl_list_for_each_safe(s, tmp, &shell->stack, link) {
		if (ash_surface_is_descendant_of(s, root)) {
			wl_list_remove(&s->link);
			wl_list_insert(group.prev, &s->link);
		}
	}

	/* to_top: above everything in the same or a lower layer.
	 * !to_top: above everything in a lower layer only. */
	wl_list_for_each(s, &shell->stack, link) {
		if (to_top ? s->layer <= root->layer : s->layer < root->layer) {
			pos = s;
			break;
		}
	}

	wl_list_for_each_safe(s, tmp, &group, link) {
		wl_list_remove(&s->link);
		if (pos)
			wl_list_insert(pos->link.prev, &s->link);
		else
			wl_list_insert(shell->stack.prev, &s->link);
	}
}

void
ash_surface_focus(struct ash_surface *shsurf)
{
	struct ash_shell *shell = shsurf->shell;
	struct weston_surface *surface =
		weston_desktop_surface_get_surface(shsurf->desktop_surface);
	struct ash_surface *old;

	if (!shell->seat || shell->focused_surface == surface)
		return;

	if (shell->focused_surface) {
		old = get_ash_surface(shell->focused_surface);
		if (old)
			weston_desktop_surface_set_activated(old->desktop_surface,
							     false);
	}

	shell->focused_surface = surface;
	weston_view_activate_input(shsurf->view, shell->seat,
				   WESTON_ACTIVATE_FLAG_NONE);
	weston_desktop_surface_set_activated(shsurf->desktop_surface, true);
}

/* Give keyboard focus to the topmost visible focusable window. */
static void
ash_refocus(struct ash_shell *shell)
{
	struct ash_surface *s;

	wl_list_for_each(s, &shell->stack, link) {
		if (s->hidden || !s->focusable || !ash_surface_is_mapped(s))
			continue;
		ash_surface_focus(s);
		return;
	}
	shell->focused_surface = NULL;
}

/* Rebuild the layers from the stack, bottom to top (move_to_layer inserts at
 * the top of a layer). */
void
ash_restack(struct ash_shell *shell)
{
	struct ash_surface *s;

	wl_list_for_each_reverse(s, &shell->stack, link) {
		if (!ash_surface_is_mapped(s))
			continue;
		weston_view_move_to_layer(s->view,
					  s->hidden ? &shell->hidden_layer.view_list
						    : &shell->normal_layer.view_list);
	}

	if (shell->focused_surface) {
		struct ash_surface *f = get_ash_surface(shell->focused_surface);
		if (!f || f->hidden)
			shell->focused_surface = NULL;
	}
	ash_refocus(shell);
	weston_compositor_schedule_repaint(shell->compositor);
}

/* Control commands act on the root of a window tree. */
void
ash_surface_raise(struct ash_surface *shsurf)
{
	struct ash_surface *root = ash_surface_root(shsurf);

	ash_stack_move_group(shsurf->shell, root, true);
	ash_restack(shsurf->shell);
}

void
ash_surface_lower(struct ash_surface *shsurf)
{
	struct ash_surface *root = ash_surface_root(shsurf);

	ash_stack_move_group(shsurf->shell, root, false);
	ash_restack(shsurf->shell);
}

void
ash_surface_set_hidden(struct ash_surface *shsurf, bool hidden)
{
	struct ash_surface *root = ash_surface_root(shsurf);
	struct ash_surface *s;

	wl_list_for_each(s, &shsurf->shell->stack, link)
		if (ash_surface_is_descendant_of(s, root))
			s->hidden = hidden;
	ash_restack(shsurf->shell);
}

void
ash_surface_set_layer(struct ash_surface *shsurf, int layer)
{
	struct ash_surface *root = ash_surface_root(shsurf);
	struct ash_surface *s;

	wl_list_for_each(s, &shsurf->shell->stack, link)
		if (ash_surface_is_descendant_of(s, root))
			s->layer = layer;
	ash_stack_move_group(shsurf->shell, root, true);
	ash_restack(shsurf->shell);
}

/*
 * shell surfaces
 */

static void
ash_surface_parent_destroyed(struct wl_listener *listener, void *data);

static void
ash_surface_set_parent(struct ash_surface *shsurf, struct ash_surface *parent)
{
	wl_list_remove(&shsurf->parent_destroy_listener.link);
	wl_list_init(&shsurf->parent_destroy_listener.link);

	shsurf->parent = parent;
	if (parent) {
		wl_signal_add(&parent->parent_destroy_signal,
			      &shsurf->parent_destroy_listener);
		shsurf->layer = ash_surface_root(parent)->layer;
		shsurf->hidden = ash_surface_root(parent)->hidden;
		ash_surface_set_output(shsurf, ash_surface_root(parent)->output);
		/* sit directly above the parent */
		wl_list_remove(&shsurf->link);
		wl_list_insert(parent->link.prev, &shsurf->link);
		ash_surface_configure_normal(shsurf);
	} else {
		ash_surface_configure_fullscreen(shsurf);
	}
}

static void
ash_surface_parent_destroyed(struct wl_listener *listener, void *data)
{
	struct ash_surface *shsurf =
		container_of(listener, shsurf, parent_destroy_listener);

	ash_surface_set_parent(shsurf, shsurf->parent->parent);
}

static struct ash_surface *
ash_surface_create(struct ash_shell *shell,
		   struct weston_desktop_surface *desktop_surface)
{
	struct ash_surface *shsurf;
	struct weston_view *view;

	view = weston_desktop_surface_create_view(desktop_surface);
	if (!view)
		return NULL;

	shsurf = zalloc(sizeof *shsurf);
	if (!shsurf) {
		weston_view_destroy(view);
		return NULL;
	}

	shsurf->shell = shell;
	shsurf->desktop_surface = desktop_surface;
	shsurf->view = view;
	shsurf->id = ++shell->next_id;
	shsurf->focusable = true;
	wl_list_init(&shsurf->rotate.link);
	wl_list_init(&shsurf->parent_destroy_listener.link);
	shsurf->parent_destroy_listener.notify = ash_surface_parent_destroyed;
	wl_list_init(&shsurf->output_destroy_listener.link);
	shsurf->output_destroy_listener.notify = ash_surface_output_destroyed;
	wl_signal_init(&shsurf->parent_destroy_signal);

	weston_desktop_surface_set_user_data(desktop_surface, shsurf);

	/* Until the app-id is known (first commit) the window is a new
	 * layer-0 window: stack it above other layer-0 windows. */
	wl_list_insert(&shell->stack, &shsurf->link);

	return shsurf;
}

static void
ash_surface_destroy(struct ash_surface *shsurf)
{
	if (!wl_list_empty(&shsurf->rotate.link))
		weston_view_remove_transform(shsurf->view, &shsurf->rotate);
	wl_list_remove(&shsurf->link);
	wl_list_remove(&shsurf->parent_destroy_listener.link);
	wl_list_remove(&shsurf->output_destroy_listener.link);

	weston_desktop_surface_set_user_data(shsurf->desktop_surface, NULL);
	weston_desktop_surface_unlink_view(shsurf->view);
	weston_view_destroy(shsurf->view);
	free(shsurf);
}

/* Apply the matching [appliance-rule] once the app-id is known. */
static void
ash_surface_apply_rule(struct ash_surface *shsurf)
{
	struct ash_shell *shell = shsurf->shell;
	struct ash_rule *rule;

	shsurf->rule_applied = true;
	if (shsurf->parent)
		return;

	rule = ash_find_rule(shell, weston_desktop_surface_get_app_id(
						shsurf->desktop_surface));
	if (rule) {
		shsurf->layer = rule->layer;
		shsurf->rotation = rule->rotation;
		shsurf->focusable = rule->focusable;
	}
	ash_surface_set_output(shsurf, ash_surface_pick_output(shsurf, rule));
	ash_surface_configure_fullscreen(shsurf);
	ash_stack_move_group(shell, shsurf, true);
}

/*
 * libweston-desktop
 */

static void
desktop_surface_added(struct weston_desktop_surface *desktop_surface,
		      void *data)
{
	struct ash_shell *shell = data;
	struct ash_surface *shsurf;

	shsurf = ash_surface_create(shell, desktop_surface);
	if (!shsurf)
		return;

	weston_surface_set_label_func(
		weston_desktop_surface_get_surface(desktop_surface),
		weston_shell_utils_surface_get_label);

	ash_surface_set_output(shsurf, ash_surface_pick_output(shsurf, NULL));
	ash_surface_configure_fullscreen(shsurf);
}

static void
desktop_surface_removed(struct weston_desktop_surface *desktop_surface,
			void *data)
{
	struct ash_shell *shell = data;
	struct ash_surface *shsurf =
		weston_desktop_surface_get_user_data(desktop_surface);
	struct weston_surface *surface =
		weston_desktop_surface_get_surface(desktop_surface);

	if (!shsurf)
		return;

	/* reparent children before the parent goes away */
	wl_signal_emit(&shsurf->parent_destroy_signal, shsurf);

	if (shell->focused_surface == surface)
		shell->focused_surface = NULL;

	ash_surface_destroy(shsurf);
	ash_restack(shell);
}

static void
desktop_surface_committed(struct weston_desktop_surface *desktop_surface,
			  struct weston_coord_surface buf_offset, void *data)
{
	struct ash_shell *shell = data;
	struct ash_surface *shsurf =
		weston_desktop_surface_get_user_data(desktop_surface);
	struct weston_surface *surface =
		weston_desktop_surface_get_surface(desktop_surface);
	bool resized;

	assert(shsurf);

	if (surface->width == 0)
		return;

	if (!shsurf->rule_applied)
		ash_surface_apply_rule(shsurf);

	resized = surface->width != shsurf->last_width ||
		  surface->height != shsurf->last_height;

	if (!weston_surface_is_mapped(surface) || resized)
		ash_surface_place(shsurf);

	if (!weston_surface_is_mapped(surface)) {
		weston_surface_map(surface);
		ash_restack(shell);
	}

	shsurf->last_width = surface->width;
	shsurf->last_height = surface->height;
}

static void
desktop_surface_move(struct weston_desktop_surface *desktop_surface,
		     struct weston_seat *seat, uint32_t serial, void *shell)
{
	/* windows are placed by the shell only */
}

static void
desktop_surface_resize(struct weston_desktop_surface *desktop_surface,
		       struct weston_seat *seat, uint32_t serial,
		       enum weston_desktop_surface_edge edges, void *shell)
{
}

static void
desktop_surface_set_parent(struct weston_desktop_surface *desktop_surface,
			   struct weston_desktop_surface *parent,
			   void *data)
{
	struct ash_surface *shsurf =
		weston_desktop_surface_get_user_data(desktop_surface);
	struct ash_surface *shparent =
		parent ? weston_desktop_surface_get_user_data(parent) : NULL;

	ash_surface_set_parent(shsurf, shparent);
	ash_restack(shsurf->shell);
}

static void
desktop_surface_fullscreen_requested(struct weston_desktop_surface *desktop_surface,
				     bool fullscreen,
				     struct weston_output *output, void *shell)
{
	struct ash_surface *shsurf =
		weston_desktop_surface_get_user_data(desktop_surface);

	/* top-level windows are always fullscreen */
	if (!shsurf->parent)
		ash_surface_configure_fullscreen(shsurf);
	else if (!fullscreen)
		ash_surface_configure_normal(shsurf);
}

static void
desktop_surface_maximized_requested(struct weston_desktop_surface *desktop_surface,
				    bool maximized, void *shell)
{
	struct ash_surface *shsurf =
		weston_desktop_surface_get_user_data(desktop_surface);

	if (!shsurf->parent)
		ash_surface_configure_fullscreen(shsurf);
}

static void
desktop_surface_minimized_requested(struct weston_desktop_surface *desktop_surface,
				    void *shell)
{
}

static void
desktop_surface_ping_timeout(struct weston_desktop_client *client, void *shell)
{
}

static void
desktop_surface_pong(struct weston_desktop_client *client, void *shell)
{
}

static void
desktop_surface_get_position(struct weston_desktop_surface *desktop_surface,
			     int32_t *x, int32_t *y, void *shell)
{
	struct ash_surface *shsurf =
		weston_desktop_surface_get_user_data(desktop_surface);

	*x = shsurf->view->geometry.pos_offset.x;
	*y = shsurf->view->geometry.pos_offset.y;
}

static const struct weston_desktop_api ash_desktop_api = {
	.struct_size = sizeof(struct weston_desktop_api),
	.surface_added = desktop_surface_added,
	.surface_removed = desktop_surface_removed,
	.committed = desktop_surface_committed,
	.move = desktop_surface_move,
	.resize = desktop_surface_resize,
	.set_parent = desktop_surface_set_parent,
	.fullscreen_requested = desktop_surface_fullscreen_requested,
	.maximized_requested = desktop_surface_maximized_requested,
	.minimized_requested = desktop_surface_minimized_requested,
	.ping_timeout = desktop_surface_ping_timeout,
	.pong = desktop_surface_pong,
	.get_position = desktop_surface_get_position,
};

/*
 * compositor events
 */

static void
ash_handle_output_created(struct wl_listener *listener, void *data)
{
	struct ash_shell *shell =
		container_of(listener, shell, output_created_listener);

	ash_output_create(shell, data);
}

static void
ash_handle_output_resized(struct wl_listener *listener, void *data)
{
	struct ash_shell *shell =
		container_of(listener, shell, output_resized_listener);
	struct weston_output *output = data;
	struct ash_output *shoutput = ash_find_output(shell, output);
	struct ash_surface *s;

	if (shoutput)
		ash_output_recreate_background(shoutput);

	wl_list_for_each(s, &shell->stack, link) {
		if (s->output != output || s->parent)
			continue;
		ash_surface_configure_fullscreen(s);
		if (ash_surface_is_mapped(s))
			ash_surface_place(s);
	}
}

static void
ash_handle_output_moved(struct wl_listener *listener, void *data)
{
	struct ash_shell *shell =
		container_of(listener, shell, output_moved_listener);
	struct weston_output *output = data;
	struct ash_output *shoutput = ash_find_output(shell, output);
	struct ash_surface *s;

	if (shoutput)
		ash_output_recreate_background(shoutput);

	wl_list_for_each(s, &shell->stack, link)
		if (s->output == output && ash_surface_is_mapped(s))
			ash_surface_place(s);
}

static void
ash_handle_seat_created(struct wl_listener *listener, void *data)
{
	struct ash_shell *shell =
		container_of(listener, shell, seat_created_listener);

	if (!shell->seat)
		shell->seat = data;
}

static void
ash_handle_session(struct wl_listener *listener, void *data)
{
	struct ash_shell *shell =
		container_of(listener, shell, session_listener);
	struct weston_compositor *compositor = data;
	struct ash_surface *f;

	if (!compositor->session_active || !shell->seat ||
	    !shell->focused_surface)
		return;

	f = get_ash_surface(shell->focused_surface);
	if (f)
		weston_view_activate_input(f->view, shell->seat,
					   WESTON_ACTIVATE_FLAG_NONE);
}

static void
ash_destroy_layer_surfaces(struct weston_layer *layer)
{
	struct weston_view *view, *next;

	wl_list_for_each_safe(view, next, &layer->view_list.link,
			      layer_link.link) {
		struct ash_surface *shsurf = get_ash_surface(view->surface);
		if (shsurf)
			ash_surface_destroy(shsurf);
	}
	weston_layer_fini(layer);
}

static void
ash_shell_destroy(struct wl_listener *listener, void *data)
{
	struct ash_shell *shell =
		container_of(listener, shell, destroy_listener);
	struct ash_output *shoutput, *otmp;
	struct ash_rule *rule, *rtmp;

	ash_control_fini(shell);

	wl_list_remove(&shell->destroy_listener.link);
	wl_list_remove(&shell->output_created_listener.link);
	wl_list_remove(&shell->output_resized_listener.link);
	wl_list_remove(&shell->output_moved_listener.link);
	wl_list_remove(&shell->seat_created_listener.link);
	wl_list_remove(&shell->session_listener.link);

	wl_list_for_each_safe(shoutput, otmp, &shell->output_list, link)
		ash_output_destroy(shoutput);

	weston_layer_fini(&shell->background_layer);
	ash_destroy_layer_surfaces(&shell->normal_layer);
	ash_destroy_layer_surfaces(&shell->hidden_layer);

	wl_list_for_each_safe(rule, rtmp, &shell->rule_list, link) {
		free(rule->app_id);
		free(rule->output);
		free(rule);
	}

	weston_desktop_destroy(shell->desktop);
	if (shell->config)
		weston_config_destroy(shell->config);
	free(shell);
}

WL_EXPORT int
wet_shell_init(struct weston_compositor *ec, int *argc, char *argv[])
{
	struct ash_shell *shell;
	struct weston_output *output;
	struct weston_seat *seat;

	shell = zalloc(sizeof *shell);
	if (!shell)
		return -1;

	shell->compositor = ec;
	shell->listen_fd = -1;

	if (!weston_compositor_add_destroy_listener_once(ec,
							 &shell->destroy_listener,
							 ash_shell_destroy)) {
		free(shell);
		return 0;
	}

	shell->config = weston_config_parse(weston_config_get_name_from_env());
	ash_load_rules(shell);

	weston_layer_init(&shell->background_layer, ec);
	weston_layer_init(&shell->normal_layer, ec);
	weston_layer_init(&shell->hidden_layer, ec);
	weston_layer_set_position(&shell->background_layer,
				  WESTON_LAYER_POSITION_BACKGROUND);
	weston_layer_set_position(&shell->hidden_layer,
				  WESTON_LAYER_POSITION_HIDDEN);
	weston_layer_set_position(&shell->normal_layer,
				  WESTON_LAYER_POSITION_NORMAL);

	wl_list_init(&shell->stack);
	wl_list_init(&shell->output_list);
	wl_list_init(&shell->client_list);

	shell->desktop = weston_desktop_create(ec, &ash_desktop_api, shell);
	if (!shell->desktop)
		return -1;

	wl_list_for_each(seat, &ec->seat_list, link) {
		shell->seat = seat;
		break;
	}
	shell->seat_created_listener.notify = ash_handle_seat_created;
	wl_signal_add(&ec->seat_created_signal, &shell->seat_created_listener);

	wl_list_for_each(output, &ec->output_list, link)
		ash_output_create(shell, output);
	shell->output_created_listener.notify = ash_handle_output_created;
	wl_signal_add(&ec->output_created_signal, &shell->output_created_listener);
	shell->output_resized_listener.notify = ash_handle_output_resized;
	wl_signal_add(&ec->output_resized_signal, &shell->output_resized_listener);
	shell->output_moved_listener.notify = ash_handle_output_moved;
	wl_signal_add(&ec->output_moved_signal, &shell->output_moved_listener);

	shell->session_listener.notify = ash_handle_session;
	wl_signal_add(&ec->session_signal, &shell->session_listener);

	screenshooter_create(ec);

	if (ash_control_init(shell) < 0)
		weston_log("appliance-shell: control socket disabled\n");

	weston_log("appliance-shell: loaded, %d rule(s)\n",
		   wl_list_length(&shell->rule_list));
	return 0;
}
