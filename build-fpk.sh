#!/bin/bash
# Build the FygoOS packages: t6-drivers.fpk (DKMS modules) and t6control.fpk
# (fan and indicator daemons + web UI). Output lands in build/.
#
#   ./build-fpk.sh              build both
#   ./build-fpk.sh t6control    build one
#
# Package sources live in fpk/<name>/; their app/ payload is assembled here
# from the rest of the repository so nothing is duplicated in git.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BUILD_DIR=$SCRIPT_DIR/build
STAGE_DIR=$BUILD_DIR/fpk
DKMS_PACKAGES=(t6-platform-dkms focaltech-ft8722-dkms)

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
    local app=$1/app dir
    for dir in "${DKMS_PACKAGES[@]}"; do
        mkdir -p "$app/$dir"
        cp "$SCRIPT_DIR/$dir"/{Makefile,dkms.conf,*.c,README.md} "$app/$dir/"
        cp "$SCRIPT_DIR/$dir"/*.h "$app/$dir/" 2>/dev/null || true
    done
    cp "$SCRIPT_DIR/install-dkms.sh" "$app/"
}

payload_t6control() {
    local app=$1/app crate
    mkdir -p "$app/bin"
    for crate in t6-fand t6-ledd t6-web; do
        log "building $crate (release)"
        (cd "$SCRIPT_DIR/$crate" && cargo build --release --quiet)
    done
    cp "$SCRIPT_DIR/t6-fand/target/release/t6-fand" "$SCRIPT_DIR/t6-ledd/target/release/t6-ledd" \
       "$SCRIPT_DIR/t6-web/target/release/t6-webd" "$app/bin/"
    # Daemon defaults and units, installed system-wide by cmd/install_callback.
    cp "$SCRIPT_DIR/t6-fand/t6-fand.toml" "$SCRIPT_DIR/t6-fand/t6-fand.service" \
       "$SCRIPT_DIR/t6-ledd/t6-ledd.toml" "$SCRIPT_DIR/t6-ledd/t6-ledd.service" "$app/"
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
    [ ${#names[@]} -gt 0 ] || names=(t6-drivers t6control)
    mkdir -p "$BUILD_DIR"
    for n in "${names[@]}"; do
        build_package "$n"
    done
}

main "$@"
