//! Thunderbolt / USB4 status and device authorization.
//!
//! TB is a transport: an authorized link may tunnel PCIe (an SSD, eGPU or NIC
//! that then shows up in its own subsystem) or, host-to-host, bring up a
//! `thunderbolt-net` interface for IP/SMB over the link. This module reads the
//! bus + `bolt` state from sysfs and drives authorization through `boltctl`
//! (the domain security level here is `iommu+user`, so a freshly-plugged device
//! is blocked until authorized — the panel is the natural approve point).
//!
//! Reads are pure sysfs (robust); the enrolled ("stored") set comes from bolt's
//! own database directory, not from parsing `boltctl list` text.

use serde::Serialize;
use std::process::Command;

const BUS: &str = "/sys/bus/thunderbolt/devices";
const BOLT_DB: &str = "/var/lib/boltd/devices";

#[derive(Serialize)]
pub struct TbDevice {
    pub uuid: String,
    pub name: String,
    pub vendor: String,
    pub generation: Option<u32>,
    /// Authorized to communicate (PCIe/DP tunnels or net allowed).
    pub authorized: bool,
    /// Connected but not yet authorized — needs the user to approve.
    pub pending: bool,
    /// Enrolled in bolt's database (auto-authorized on future connects).
    pub stored: bool,
}

/// A host-to-host Thunderbolt network interface (SMB-over-TB), with its
/// editable IPv4 config so the panel can address it.
#[derive(Serialize)]
pub struct TbNet {
    pub iface: String,
    pub connected: bool,
    /// NM connection name (target for IPv4 config), if managed.
    pub conn: Option<String>,
    pub ipv4: crate::network::Ipv4Cfg,
}

#[derive(Serialize, Default)]
pub struct Thunderbolt {
    /// A Thunderbolt/USB4 bus exists on this machine.
    pub supported: bool,
    /// Domain security level (e.g. "iommu+user").
    pub security: Option<String>,
    /// e.g. "Thunderbolt 4".
    pub controller: Option<String>,
    /// Attached peripheral devices (excludes the host router).
    pub devices: Vec<TbDevice>,
    /// Host-to-host TB network interfaces.
    pub net: Vec<TbNet>,
}

fn read(p: &str) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

/// UUIDs enrolled in bolt's database (files named by uuid).
fn stored_uuids() -> Vec<String> {
    std::fs::read_dir(BOLT_DB)
        .map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default()
}

pub fn info() -> Thunderbolt {
    let mut t = Thunderbolt::default();
    if !std::path::Path::new(BUS).exists() {
        return t;
    }
    t.supported = true;
    t.security = read(&format!("{BUS}/domain0/security"));
    t.controller = read(&format!("{BUS}/0-0/generation")).map(|g| match g.as_str() {
        "4" => "Thunderbolt 4",
        "3" => "Thunderbolt 3",
        _ => "Thunderbolt/USB4",
    }.to_string());

    let stored = stored_uuids();
    if let Ok(rd) = std::fs::read_dir(BUS) {
        for e in rd.flatten() {
            let name = e.file_name().into_string().unwrap_or_default();
            // Peripheral routers look like "1-0"/"1-1"; skip domains and the
            // host router "0-0".
            if name.starts_with("domain") || name == "0-0" || !name.contains('-') {
                continue;
            }
            let base = format!("{BUS}/{name}");
            let uuid = match read(&format!("{base}/unique_id")) {
                Some(u) if !u.is_empty() => u,
                _ => continue,
            };
            let auth = read(&format!("{base}/authorized")).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let stored_dev = stored.iter().any(|u| u.eq_ignore_ascii_case(&uuid));
            t.devices.push(TbDevice {
                name: read(&format!("{base}/device_name")).filter(|s| !s.is_empty()).unwrap_or_else(|| "Thunderbolt device".into()),
                vendor: read(&format!("{base}/vendor_name")).unwrap_or_default(),
                generation: read(&format!("{base}/generation")).and_then(|s| s.parse().ok()),
                authorized: auth >= 1,
                pending: auth == 0,
                stored: stored_dev,
                uuid,
            });
        }
    }
    t.net = tb_net_ifaces();
    t
}

/// Network interfaces backed by the Thunderbolt bus (thunderbolt-net).
fn tb_net_ifaces() -> Vec<TbNet> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir("/sys/class/net") else { return out };
    for e in rd.flatten() {
        let iface = e.file_name().into_string().unwrap_or_default();
        // A TB net iface's device link (or its driver) sits under the
        // thunderbolt bus / a TB domain.
        let devlink = std::fs::read_link(format!("/sys/class/net/{iface}/device")).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let drvlink = std::fs::read_link(format!("/sys/class/net/{iface}/device/driver")).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let is_tb = devlink.contains("thunderbolt") || devlink.contains("/domain")
            || drvlink.contains("thunderbolt");
        if !is_tb {
            continue;
        }
        let connected = read(&format!("/sys/class/net/{iface}/carrier")).as_deref() == Some("1");
        let conn = crate::network::device_connection(&iface);
        let ipv4 = conn.as_deref().map(crate::network::ipv4_config).unwrap_or_default();
        out.push(TbNet { iface, connected, conn, ipv4 });
    }
    out
}

/// A UUID is a safe boltctl argument only if it looks like one.
fn valid_uuid(u: &str) -> bool {
    !u.is_empty() && u.len() <= 40 && u.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn boltctl(verb: &str, uuid: &str) -> Result<(), String> {
    if !valid_uuid(uuid) {
        return Err("invalid device id".into());
    }
    let o = Command::new("boltctl").args([verb, uuid]).output().map_err(|e| format!("boltctl: {e}"))?;
    if o.status.success() {
        Ok(())
    } else {
        let e = String::from_utf8_lossy(&o.stderr);
        Err(if e.trim().is_empty() { format!("boltctl {verb} failed") } else { e.trim().to_string() })
    }
}

/// Authorize a connected device for this session.
pub fn authorize(uuid: &str) -> Result<(), String> {
    boltctl("authorize", uuid)
}
/// Authorize and store the device (auto-authorized on future connects).
pub fn enroll(uuid: &str) -> Result<(), String> {
    boltctl("enroll", uuid)
}
/// Remove a stored device from bolt's database.
pub fn forget(uuid: &str) -> Result<(), String> {
    boltctl("forget", uuid)
}
