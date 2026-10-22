#!/bin/sh
# Put this tree's panel on this machine's front panel, as root, without
# building an .fpk:
#
#   sudo panel/tools/dev-deploy.sh
#
# Installs the t6-paneld from `cargo build --release -p t6-paneld`, the
# kiosk's main.js, preload.js and run-kiosk.sh, and panel/www, into the installed app, then
# restarts the backend and the kiosk. Not for releases: build-fpk.sh is.
set -eu

APP=/usr/local/apps/@appcenter/t6-panel
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=$REPO/crates/target/release/t6-paneld
[ -x "$BIN" ] || { echo "build it first: (cd crates && cargo build --release -p t6-paneld)" >&2; exit 1; }

install -m 755 "$BIN" "$APP/bin/t6-paneld"
install -m 644 "$REPO/panel/app/main.js" "$REPO/panel/app/preload.js" "$APP/app/"
install -m 755 "$REPO/panel/app/run-kiosk.sh" "$APP/app/"
# as build-fpk.sh lays it out: the kiosk's libva is mpv's
mkdir -p "$APP/app/libva"
ln -sfn ../../mpv/lib/libva.so.2 ../../mpv/lib/libva-drm.so.2 "$APP/app/libva/"
rm -rf "$APP/www" "$APP/www-next"
cp -r "$REPO/panel/www" "$APP/www"

# The 2.0 preview pointed t6-paneld at www-next with a drop-in; not needed now.
DROPIN=/etc/systemd/system/t6-paneld.service.d/dev-ui.conf
if [ -f "$DROPIN" ]; then
    rm -f "$DROPIN"
    rmdir /etc/systemd/system/t6-paneld.service.d 2>/dev/null || true
fi

systemctl daemon-reload
systemctl restart t6-paneld t6-panel-kiosk
echo "panel updated from $REPO"
