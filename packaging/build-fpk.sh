#!/bin/bash
# Build the FygoOS packages: t6-drivers.fpk (DKMS modules) and t6-control.fpk
# (fan and indicator daemons + web UI). Output lands in build/.
#
#   ./build-fpk.sh              build both
#   ./build-fpk.sh t6-control    build one
#
# Package sources live in fpk/<name>/; their app/ payload is assembled here
# from the rest of the repository so nothing is duplicated in git.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)   # packaging/
REPO=$(dirname "$SCRIPT_DIR")
CRATES=$REPO/crates
KERNEL=$REPO/kernel
BUILD_DIR=$REPO/build
STAGE_DIR=$BUILD_DIR/fpk
DKMS_PACKAGES=(t6-platform-dkms focaltech-ft8722-dkms ite-it6616-dkms)
# weston-appliance-shell (the panel's weston shell): a self-contained project
# kept in this repo (own meson build, MIT license), so it can be split out
# with `git subtree split` if it is ever published on its own.
ASH_SRC=${ASH_SRC:-$REPO/weston-appliance-shell}

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Copy the package skeleton to the staging area and return its path.
stage() {
    local name=$1 dst=$STAGE_DIR/$1
    rm -rf "$dst"
    mkdir -p "$STAGE_DIR"
    cp -r "$SCRIPT_DIR/fpk/$name" "$dst"
    mkdir -p "$dst/app"
    echo "$dst"
}

payload_t6_drivers() {
    local app=$1/app dir file
    for dir in "${DKMS_PACKAGES[@]}"; do
        mkdir -p "$app/$dir"
        cp "$KERNEL/$dir"/{Makefile,dkms.conf,README.md} "$app/$dir/"
        for file in "$KERNEL/$dir"/*.c "$KERNEL/$dir"/*.h; do
            [ -f "$file" ] || continue
            case "$file" in *.mod.c) continue ;; esac
            cp "$file" "$app/$dir/"
        done
    done
    cp "$SCRIPT_DIR/install-dkms.sh" "$app/"
}

payload_t6_control() {
    local app=$1/app crate
    mkdir -p "$app/bin"
    for crate in t6-fand t6-ledd t6-webd remoted; do
        log "building $crate (release)"
        (cd "$CRATES" && cargo build --release --quiet -p "$crate")
    done
    cp "$CRATES/target/release/t6-fand" "$CRATES/target/release/t6-ledd" \
       "$CRATES/target/release/t6-webd" "$CRATES/target/release/remoted" "$app/bin/"
    # Daemon defaults and units, installed system-wide by cmd/install_callback.
    cp "$CRATES/t6-fand/t6-fand.toml" "$CRATES/t6-fand/t6-fand.service" \
       "$CRATES/t6-ledd/t6-ledd.toml" "$CRATES/t6-ledd/t6-ledd.service" \
       "$CRATES/remoted/remoted.toml" "$CRATES/remoted/remoted.service" "$app/"
}

# Build weston-appliance-shell into $1 (module + screensaver + control tool + license).
# Needs meson, ninja and the libweston/weston dev headers matching the
# weston the panel runs (Debian: libweston-14-dev, weston-dev), plus
# libwayland-dev and wayland-protocols for appliance-screensaver.
build_appliance_shell() {
    local out=$1 bdir=$BUILD_DIR/appliance-shell
    [ -f "$ASH_SRC/meson.build" ] || die "weston-appliance-shell not found at $ASH_SRC (set ASH_SRC)"
    command -v meson >/dev/null && command -v ninja >/dev/null \
        || die "meson and ninja are needed to build weston-appliance-shell"
    log "building weston-appliance-shell"
    rm -rf "$bdir"
    { meson setup "$bdir" "$ASH_SRC" --buildtype=release && ninja -C "$bdir"; } >/dev/null \
        || die "weston-appliance-shell build failed"
    mkdir -p "$out"
    cp "$bdir/appliance-shell.so" "$bdir/appliance-screensaver" "$ASH_SRC/tools/appliance-shell-ctl" "$ASH_SRC/LICENSE" "$out/"
}

payload_t6_panel() {
    local app=$1/app
    mkdir -p "$app/bin" "$app/www" "$app/app/node_modules"
    log "building t6-paneld (release)"
    (cd "$CRATES" && cargo build --release --quiet -p t6-paneld)
    cp "$CRATES/target/release/t6-paneld" "$app/bin/"
    # The panel UI (served by t6-paneld from $TRIM_APPDEST/www).
    cp "$REPO/panel/www/"* "$app/www/"
    mkdir -p "$app/web"
    cp "$REPO/panel/web/"* "$app/web/"   # admin page (fnOS desktop window)
    # The on-device kiosk: the Electron shell + its bundled Electron runtime,
    # launched at boot by the t6-panel-kiosk unit (see fpk/t6-panel/cmd/common).
    cp "$REPO/panel/app/"{main.js,preload.js,package.json,package-lock.json,run-kiosk.sh,set-drm-prop.py,weston.ini} "$app/app/"
    chmod +x "$app/app/run-kiosk.sh" "$app/app/set-drm-prop.py"
    [ -x "$REPO/panel/app/node_modules/electron/dist/electron" ] \
        || die "panel/app/node_modules/electron missing — run 'npm ci' in panel/app first"
    log "bundling Electron runtime (~280 MB)"
    cp -a "$REPO/panel/app/node_modules/electron" "$app/app/node_modules/electron"
    # The video player: mpv from the pinned Debian packages (packaging/mpv),
    # plus its config and launcher (panel/mpv; see its README).
    log "bundling mpv"
    "$SCRIPT_DIR/mpv/bundle-mpv.sh" "$app/mpv" >/dev/null
    cp -r "$REPO/panel/mpv/config" "$REPO/panel/mpv/run-mpv.sh" "$app/mpv/"
    # Sound server config (WirePlumber rules), read via XDG_CONFIG_HOME by the
    # t6-audio units (fpk/t6-panel/cmd/common).
    mkdir -p "$app/audio/config"
    cp -r "$REPO/panel/audio/wireplumber" "$app/audio/config/"
    # The weston shell that stacks the player above the panel (run-kiosk.sh).
    build_appliance_shell "$app/shell"
}

build_package() {
    local name=$1 dir
    [ -d "$SCRIPT_DIR/fpk/$name" ] || die "unknown package: $name"
    dir=$(stage "$name")
    "payload_${name//-/_}" "$dir"
    log "packing $name $(sed -n 's/^version="\(.*\)"/\1/p' "$dir/manifest")"
    (cd "$BUILD_DIR" && fygopack build --directory "$dir" >/dev/null) || die "fygopack build failed for $name"
    ls -l "$BUILD_DIR/$name.fpk"
}

main() {
    command -v fygopack >/dev/null || die "fygopack not found (https://developer.fygonas.com/docs/cli/fygopack/)"
    local names=("$@")
    [ ${#names[@]} -gt 0 ] || names=(t6-drivers t6-control t6-panel)
    mkdir -p "$BUILD_DIR"
    for n in "${names[@]}"; do
        build_package "$n"
    done
}

main "$@"
