/*
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
 * Control socket: a unix stream socket speaking one command per line and
 * answering one JSON object per line.
 *
 *   list
 *   raise  <sel>          top of its layer
 *   lower  <sel>          bottom of its layer
 *   hide   <sel>
 *   show   <sel>
 *   focus  <sel>          keyboard focus (until the stack changes)
 *   close  <sel>          ask the client to close (xdg_toplevel.close)
 *   rotate <sel> <deg>    0, 90, 180 or 270 (clockwise)
 *   layer  <sel> <n>      move to another layer
 *
 * <sel> is "#<id>" for one window or an app-id for every top-level window
 * with that app-id. Commands act on top-level windows and carry their
 * child windows along.
 *
 * The socket is created mode 0600: only the compositor's own user may
 * control it.
 */

#include <errno.h>
#include <stdarg.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <libweston/libweston.h>
#include <libweston/zalloc.h>

#include "appliance-shell.h"

#define ASH_LINE_MAX 1024

struct ash_client {
	struct ash_shell *shell;
	int fd;
	struct wl_event_source *source;
	struct wl_list link;
	char buf[ASH_LINE_MAX];
	size_t len;
};

/* growable output buffer */
struct ash_out {
	char *data;
	size_t len, cap;
	bool oom;
};

static void
out_append(struct ash_out *o, const char *s, size_t n)
{
	if (o->oom)
		return;
	if (o->len + n + 1 > o->cap) {
		size_t cap = o->cap ? o->cap * 2 : 256;
		char *d;

		while (cap < o->len + n + 1)
			cap *= 2;
		d = realloc(o->data, cap);
		if (!d) {
			o->oom = true;
			return;
		}
		o->data = d;
		o->cap = cap;
	}
	memcpy(o->data + o->len, s, n);
	o->len += n;
	o->data[o->len] = '\0';
}

static void
out_str(struct ash_out *o, const char *s)
{
	out_append(o, s, strlen(s));
}

static void
out_fmt(struct ash_out *o, const char *fmt, ...)
{
	char tmp[256];
	va_list ap;
	int n;

	va_start(ap, fmt);
	n = vsnprintf(tmp, sizeof tmp, fmt, ap);
	va_end(ap);
	if (n > 0)
		out_append(o, tmp, (size_t)n < sizeof tmp ? (size_t)n : sizeof tmp - 1);
}

static void
out_json_string(struct ash_out *o, const char *s)
{
	out_str(o, "\"");
	for (; *s; s++) {
		unsigned char c = *s;

		if (c == '"' || c == '\\') {
			char e[2] = { '\\', c };
			out_append(o, e, 2);
		} else if (c < 0x20) {
			out_fmt(o, "\\u%04x", c);
		} else {
			out_append(o, (const char *)&c, 1);
		}
	}
	out_str(o, "\"");
}

static void
reply_error(struct ash_out *o, const char *msg)
{
	out_str(o, "{\"ok\":false,\"error\":");
	out_json_string(o, msg);
	out_str(o, "}\n");
}

static void
cmd_list(struct ash_shell *shell, struct ash_out *o)
{
	struct ash_surface *s;
	bool first = true;

	out_str(o, "{\"ok\":true,\"windows\":[");
	wl_list_for_each(s, &shell->stack, link) {
		struct weston_surface *surface =
			weston_desktop_surface_get_surface(s->desktop_surface);

		if (!first)
			out_str(o, ",");
		first = false;

		out_fmt(o, "{\"id\":%u,\"app_id\":", s->id);
		out_json_string(o, ash_surface_app_id(s));
		out_str(o, ",\"title\":");
		out_json_string(o, ash_surface_title(s));
		out_fmt(o, ",\"parent\":%u,\"layer\":%d,\"rotation\":%d,"
			   "\"hidden\":%s,\"mapped\":%s,\"focused\":%s,"
			   "\"width\":%d,\"height\":%d,\"output\":",
			s->parent ? s->parent->id : 0, s->layer, s->rotation,
			s->hidden ? "true" : "false",
			weston_surface_is_mapped(surface) ? "true" : "false",
			ash_surface_is_focused(s) ? "true" : "false",
			surface->width, surface->height);
		if (s->output)
			out_json_string(o, s->output->name);
		else
			out_str(o, "null");
		out_str(o, "}");
	}
	out_str(o, "]}\n");
}

