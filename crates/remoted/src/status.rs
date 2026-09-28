//! Status for other programs (e.g. a dashboard), as JSON in
//! /run/remoted/status.json, rewritten atomically on every change: whether
//! each configured remote is paired and connected, its key map, and the last
//! code received (for a key test).
//!
//! The file lives in the service's RuntimeDirectory, so it is gone while
//! remoted isn't running.

use crate::config::Remote;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const DIR: &str = "/run/remoted";

#[derive(Serialize)]
struct Key {
    code: u8,
    key: String,
}

#[derive(Serialize, Clone)]
struct Last {
    /// Increases with every code, so a reader can tell repeats apart.
    seq: u64,
    code: u8,
    /// Linux key name; None for the release code or an unmapped code.
    key: Option<String>,
    mapped: bool,
    /// Wall clock, ms since the epoch.
    at_ms: u64,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    paired: bool,
    connected: bool,
    /// Address of the connected (else paired) remote.
    address: Option<String>,
    keys: Vec<Key>,
    /// Last non-release code.
    last: Option<Last>,
    /// A key is held right now.
    held: bool,
}

#[derive(Serialize)]
struct File {
    remotes: Vec<Entry>,
}

static STATE: Mutex<Option<File>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn init(remotes: &[Remote]) {
    let file = File {
        remotes: remotes
            .iter()
            .map(|r| Entry {
                name: r.label(),
                paired: false,
                connected: false,
                address: None,
                keys: r.keys.iter().map(|(&code, &k)| Key { code, key: crate::keys::name(k) }).collect(),
                last: None,
                held: false,
            })
            .collect(),
    };
    let _ = std::fs::create_dir_all(DIR);
    write(&file);
    *STATE.lock().unwrap() = Some(file);
}

fn update(idx: usize, f: impl FnOnce(&mut Entry) -> bool) {
    let mut g = STATE.lock().unwrap();
    let Some(file) = g.as_mut() else { return };
    let Some(e) = file.remotes.get_mut(idx) else { return };
    if f(e) {
        write(file);
    }
}

/// Paired/connected state from a BlueZ scan.
pub fn set_link(idx: usize, paired: bool, connected: bool, address: Option<String>) {
    update(idx, |e| {
        let changed = e.paired != paired || e.connected != connected || e.address != address;
        e.paired = paired;
        e.connected = connected;
        e.address = address;
        if !connected {
            e.held = false;
        }
        changed
    });
}

/// A code arrived; `key` is what it pressed (None: release or unmapped).
pub fn on_code(idx: usize, code: u8, release: bool, key: Option<u16>) {
    update(idx, |e| {
        e.held = key.is_some();
        if !release {
            let seq = e.last.as_ref().map_or(1, |l| l.seq + 1);
            e.last = Some(Last { seq, code, key: key.map(crate::keys::name), mapped: key.is_some(), at_ms: now_ms() });
        }
        true
    });
}

fn write(file: &File) {
    let Ok(json) = serde_json::to_vec(file) else { return };
    let tmp = format!("{DIR}/.status.json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, format!("{DIR}/status.json"));
    }
}
