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
    /// Another computer (XDomain link) rather than a peripheral. Hosts have
    /// no `authorized` attribute and bolt doesn't manage them — the link is
    /// simply up, and IP runs over it (see `Thunderbolt::net`).
    pub host: bool,
    /// Negotiated link as aggregate bandwidth + lanes, e.g. "40 Gb/s ×2".
    pub link: Option<String>,
    /// Link is below what TB3/TB4/USB4 negotiate on a good cable (40 Gb/s):
    /// one lane, or a lane below 20 Gb/s — usually a cable or port issue.
    pub link_slow: bool,
    /// Which physical port (1-based, in sysfs order) the peer hangs off.
    pub port: Option<u32>,
}

/// A host-to-host Thunderbolt network interface (SMB-over-TB), with its
/// editable IPv4 config so the panel can address it.
#[derive(Serialize)]
pub struct TbNet {
    pub iface: String,
    pub connected: bool,
    /// NM connection name (target for IPv4 config), if managed.
    pub conn: Option<String>,
    /// Profile config (what the editor shows).
    pub ipv4: crate::network::Ipv4Cfg,
    /// Runtime address actually on the interface (link-local under the
    /// default profile, so `ipv4.address` is empty while this isn't).
    pub ip: Option<String>,
    pub mtu: Option<u32>,
    /// Interface byte counters; the UI turns deltas into a live rate.
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// The computer at the other end, as far as we can tell.
    pub peer: Option<TbPeer>,
}

#[derive(Serialize, Clone)]
pub struct TbPeer {
    pub ip: String,
    /// mDNS name (e.g. "Mason-MacBook-Air.local"), only from `info_full`.
    pub host: Option<String>,
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
    /// Physical USB4/TB ports on the host router.
    pub ports: u32,
    /// Devices enrolled in bolt's database.
    pub remembered: u32,
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
    t.remembered = stored.len() as u32;
    // Host router ports are `0-0/usb4_port<adapter>`; a peer at route "0-N"
    // hangs off adapter N. Numbered 1.. in adapter order for display.
    let mut ports: Vec<u32> = std::fs::read_dir(format!("{BUS}/0-0")).map(|rd| rd.flatten()
        .filter_map(|e| e.file_name().into_string().ok()?.strip_prefix("usb4_port")?.parse().ok()).collect()).unwrap_or_default();
    ports.sort_unstable();
    t.ports = ports.len() as u32;
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
            // Peer computers are DEVTYPE=thunderbolt_xdomain and carry no
            // `authorized` file; treating that as "0" would show a phantom
            // "Pending authorization" that boltctl can't act on.
            let host = read(&format!("{base}/uevent")).map(|u| u.contains("DEVTYPE=thunderbolt_xdomain")).unwrap_or(false)
                || !std::path::Path::new(&format!("{base}/authorized")).exists();
            let auth = read(&format!("{base}/authorized")).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let stored_dev = stored.iter().any(|u| u.eq_ignore_ascii_case(&uuid));
            // rx_speed is per lane ("20.0 Gb/s"); show the aggregate the way
            // marketing does (40 Gb/s) plus the lane count.
            let gbps: Option<f64> = read(&format!("{base}/rx_speed")).and_then(|s| s.split_whitespace().next()?.parse().ok());
            let lanes: u32 = read(&format!("{base}/rx_lanes")).and_then(|s| s.parse().ok()).unwrap_or(1);
            let link = gbps.map(|g| format!("{} Gb/s ×{lanes}", g * lanes as f64));
            let link_slow = gbps.map(|g| g < 20.0 || lanes < 2).unwrap_or(false);
            let port = name.strip_prefix("0-").and_then(|r| r.split('.').next()?.parse::<u32>().ok())
                .and_then(|adapter| ports.iter().position(|p| *p == adapter)).map(|i| i as u32 + 1);
            t.devices.push(TbDevice {
                name: read(&format!("{base}/device_name")).filter(|s| !s.is_empty()).unwrap_or_else(|| if host { "Computer".into() } else { "Thunderbolt device".into() }),
                vendor: read(&format!("{base}/vendor_name")).unwrap_or_default(),
                generation: read(&format!("{base}/generation")).and_then(|s| s.parse().ok()),
                authorized: host || auth >= 1,
                pending: !host && auth == 0,
                stored: stored_dev,
                host,
                link,
                link_slow,
                port,
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
        let ip = crate::network::iface_ipv4(&iface);
        let stat = |k: &str| read(&format!("/sys/class/net/{iface}/statistics/{k}")).and_then(|s| s.parse().ok()).unwrap_or(0);
        let peer = arp_peer(&iface).map(|ip| TbPeer { ip, host: None });
        out.push(TbNet {
            mtu: read(&format!("/sys/class/net/{iface}/mtu")).and_then(|s| s.parse().ok()),
            rx_bytes: stat("rx_bytes"),
            tx_bytes: stat("tx_bytes"),
            peer,
            iface, connected, conn, ipv4, ip,
        });
    }
    out
}

/// First IPv4 neighbour seen on `iface` (/proc/net/arp; no exec). A
/// host-to-host link has exactly one peer, so that's the other computer —
/// once any traffic has flowed (mDNS does that within seconds).
fn arp_peer(iface: &str) -> Option<String> {
    let text = std::fs::read_to_string("/proc/net/arp").ok()?;
    text.lines().skip(1).find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        // IP HWtype Flags HWaddr Mask Device — flags 0x0 = incomplete.
        (f.len() >= 6 && f[5] == iface && f[2] != "0x0").then(|| f[0].to_string())
    })
}

/// `info()` plus the peer's mDNS hostname from avahi's cache (~0.8 s, so only
/// for the detail page, not the 2 s panel poll).
pub fn info_full() -> Thunderbolt {
    let mut t = info();
    for n in t.net.iter_mut() {
        // ARP only knows the peer once we've talked to it; mDNS hears the peer
        // advertise itself right away, so it fills in both the hostname and,
        // when ARP is still empty, the address.
        match n.peer.as_mut() {
            Some(p) => p.host = avahi_peer(&n.iface, Some(&p.ip)).map(|(h, _)| h),
            None => n.peer = avahi_peer(&n.iface, None).map(|(h, ip)| TbPeer { ip, host: Some(h) }),
        }
    }
    t
}

/// (hostname, IPv4) of a host seen by avahi on `iface`, from its cache. With
/// `ip` given, only that host; otherwise the first one (a host-to-host link
/// has exactly one peer).
fn avahi_peer(iface: &str, ip: Option<&str>) -> Option<(String, String)> {
    let o = Command::new("avahi-browse").args(["-arpc"]).output().ok()?;
    // Resolved lines: =;iface;proto;name;type;domain;hostname;address;port;txt
    String::from_utf8_lossy(&o.stdout).lines().find_map(|l| {
        let f: Vec<&str> = l.split(';').collect();
        (f.len() >= 8 && f[0] == "=" && f[1] == iface && f[2] == "IPv4" && ip.map_or(true, |x| f[7] == x))
            .then(|| (f[6].to_string(), f[7].to_string()))
    })
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
