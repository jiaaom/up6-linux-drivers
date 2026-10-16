//! Screen idle: the front-panel screen dims after `dim_after_s` without a
//! touch or a key press, and turns off after `off_after_s` (both counted from
//! the last touch; either may be 0 = never).
//!
//!   bright ──idle dim_after_s──▶ dim (dim_percent of the level, at least 1)
//!     ▲                            │
//!     └──── any touch or key ──────┘  (back at once; the touch still acts)
//!   bright or dim ──idle off_after_s──▶ off
//!
//! Activity is read straight from the touch controller's input devices and
//! from navigation keyboards (the remote's uinput device from t6-control, a
//! USB keyboard; see `is_nav_keyboard`) (a
//! passive reader, no grab, so weston still gets every event), not reported
//! by the kiosk, so the timeout holds even when the kiosk has crashed, hung
//! or is reloading. The countdown runs only while the screen is lit and
//! starts over from whichever is later: the last touch, or the moment the
//! screen came on (whoever switched it: double-tap wake, the power button,
//! Control Center). Turning the screen off puts the screensaver window up
//! first (`screensaver::screen_off`), then switches the backlight off.
//!
//! There is no separate "default brightness": it is the level while the
//! screen is not dimmed, whoever set it (the panel's slider, Control Center).
//! While dimmed, the level before dimming is kept in the settings
//! (`dimmed_from`), so it comes back after a restart or a stop that happened
//! while dim (systemd-backlight saves the level at shutdown, after us). A
//! level changed by someone else while dimmed counts as brought back.

use std::io::Read;
use std::os::unix::fs::FileTypeExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Input devices whose events count as activity: the FT8722's finger and
/// pen interfaces.
const DEVICE_PREFIX: &str = "FT8722";
/// struct input_event on 64-bit: timeval (16) + type (2) + code (2) + value (4).
const EVENT_SIZE: usize = 24;

static EPOCH: OnceLock<Instant> = OnceLock::new();
/// Last activity, in ms since `EPOCH` (monotonic).
static LAST: AtomicU64 = AtomicU64::new(0);
/// Screen-timeout hold (a lease), in ms since `EPOCH`: until then the screen
/// stays on, e.g. while a video plays. The holder renews it; if it dies the
/// lease simply runs out. See `hold_until`.
static HOLD_UNTIL: AtomicU64 = AtomicU64::new(0);
/// Poked when the timeout or the panel-enabled setting changes.
static CHANGED: Notify = Notify::const_new();

fn now_ms() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn mark_activity() {
    LAST.fetch_max(now_ms(), Ordering::Relaxed);
    // dimmed: brighten at once, not at the next deadline
    if DIMMED.load(Ordering::Relaxed) {
        CHANGED.notify_one();
    }
}

/// Re-read the settings now (the timeout or panel-enabled flag changed).
pub fn settings_changed() {
    CHANGED.notify_one();
}

/// Hold the screen timeout for the next `secs` seconds (renewable lease);
/// 0 releases it. The countdown restarts when the hold ends, so the screen
/// doesn't go off the moment a video stops.
pub fn hold_for(secs: u64) {
    let now = now_ms();
    HOLD_UNTIL.store(now + secs * 1000, Ordering::Relaxed);
    if secs == 0 {
        mark_activity();
    }
    CHANGED.notify_one();
}

/// Start the touch readers and the timer (once, from main, after
/// `backlight::start`). A level left dimmed by an earlier run comes back first.
pub fn start() {
    restore_saved();
    mark_activity();
    std::thread::spawn(watch_devices);
    tokio::spawn(timer());
}

/// When to dim and when to switch off (seconds; 0 = never), and how dim.
/// None while the panel app is turned off: nothing applies.
fn times() -> Option<(u64, u64, u32)> {
    let s = crate::settings::load();
    s.panel_enabled().then(|| (s.dim_after_s() as u64, s.off_after_s() as u64, s.dim_percent()))
}

/// The screen is dimmed: the level it came from, the dim level, and when.
#[derive(Clone, Copy)]
struct Dim {
    normal: u32,
    level: u32,
    at: u64,
}

/// Set when dimmed, so a touch wakes the timer at once (see `mark_activity`).
static DIMMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Dimming steps down over this long (a touch meanwhile stops it).
const DIM_STEPS: u32 = 8;
const DIM_STEP: Duration = Duration::from_millis(100);

fn level_now() -> Option<u32> {
    t6_hw_rs::display::Display::new().info().brightness
}

async fn set_level(v: u32) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || t6_hw_rs::display::Display::new().set_brightness(v))
        .await
        .map_err(|e| e.to_string())?
}

/// The dim level for a normal level: `percent` of it, at least 1; None when
/// that would not be dimmer (a level of 1).
fn dim_level(normal: u32, percent: u32) -> Option<u32> {
    let v = ((normal * percent + 50) / 100).max(t6_hw_rs::display::MIN_ON);
    (v < normal).then_some(v)
}

