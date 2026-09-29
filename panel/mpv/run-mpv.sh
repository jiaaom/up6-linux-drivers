#!/bin/sh
# Start the bundled mpv (bin/, lib/ from packaging/mpv/bundle-mpv.sh) with the
# panel's player config. The kiosk (Electron main) runs this with the
# compositor's client environment (XDG_RUNTIME_DIR, WAYLAND_DISPLAY) already set.
HERE=$(cd "$(dirname "$0")" && pwd)

# Hardware decoding: lib/ carries our own libva 2.23.0 (core, drm, wayland,
# x11 — packaging/mpv/build-libva.sh) to match fnOS's iHD 26 driver, which we
# load from fnOS's media server. The iHD in /usr/lib/x86_64-linux-gnu/dri is
# too new for Debian's libva 2.17. Without the fnOS driver mpv decodes in
# software.
MEDIASRV_DRI=/usr/trim/lib/mediasrv/lib/dri
if [ -e "$MEDIASRV_DRI/iHD_drv_video.so" ]; then
    export LIBVA_DRIVERS_PATH="$MEDIASRV_DRI" LIBVA_DRIVER_NAME=iHD
fi

# The rotate button drives the compositor (see config/scripts/ash_rotate.lua),
# through appliance-compositor's control tool (its docs/CONTRACT.md).
CTL=/usr/local/lib/appliance-compositor/bin/appliance-shell-ctl
[ -x "$CTL" ] && export ASH_CTL="$CTL"

exec "$HERE/bin/mpv" --config-dir="$HERE/config" "$@"
