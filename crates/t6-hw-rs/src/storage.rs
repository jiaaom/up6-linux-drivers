//! Storage volume usage via `statvfs(3)` on the mounted data volumes.
//!
//! fnOS data pools mount at `/vol1`, `/vol2`, ... We report used/total per
//! volume straight from the kernel — no fnOS API needed, so this works with
//! or without a login. Volume *contents* are a separate, login-gated concern.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;

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

// --- Physical disks (local `lsblk`, no fnOS API) -------------------------------
//
// A read-only inventory of the block devices: model, bus, SSD/HDD, whether the
// drive is removable/hot-plugged, and its partitions + mount points. Ideal for
// checking an external drive you just plugged in. SMART health/temperature would
// need `smartctl`, which isn't installed on this box, so it's omitted for now.

#[derive(Deserialize)]
struct LsblkRoot {
    blockdevices: Vec<LsblkDev>,
}

#[derive(Deserialize)]
struct LsblkDev {
    name: String,
    #[serde(rename = "type")]
    dtype: Option<String>,
    size: Option<u64>,
    model: Option<String>,
    serial: Option<String>,
    tran: Option<String>,
    rota: Option<bool>,
    rm: Option<bool>,
    hotplug: Option<bool>,
    fstype: Option<String>,
    label: Option<String>,
    mountpoint: Option<String>,
    #[serde(default)]
    children: Vec<LsblkDev>,
}

#[derive(Serialize)]
pub struct Part {
    pub name: String,
    pub size_bytes: u64,
    pub fstype: Option<String>,
    pub label: Option<String>,
    /// Where the data on this partition is reachable. For a plain filesystem
    /// that's its own mountpoint; for a pool/array member it's the mount of
    /// what is built on top (see `via`), which lsblk alone reports as empty.
    pub mount: Option<String>,
    /// How `mount` was reached when the partition isn't mounted directly:
    /// "ZFS pool <name>" or the stacked device chain, e.g. "md2 → LVM".
    pub via: Option<String>,
}

/// ZFS pool name → mountpoint of its root dataset, from /proc/self/mounts
/// (the source of a zfs mount is the dataset name, `pool` or `pool/child`).
fn zfs_pool_mounts() -> BTreeMap<String, String> {
    let text = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let mut f = line.split_whitespace();
        let (Some(src), Some(mnt), Some(fs)) = (f.next(), f.next(), f.next()) else { continue };
        if fs != "zfs" {
            continue;
        }
        let pool = src.split('/').next().unwrap_or(src).to_string();
        // Prefer the root dataset; otherwise the shortest path (closest to the root).
        let e = out.entry(pool.clone()).or_insert_with(|| mnt.to_string());
        if src == pool || (mnt.len() < e.len() && !e.is_empty()) {
            *e = mnt.to_string();
        }
    }
    out
}

/// Walk down the devices stacked on `c` (md → LVM → filesystem, …) to the first
/// one that is mounted. Returns (mount, chain of device names walked through).
fn stacked_mount(c: &LsblkDev, chain: &mut Vec<String>) -> Option<String> {
    for ch in &c.children {
        if let Some(m) = ch.mountpoint.as_deref().filter(|s| !s.is_empty()) {
            chain.push(stack_label(ch));
            return Some(m.to_string());
        }
        chain.push(stack_label(ch));
        if let Some(m) = stacked_mount(ch, chain) {
            return Some(m);
        }
        chain.pop();
    }
    None
}

fn stack_label(d: &LsblkDev) -> String {
    match d.dtype.as_deref() {
        Some("lvm") => "LVM".into(),
        Some("crypt") => "LUKS".into(),
        _ => d.name.clone(),
    }
}

#[derive(Serialize)]
pub struct Disk {
    pub name: String,
    pub model: String,
    pub serial: Option<String>,
    pub size_bytes: u64,
    /// Bus/transport: sata, nvme, usb, …
    pub bus: String,
    pub ssd: bool,
    pub removable: bool,
    pub parts: Vec<Part>,
}

fn part_of(c: &LsblkDev, zfs: &BTreeMap<String, String>) -> Part {
    let fstype = c.fstype.clone().filter(|s| !s.is_empty());
    let label = c.label.clone().filter(|s| !s.is_empty());
    let mut mount = c.mountpoint.clone().filter(|s| !s.is_empty());
    let mut via = None;
    if mount.is_none() {
        if fstype.as_deref() == Some("zfs_member") {
            // lsblk's LABEL of a zfs_member is the pool name.
            if let Some(m) = label.as_ref().and_then(|p| zfs.get(p)) {
                mount = Some(m.clone());
                via = label.as_ref().map(|p| format!("ZFS pool {}", short_pool(p)));
            }
        } else {
            let mut chain = Vec::new();
            if let Some(m) = stacked_mount(c, &mut chain) {
                mount = Some(m);
                via = Some(chain.join(" → "));
            }
        }
    }
    Part { name: c.name.clone(), size_bytes: c.size.unwrap_or(0), fstype, label, mount, via }
}

/// fnOS names pools `trim_<uuid>`; keep that readable on a small screen.
fn short_pool(p: &str) -> String {
    match p.strip_prefix("trim_") {
        Some(rest) if rest.len() > 8 => format!("trim_{}…", &rest[..8]),
        _ => p.to_string(),
    }
}

/// Physical disks with their partitions. Empty if `lsblk` can't be read.
pub fn disks() -> Vec<Disk> {
    let out = Command::new("lsblk")
        .args(["-b", "-J", "-o", "NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,ROTA,RM,HOTPLUG,FSTYPE,LABEL,MOUNTPOINT"])
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    let root: LsblkRoot = match serde_json::from_slice(&out) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let zfs = zfs_pool_mounts();
    root.blockdevices
        .into_iter()
        .filter(|d| d.dtype.as_deref() == Some("disk"))
        .map(|d| Disk {
            model: d.model.clone().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Disk".into()),
            serial: d.serial.clone().filter(|s| !s.is_empty()),
            size_bytes: d.size.unwrap_or(0),
            bus: d.tran.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "—".into()),
            ssd: !d.rota.unwrap_or(true),
            removable: d.rm.unwrap_or(false) || d.hotplug.unwrap_or(false),
            parts: d.children.iter().filter(|c| c.dtype.as_deref() == Some("part")).map(|c| part_of(c, &zfs)).collect(),
            name: d.name,
        })
        .collect()
}