/// Put the normal level back (also while the screen is off: setting the
/// level does not switch it on).
async fn undim(d: Dim, why: &str) {
    DIMMED.store(false, Ordering::Relaxed);
    let _ = tokio::task::spawn_blocking(|| crate::settings::set_dimmed_from(None)).await;
    // someone else set a level meanwhile: theirs stands
    match level_now() {
        Some(l) if l != d.level => eprintln!("screen idle: brightness {l} kept ({why})"),
        _ => match set_level(d.normal).await {
            Ok(_) => eprintln!("screen idle: brightness back to {} ({why})", d.normal),
            Err(e) => eprintln!("screen idle: cannot restore brightness {}: {e}", d.normal),
        },
    }
}

/// Step down to the dim level; a touch meanwhile puts it back. Returns the
/// dim state, None when a touch interrupted it, Err when the level could not
/// be set.
async fn dim(normal: u32, level: u32) -> Result<Option<Dim>, ()> {
    let started = now_ms();
    let _ = tokio::task::spawn_blocking(move || crate::settings::set_dimmed_from(Some(normal))).await;
    let d = Dim { normal, level, at: started };
    DIMMED.store(true, Ordering::Relaxed);
    for i in 1..=DIM_STEPS {
        let v = normal - (normal - level) * i / DIM_STEPS;
        if LAST.load(Ordering::Relaxed) > started {
            undim(Dim { level: level_now().unwrap_or(v), ..d }, "touched while dimming").await;
            return Ok(None);
        }
        if let Err(e) = set_level(v.max(level)).await {
            eprintln!("screen idle: cannot dim: {e}");
            undim(Dim { level: level_now().unwrap_or(v), ..d }, "dimming failed").await;
            return Err(());
        }
        tokio::time::sleep(DIM_STEP).await;
    }
    eprintln!("screen idle: dimmed {normal} → {level}");
    Ok(Some(d))
}

/// Bring the level back now if it was left dimmed (startup, or stopping:
/// systemd-backlight saves the level at shutdown).
pub fn restore_saved() {
    let Some(normal) = crate::settings::load().dimmed_from else { return };
    let disp = t6_hw_rs::display::Display::new();
    if disp.info().brightness.is_some_and(|b| b > 0 && b < normal) {
        match disp.set_brightness(normal) {
            Ok(_) => eprintln!("screen idle: brightness back to {normal} (left dimmed)"),
            Err(e) => eprintln!("screen idle: cannot restore brightness {normal}: {e}"),
        }
    }
    let _ = crate::settings::set_dimmed_from(None);
}

async fn timer() {
    let mut screen = crate::backlight::subscribe();
    let mut was_on = *screen.borrow_and_update();
    let mut dimmed: Option<Dim> = None;
    // after a failed dim, don't try again before this (no tight retry loop)
    let mut dim_retry_at = 0u64;
    loop {
        let on = *screen.borrow();
        if on && !was_on {
            mark_activity(); // screen just came on: count from now
        }
        was_on = on;
        let now = now_ms();
        let held = now < HOLD_UNTIL.load(Ordering::Relaxed);
        let times = times();

        // Back from dim: a touch, a hold (a video started), the screen went
        // off, dimming was turned off, or someone else set a level.
        if let Some(d) = dimmed {
            let why = if LAST.load(Ordering::Relaxed) > d.at {
                Some("touched")
            } else if held {
                Some("held")
            } else if !on {
                Some("screen off")
            } else if times.is_none_or(|(dim_after, _, _)| dim_after == 0) {
                Some("dimming turned off")
            } else if level_now() != Some(d.level) {
                Some("level changed")
            } else {
                None
            };
            if let Some(why) = why {
                dimmed = None;
                undim(d, why).await;
                // someone chose a level: that counts as use, or it would dim again at once
                if why == "level changed" {
                    mark_activity();
                }
                if why == "touched" || why == "held" || why == "level changed" {
                    continue;
                }
            }
        }

        let wait = match times {
            Some(_) if on && held => {
                // Held: look again when the lease ends (or is renewed).
                Some(Duration::from_millis(HOLD_UNTIL.load(Ordering::Relaxed).saturating_sub(now).max(1)))
            }
            Some((dim_after, off_after, percent)) if on && (dim_after > 0 || off_after > 0) => {
                // Count from the last touch or the end of the last hold.
                let since = LAST.load(Ordering::Relaxed).max(HOLD_UNTIL.load(Ordering::Relaxed));
                let off_due = (off_after > 0).then(|| since + off_after * 1000);
                let dim_due = (dim_after > 0 && dimmed.is_none() && off_due.is_none_or(|o| since + dim_after * 1000 < o))
                    .then(|| (since + dim_after * 1000).max(dim_retry_at));
                if off_due.is_some_and(|due| now >= due) {
                    match crate::screensaver::screen_off().await {
                        Ok(_) => eprintln!("screen idle: screen off after {off_after} s idle"),
                        Err(e) => eprintln!("screen idle: {e}"),
                    }
                    // the level it wakes up at is the normal one
                    if let Some(d) = dimmed.take() {
                        undim(d, "screen off").await;
                    }
                    // Don't retry a failed switch in a tight loop.
                    mark_activity();
                    continue;
                }
                if dim_due.is_some_and(|due| now >= due) {
                    if let Some(normal) = level_now().filter(|&b| b > 0) {
                        match dim_level(normal, percent) {
                            Some(level) => match dim(normal, level).await {
                                Ok(d) => dimmed = d,
                                Err(()) => dim_retry_at = now_ms() + 60_000,
                            },
                            // already as dim as it goes: count as dimmed, change nothing
                            None => {
                                DIMMED.store(true, Ordering::Relaxed);
                                dimmed = Some(Dim { normal, level: normal, at: now });
                            }
                        }
                    }
                    continue;
                }
                // A touch in the meantime only moves `LAST` (or, while dim,
                // wakes us); the deadline is recomputed on wake-up.
                [dim_due, off_due].into_iter().flatten().min().map(|due| Duration::from_millis(due - now))
            }
            _ => None,
        };
        let sleep = async {
            match wait {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending().await,
            }
        };
        // while dimmed, also look at the level now and then (someone else may set it)
        let poll = async {
            if dimmed.is_some() { tokio::time::sleep(Duration::from_secs(2)).await } else { std::future::pending().await }
        };
        tokio::select! {
            _ = sleep => {}
            _ = poll => {}
            r = screen.changed() => { if r.is_err() { return; } }
            _ = CHANGED.notified() => {}
        }
    }
}

