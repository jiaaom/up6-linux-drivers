#!/bin/bash
# Launch the T6 front-panel kiosk on the physical touch screen.
#
# The panel runs under a private weston compositor on the built-in DRM output.
# This script wires up the Wayland environment and launches the Electron shell
# with the one Chromium flag that must live on the real command line:
# --ozone-platform=wayland (Electron reads the ozone platform before main.js
# runs, so it can't be set via app.commandLine). The GPU/ANGLE switches that
# turn on iGPU acceleration are set inside main.js instead.
#
# Prereq: a system Mesa new enough to drive the Meteor Lake iGPU (PCI 0x7d55) —
# Debian 12's stock Mesa 22.3 does NOT; the backports 25.x GL stack
# (libgl1-mesa-dri, libegl-mesa0, libglx-mesa0, libgbm1) does. Without it the
# whole stack (weston included) falls back to llvmpipe/SwiftShader software
# rendering and pegs the CPU.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON="$APP_DIR/node_modules/electron/dist/electron"

# Wayland environment. Root's XDG_RUNTIME_DIR is not created by pam, so ensure it.
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
: "${WAYLAND_DISPLAY:=wayland-panel}"
export XDG_RUNTIME_DIR WAYLAND_DISPLAY
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Start weston on the DRM output if it isn't already up on our socket.
if [ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then
  weston --backend=drm-backend.so --socket="$WAYLAND_DISPLAY" --idle-time=0 &
  for _ in $(seq 1 40); do
    [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
    sleep 0.25
  done
fi

# --no-sandbox: the shell runs as root on the appliance; the Chromium sandbox
# can't drop privileges from uid 0 and would refuse to start otherwise.
exec "$ELECTRON" \
  --no-sandbox \
  --ozone-platform=wayland \
  "$APP_DIR"
