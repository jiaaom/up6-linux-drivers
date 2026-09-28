# weston-appliance-shell

A [weston](https://gitlab.freedesktop.org/wayland/weston) shell plugin for
single-purpose screens (appliance front panels, TVs, kiosks) where
**software decides what is on screen**, not the user.

weston's own shells are built for other jobs. `desktop-shell` raises whatever
you touch, lets windows be dragged and shows a clock bar. `kiosk-shell` shows
one application at a time. This shell keeps every window mapped and stacks
windows by rule and by command. That lets you put a native app (mpv, a Qt
app, an emulator…) on top of a web UI, float a translucent control layer
over it, or rotate one window without rotating the screen.

Applications need no changes: they are ordinary `xdg-shell` clients.

## Features

- **Stacking by layer.** Each top-level window has a layer number (from a
  rule, default 0). Higher layers are always above lower ones. Within a
  layer, newer or raised windows are on top.
- **No accidental reordering.** Touching or clicking a window never changes
  the stacking order. There is no interactive move or resize.
- **Translucency works.** Lower windows keep rendering live under
  translucent ones. Input goes to the topmost window under the finger.
- **Per-window rotation.** 0/90/180/270°. The client is configured with the
  rotated size, so it lays out in landscape on a portrait panel. The
  compositor maps touch and pointer input back to it.
- **Fullscreen top-levels on a chosen output.** Child windows (dialogs) stay
  with their parent.
- **Keyboard focus** follows the topmost visible `focusable` window, or is
  set explicitly.
- **Control socket** for a supervising process.

## appliance-screensaver

A companion client, built along with the shell (`-Dscreensaver=false` to
skip it). It opens a black fullscreen window and reports input on stdout,
one event per line:

| line | meaning |
|---|---|
| `ready` | the window is mapped (first frame shown) |
| `key <code>` | a key was pressed (Linux evdev code) |
| `tap` / `doubletap` | a short touch or click / two close together |

It fades in from transparent to black (`--fade-in MS`, default 400; 0 =
black at once) and reports `ready` once it is black. With `--watch-stdin`
it reads commands from stdin, one per line: `fade-out` fades back out
(`--fade-out MS`, default 300) and exits. A 1×1 pixel per alpha level is
scaled to the window with `wp_viewporter`, so a fade step costs one pixel.
Without a viewporter it is simply black and never fades. Input is taken from
the first frame on, while it is still fading in.

It decides nothing itself. A supervising process starts it when the screen
goes dark, reads the events (e.g. wake the screen on a key, change the
volume on volume keys), and sends `fade-out` (or stops it) when the screen
is lit again. It stays
alive until SIGTERM, the compositor closes it, or (with `--watch-stdin`) its
stdin reaches EOF. Give its app-id (`screensaver`, or `--app-id`) a rule above
everything else, and while it is up it alone gets keys and touches:

```ini
[appliance-rule]
app-id=screensaver
layer=100
```

A different screensaver (a clock, a slideshow) can be any client that
follows the same stdout contract.

## Build

Needs the libweston and weston plugin headers for the **same major version**
as the weston that will load the module (Debian: `libweston-14-dev`,
`weston-dev`), plus meson and ninja.

```sh
meson setup build            # -Dlibweston=libweston-15 for weston 15
ninja -C build
sudo ninja -C build install  # installs appliance-shell.so into <libdir>/weston
```

## Use

```ini
[core]
shell=appliance-shell.so          # or an absolute path

[appliance-rule]
app-id=my-main-ui
layer=0

[appliance-rule]
app-id=mpv
layer=10

[appliance-rule]
app-id=my-overlay
layer=20
focusable=false                    # never takes keyboard focus
#rotation=90                       # initial rotation
#output=HDMI-A-2                   # open on this output
```

See `examples/weston.ini`.

### `[appliance-rule]` keys

| key | default | meaning |
|---|---|---|
| `app-id` | (required) | exact xdg-shell app-id to match |
| `layer` | `0` | stacking layer; higher is above |
| `rotation` | `0` | initial rotation, clockwise degrees (0/90/180/270) |
| `focusable` | `true` | may receive keyboard focus |
| `output` | default output | output name to open on |

### `[appliance-shell]` keys

| key | default | meaning |
|---|---|---|
| `control-socket` | `$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY.appliance-shell` | path, or `none` |

`[shell] background-color` sets the colour behind all windows.

## Control socket

A unix stream socket, mode 0600 (only the compositor's user). It takes one
command per line and answers one JSON object per line.

| command | effect |
|---|---|
| `list` | all windows, topmost first: id, app_id, title, parent, layer, rotation, hidden, mapped, focused, size, output |
| `raise <sel>` / `lower <sel>` | top / bottom of its layer |
| `hide <sel>` / `show <sel>` | unmap / remap without closing |
| `focus <sel>` | keyboard focus |
| `close <sel>` | ask the client to close |
| `rotate <sel> <deg>` | 0, 90, 180, 270 |
| `layer <sel> <n>` | move to another layer |

`<sel>` is `#<id>` for one window, or an app-id for every top-level window
with that app-id. Commands act on a whole window tree (a window and its
dialogs).

```sh
$ tools/appliance-shell-ctl list
id   app_id                   layer rot  hidden focus title
2    mpv                      10    90          *     movie.mkv
1    t6-panel                 0     0                 Panel
$ tools/appliance-shell-ctl rotate mpv 0
{"ok": true, "count": 1}
```

## Compatibility

libweston breaks its API between major versions, so a module built for
weston 14 only loads in weston 14. Pin the weston package or rebuild on
upgrade. If the module fails to load, weston does not start. A launcher
should fall back to `shell=kiosk-shell.so`.

Developed and tested against weston 14.0.2 (Debian bookworm-backports) with
the DRM backend on an Intel Meteor Lake iGPU, and with the headless backend.

## License

MIT. Derived from weston's kiosk-shell; see `LICENSE`.
