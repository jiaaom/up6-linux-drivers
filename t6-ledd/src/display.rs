//! Apply the persisted built-in display brightness once at boot.
//!
//! Ownership is split between two processes that share one file:
//!
//!   - `t6-webd` (the web backend) owns *runtime* control of the LCD
//!     backlight — the brightness slider and the on/off toggle — and writes
//!     the chosen level and the boot preference to `/etc/t6-display.conf`.
//!   - `t6-ledd` (this daemon) starts early in boot, so it owns the *boot*
//!     value: it reads that file once and sets the backlight before the user
//!     ever sees the screen.
//!
//! The point of doing this here rather than leaning on `systemd-backlight`
//! is that `systemd-backlight` persists whatever brightness was set at
//! shutdown — including 0. So if the user switches the panel off and then
//! reboots, `systemd-backlight` would restore a black screen that looks
//! broken. Instead the on/off toggle is treated as "for now only": the
//! screen always comes back on at `on_level` after a reboot, unless the
//! user explicitly asked for `off_after_boot` (a headless setup). Our unit
//! is ordered after `systemd-backlight`, so this value is the final one.
//!
//! Called exactly once per boot, gated by t6-ledd's `/run/t6-ledd/booted`
//! marker (the same marker that gates the startup beep), so an app upgrade
//! that restarts the daemon mid-session does not disturb the screen.

/// Backlight brightness control (0 = off, up to `max_brightness` = 100).
const BACKLIGHT: &str = "/sys/class/backlight/t6_ec_backlight/brightness";
/// Settings written by t6-webd: `on_level=<10..100>` and
/// `off_after_boot=<true|false>`, one `key=value` per line, `#` comments.
const CONF: &str = "/etc/t6-display.conf";
/// Level used when the config file is missing (e.g. first boot after a fresh
/// install, before the user has touched the brightness).
const DEFAULT_ON: u32 = 20;

/// Read the persisted settings and set the backlight for this boot. Returns
/// the brightness written, or an error string if the sysfs write failed.
///
/// A missing or unreadable config file is not an error: it just means "no
/// preference yet", so the screen comes up on at `DEFAULT_ON`.
pub fn apply_boot() -> Result<u32, String> {
    let mut on_level = DEFAULT_ON;
    let mut off_after_boot = false;

    // Parse the tiny key=value file by hand (no toml dependency needed for
    // two fields). Unknown keys and malformed lines are ignored so a partly
    // written or future-extended file still yields a sane result.
    if let Ok(text) = std::fs::read_to_string(CONF) {
        for line in text.lines() {
            let Some((k, v)) = line.split_once('=') else { continue };
            match k.trim() {
                // Clamp to the UI's range: the panel is unreadable below ~10 %,
                // and the driver caps at 100.
                "on_level" => {
                    if let Ok(n) = v.trim().parse::<u32>() {
                        on_level = n.clamp(10, 100);
                    }
                }
                "off_after_boot" => off_after_boot = matches!(v.trim(), "true" | "1" | "yes"),
                _ => {}
            }
        }
    }

    // off_after_boot wins: a headless user asked for a dark panel. Otherwise
    // the screen is always on at the remembered level.
    let value = if off_after_boot { 0 } else { on_level };
    std::fs::write(BACKLIGHT, format!("{value}\n"))
        .map_err(|e| format!("{BACKLIGHT}: {e}"))?;
    Ok(value)
}
