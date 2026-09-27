#!/bin/bash
# Assemble the panel's private mpv from pinned Debian packages.
#
#   packaging/mpv/bundle-mpv.sh <out-dir>
#
# Produces <out-dir>/{bin/mpv, lib/*.so.*, LICENSES/} — a self-contained
# copy that never touches the system's dpkg state or /usr/bin/mpv. mpv's
# RUNPATH is $ORIGIN/../lib and each bundled library's is $ORIGIN, so the
# bundled libraries win over any system copies without LD_LIBRARY_PATH.
#
# The pinned .debs are committed in packaging/mpv/debs/ (untouched Debian
# archive files, ~1.7 MB), so builds are offline and reproducible. Each is
# checked against the sha256 in debs.txt; a missing or mismatching one is
# fetched with apt-get download (on Debian 12) — that is how a version bump
# brings in a new file, which then gets committed.
# Needs: dpkg-deb, patchelf; apt-get only when a .deb has to be fetched;
# plus libva's build deps (packaging/mpv/libva/build-libva.sh).

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)   # packaging/mpv/
CACHE=$SCRIPT_DIR/debs
MANIFEST=$SCRIPT_DIR/debs.txt

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: $0 <out-dir>"
OUT=$1
for tool in dpkg-deb patchelf sha256sum; do
    command -v "$tool" >/dev/null || die "$tool not found"
done

mkdir -p "$CACHE"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Cached file for package $1 version $2 (apt-get download escapes ':' as %3a).
deb_path() { echo "$CACHE/${1}_${2//:/%3a}_amd64.deb"; }

fetch() {
    local pkg=$1 ver=$2 sum=$3 deb
    deb=$(deb_path "$pkg" "$ver")
    if [ -f "$deb" ] && echo "$sum  $deb" | sha256sum -c --status; then
        return
    fi
    log "downloading $pkg=$ver"
    rm -f "$deb"
    (cd "$CACHE" && apt-get download -q "$pkg=$ver" >/dev/null) ||
        die "cannot download $pkg=$ver (is it still in the apt sources?)"
    echo "$sum  $deb" | sha256sum -c --status ||
        die "sha256 mismatch for $pkg=$ver: got $(sha256sum "$deb" | cut -d' ' -f1)"
}

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib" "$OUT/LICENSES"

while read -r pkg ver sum; do
    case $pkg in ''|'#'*) continue ;; esac
    fetch "$pkg" "$ver" "$sum"
    dpkg-deb -x "$(deb_path "$pkg" "$ver")" "$work/$pkg"
    cp "$work/$pkg/usr/share/doc/$pkg/copyright" "$OUT/LICENSES/$pkg.copyright"
    echo "$pkg $ver" >> "$OUT/LICENSES/VERSIONS"
    if [ "$pkg" = mpv ]; then
        cp "$work/$pkg/usr/bin/mpv" "$OUT/bin/"
    else
        # runtime libraries only (skip the C++ variant of liblua)
        find "$work/$pkg/usr/lib/x86_64-linux-gnu" -maxdepth 1 -name '*.so.*' \
            ! -name '*-c++.so*' -exec cp -a {} "$OUT/lib/" \;
    fi
done < "$MANIFEST"

cat > "$OUT/LICENSES/SOURCE" <<'EOF'
These binaries are unmodified Debian bookworm packages (see VERSIONS).
Corresponding source: https://snapshot.debian.org/ or
`apt-get source <package>=<version>` on Debian 12.
EOF

patchelf --set-rpath '$ORIGIN/../lib' "$OUT/bin/mpv"
for lib in "$OUT"/lib/*.so.*; do
    [ -L "$lib" ] || patchelf --set-rpath '$ORIGIN' "$lib"
done

# A libva matching fnOS's iHD driver, built from source (see its header).
"$SCRIPT_DIR/libva/build-libva.sh" "$OUT/lib" "$OUT/LICENSES"

# Every library mpv needs must resolve, from the bundle or the system.
if ldd "$OUT/bin/mpv" | grep -q 'not found'; then
    ldd "$OUT/bin/mpv" | grep 'not found' >&2
    die "unresolved libraries (is this FygoOS / Debian 12?)"
fi

log "mpv bundle: $OUT ($(du -sh "$OUT" | cut -f1))"
