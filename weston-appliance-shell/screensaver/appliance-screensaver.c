/*
 * appliance-screensaver: a fullscreen black window that takes every key and
 * touch while it is up, and reports them on stdout for a supervising process
 * to act on. It decides nothing itself (waking the screen, volume keys…).
 *
 * With weston-appliance-shell, give its app-id a rule above everything else
 * (e.g. layer=100): being the topmost window it gets keyboard focus and all
 * touches, so nothing underneath sees input while the screen is dark.
 *
 * It fades in from transparent to black (--fade-in), and on `fade-out` from
 * the supervisor fades back out and exits (--fade-out). Input is taken from
 * the first frame on, while it is still fading in.
 *
 * stdout, one event per line:
 *   ready            the window is fully black (faded in) and shown
 *   key <code>       a key was pressed (Linux evdev code, e.g. 108 = KEY_DOWN)
 *   tap              a short touch or click
 *   doubletap        two taps close together in time and place
 * stdin (with --watch-stdin), one command per line:
 *   fade-out         fade out, then exit
 * It exits when the compositor closes the window, on SIGTERM, after a
 * fade-out, and with --watch-stdin also when stdin reaches EOF (the
 * supervisor that holds the other end of the pipe went away).
 *
 * SPDX-License-Identifier: MIT
 */

#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "viewporter-client-protocol.h"
#include "xdg-shell-client-protocol.h"

#define DEFAULT_FADE_IN_MS 400
#define DEFAULT_FADE_OUT_MS 300

/* Double-tap: each tap shorter than TAP_MAX_MS, the gap between them within
 * [GAP_MIN_MS, GAP_MAX_MS], the second one near the first. */
#define TAP_MAX_MS 500
#define GAP_MIN_MS 40
#define GAP_MAX_MS 400
#define NEAR_MIN_PX 60.0

struct app {
	struct wl_display *display;
	struct wl_compositor *compositor;
	struct wl_shm *shm;
	struct xdg_wm_base *wm_base;
	struct wp_viewporter *viewporter;
	struct wl_surface *surface;
	struct wp_viewport *viewport;
	struct xdg_surface *xdg_surface;
	struct xdg_toplevel *toplevel;
	int32_t width, height, buf_w, buf_h;
	bool configured, ready, quit, stdin_eof;

	/* Content: a 1x1 premultiplied black pixel per alpha level, scaled to
	 * the window by wp_viewporter, so a fade step costs one pixel. Without
	 * a viewporter: one opaque full-size buffer and no fading. */
	struct wl_shm_pool *pool;
	struct wl_buffer *level[256];
	struct wl_buffer *full;
	int alpha;

	/* fade animation, driven by frame callbacks */
	enum { FADE_IN, SHOWN, FADE_OUT } phase;
	int from, to;              /* alpha at the start and end */
	uint32_t duration, start;  /* ms; start = 0 until the first frame */
	bool started, frame_pending;
	int fade_in_ms, fade_out_ms;

	/* current touch / pointer press */
	bool down;
	uint32_t down_ms;
	double down_x, down_y, ptr_x, ptr_y;
	/* last tap, for double-tap */
	bool have_tap;
	uint32_t tap_up_ms;
	double tap_x, tap_y;
};

static volatile sig_atomic_t got_signal;

static void emit(const char *line)
{
	fputs(line, stdout);
	fputc('\n', stdout);
	fflush(stdout);
}

/* ---- content ---- */

/* 256 one-pixel buffers in one pool: pixel i is black with alpha i
 * (ARGB8888 is premultiplied, so black is 0 in every colour channel). */
