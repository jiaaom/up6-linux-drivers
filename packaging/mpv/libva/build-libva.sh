#!/bin/bash
# Build libva 2.23.0 (core + drm + wayland + x11) for the bundled mpv.
#
#   packaging/mpv/libva/build-libva.sh <lib-dir> <licenses-dir>
#
# Why: hardware decoding on the T6 uses fnOS's iHD 26 driver
# (/usr/trim/lib/mediasrv/lib/dri), which needs libva >= 2.23. fnOS ships
# libva 2.23 but no libva-wayland, and Debian's libva 2.17 can't load that
# driver at all; mixing fnOS's 2.23 core with Debian's 2.17 libva-wayland
# segfaults mpv's zero-copy path. So mpv gets a matching set of its own.
#
# The upstream release tarball is committed next to this script and checked
# against SHA256 below, so builds are offline and reproducible.
# Build deps (Debian): meson ninja-build libdrm-dev libwayland-dev
#   libx11-dev libxext-dev libxfixes-dev libx11-xcb-dev libxcb1-dev libxcb-dri3-dev

set -euo pipefail

VERSION=2.23.0
SHA256=9ac190a87017bfd49743248f5df7cf3b18a99a9962175caf6bbe3f1ea41b6dbb
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TARBALL=$SCRIPT_DIR/libva-$VERSION.tar.bz2

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: $0 <lib-dir> <licenses-dir>"
LIB=$1 LICENSES=$2
for tool in meson ninja patchelf; do
    command -v "$tool" >/dev/null || die "$tool not found"
done
echo "$SHA256  $TARBALL" | sha256sum -c --status || die "bad or missing $TARBALL"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar xjf "$TARBALL" -C "$work"
src=$work/libva-$VERSION
{
    meson setup "$work/build" "$src" --buildtype=release \
        -Dwith_x11=yes -Dwith_glx=no -Dwith_wayland=yes -Denable_docs=false &&
    ninja -C "$work/build"
} > "$work/build.log" 2>&1 || { tail -20 "$work/build.log" >&2; die "libva build failed (build deps: see header)"; }

mkdir -p "$LIB" "$LICENSES"
for name in libva libva-drm libva-wayland libva-x11; do
    so=$name.so.2.2300.0
    cp "$work/build/va/$so" "$LIB/"
    ln -sf "$so" "$LIB/$name.so.2"
    # the drm/wayland/x11 parts find libva.so.2 next to them
    patchelf --set-rpath '$ORIGIN' "$LIB/$so"
done
cp "$src/COPYING" "$LICENSES/libva.COPYING"
echo "libva $VERSION (built from source, upstream tarball sha256 $SHA256)" >> "$LICENSES/VERSIONS"