/* Collect the top-level windows matching a selector. Returns the count. */
static int
select_roots(struct ash_shell *shell, const char *sel,
	     struct ash_surface **found, int max)
{
	struct ash_surface *s;
	int n = 0;

	if (sel[0] == '#') {
		char *end;
		unsigned long id = strtoul(sel + 1, &end, 10);

		if (*end)
			return 0;
		wl_list_for_each(s, &shell->stack, link) {
			if (s->id == id && n < max) {
				found[n++] = s;
				break;
			}
		}
		return n;
	}

	wl_list_for_each(s, &shell->stack, link) {
		if (s->parent || strcmp(ash_surface_app_id(s), sel) != 0)
			continue;
		if (n < max)
			found[n++] = s;
	}
	return n;
}

static bool
parse_int(const char *s, int *v)
{
	char *end;
	long l;

	if (!s || !*s)
		return false;
	l = strtol(s, &end, 10);
	if (*end)
		return false;
	*v = (int)l;
	return true;
}

static void
handle_line(struct ash_shell *shell, char *line, struct ash_out *o)
{
	char *argv[4] = { NULL };
	int argc = 0, n, i, v = 0;
	struct ash_surface *found[64];
	char *save = NULL, *tok;

	for (tok = strtok_r(line, " \t\r", &save); tok && argc < 4;
	     tok = strtok_r(NULL, " \t\r", &save))
		argv[argc++] = tok;

	if (argc == 0)
		return;

	if (strcmp(argv[0], "list") == 0) {
		cmd_list(shell, o);
		return;
	}

	static const char *const commands[] = {
		"raise", "lower", "hide", "show", "focus", "close", "rotate",
		"layer", NULL
	};
	for (i = 0; commands[i]; i++)
		if (strcmp(argv[0], commands[i]) == 0)
			break;
	if (!commands[i]) {
		reply_error(o, "unknown command");
		return;
	}

	if (argc < 2) {
		reply_error(o, "missing selector");
		return;
	}

	if ((strcmp(argv[0], "rotate") == 0 || strcmp(argv[0], "layer") == 0) &&
	    !parse_int(argv[2], &v)) {
		reply_error(o, "missing or invalid number");
		return;
	}
	if (strcmp(argv[0], "rotate") == 0 && v % 90 != 0) {
		reply_error(o, "rotation must be a multiple of 90");
		return;
	}

	n = select_roots(shell, argv[1], found, 64);
	if (n == 0) {
		reply_error(o, "no such window");
		return;
	}

	for (i = 0; i < n; i++) {
		struct ash_surface *s = found[i];

		if (strcmp(argv[0], "raise") == 0)
			ash_surface_raise(s);
		else if (strcmp(argv[0], "lower") == 0)
			ash_surface_lower(s);
		else if (strcmp(argv[0], "hide") == 0)
			ash_surface_set_hidden(s, true);
		else if (strcmp(argv[0], "show") == 0)
			ash_surface_set_hidden(s, false);
		else if (strcmp(argv[0], "focus") == 0)
			ash_surface_focus(s);
		else if (strcmp(argv[0], "close") == 0)
			weston_desktop_surface_close(s->desktop_surface);
		else if (strcmp(argv[0], "rotate") == 0)
			ash_surface_set_rotation(s, v);
		else if (strcmp(argv[0], "layer") == 0)
			ash_surface_set_layer(s, v);
		else {
			reply_error(o, "unknown command");
			return;
		}
	}

	out_fmt(o, "{\"ok\":true,\"count\":%d}\n", n);
}

static void
client_destroy(struct ash_client *client)
{
	wl_event_source_remove(client->source);
	close(client->fd);
	wl_list_remove(&client->link);
	free(client);
}

static void
client_send(struct ash_client *client, struct ash_out *o)
{
	size_t off = 0;

	while (off < o->len) {
		ssize_t w = send(client->fd, o->data + off, o->len - off,
				 MSG_NOSIGNAL);
		if (w < 0) {
			if (errno == EINTR)
				continue;
			/* EAGAIN: slow reader; drop the rest rather than
			 * block the compositor. */
			break;
		}
		off += w;
	}
}