static bool make_levels(struct app *app)
{
	int fd = memfd_create("appliance-screensaver", MFD_CLOEXEC);
	if (fd < 0 || ftruncate(fd, 256 * 4) < 0) {
		perror("shm");
		if (fd >= 0)
			close(fd);
		return false;
	}
	uint32_t *px = mmap(NULL, 256 * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (px == MAP_FAILED) {
		perror("mmap");
		close(fd);
		return false;
	}
	for (uint32_t i = 0; i < 256; i++)
		px[i] = i << 24;
	munmap(px, 256 * 4);
	app->pool = wl_shm_create_pool(app->shm, fd, 256 * 4);
	close(fd);
	return true;
}

static struct wl_buffer *level_buffer(struct app *app, int a)
{
	if (!app->level[a])
		app->level[a] = wl_shm_pool_create_buffer(app->pool, a * 4, 1, 1, 4, WL_SHM_FORMAT_ARGB8888);
	return app->level[a];
}

/* Opaque full-size buffer (no viewporter). ftruncate zero-fills: black. */
static struct wl_buffer *full_buffer(struct app *app, int32_t w, int32_t h)
{
	int32_t stride = w * 4;
	size_t size = (size_t)stride * h;
	int fd = memfd_create("appliance-screensaver", MFD_CLOEXEC);
	if (fd < 0 || ftruncate(fd, size) < 0) {
		perror("shm");
		if (fd >= 0)
			close(fd);
		return NULL;
	}
	struct wl_shm_pool *pool = wl_shm_create_pool(app->shm, fd, size);
	struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, w, h, stride, WL_SHM_FORMAT_XRGB8888);
	wl_shm_pool_destroy(pool);
	close(fd);
	return buf;
}

static const struct wl_callback_listener frame_listener;

/* Show alpha `a` (0..255) and ask for the next frame. */
static void draw(struct app *app, int a)
{
	app->alpha = a;
	if (app->viewport) {
		wl_surface_attach(app->surface, level_buffer(app, a), 0, 0);
		wl_surface_damage_buffer(app->surface, 0, 0, 1, 1);
	} else {
		if (!app->full || app->buf_w != app->width || app->buf_h != app->height) {
			if (app->full)
				wl_buffer_destroy(app->full);
			app->full = full_buffer(app, app->width, app->height);
			if (!app->full) {
				app->quit = true;
				return;
			}
			app->buf_w = app->width;
			app->buf_h = app->height;
		}
		wl_surface_attach(app->surface, app->full, 0, 0);
		wl_surface_damage_buffer(app->surface, 0, 0, app->width, app->height);
	}
	/* Fully black: tell the compositor, so it stops drawing what is below. */
	if (a == 255) {
		struct wl_region *r = wl_compositor_create_region(app->compositor);
		wl_region_add(r, 0, 0, app->width, app->height);
		wl_surface_set_opaque_region(app->surface, r);
		wl_region_destroy(r);
	} else {
		wl_surface_set_opaque_region(app->surface, NULL);
	}
	if (!app->frame_pending) {
		app->frame_pending = true;
		wl_callback_add_listener(wl_surface_frame(app->surface), &frame_listener, app);
	}
	wl_surface_commit(app->surface);
}

static void start_fade(struct app *app, int phase, int to, int full_ms)
{
	app->phase = phase;
	app->from = app->alpha;
	app->to = to;
	/* a fade that starts part-way takes its share of the full time */
	app->duration = (uint32_t)(full_ms * abs(to - app->alpha) / 255);
	app->started = false;
}

static void frame_done(void *data, struct wl_callback *cb, uint32_t time)
{
	struct app *app = data;
	wl_callback_destroy(cb);
	app->frame_pending = false;

	if (app->phase == SHOWN) {
		/* the opaque frame is on screen */
		if (!app->ready) {
			app->ready = true;
			emit("ready");
		}
		return;
	}
	if (!app->started) {
		app->started = true;
		app->start = time;
	}
	double t = app->duration ? (double)(time - app->start) / app->duration : 1.0;
	if (t >= 1.0) {
		if (app->phase == FADE_OUT) {
			app->quit = true;
			return;
		}
		app->phase = SHOWN;
		draw(app, 255);
		return;
	}
	double e = t * t * (3.0 - 2.0 * t); /* smoothstep */
	draw(app, (int)lround(app->from + (app->to - app->from) * e));
}
static const struct wl_callback_listener frame_listener = { frame_done };

