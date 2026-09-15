#!/usr/bin/env python3
"""Generate package icons without any imaging library: a rounded-rectangle
body with a fan glyph, supersampled for anti-aliasing. FygoOS asks for a
rounded-rect body on a square canvas.

    make-icons.py <package dir> <colour hex> [--chip] [--ui <ui dir>]

Writes ICON.PNG and ICON_256.PNG (both 256 px: App Center scales ICON.PNG
up, so the nominal 64 px looks blurry) and, with --ui, the desktop entry
icons images/icon_64.png and images/icon_256.png.
`--chip` draws a chip outline instead of the fan (used for t6-drivers)."""
import math, struct, sys, zlib


def png(width, height, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def rounded_rect(x, y, size, radius, margin):
    """1 inside the rounded square, 0 outside."""
    lo, hi = margin, size - margin
    if x < lo or x > hi or y < lo or y > hi:
        return 0
    cx = min(max(x, lo + radius), hi - radius)
    cy = min(max(y, lo + radius), hi - radius)
    return 1 if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 else 0


def fan(x, y, size):
    """White fan glyph: hub + three blades, each blade a rotated teardrop."""
    cx = cy = size / 2
    dx, dy = x - cx, y - cy
    r = math.hypot(dx, dy) / size
    if r < 0.075:
        return 1
    if r < 0.10:
        return 0
    a = math.atan2(dy, dx)
    for k in range(3):
        t = a - k * 2 * math.pi / 3 - 0.9 * r * 2.2  # sweep the blade
        t = (t + math.pi) % (2 * math.pi) - math.pi
        half = 0.26 * (1 - ((r - 0.22) / 0.16) ** 2) if 0.11 < r < 0.36 else 0
        if abs(t) < half:
            return 1
    return 0


def chip(x, y, size):
    """White chip glyph: square die outline with pin stubs."""
    cx = cy = size / 2
    dx, dy = abs(x - cx) / size, abs(y - cy) / size
    outer, inner = 0.21, 0.16
    if max(dx, dy) <= outer and max(dx, dy) >= inner:
        return 1
    if max(dx, dy) < 0.06:
        return 1
    # pins: short bars on each side
    for main, cross in ((dx, dy), (dy, dx)):
        if outer + 0.02 <= main <= outer + 0.09:
            for c in (0.0, 0.11):
                if abs(cross - c) < 0.02:
                    return 1
    return 0


def render(size, colour, glyph, ss=4):
    rgb = tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4))
    dark = tuple(max(0, int(c * 0.72)) for c in rgb)
    rows = []
    n = size * ss
    for py in range(size):
        row = []
        for px in range(size):
            body = ink = 0
            for sy in range(ss):
                for sx in range(ss):
                    x, y = px + (sx + 0.5) / ss, py + (sy + 0.5) / ss
                    b = rounded_rect(x, y, size, size * 0.22, size * 0.04)
                    body += b
                    if b:
                        ink += glyph(x, y, size)
            body /= ss * ss
            ink /= ss * ss
            t = py / size  # vertical gradient
            base = tuple(int(rgb[i] * (1 - t) + dark[i] * t) for i in range(3))
            col = tuple(int(base[i] * (1 - ink) + 255 * ink) for i in range(3))
            row += [*col, int(255 * body)]
        rows.append(row)
    return png(size, size, rows)


def main():
    args = sys.argv[1:]
    out, colour = args[0], args[1].lstrip("#")
    glyph = chip if "--chip" in args else fan
    targets = [(f"{out}/ICON.PNG", 256), (f"{out}/ICON_256.PNG", 256)]
    if "--ui" in args:
        ui = args[args.index("--ui") + 1]
        targets += [(f"{ui}/images/icon_64.png", 64), (f"{ui}/images/icon_256.png", 256)]
    rendered = {}
    for path, size in targets:
        rendered.setdefault(size, render(size, colour, glyph))
        with open(path, "wb") as f:
            f.write(rendered[size])


if __name__ == "__main__":
    main()
