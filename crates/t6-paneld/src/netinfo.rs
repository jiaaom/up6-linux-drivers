//! `network` in /api/panel, cached.
//!
//! Reading it runs nmcli about ten times (some 0.4 s), and /api/panel is
//! polled every 2 s. So a poll gets the last reading at once, and one that
//! finds it older than `FRESH` starts a new reading in the background (no
//! one polling, no nmcli). After a network change made through the API
//! (`invalidate`, called for every non-GET request under /api/network) the
//! next poll reads it afresh and waits for it, so the change shows at once,
//! and for `SETTLING` after it every poll starts a new reading.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FRESH: Duration = Duration::from_secs(3);
/// NetworkManager finishes a change after the request returns (a radio
/// going off, a connection coming up): for this long after one, every poll
/// starts a new reading.
const SETTLING: Duration = Duration::from_secs(10);

struct Reading {
    at: Instant,
    value: Value,
}

static LAST: Mutex<Option<Reading>> = Mutex::new(None);
/// Held while nmcli runs: two polls at once share one reading.
static READING: Mutex<()> = Mutex::new(());
static STALE: AtomicBool = AtomicBool::new(false);
static REFRESHING: AtomicBool = AtomicBool::new(false);
static CHANGED: Mutex<Option<Instant>> = Mutex::new(None);

fn read() -> Value {
    let _one = READING.lock().unwrap_or_else(|e| e.into_inner());
    let value = serde_json::to_value(t6_hw_rs::network::info()).unwrap_or(Value::Null);
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(Reading { at: Instant::now(), value: value.clone() });
    value
}

/// The network as /api/panel reports it (blocking: call from a blocking thread).
pub fn get() -> Value {
    let cached = LAST.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| (r.at.elapsed(), r.value.clone()));
    match cached {
        Some((age, value)) if !STALE.load(Ordering::SeqCst) => {
            let settling = CHANGED.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() < SETTLING);
            if (age > FRESH || settling) && !REFRESHING.swap(true, Ordering::SeqCst) {
                std::thread::spawn(|| {
                    read();
                    REFRESHING.store(false, Ordering::SeqCst);
                });
            }
            value
        }
        // first reading, or just changed: wait for a fresh one
        _ => {
            STALE.store(false, Ordering::SeqCst);
            read()
        }
    }
}

/// A network setting was just changed: the next `get` reads afresh.
pub fn invalidate() {
    *CHANGED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    STALE.store(true, Ordering::SeqCst);
}