static void fade_out(struct app *app)
{
	if (app->phase == FADE_OUT)
		return;
	if (!app->viewport || app->fade_out_ms <= 0 || !app->configured) {
		app->quit = true;
		return;
	}
	start_fade(app, FADE_OUT, 0, app->fade_out_ms);
	draw(app, app->alpha);
}

/* ---- xdg-shell ---- */

static void wm_base_ping(void *data, struct xdg_wm_base *wm_base, uint32_t serial)
{
	xdg_wm_base_pong(wm_base, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = { wm_base_ping };

static void xdg_surface_configure(void *data, struct xdg_surface *xdg_surface, uint32_t serial)
{
	struct app *app = data;
	if (app->width <= 0)
		app->width = 1;
	if (app->height <= 0)
		app->height = 1;
	xdg_surface_ack_configure(xdg_surface, serial);
	if (app->viewport)
		wp_viewport_set_destination(app->viewport, app->width, app->height);
	if (!app->configured) {
		app->configured = true;
		if (app->viewport && app->fade_in_ms > 0) {
			app->alpha = 0;
			start_fade(app, FADE_IN, 255, app->fade_in_ms);
			draw(app, 0);
		} else {
			app->phase = SHOWN;
			draw(app, 255);
		}
		return;
	}
	draw(app, app->alpha); /* resized: same content at the new size */
}
static const struct xdg_surface_listener xdg_surface_listener = { xdg_surface_configure };

static void toplevel_configure(void *data, struct xdg_toplevel *toplevel, int32_t w, int32_t h,
			       struct wl_array *states)
{
	struct app *app = data;
	app->width = w;
	app->height = h;
}
static void toplevel_close(void *data, struct xdg_toplevel *toplevel)
{
	((struct app *)data)->quit = true;
}
static void toplevel_bounds(void *data, struct xdg_toplevel *t, int32_t w, int32_t h) {}
static void toplevel_caps(void *data, struct xdg_toplevel *t, struct wl_array *caps) {}
static const struct xdg_toplevel_listener toplevel_listener = {
	.configure = toplevel_configure,
	.close = toplevel_close,
	.configure_bounds = toplevel_bounds,
	.wm_capabilities = toplevel_caps,
};

/* ---- taps (touch and pointer share this) ---- */

static void press(struct app *app, uint32_t ms, double x, double y)
{
	app->down = true;
	app->down_ms = ms;
	app->down_x = x;
	app->down_y = y;
}

static void release(struct app *app, uint32_t ms)
{
	if (!app->down)
		return;
	app->down = false;
	if (ms - app->down_ms > TAP_MAX_MS) {
		app->have_tap = false; /* a press, not a tap */
		return;
	}
	double near = fmax(NEAR_MIN_PX, app->width * 0.12);
	uint32_t gap = app->down_ms - app->tap_up_ms;
	if (app->have_tap && gap >= GAP_MIN_MS && gap <= GAP_MAX_MS &&
	    hypot(app->down_x - app->tap_x, app->down_y - app->tap_y) < near) {
		app->have_tap = false;
		emit("tap");
		emit("doubletap");
		return;
	}
	emit("tap");
	app->have_tap = true;
	app->tap_up_ms = ms;
	app->tap_x = app->down_x;
	app->tap_y = app->down_y;
}

/* ---- keyboard ---- */

static void kb_keymap(void *data, struct wl_keyboard *kb, uint32_t format, int32_t fd, uint32_t size)
{
	close(fd); /* raw evdev codes are all we report */
}
static void kb_enter(void *data, struct wl_keyboard *kb, uint32_t serial, struct wl_surface *s,
		     struct wl_array *keys) {}
static void kb_leave(void *data, struct wl_keyboard *kb, uint32_t serial, struct wl_surface *s) {}
static void kb_key(void *data, struct wl_keyboard *kb, uint32_t serial, uint32_t time, uint32_t key,
		   uint32_t state)
{
	char line[32];
	if (state != WL_KEYBOARD_KEY_STATE_PRESSED)
		return;
	snprintf(line, sizeof line, "key %u", key);
	emit(line);
}
static void kb_modifiers(void *data, struct wl_keyboard *kb, uint32_t serial, uint32_t dep,
			 uint32_t lat, uint32_t lock, uint32_t group) {}
static void kb_repeat(void *data, struct wl_keyboard *kb, int32_t rate, int32_t delay) {}
static const struct wl_keyboard_listener keyboard_listener = {
	kb_keymap, kb_enter, kb_leave, kb_key, kb_modifiers, kb_repeat,
};

/* ---- touch ---- */

static void touch_down(void *data, struct wl_touch *t, uint32_t serial, uint32_t time,
		       struct wl_surface *s, int32_t id, wl_fixed_t x, wl_fixed_t y)
{
	press(data, time, wl_fixed_to_double(x), wl_fixed_to_double(y));
}
static void touch_up(void *data, struct wl_touch *t, uint32_t serial, uint32_t time, int32_t id)
{
	release(data, time);
}
static void touch_motion(void *data, struct wl_touch *t, uint32_t time, int32_t id, wl_fixed_t x,
			 wl_fixed_t y) {}
static void touch_frame(void *data, struct wl_touch *t) {}
static void touch_cancel(void *data, struct wl_touch *t)
{
	((struct app *)data)->down = false;
}
static void touch_shape(void *data, struct wl_touch *t, int32_t id, wl_fixed_t a, wl_fixed_t b) {}
static void touch_orientation(void *data, struct wl_touch *t, int32_t id, wl_fixed_t o) {}
static const struct wl_touch_listener touch_listener = {
	touch_down, touch_up, touch_motion, touch_frame, touch_cancel, touch_shape, touch_orientation,
};

/* ---- pointer (a mouse behaves like touch) ---- */

static void ptr_enter(void *data, struct wl_pointer *p, uint32_t serial, struct wl_surface *s,
		      wl_fixed_t x, wl_fixed_t y)
{
	struct app *app = data;
	wl_pointer_set_cursor(p, serial, NULL, 0, 0); /* no cursor on a dark screen */
	app->ptr_x = wl_fixed_to_double(x);
	app->ptr_y = wl_fixed_to_double(y);
}
static void ptr_leave(void *data, struct wl_pointer *p, uint32_t serial, struct wl_surface *s) {}
static void ptr_motion(void *data, struct wl_pointer *p, uint32_t time, wl_fixed_t x, wl_fixed_t y)
{
	struct app *app = data;
	app->ptr_x = wl_fixed_to_double(x);
	app->ptr_y = wl_fixed_to_double(y);
}
static void ptr_button(void *data, struct wl_pointer *p, uint32_t serial, uint32_t time,
		       uint32_t button, uint32_t state)
{
	struct app *app = data;
	if (state == WL_POINTER_BUTTON_STATE_PRESSED)
		press(app, time, app->ptr_x, app->ptr_y);
	else
		release(app, time);
}
static void ptr_axis(void *data, struct wl_pointer *p, uint32_t time, uint32_t axis, wl_fixed_t v) {}
static void ptr_frame(void *data, struct wl_pointer *p) {}
static void ptr_axis_source(void *data, struct wl_pointer *p, uint32_t src) {}
static void ptr_axis_stop(void *data, struct wl_pointer *p, uint32_t time, uint32_t axis) {}
static void ptr_axis_discrete(void *data, struct wl_pointer *p, uint32_t axis, int32_t d) {}
static void ptr_axis_v120(void *data, struct wl_pointer *p, uint32_t axis, int32_t v) {}
static void ptr_axis_dir(void *data, struct wl_pointer *p, uint32_t axis, uint32_t dir) {}
static const struct wl_pointer_listener pointer_listener = {
	ptr_enter, ptr_leave, ptr_motion, ptr_button, ptr_axis, ptr_frame,
	ptr_axis_source, ptr_axis_stop, ptr_axis_discrete, ptr_axis_v120, ptr_axis_dir,
};

/* ---- seat ---- */

static void seat_caps(void *data, struct wl_seat *seat, uint32_t caps)
{
	/* Bound once per capability; devices coming and going keep the object. */
	static struct wl_keyboard *kb;
	static struct wl_touch *touch;
	static struct wl_pointer *pointer;
	if ((caps & WL_SEAT_CAPABILITY_KEYBOARD) && !kb) {
		kb = wl_seat_get_keyboard(seat);
		wl_keyboard_add_listener(kb, &keyboard_listener, data);
	}
	if ((caps & WL_SEAT_CAPABILITY_TOUCH) && !touch) {
		touch = wl_seat_get_touch(seat);
		wl_touch_add_listener(touch, &touch_listener, data);
	}
	if ((caps & WL_SEAT_CAPABILITY_POINTER) && !pointer) {
		pointer = wl_seat_get_pointer(seat);
		wl_pointer_add_listener(pointer, &pointer_listener, data);
	}
}
static void seat_name(void *data, struct wl_seat *seat, const char *name) {}
static const struct wl_seat_listener seat_listener = { seat_caps, seat_name };

/* ---- registry ---- */

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t ver)
{
	struct app *app = data;
	if (!strcmp(iface, wl_compositor_interface.name)) {
		app->compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
	} else if (!strcmp(iface, wl_shm_interface.name)) {
		app->shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
	} else if (!strcmp(iface, xdg_wm_base_interface.name)) {
		app->wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, ver < 5 ? ver : 5);
		xdg_wm_base_add_listener(app->wm_base, &wm_base_listener, app);
	} else if (!strcmp(iface, wp_viewporter_interface.name)) {
		app->viewporter = wl_registry_bind(reg, name, &wp_viewporter_interface, 1);
	} else if (!strcmp(iface, wl_seat_interface.name)) {
		struct wl_seat *seat = wl_registry_bind(reg, name, &wl_seat_interface, ver < 7 ? ver : 7);
		wl_seat_add_listener(seat, &seat_listener, app);
	}
}
static void global_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { global, global_remove };