static int
client_readable(int fd, uint32_t mask, void *data)
{
	struct ash_client *client = data;
	struct ash_out out = {};
	ssize_t r;
	char *nl;

	if (mask & (WL_EVENT_HANGUP | WL_EVENT_ERROR)) {
		client_destroy(client);
		return 0;
	}

	r = read(fd, client->buf + client->len,
		 sizeof client->buf - client->len - 1);
	if (r <= 0) {
		if (r < 0 && (errno == EAGAIN || errno == EINTR))
			return 0;
		client_destroy(client);
		return 0;
	}
	client->len += r;
	client->buf[client->len] = '\0';

	while ((nl = memchr(client->buf, '\n', client->len))) {
		size_t line_len = nl - client->buf;

		*nl = '\0';
		handle_line(client->shell, client->buf, &out);
		memmove(client->buf, nl + 1, client->len - line_len - 1);
		client->len -= line_len + 1;
		client->buf[client->len] = '\0';
	}

	if (client->len == sizeof client->buf - 1) {
		reply_error(&out, "line too long");
		client->len = 0;
	}

	if (out.oom) {
		free(out.data);
		client_destroy(client);
		return 0;
	}
	if (out.len)
		client_send(client, &out);
	free(out.data);
	return 0;
}

static int
listen_readable(int fd, uint32_t mask, void *data)
{
	struct ash_shell *shell = data;
	struct wl_event_loop *loop =
		wl_display_get_event_loop(shell->compositor->wl_display);
	struct ash_client *client;
	int cfd;

	cfd = accept4(fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
	if (cfd < 0)
		return 0;

	client = zalloc(sizeof *client);
	if (!client) {
		close(cfd);
		return 0;
	}
	client->shell = shell;
	client->fd = cfd;
	client->source = wl_event_loop_add_fd(loop, cfd, WL_EVENT_READABLE,
					      client_readable, client);
	if (!client->source) {
		close(cfd);
		free(client);
		return 0;
	}
	wl_list_insert(&shell->client_list, &client->link);
	return 0;
}

static char *
default_socket_path(void)
{
	const char *dir = getenv("XDG_RUNTIME_DIR");
	const char *display = getenv("WAYLAND_DISPLAY");
	char *path;

	if (!dir)
		return NULL;
	if (!display || strchr(display, '/'))
		display = "wayland";
	if (asprintf(&path, "%s/%s.appliance-shell", dir, display) < 0)
		return NULL;
	return path;
}

int
ash_control_init(struct ash_shell *shell)
{
	struct weston_config_section *section = NULL;
	struct wl_event_loop *loop =
		wl_display_get_event_loop(shell->compositor->wl_display);
	struct sockaddr_un addr = { .sun_family = AF_UNIX };
	int fd;

	if (shell->config)
		section = weston_config_get_section(shell->config,
						    "appliance-shell", NULL, NULL);
	if (section)
		weston_config_section_get_string(section, "control-socket",
						 &shell->socket_path, NULL);
	if (shell->socket_path && strcmp(shell->socket_path, "none") == 0) {
		free(shell->socket_path);
		shell->socket_path = NULL;
		return -1;
	}
	if (!shell->socket_path)
		shell->socket_path = default_socket_path();
	if (!shell->socket_path ||
	    strlen(shell->socket_path) >= sizeof addr.sun_path) {
		weston_log("appliance-shell: no usable control socket path\n");
		return -1;
	}
	strcpy(addr.sun_path, shell->socket_path);

	fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (fd < 0)
		return -1;

	unlink(shell->socket_path);
	if (bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0 ||
	    chmod(shell->socket_path, 0600) < 0 ||
	    listen(fd, 8) < 0) {
		weston_log("appliance-shell: control socket %s: %s\n",
			   shell->socket_path, strerror(errno));
		close(fd);
		return -1;
	}

	shell->listen_fd = fd;
	shell->listen_source = wl_event_loop_add_fd(loop, fd, WL_EVENT_READABLE,
						    listen_readable, shell);
	weston_log("appliance-shell: control socket %s\n", shell->socket_path);
	return 0;
}

void
ash_control_fini(struct ash_shell *shell)
{
	struct ash_client *client, *tmp;

	wl_list_for_each_safe(client, tmp, &shell->client_list, link)
		client_destroy(client);

	if (shell->listen_source)
		wl_event_source_remove(shell->listen_source);
	if (shell->listen_fd >= 0) {
		close(shell->listen_fd);
		unlink(shell->socket_path);
	}
	free(shell->socket_path);
}
