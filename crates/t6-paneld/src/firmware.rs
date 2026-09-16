//! Firmware-update *check* (show-only, no install).
//!
//! FygoOS's update server publishes a public manifest at the liveupdate root —
//! a plain GET, no auth/fingerprint — whose `packages[]` entry
//! `packageName == "trim"` carries the latest OS version + changelog. We compare
//! it to the installed version (`/usr/trim/etc/version`) and surface either
//! "update available" or, when current, the installed version. We never install
//! (that stays in the NAS OS).
//!
//! We don't hit the network on every call: the last successful fetch (version +
//! notes) is cached to disk and reused, and a fresh fetch is attempted at most
//! once per [`FETCH_INTERVAL`]. Because the manifest's notes always describe the
//! *latest* version, they double as the installed version's notes once you're up
//! to date (`available == current`), so a single cache serves both card states.
//!
//! The manifest response has a trailing signature blob after the JSON, so we
//! parse only the first JSON value. We shell `curl` (already on the box) to
//! avoid pulling a TLS stack into the daemon.

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const MANIFEST_URL: &str = "https://apiv2-liveupdate.fygonas.com/";
const VERSION_FILE: &str = "/usr/trim/etc/version";
const CACHE_FILE: &str = "/var/lib/t6panel/firmware.json";
/// How long a *successful* fetch stays fresh — we don't re-check within this.
const FETCH_INTERVAL: u64 = 30 * 60;
/// Minimum gap between fetch *attempts*, so a failed check (the server is a flaky
/// remote ALB) retries in a couple of minutes instead of waiting a full
/// `FETCH_INTERVAL`, without hammering during an outage.
const RETRY_INTERVAL: u64 = 2 * 60;

#[derive(Serialize, Default)]
pub struct Firmware {
    pub current: Option<String>,
    pub available: Option<String>,
    pub update_available: bool,
    /// Release notes / changelog for the available version (from the cache).
    pub notes: Option<String>,
}

/// On-disk cache of the last manifest fetch. `available`/`notes` hold the last
/// *successful* result; `attempted_at` throttles fetches even when they fail.
#[derive(Serialize, Deserialize, Default)]
struct Cache {
    available: Option<String>,
    notes: Option<String>,
    #[serde(default)]
    fetched_at: u64,
    #[serde(default)]
    attempted_at: u64,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load_cache() -> Cache {
    std::fs::read(CACHE_FILE).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_cache(c: &Cache) {
    if let Ok(json) = serde_json::to_vec(c) {
        let _ = std::fs::create_dir_all("/var/lib/t6panel");
        let tmp = format!("{CACHE_FILE}.tmp");
        if std::fs::write(&tmp, &json).is_ok() {
            let _ = std::fs::rename(&tmp, CACHE_FILE);
        }
    }
}

/// True if `a` is a newer version than `b` (dot-separated numeric compare, with
/// a lexical fallback for non-numeric parts).
fn newer(a: &str, b: &str) -> bool {
    let mut ai = a.split('.');
    let mut bi = b.split('.');
    loop {
        match (ai.next(), bi.next()) {
            (None, None) => return false,
            (Some(x), None) => return x.parse::<u64>().map(|n| n > 0).unwrap_or(!x.is_empty()),
            (None, Some(_)) => return false,
            (Some(x), Some(y)) if x == y => continue,
            (Some(x), Some(y)) => {
                return match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(xn), Ok(yn)) => xn > yn,
                    _ => x > y,
                };
            }
        }
    }
}

/// Fetch the manifest and return `(available, notes)` on success. Errors (offline
/// / server down / bad body) yield `None` and the caller keeps the cached value.
fn fetch() -> Option<(String, String)> {
    // The manifest host is a remote AWS ALB, so a lone SYN is occasionally
    // dropped — retry a couple of times. No `--compressed`: the server's gzip
    // stream is trailed by a signature blob that trips curl's decompressor, and
    // the plain response is small anyway.
    let out = match Command::new("curl")
        .args([
            "-sS",
            "--connect-timeout", "6",
            "--max-time", "20",
            "--retry", "2",
            "--retry-delay", "1",
            "--retry-all-errors",
            MANIFEST_URL,
        ])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            eprintln!("firmware: curl exit {:?} stderr={}", o.status.code(), String::from_utf8_lossy(&o.stderr).trim());
            return None;
        }
        Err(e) => {
            eprintln!("firmware: curl spawn failed: {e}");
            return None;
        }
    };
    // Parse only the first JSON value (the manifest is followed by a signature).
    let val = serde_json::Deserializer::from_slice(&out).into_iter::<serde_json::Value>().next()?.ok()?;
    let trim = val
        .get("packages")
        .and_then(|p| p.as_array())?
        .iter()
        .find(|p| p.get("packageName").and_then(|n| n.as_str()) == Some("trim"))?;
    let available = trim.get("version").and_then(|x| x.as_str())?.to_string();
    let notes = trim.get("description").and_then(|x| x.as_str()).map(|s| s.trim().to_string()).unwrap_or_default();
    Some((available, notes))
}

pub fn status() -> Firmware {
    let current = std::fs::read_to_string(VERSION_FILE).ok().map(|s| s.trim().to_string());

    let mut cache = load_cache();
    let now = now();
    // Re-check only when the last success is stale, and never more often than
    // RETRY_INTERVAL (so a run of failures backs off rather than hammering).
    let stale = now.saturating_sub(cache.fetched_at) >= FETCH_INTERVAL;
    let may_retry = now.saturating_sub(cache.attempted_at) >= RETRY_INTERVAL;
    if stale && may_retry {
        cache.attempted_at = now;
        if let Some((available, notes)) = fetch() {
            cache.available = Some(available);
            cache.notes = Some(notes);
            cache.fetched_at = now;
        }
        save_cache(&cache); // persist the attempt timestamp even on failure
    }

    let update_available = match (&current, &cache.available) {
        (Some(c), Some(a)) => newer(a, c),
        _ => false,
    };
    Firmware { current, available: cache.available, update_available, notes: cache.notes }
}
