//! Live screen state for the kiosk. The backlight can be switched by others
//! (the front power button via t6-ledd, T6 Control Center, a desktop), so a
//! task watches it and `/api/display/events` pushes every change, and the
//! panel's black "asleep" overlay follows at once instead of at the next poll.

use std::sync::OnceLock;
use std::time::Duration;
use t6_hw_rs::display::Display;
use tokio::sync::watch;

/// Cached sysfs values, no EC access: cheap to poll this often.
const POLL: Duration = Duration::from_millis(250);

static STATE: OnceLock<watch::Sender<bool>> = OnceLock::new();

/// Start the watcher (once, from main).
pub fn start() {
    let (tx, _) = watch::channel(Display::new().is_on());
    if STATE.set(tx).is_err() {
        return;
    }
    tokio::spawn(async {
        let mut tick = tokio::time::interval(POLL);
        loop {
            tick.tick().await;
            let on = Display::new().is_on();
            if let Some(tx) = STATE.get() {
                tx.send_if_modified(|v| std::mem::replace(v, on) != on);
            }
        }
    });
}

/// Screen on/off, updated on every change.
pub fn subscribe() -> watch::Receiver<bool> {
    match STATE.get() {
        Some(tx) => tx.subscribe(),
        None => watch::channel(Display::new().is_on()).1,
    }
}
