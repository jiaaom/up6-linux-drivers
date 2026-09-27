-- Remember the player's volume between videos.
--
-- The output device is not chosen here: mpv plays into PipeWire's default
-- output (ao=pipewire, audio-device=auto), which the panel's Settings → Audio
-- sets through t6-paneld, and WirePlumber remembers per-device volumes.
-- This is only mpv's own volume on top of that. It starts at 15 %, not mpv's
-- 100 %: small USB speakers can be very loud.
-- Stored in /var/lib/t6-paneld (removed with "remove settings" on uninstall).

local utils = require "mp.utils"

local PREFS = "/var/lib/t6-paneld/mpv-prefs.json"
local DEFAULT_VOLUME = 15

local function load_prefs()
    local f = io.open(PREFS, "r")
    if not f then return {} end
    local prefs = utils.parse_json(f:read("*a") or "") or {}
    f:close()
    return prefs
end

local function save_prefs(prefs)
    local json, err = utils.format_json(prefs)
    if not json then
        mp.msg.warn("cannot save prefs: " .. tostring(err))
        return
    end
    local f = io.open(PREFS .. ".tmp", "w")
    if not f then return end
    f:write(json)
    f:close()
    os.rename(PREFS .. ".tmp", PREFS)
end

local prefs = load_prefs()
mp.set_property_number("volume", tonumber(prefs.volume) or DEFAULT_VOLUME)

-- Track the value while playing; at shutdown the property may already be gone.
local volume = mp.get_property_number("volume")
mp.observe_property("volume", "number", function(_, v) if v then volume = v end end)

mp.register_event("shutdown", function()
    save_prefs({ volume = volume })
end)