const KEY_ENTER: usize = 28;
const KEY_UP: usize = 103;

/// A keyboard that can drive the panel UI: it has both the Up arrow and
/// Enter. `capabilities/key` is a hex bitmap in words of `unsigned long`,
/// most significant word first. This leaves out single-purpose key devices
/// such as the power button (KEY_SCREENLOCK only).
fn is_nav_keyboard(caps: &str) -> bool {
    let words: Vec<u64> = caps.split_whitespace().rev().filter_map(|w| u64::from_str_radix(w, 16).ok()).collect();
    let bit = |n: usize| words.get(n / 64).is_some_and(|w| w >> (n % 64) & 1 == 1);
    bit(KEY_UP) && bit(KEY_ENTER)
}

/// The input devices whose events count as activity: touch and navigation
/// keyboards.
fn find_devices() -> Vec<PathBuf> {
    let Ok(dir) = std::fs::read_dir("/sys/class/input") else { return Vec::new() };
    let mut out = Vec::new();
    for e in dir.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if !n.starts_with("event") {
            continue;
        }
        let name = std::fs::read_to_string(e.path().join("device/name")).unwrap_or_default();
        let caps = std::fs::read_to_string(e.path().join("device/capabilities/key")).unwrap_or_default();
        // The i8042 "AT Raw Set 2 keyboard" exists without any keyboard
        // attached (the T6 has no PS/2 port); don't let it hold the screen on.
        let i8042 = std::fs::read_to_string(e.path().join("device/id/bustype")).is_ok_and(|b| b.trim() == "0011");
        if name.trim().starts_with(DEVICE_PREFIX) || (is_nav_keyboard(&caps) && !i8042) {
            let dev = PathBuf::from("/dev/input").join(&n);
            if std::fs::metadata(&dev).is_ok_and(|m| m.file_type().is_char_device()) {
                out.push(dev);
            }
        }
    }
    out
}

/// Keep one reader per touch device; look again every few seconds so a
/// driver reload is picked up.
fn watch_devices() {
    let active = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::<PathBuf>::new()));
    loop {
        for dev in find_devices() {
            if !active.lock().unwrap().insert(dev.clone()) {
                continue;
            }
            let active = active.clone();
            std::thread::spawn(move || {
                read_device(&dev);
                active.lock().unwrap().remove(&dev);
            });
        }
        std::thread::sleep(Duration::from_secs(10));
    }
}

/// Any event on the device counts as activity. Returns when it goes away.
fn read_device(dev: &PathBuf) {
    let mut f = match std::fs::File::open(dev) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("screen timeout: {}: {e}", dev.display());
            return;
        }
    };
    eprintln!("screen timeout: watching {}", dev.display());
    let mut buf = [0u8; EVENT_SIZE * 32];
    loop {
        match f.read(&mut buf) {
            Ok(n) if n > 0 => mark_activity(),
            _ => break,
        }
    }
    eprintln!("screen timeout: {} gone", dev.display());
}

#[cfg(test)]
mod tests {
    use super::is_nav_keyboard;

    #[test]
    fn nav_keyboard_bitmap() {
        // full keyboard (a real USB keyboard's capabilities/key)
        assert!(is_nav_keyboard("1000000000007 ff9f207ac14057ff febeffdfffefffff fffffffffffffffe"));
        // bit 28 (Enter) and bit 103 (Up) only
        assert!(is_nav_keyboard("8000000000 10000000"));
        // power-button style device: one key, KEY_SCREENLOCK (152) -> word 2
        assert!(!is_nav_keyboard("1000000 0 0"));
        assert!(!is_nav_keyboard(""));
    }
}