static void on_signal(int sig)
{
	got_signal = 1;
}

static void usage(void)
{
	fprintf(stderr, "usage: appliance-screensaver [--app-id ID] [--fade-in MS] [--fade-out MS] [--watch-stdin]\n"
			"  --app-id ID     xdg-shell app-id (default \"screensaver\")\n"
			"  --fade-in MS    fade from transparent to black (default %d, 0 = at once)\n"
			"  --fade-out MS   fade out on the fade-out command (default %d)\n"
			"  --watch-stdin   read commands from stdin; exit when it reaches EOF\n",
		DEFAULT_FADE_IN_MS, DEFAULT_FADE_OUT_MS);
	exit(2);
}

int main(int argc, char **argv)
{
	static const struct option opts[] = {
		{ "app-id", required_argument, NULL, 'a' },
		{ "watch-stdin", no_argument, NULL, 's' },
		{ "fade-in", required_argument, NULL, 'i' },
		{ "fade-out", required_argument, NULL, 'o' },
		{ "help", no_argument, NULL, 'h' },
		{ 0 },
	};
	const char *app_id = "screensaver";
	bool watch_stdin = false;
	struct app app = { .fade_in_ms = DEFAULT_FADE_IN_MS, .fade_out_ms = DEFAULT_FADE_OUT_MS };
	int c;

	while ((c = getopt_long(argc, argv, "a:h", opts, NULL)) != -1) {
		if (c == 'a')
			app_id = optarg;
		else if (c == 's')
			watch_stdin = true;
		else if (c == 'i')
			app.fade_in_ms = atoi(optarg);
		else if (c == 'o')
			app.fade_out_ms = atoi(optarg);
		else
			usage();
	}

	struct sigaction sa = { .sa_handler = on_signal };
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);
	signal(SIGPIPE, SIG_IGN);

	app.display = wl_display_connect(NULL);
	if (!app.display) {
		fprintf(stderr, "appliance-screensaver: cannot connect to the Wayland display\n");
		return 1;
	}
	struct wl_registry *reg = wl_display_get_registry(app.display);
	wl_registry_add_listener(reg, &registry_listener, &app);
	wl_display_roundtrip(app.display);
	if (!app.compositor || !app.shm || !app.wm_base) {
		fprintf(stderr, "appliance-screensaver: compositor lacks wl_compositor, wl_shm or xdg_wm_base\n");
		return 1;
	}

	if (!make_levels(&app))
		return 1;
	app.surface = wl_compositor_create_surface(app.compositor);
	if (app.viewporter)
		app.viewport = wp_viewporter_get_viewport(app.viewporter, app.surface);
	app.xdg_surface = xdg_wm_base_get_xdg_surface(app.wm_base, app.surface);
	xdg_surface_add_listener(app.xdg_surface, &xdg_surface_listener, &app);
	app.toplevel = xdg_surface_get_toplevel(app.xdg_surface);
	xdg_toplevel_add_listener(app.toplevel, &toplevel_listener, &app);
	xdg_toplevel_set_app_id(app.toplevel, app_id);
	xdg_toplevel_set_title(app.toplevel, "Screensaver");
	xdg_toplevel_set_fullscreen(app.toplevel, NULL);
	wl_surface_commit(app.surface);

	/* Wayland events, plus stdin commands if asked (EOF: the supervisor is gone). */
	char line[128];
	size_t line_len = 0;
	struct pollfd fds[2] = {
		{ .fd = wl_display_get_fd(app.display), .events = POLLIN },
		{ .fd = STDIN_FILENO, .events = POLLIN },
	};
	while (!app.quit && !got_signal) {
		while (wl_display_prepare_read(app.display) != 0)
			wl_display_dispatch_pending(app.display);
		if (wl_display_flush(app.display) < 0 && errno != EAGAIN) {
			wl_display_cancel_read(app.display);
			break;
		}
		if (poll(fds, watch_stdin ? 2 : 1, -1) < 0) {
			wl_display_cancel_read(app.display);
			if (errno == EINTR)
				continue;
			break;
		}
		if (fds[0].revents & POLLIN) {
			if (wl_display_read_events(app.display) < 0)
				break;
		} else {
			wl_display_cancel_read(app.display);
		}
		if (wl_display_dispatch_pending(app.display) < 0)
			break;
		if (fds[0].revents & (POLLERR | POLLHUP))
			break;
		if (watch_stdin && (fds[1].revents & (POLLIN | POLLHUP))) {
			ssize_t n = read(STDIN_FILENO, line + line_len, sizeof line - 1 - line_len);
			if (n <= 0) {
				app.stdin_eof = true; /* the supervisor is gone */
				break;
			}
			line_len += n;
			line[line_len] = 0;
			char *nl;
			while ((nl = strchr(line, '\n'))) {
				*nl = 0;
				if (!strcmp(line, "fade-out"))
					fade_out(&app);
				line_len -= nl + 1 - line;
				memmove(line, nl + 1, line_len + 1);
			}
			if (line_len == sizeof line - 1)
				line_len = 0; /* an overlong line: drop it */
		}
	}
	/* Leaving: the compositor unmaps the window when the connection closes. */
	wl_display_disconnect(app.display);
	return got_signal || app.quit || app.stdin_eof ? 0 : 1;
}
