#!/bin/bash
# Install (or remove) the DKMS packages from t6-platform-dkms/, focaltech-ft8722-dkms/ and ite-it6616-dkms/.
#
#   sudo ./install-dkms.sh            install/upgrade all packages for the running kernel
#   sudo ./install-dkms.sh --remove   remove all packages and their boot-time config
#   sudo ./install-dkms.sh --no-load  install without loading the modules right away
#   sudo ./install-dkms.sh --repair   build whatever is missing for the running kernel,
#                                     load the modules and restart T6 services that are down
#   sudo ./install-dkms.sh --repair --boot
#                                     same, from t6-drivers-check.service at boot: the T6
#                                     services are ordered after it, so none are restarted
#
# Each package directory must contain a dkms.conf with PACKAGE_NAME and
# PACKAGE_VERSION; everything else is derived from it. Older versions of the
# same package are removed first, so re-running after a version bump upgrades.
#
# --repair exits 3 when the kernel headers are missing and 4 while dpkg is
# busy (a system update may be installing the kernel right now); nothing is
# changed in either case.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PACKAGES=(t6-platform-dkms focaltech-ft8722-dkms ite-it6616-dkms)
# Package dirs are siblings of this script inside the .fpk payload, but live
# under ../kernel/ in the source tree.
if [ -d "$SCRIPT_DIR/${PACKAGES[0]}" ]; then PKG_ROOT=$SCRIPT_DIR; else PKG_ROOT=$SCRIPT_DIR/../kernel; fi
MODULES_LOAD_CONF=/etc/modules-load.d/t6-platform.conf
MODULES=(t6_platform ft8722_ts ite_it6616)
# Services that use the modules, restarted by --repair when a module was
# (re)loaded or the service is down. Missing ones are skipped.
T6_SERVICES=(t6-fand t6-ledd t6-paneld t6-panel-kiosk)
# Serialises every run: the boot check, a repair from the web UI and the
# App Center install/upgrade/uninstall callbacks.
LOCK_FILE=/run/lock/t6-drivers.lock
# Keep the compositor running: IT6616 needs HDMI video to wake on removal.
# Stop only the background writers before replacing their kernel devices.
RESTART_AFTER_RELOAD=()

LOG=$(mktemp -t install-dkms.XXXXXX)
finish() {
    local status=$? s
    trap - EXIT
    rm -f "$LOG"
    for s in "${RESTART_AFTER_RELOAD[@]}"; do
        systemctl start "$s" || printf 'warning: failed to restore %s\n' "$s" >&2
    done
    exit "$status"
}
trap finish EXIT

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

# Wait for any other run of this script to finish.
take_lock() {
    exec 9>"$LOCK_FILE"
    flock 9 || die "cannot lock $LOCK_FILE"
}

