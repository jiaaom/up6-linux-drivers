#!/bin/bash
# Install (or remove) the DKMS packages from t6-platform-dkms/ and focaltech-ft8722-dkms/.
#
#   sudo ./install-dkms.sh            install/upgrade both packages for the running kernel
#   sudo ./install-dkms.sh --remove   remove both packages and their boot-time config
#   sudo ./install-dkms.sh --no-load  install without loading the modules right away
#
# Each package directory must contain a dkms.conf with PACKAGE_NAME and
# PACKAGE_VERSION; everything else is derived from it. Older versions of the
# same package are removed first, so re-running after a version bump upgrades.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PACKAGES=(t6-platform-dkms focaltech-ft8722-dkms)
MODULES_LOAD_CONF=/etc/modules-load.d/t6-platform.conf

LOG=$(mktemp -t install-dkms.XXXXXX)
trap 'rm -f "$LOG"' EXIT

log()  { printf '==> %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Run a dkms step quietly; print its output only when it fails.
dkms_step() {
    if ! dkms "$@" >"$LOG" 2>&1; then
        cat "$LOG" >&2
        die "dkms $* failed"
    fi
}

# Read PACKAGE_NAME / PACKAGE_VERSION from a dkms.conf without sourcing it.
conf_value() {
    sed -n "s/^$2=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$1/dkms.conf" | head -n1
}

module_loaded() { [ -d "/sys/module/$1" ]; }

# rmmod rather than modprobe -r: the latter also tries to remove soft
# dependencies (pinctrl_meteorlake, always busy) and reports failure
# even though the module itself was unloaded.
unload_module() {
    module_loaded "$1" || return 0
    rmmod "$1" || die "cannot unload $1"
}

require_root() {
    [ "$(id -u)" -eq 0 ] || die "run as root (sudo $0 $*)"
}

check_prerequisites() {
    command -v dkms >/dev/null || die "dkms is not installed (apt install dkms)"
    local kver
    kver=$(uname -r)
    [ -d "/lib/modules/$kver/build" ] || die "kernel headers for $kver are missing (apt install linux-headers-$kver)"
}

# Remove every registered version of a package (dkms status lists "name/version, ...").
remove_package() {
    local name=$1 ver
    for ver in $(dkms status 2>/dev/null | sed -n "s|^$name/\([^,]*\),.*|\1|p" | sort -u); do
        log "removing $name/$ver"
        dkms_step remove "$name/$ver" --all
        rm -rf "/usr/src/$name-$ver"
    done
}

install_package() {
    local dir=$1 name ver src
    name=$(conf_value "$dir" PACKAGE_NAME)
    ver=$(conf_value "$dir" PACKAGE_VERSION)
    [ -n "$name" ] && [ -n "$ver" ] || die "$dir/dkms.conf lacks PACKAGE_NAME/PACKAGE_VERSION"

    remove_package "$name"

    src=/usr/src/$name-$ver
    log "installing $name/$ver"
    mkdir -p "$src"
    # Sources only; build artefacts stay out of /usr/src.
    cp "$dir"/Makefile "$dir"/dkms.conf "$src"/
    cp "$dir"/*.c "$src"/
    cp "$dir"/*.h "$src"/ 2>/dev/null || true
    [ -f "$dir/README.md" ] && cp "$dir/README.md" "$src"/

    dkms_step add "$name/$ver"
    dkms_step build "$name/$ver"
    dkms_step install "$name/$ver" --force
}

# t6_platform has no hardware alias (it gates on DMI in probe), so it must be
# listed for boot-time loading; ft8722_ts autoloads from its ACPI alias.
install_boot_config() {
    if [ ! -f "$MODULES_LOAD_CONF" ]; then
        log "enabling t6_platform at boot ($MODULES_LOAD_CONF)"
        printf '# ZSpace T6 EC platform driver (no hardware alias; gated by DMI in probe)\nt6_platform\n' > "$MODULES_LOAD_CONF"
    fi
}

load_modules() {
    local m
    for m in t6_platform ft8722_ts; do
        unload_module "$m"
        modprobe "$m" || die "cannot load $m (see dmesg)"
    done
    # Reloading t6_platform renumbers its hwmon device; the fan daemon caches paths.
    if systemctl is-active --quiet t6-fand 2>/dev/null; then
        log "restarting t6-fand"
        systemctl restart t6-fand
    fi
}

do_install() {
    local load=$1 dir names=()
    check_prerequisites
    for dir in "${PACKAGES[@]}"; do
        [ -f "$SCRIPT_DIR/$dir/dkms.conf" ] || die "missing $SCRIPT_DIR/$dir/dkms.conf"
        install_package "$SCRIPT_DIR/$dir"
        names+=("$(conf_value "$SCRIPT_DIR/$dir" PACKAGE_NAME)")
    done
    install_boot_config
    if [ "$load" = yes ]; then
        log "loading modules"
        load_modules
    fi
    log "done"
    dkms status | grep -E "^($(IFS='|'; echo "${names[*]}"))/" || true
}

do_remove() {
    local m dir name
    for m in ft8722_ts t6_platform; do
        unload_module "$m"
    done
    for dir in "${PACKAGES[@]}"; do
        name=$(conf_value "$SCRIPT_DIR/$dir" PACKAGE_NAME)
        [ -n "$name" ] && remove_package "$name"
    done
    rm -f "$MODULES_LOAD_CONF"
    log "removed"
}

main() {
    local action=install load=yes
    while [ $# -gt 0 ]; do
        case $1 in
            --remove)  action=remove ;;
            --no-load) load=no ;;
            -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
            *) die "unknown option: $1" ;;
        esac
        shift
    done
    require_root "$@"
    case $action in
        install) do_install "$load" ;;
        remove)  do_remove ;;
    esac
}

main "$@"
