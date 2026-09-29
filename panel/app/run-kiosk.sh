#!/bin/bash
# Launch the T6 front-panel kiosk on the physical touch screen.
#
# The panel is a window of appliance-compositor (one weston + appliance-shell
# on every display, shared with other screen apps; its runtime contract is
# docs/CONTRACT.md in that project). Our fragment in
# /etc/appliance-compositor/clients.d/t6-panel.ini puts this window (app-id
# t6-panel) on the built-in screen, scaled 2x; see compositor.ini.
#
# This script launches the Electron shell with the one Chromium flag that must
# live on the real command line: --ozone-platform=wayland (Electron reads the
# ozone platform before main.js runs, so it can't be set via
# app.commandLine). The GPU/ANGLE switches that turn on iGPU acceleration are
# set inside main.js instead; the Mesa they need is appliance-compositor's
# install requirement.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON="$APP_DIR/node_modules/electron/dist/electron"

# The compositor's client environment. The kiosk unit loads it with
# EnvironmentFile=; this covers manual starts.
CLIENT_ENV=/usr/local/lib/appliance-compositor/client.env
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -f "$CLIENT_ENV" ]; then
  set -a; . "$CLIENT_ENV"; set +a
fi
: "${XDG_RUNTIME_DIR:=/run/user/0}"
: "${WAYLAND_DISPLAY:=wayland-appliance}"
export XDG_RUNTIME_DIR WAYLAND_DISPLAY

# The compositor unit is Type=notify, so under systemd the socket is already
# up; give manual starts a few seconds.
for _ in $(seq 1 40); do
  [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
  sleep 0.25
done

# --no-sandbox: the shell runs as root on the appliance; the Chromium sandbox
# can't drop privileges from uid 0 and would refuse to start otherwise.
exec "$ELECTRON" \
  --no-sandbox \
  --ozone-platform=wayland \
  "$APP_DIR"
