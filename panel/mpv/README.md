# Panel video player (mpv)

Tapping a video in the panel's file browser plays it fullscreen in a bundled
mpv. mpv runs as its own Wayland window on the panel's weston;
weston-appliance-shell (`/weston-appliance-shell` in this repo) stacks it
above the panel UI (`[appliance-rule] app-id=mpv layer=10` in `panel/app/weston.ini`).
When mpv exits, the panel is on top again.

```
panel/mpv/
  run-mpv.sh                  launcher: fnOS iHD driver path, ASH_CTL, --config-dir
  config/mpv.conf             vo/hwdec, geometry workaround, subtitles
  config/input.conf           keyboard / remote keys
  config/script-opts/uosc.conf  touch-sized controls + rotate button
  config/scripts/uosc/        uosc 5.13.0 (LGPL-2.1, patched, see below)
  config/scripts/ash_rotate.lua rotate button → appliance-shell-ctl rotate mpv
  config/scripts/t6_prefs.lua  player volume (starts at 15 %), remembered
  config/fonts/               uosc icon fonts
```

The mpv binary and its libraries are not in git as files. They come from the
pinned Debian packages in `packaging/mpv/` plus libva built from source
(`bundle-mpv.sh`), and the fpk build adds them next to this directory as
`bin/` and `lib/`.

## Runtime

- The kiosk (`panel/app/main.js`, `player:open`) starts `run-mpv.sh` with
  `--input-ipc-server`. It follows `pause` / `idle-active` over that socket to
  hold off the screen timeout while a video plays (t6-paneld
  `PUT /api/screen/inhibit`).
- **Hardware decoding**: zero-copy `hwdec=vaapi`, so frames stay on the GPU.
  This is what makes 4K HDR play smoothly. `vaapi-copy` read every frame back
  and managed only ~17 fps at 4K. The driver is fnOS's iHD 26
  (`/usr/trim/lib/mediasrv/lib/dri`, via `LIBVA_DRIVERS_PATH`). The iHD in
  `/usr/lib/x86_64-linux-gnu/dri` is too new for Debian's libva 2.17. It needs
  libva ≥ 2.23, and fnOS ships no libva-wayland. The bundle therefore carries
  its own libva 2.23.0 (core, drm, wayland, x11), built from the committed
  upstream tarball by `packaging/mpv/libva/build-libva.sh`. mpv falls back
  to software decoding on its own.
- **Audio**: `ao=pipewire`. mpv plays into PipeWire's default output.
  - That output is chosen on the panel (Settings → Audio, t6-paneld `/api/audio`). WirePlumber remembers it and each output's volume.
  - `config/scripts/t6_prefs.lua` only remembers mpv's own volume, which starts at 15 %.
  - With no speaker connected, WirePlumber's "Dummy Output" keeps the clock running, so video plays silently.
  - If PipeWire is down, mpv plays video without audio.
- **Rotation.** The uosc rotate button calls `appliance-shell-ctl rotate mpv
  0|90`. The compositor rotates video and controls together and maps touch.

## uosc changes

uosc 5.13.0 from https://github.com/tomasklaen/uosc/releases (LGPL-2.1, see
`config/scripts/uosc/LICENSE.LGPL`), with these changes:

1. `bin/` (ziggy helpers, ~17 MB, used for online subtitle search and the
   clipboard) is removed.
2. `lib/cursor.lua` `handle_mouse_pos`: on mpv < 0.38 Wayland touches move
   `mouse-pos` but always report `hover=false`. uosc treats hover=false→false as
   a repeated "mouse left" and ignored every tap. The patch treats moves as
   hovered until a real hover is ever seen.
3. `elements/TopBar.lua`: only the Close button (the player is always
   fullscreen under weston-appliance-shell; maximize/minimize do nothing).
4. `main.lua` audio-device menu: `auto` and `pipewire` are the same device
   here (the AO is fixed), so the menu shows one "System default" (the AO's
   default, following the system output) and then the real devices.