# dpkg holds POSIX locks on these while it installs packages (including the
# kernel image/headers, whose hooks run DKMS themselves).
dpkg_busy() {
    local f ino
    for f in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock; do
        [ -e "$f" ] || continue
        ino=$(stat -c %i "$f")
        grep -q ":$ino " /proc/locks && return 0
    done
    return 1
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
    local dir=$1 name ver src file
    name=$(conf_value "$dir" PACKAGE_NAME)
    ver=$(conf_value "$dir" PACKAGE_VERSION)
    [ -n "$name" ] && [ -n "$ver" ] || die "$dir/dkms.conf lacks PACKAGE_NAME/PACKAGE_VERSION"

    remove_package "$name"

    src=/usr/src/$name-$ver
    log "installing $name/$ver"
    mkdir -p "$src"
    # Sources only; build artefacts stay out of /usr/src.
    cp "$dir"/Makefile "$dir"/dkms.conf "$src"/
    for file in "$dir"/*.c "$dir"/*.h; do
        [ -f "$file" ] || continue
        case "$file" in *.mod.c) continue ;; esac
        cp "$file" "$src/"
    done
    [ -f "$dir/README.md" ] && cp "$dir/README.md" "$src"/

    dkms_step add "$name/$ver"
    dkms_step build "$name/$ver"
    dkms_step install "$name/$ver" --force
}

# t6_platform has no hardware alias (it gates on DMI in probe), so it must be
# listed for boot-time loading; the ACPI-matched modules autoload from aliases.
install_boot_config() {
    if [ ! -f "$MODULES_LOAD_CONF" ]; then
        log "enabling t6_platform at boot ($MODULES_LOAD_CONF)"
        printf '# ZSpace T6 EC platform driver (no hardware alias; gated by DMI in probe)\nt6_platform\n' > "$MODULES_LOAD_CONF"
    fi
}

# 0.9.12 briefly reported KEY_POWER and needed a udev rule to keep logind
# from powering off on a tap. The button is KEY_SCREENLOCK now, which logind
# ignores; remove the old rules.
remove_old_button_rules() {
    if [ -e /etc/udev/rules.d/69-t6-power-button.rules ] || [ -e /etc/udev/rules.d/71-t6-power-button.rules ]; then
        rm -f /etc/udev/rules.d/69-t6-power-button.rules /etc/udev/rules.d/71-t6-power-button.rules
        udevadm control --reload 2>/dev/null || true
    fi
}

pause_controls() {
    local s
    for s in t6-fand t6-ledd; do
        if systemctl is-active --quiet "$s"; then
            RESTART_AFTER_RELOAD+=("$s")
            log "stopping $s before module replacement"
            systemctl stop "$s" || die "cannot stop $s"
        fi
    done
}

resume_controls() {
    local s failed=no
    for s in "${RESTART_AFTER_RELOAD[@]}"; do
        log "starting $s with the new kernel devices"
        systemctl start "$s" || failed=yes
    done
    [ "$failed" = no ] || die "cannot restart control services (see journalctl)"
    RESTART_AFTER_RELOAD=()
}

load_modules() {
    local m
    pause_controls
    for m in "${MODULES[@]}"; do
        unload_module "$m"
        modprobe "$m" || die "cannot load $m (see dmesg)"
    done
    resume_controls
}

do_install() {
    local load=$1 dir names=()
    check_prerequisites
    for dir in "${PACKAGES[@]}"; do
        [ -f "$PKG_ROOT/$dir/dkms.conf" ] || die "missing $PKG_ROOT/$dir/dkms.conf"
        install_package "$PKG_ROOT/$dir"
        names+=("$(conf_value "$PKG_ROOT/$dir" PACKAGE_NAME)")
    done
    install_boot_config
    remove_old_button_rules
    if [ "$load" = yes ]; then
        log "loading modules"
        load_modules
    fi
    log "done"
    dkms status | grep -E "^($(IFS='|'; echo "${names[*]}"))/" || true
}

# Captured first: with pipefail, `dkms ... | grep -q` fails whenever grep
# exits early and dkms gets SIGPIPE.
dkms_status() { dkms status "$@" 2>/dev/null || true; }

# "name/ver, kver, arch: installed" once a package is built for a kernel.
built_for_kernel() {
    local out
    out=$(dkms_status "$1" -k "$2")
    [[ $out == *": installed"* ]]
}

registered() { [ -n "$(dkms_status "$1")" ]; }

restart_services() {
    local reloaded=$1 s
    for s in "${T6_SERVICES[@]}"; do
        systemctl is-enabled --quiet "$s" 2>/dev/null || continue
        if [ "$reloaded" = yes ] || ! systemctl is-active --quiet "$s"; then
            log "restarting $s"
            systemctl reset-failed "$s" 2>/dev/null || true
            systemctl restart "$s" || log "warning: $s failed to start (journalctl -u $s)"
        fi
    done
}

# Kernel updates on fnOS install the image before the headers, and the
# headers package runs no hooks, so DKMS never builds for the new kernel.
# Build only what is missing for the running one; a package whose sources
# are gone from /usr/src is reinstalled from this directory.
do_repair() {
    local boot=$1 kver dir name ver m reloaded=no
    kver=$(uname -r)
    command -v dkms >/dev/null || die "dkms is not installed (apt install dkms)"
    if [ ! -e "/lib/modules/$kver/build/include" ]; then
        printf 'error: kernel headers for %s are missing; install them with: apt install linux-headers-%s\n' "$kver" "$kver" >&2
        exit 3
    fi
    if [ "$boot" = no ] && dpkg_busy; then
        printf 'error: a system update is in progress; try again once it has finished\n' >&2
        exit 4
    fi
    remove_old_button_rules
    for dir in "${PACKAGES[@]}"; do
        [ -f "$PKG_ROOT/$dir/dkms.conf" ] || die "missing $PKG_ROOT/$dir/dkms.conf"
        name=$(conf_value "$PKG_ROOT/$dir" PACKAGE_NAME)
        ver=$(conf_value "$PKG_ROOT/$dir" PACKAGE_VERSION)
        if built_for_kernel "$name/$ver" "$kver"; then
            log "$name/$ver is built for $kver"
        elif [ -f "/usr/src/$name-$ver/dkms.conf" ] && registered "$name/$ver"; then
            log "building $name/$ver for $kver"
            dkms_step install "$name/$ver" -k "$kver"
        else
            install_package "$PKG_ROOT/$dir"
        fi
    done
    install_boot_config
    for m in "${MODULES[@]}"; do
        module_loaded "$m" && continue
        log "loading $m"
        modprobe "$m" || die "cannot load $m (see dmesg)"
        reloaded=yes
    done
    [ "$boot" = yes ] || restart_services "$reloaded"
    log "done"
}

do_remove() {
    local m dir name
    for m in ite_it6616 ft8722_ts t6_platform; do
        unload_module "$m"
    done
    for dir in "${PACKAGES[@]}"; do
        name=$(conf_value "$PKG_ROOT/$dir" PACKAGE_NAME)
        [ -n "$name" ] && remove_package "$name"
    done
    rm -f "$MODULES_LOAD_CONF"
    remove_old_button_rules
    log "removed"
}

main() {
    local action=install load=yes boot=no
    while [ $# -gt 0 ]; do
        case $1 in
            --remove)  action=remove ;;
            --repair)  action=repair ;;
            --boot)    boot=yes ;;
            --no-load) load=no ;;
            -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
            *) die "unknown option: $1" ;;
        esac
        shift
    done
    require_root "$@"
    take_lock
    case $action in
        install) do_install "$load" ;;
        repair)  do_repair "$boot" ;;
        remove)  do_remove ;;
    esac
}

main "$@"
