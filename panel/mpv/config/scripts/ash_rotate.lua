-- Rotate the player between portrait and landscape through
-- appliance-compositor's shell (rotates the whole window: video and controls, with
-- touch mapped by the compositor). ASH_CTL is set by run-mpv.sh.
local ctl = os.getenv("ASH_CTL")
local rotation = 0

mp.register_script_message("rotate", function()
    if not ctl then
        mp.osd_message("Rotation needs appliance-compositor")
        return
    end
    local next_rotation = (rotation == 0) and 90 or 0
    local r = mp.command_native({ name = "subprocess", playback_only = false,
        capture_stdout = true, capture_stderr = true,
        args = { ctl, "rotate", "mpv", tostring(next_rotation) } })
    if r.status == 0 then
        rotation = next_rotation
    else
        mp.msg.warn("rotate failed: " .. (r.stdout or "") .. (r.stderr or ""))
        mp.osd_message("Rotation failed")
    end
end)
