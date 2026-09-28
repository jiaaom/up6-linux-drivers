//! Screen timeout: turns the front-panel screen off after `screen_timeout_s`
//! without a touch or a key press.
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
/// `backlight::start`).
pub fn start() {
    mark_activity();
    std::thread::spawn(watch_devices);
    tokio::spawn(timer());
}

/// Seconds to wait before switching off; None = no timeout applies.
fn timeout() -> Option<u64> {
    let s = crate::settings::load();
    (s.panel_enabled() && s.screen_timeout_s > 0).then_some(s.screen_timeout_s as u64)
}

async fn timer() {
    let mut screen = crate::backlight::subscribe();
    let mut was_on = *screen.borrow_and_update();
    loop {
        let on = *screen.borrow();
        if on && !was_on {
            mark_activity(); // screen just came on: count from now
        }
        was_on = on;

        let wait = match timeout() {
            Some(_) if on && now_ms() < HOLD_UNTIL.load(Ordering::Relaxed) => {
                // Held: look again when the lease ends (or is renewed).
                Some(Duration::from_millis(HOLD_UNTIL.load(Ordering::Relaxed).saturating_sub(now_ms()).max(1)))
            }
            Some(secs) if on => {
                // Count from the last touch or the end of the last hold.
                let since = LAST.load(Ordering::Relaxed).max(HOLD_UNTIL.load(Ordering::Relaxed));
                let due = since + secs * 1000;
                let now = now_ms();
                if now >= due {
                    match crate::screensaver::screen_off().await {
                        Ok(_) => eprintln!("screen timeout: screen off after {secs} s idle"),
                        Err(e) => eprintln!("screen timeout: {e}"),
                    }
                    // Don't retry a failed switch in a tight loop.
                    mark_activity();
                    continue;
                }
                // A touch in the meantime only moves `LAST`; the deadline is
                // recomputed on wake-up.
                Some(Duration::from_millis(due - now))
            }
            _ => None,
        };
        let sleep = async {
            match wait {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = sleep => {}
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
