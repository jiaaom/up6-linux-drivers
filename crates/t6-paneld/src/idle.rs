//! Screen timeout: turns the front-panel screen off after `screen_timeout_s`
//! without a touch.
//!
//! Activity is read straight from the touch controller's input devices (a
//! passive reader, no grab, so weston still gets every event), not reported
//! by the kiosk, so the timeout holds even when the kiosk has crashed, hung
//! or is reloading. The countdown runs only while the screen is lit and
//! starts over from whichever is later: the last touch, or the moment the
//! screen came on (whoever switched it: double-tap wake, the power button,
//! Control Center). Turning the screen off goes through the normal backlight
//! path, and `backlight`'s change events bring up the kiosk's sleep overlay.

use std::io::Read;
use std::os::unix::fs::FileTypeExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use t6_hw_rs::display::Display;
use tokio::sync::Notify;

/// Input devices whose events count as activity: the FT8722's finger and
/// pen interfaces.
const DEVICE_PREFIX: &str = "FT8722";
/// struct input_event on 64-bit: timeval (16) + type (2) + code (2) + value (4).
const EVENT_SIZE: usize = 24;

static EPOCH: OnceLock<Instant> = OnceLock::new();
/// Last activity, in ms since `EPOCH` (monotonic).
static LAST: AtomicU64 = AtomicU64::new(0);
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
            Some(secs) if on => {
                let due = LAST.load(Ordering::Relaxed) + secs * 1000;
                let now = now_ms();
                if now >= due {
                    match tokio::task::spawn_blocking(|| Display::new().set_power(false)).await {
                        Ok(Ok(_)) => eprintln!("screen timeout: screen off after {secs} s idle"),
                        Ok(Err(e)) => eprintln!("screen timeout: {e}"),
                        Err(e) => eprintln!("screen timeout worker failed: {e}"),
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

/// The touch input devices currently present.
fn find_devices() -> Vec<PathBuf> {
    let Ok(dir) = std::fs::read_dir("/sys/class/input") else { return Vec::new() };
    let mut out = Vec::new();
    for e in dir.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if !n.starts_with("event") {
            continue;
        }
        let name = std::fs::read_to_string(e.path().join("device/name")).unwrap_or_default();
        if name.trim().starts_with(DEVICE_PREFIX) {
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
