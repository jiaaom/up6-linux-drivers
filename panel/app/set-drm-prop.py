#!/usr/bin/env python3
"""Set a DRM connector property, e.g. i915's "Broadcast RGB".

    set-drm-prop.py auto HDMI-A-1 "Broadcast RGB" "Limited 16:235"

CARD is a /dev/dri/cardN path, or "auto" for whichever card has CONNECTOR.

Setting a property needs DRM master, so run-kiosk.sh calls this before it
starts weston; weston doesn't manage "Broadcast RGB" and leaves it as set.

Why the panel needs limited range: something past i915 (the IT6616 bridge or
the panel IC) treats the input as 16-235 and stretches it to 0-255, even
though the bridge's CSC reads as bypassed. Fed full range, everything above
~235 clipped to white, everything below ~16 crushed to black and the light
tones were lifted, so the screen looked washed out. Sending limited range
cancels the stretch. Verified by eye with a stripe/patch test on the panel
(2026-09-22): before, 234-253 were indistinguishable from white and the first
visible near-black step was 20; after, 253 is distinct from white, 4 is
distinct from black, and the 75/25/12.5% matches give gamma ~2.0-2.15.

Uses libdrm through ctypes, so no build step is needed.
"""
import ctypes
import glob
import os
import sys

u32, u64, c_int = ctypes.c_uint32, ctypes.c_uint64, ctypes.c_int


class Res(ctypes.Structure):
    _fields_ = [("count_fbs", c_int), ("fbs", ctypes.POINTER(u32)),
                ("count_crtcs", c_int), ("crtcs", ctypes.POINTER(u32)),
                ("count_connectors", c_int), ("connectors", ctypes.POINTER(u32)),
                ("count_encoders", c_int), ("encoders", ctypes.POINTER(u32)),
                ("min_width", u32), ("max_width", u32), ("min_height", u32), ("max_height", u32)]


class Connector(ctypes.Structure):
    _fields_ = [("connector_id", u32), ("encoder_id", u32),
                ("connector_type", u32), ("connector_type_id", u32),
                ("connection", c_int), ("mmWidth", u32), ("mmHeight", u32), ("subpixel", c_int),
                ("count_modes", c_int), ("modes", ctypes.c_void_p),
                ("count_props", c_int), ("props", ctypes.POINTER(u32)), ("prop_values", ctypes.POINTER(u64)),
                ("count_encoders", c_int), ("encoders", ctypes.POINTER(u32))]


class PropEnum(ctypes.Structure):
    _fields_ = [("value", u64), ("name", ctypes.c_char * 32)]


class Property(ctypes.Structure):
    _fields_ = [("prop_id", u32), ("flags", u32), ("name", ctypes.c_char * 32),
                ("count_values", c_int), ("values", ctypes.POINTER(u64)),
                ("count_enums", c_int), ("enums", ctypes.POINTER(PropEnum)),
                ("count_blobs", c_int), ("blob_ids", ctypes.POINTER(u32))]


DRM_MODE_PROP_ENUM = 1 << 3
DRM_MODE_OBJECT_CONNECTOR = 0xC0C0C0C0

drm = ctypes.CDLL("libdrm.so.2", use_errno=True)
drm.drmModeGetResources.restype = ctypes.POINTER(Res)
drm.drmModeGetConnector.restype = ctypes.POINTER(Connector)
drm.drmModeGetConnector.argtypes = [c_int, u32]
drm.drmModeGetProperty.restype = ctypes.POINTER(Property)
drm.drmModeGetProperty.argtypes = [c_int, u32]
drm.drmModeGetConnectorTypeName.restype = ctypes.c_char_p
drm.drmModeGetConnectorTypeName.argtypes = [u32]
drm.drmModeObjectSetProperty.argtypes = [c_int, u32, u32, u32, u64]


def set_prop(card, conn_name, prop_name, value):
    """Returns False if CARD has no such connector; exits on any other error."""
    fd = os.open(card, os.O_RDWR | os.O_CLOEXEC)
    res = drm.drmModeGetResources(fd)
    if not res:
        return False  # not a KMS device
    for i in range(res.contents.count_connectors):
        c = drm.drmModeGetConnector(fd, res.contents.connectors[i]).contents
        name = f"{drm.drmModeGetConnectorTypeName(c.connector_type).decode()}-{c.connector_type_id}"
        if name != conn_name:
            continue
        for p in range(c.count_props):
            pr = drm.drmModeGetProperty(fd, c.props[p]).contents
            if pr.name.decode() != prop_name:
                continue
            if pr.flags & DRM_MODE_PROP_ENUM:
                vals = {pr.enums[e].name.decode(): pr.enums[e].value for e in range(pr.count_enums)}
                if value not in vals:
                    sys.exit(f"{name} {prop_name}: no value {value!r} (have {', '.join(vals)})")
                v = vals[value]
            else:
                v = int(value, 0)
            if c.prop_values[p] == v:
                print(f"{name} {prop_name} already {value}")
                return True
            if drm.drmModeObjectSetProperty(fd, c.connector_id, DRM_MODE_OBJECT_CONNECTOR, pr.prop_id, v):
                err = ctypes.get_errno()
                sys.exit(f"{name} {prop_name}: set failed: {os.strerror(err)} (compositor holding DRM master?)")
            print(f"{name} {prop_name} = {value}")
            return True
        sys.exit(f"{name}: no property {prop_name!r}")
    return False


def main(card, conn_name, prop_name, value):
    cards = sorted(glob.glob("/dev/dri/card*")) if card == "auto" else [card]
    if not any(set_prop(c, conn_name, prop_name, value) for c in cards):
        sys.exit(f"no connector {conn_name} on {', '.join(cards) or 'any card'}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(f"usage: {sys.argv[0]} /dev/dri/cardN CONNECTOR PROPERTY VALUE")
    main(*sys.argv[1:])
