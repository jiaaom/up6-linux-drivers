//! Storage volume usage via `statvfs(3)` on the mounted data volumes.
//!
//! fnOS data pools mount at `/vol1`, `/vol2`, ... We report used/total per
//! volume straight from the kernel — no fnOS API needed, so this works with
//! or without a login. Volume *contents* are a separate, login-gated concern.

use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Serialize)]
pub struct Volume {
    /// Display name, e.g. "Volume 1".
    pub name: String,
    pub mount: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
}

fn statvfs(path: &str) -> Option<(u64, u64)> {
    let c = std::ffi::CString::new(path).ok()?;
    // SAFETY: `c` is a valid NUL-terminated path; statvfs only writes `s`.
    unsafe {
        let mut s: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut s) != 0 {
            return None;
        }
        let frsize = s.f_frsize as u64;
        let total = (s.f_blocks as u64).saturating_mul(frsize);
        let avail = (s.f_bavail as u64).saturating_mul(frsize);
        Some((total.saturating_sub(avail), total))
    }
}

/// `/volN` -> "Volume N"; anything else keeps its mount path.
fn pretty(mount: &str) -> String {
    mount.strip_prefix("/vol").filter(|n| n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty())
        .map(|n| format!("Volume {n}"))
        .unwrap_or_else(|| mount.to_string())
}

fn is_data_volume(mount: &str) -> bool {
    mount.strip_prefix("/vol").map(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)
}

pub fn volumes() -> Vec<Volume> {
    let text = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let mount = match line.split_whitespace().nth(1) {
            Some(m) => m,
            None => continue,
        };
        if !is_data_volume(mount) || !seen.insert(mount.to_string()) {
            continue;
        }
        if let Some((used, total)) = statvfs(mount) {
            if total > 0 {
                out.push(Volume { name: pretty(mount), mount: mount.to_string(), used_bytes: used, total_bytes: total });
            }
        }
    }
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out
}
