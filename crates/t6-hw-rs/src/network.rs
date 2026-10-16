//! Ethernet/Wi-Fi info via `ip` and `nmcli`, plus Wi-Fi *config* (scan/connect).
//!
//! Ethernet is reported per physical NIC (the built-in port and any USB
//! adapters): link/speed from the NIC itself, addresses from the interface that
//! carries its IP (the fnOS OVS bridge `en*-ovs` for the built-in port, the NIC
//! itself otherwise). Wi-Fi is a standalone NetworkManager device with no OVS
//! entanglement, so the panel can drive it directly — this matters for the
//! headless bootstrap case (join a network from the panel before the box is
//! reachable over the web UI).
//! Those writes go through NetworkManager, which fnOS observes.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Default, Clone)]
pub struct Ethernet {
    pub connected: bool,
    pub iface: Option<String>,
    /// The NIC sits on USB (an adapter) rather than the board's PCIe port.
    pub usb: bool,
    /// USB product string (e.g. "USB 10/100/1G/2.5G LAN"); None for the built-in port.
    pub model: Option<String>,
    pub mac: Option<String>,
    pub speed_mbps: Option<i64>,
    pub ip: Option<String>,
    /// IPv4 prefix length (e.g. 24).
    pub prefix: Option<u32>,
    pub gateway: Option<String>,
    pub dns: Vec<String>,
}

#[derive(Serialize, Default)]
pub struct Wifi {
    /// The radio is powered on (independent of whether it's associated).
    pub enabled: bool,
    pub connected: bool,
    pub iface: Option<String>,
    pub ssid: Option<String>,
    pub signal: Option<u32>,
    pub security: Option<String>,
    pub ip: Option<String>,
    /// IPv4 prefix length (e.g. 24) → the UI renders a dotted subnet mask.
    pub prefix: Option<u32>,
    pub gateway: Option<String>,
    pub dns: Vec<String>,
    /// First non-link-local IPv6 address (with prefix), if any.
    pub ipv6: Option<String>,
    /// Signal strength in dBm (from /proc/net/wireless), e.g. -39. `iw` isn't
    /// installed on this box, so we read the wireless-ext level column.
    pub dbm: Option<i32>,
    /// Human band label derived from the associated frequency: "2.4 GHz",
    /// "5 GHz", or "6 GHz".
    pub band: Option<String>,
    /// Wi-Fi channel of the associated AP (nmcli CHAN).
    pub channel: Option<u32>,
    /// Negotiated link rate as nmcli reports it, e.g. "270 Mbit/s".
    pub rate: Option<String>,
}

#[derive(Serialize, Default)]
pub struct Network {
    /// One connected wired NIC (preferring the one with the wired default
    /// route), else the first one — what the home tile shows.
    pub ethernet: Ethernet,
    /// Every physical wired NIC, connected or not: built-in first, then USB.
    pub ethernet_ports: Vec<Ethernet>,
    pub wifi: Wifi,
    pub hotspot: Hotspot,
    pub wireless: Wireless,
}

/// What the wireless card can do. Wi-Fi and the hotspot share it, so only one
/// can be on (`exclusive`).
#[derive(Serialize, Default)]
pub struct Wireless {
    pub wifi_available: bool,
    pub hotspot_available: bool,
    pub exclusive: bool,
}

/// Wi-Fi access-point ("hotspot") state. The password is not part of it (it
/// goes out in every /api/panel poll); see [`hotspot_details`].
#[derive(Serialize, Default)]
pub struct Hotspot {
    pub active: bool,
    pub ssid: Option<String>,
    /// "bg" (2.4 GHz) or "a" (5 GHz).
    pub band: Option<String>,
    /// How many devices are on it (the status bar shows the count).
    pub devices: usize,
}

/// The hotspot's page: its settings, password included (shown on the panel
/// as a join QR code), and the devices on it.
#[derive(Serialize, Default)]
pub struct HotspotDetails {
    #[serde(flatten)]
    pub status: Hotspot,
    pub password: Option<String>,
    /// The NAS's own address on the hotspot network.
    pub address: Option<String>,
    pub clients: Vec<HotspotClient>,
}

#[derive(Serialize)]
pub struct HotspotClient {
    pub name: Option<String>,
    pub ip: String,
    pub mac: String,
}

/// One access point in a scan result (deduped by SSID, strongest signal kept).
#[derive(Serialize)]
pub struct WifiAp {
    pub ssid: String,
    /// 0..=100.
    pub signal: u32,
    /// e.g. "WPA2", "WPA2 WPA3", or `None` for an open network.
    pub security: Option<String>,
    /// The AP we're currently associated with.
    pub in_use: bool,
    /// A saved NetworkManager profile exists for this SSID.
    pub saved: bool,
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(cmd).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

fn sysfs(iface: &str, attr: &str) -> Option<String> {
    std::fs::read_to_string(format!("/sys/class/net/{iface}/{attr}")).ok().map(|s| s.trim().to_string())
}

/// First physical interface with one of the prefixes, skipping virtual/OVS
/// ports (which contain a '-', e.g. `enp103s0-ovs`).
fn first_iface(prefixes: &[&str]) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir("/sys/class/net")
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.contains('-') && prefixes.iter().any(|p| n.starts_with(p)))
        .collect();
    names.sort();
    names.into_iter().next()
}

/// Physical wired NICs: `en*`/`eth*` backed by a device (skips OVS/veth/bridge
/// interfaces). Built-in ports first, then USB adapters, each by name.
fn wired_ifaces() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir("/sys/class/net")
        .map(|d| d.flatten().filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    names.retain(|n| {
        !n.contains('-')
            && (n.starts_with("en") || n.starts_with("eth"))
            && std::path::Path::new(&format!("/sys/class/net/{n}/device")).exists()
    });
    names.sort_by_key(|n| (is_usb(n), n.clone()));
    names
}

fn is_usb(iface: &str) -> bool {
    std::fs::canonicalize(format!("/sys/class/net/{iface}/device"))
        .map(|p| p.to_string_lossy().contains("/usb"))
        .unwrap_or(false)
}

/// The interface holding a NIC's IP: fnOS bridges the built-in port into OVS
/// and puts the address on `<nic>-ovs`.
fn l3_dev(iface: &str) -> String {
    let ovs = format!("{iface}-ovs");
    if std::path::Path::new(&format!("/sys/class/net/{ovs}")).exists() { ovs } else { iface.to_string() }
}

/// First IPv4 address on `dev` as (ip, prefix), from `ip -4 -o addr`.
fn dev_ipv4(dev: &str) -> Option<(String, Option<u32>)> {
    let out = run("ip", &["-4", "-o", "addr", "show", "dev", dev])?;
    let toks: Vec<&str> = out.lines().next()?.split_whitespace().collect();
    let cidr = tok_after(&toks, "inet")?;
    let mut parts = cidr.splitn(2, '/');
    Some((parts.next()?.to_string(), parts.next().and_then(|p| p.parse().ok())))
}

fn ethernet_port(iface: &str) -> Ethernet {
    let dev = l3_dev(iface);
    let usb = is_usb(iface);
    let (ip, prefix) = dev_ipv4(&dev).map(|(i, p)| (Some(i), p)).unwrap_or_default();
    Ethernet {
        connected: sysfs(iface, "carrier").as_deref() == Some("1"),
        iface: Some(iface.to_string()),
        usb,
        model: if usb { sysfs(iface, "device/../product") } else { None },
        mac: sysfs(iface, "address"),
        speed_mbps: sysfs(iface, "speed").and_then(|s| s.parse().ok()).filter(|&s| s > 0),
        ip,
        prefix,
        gateway: run("ip", &["route", "show", "default", "dev", &dev])
            .and_then(|o| tok_after(&o.split_whitespace().collect::<Vec<_>>(), "via")),
        dns: nmcli_field(&dev, "IP4.DNS"),
    }
}

fn tok_after(toks: &[&str], key: &str) -> Option<String> {
    toks.iter().position(|&t| t == key).and_then(|i| toks.get(i + 1)).map(|s| s.to_string())
}

/// Signal level in dBm from `/proc/net/wireless` (the wireless-extensions
/// "level" column), since `iw` isn't installed here. Line shape:
/// `wlpXsY: 0000   70.  -39.  -256  ...` → status, link, level, noise.
fn wifi_dbm(iface: &Option<String>) -> Option<i32> {
    let iface = iface.as_deref()?;
    let body = std::fs::read_to_string("/proc/net/wireless").ok()?;
    for line in body.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix(iface).and_then(|r| r.strip_prefix(':')) {
            // rest = "0000   70.  -39.  -256 ..."; level is the 3rd whitespace token.
            let lvl = rest.split_whitespace().nth(2)?;
            return lvl.trim_end_matches('.').parse::<i32>().ok();
        }
    }
    None
}

/// The default route carried over Wi-Fi (`is_wifi`) or not: (gateway, dev, src_ip).
fn default_route(is_wifi: bool) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let out = run("ip", &["route", "show", "default"])?;
    for line in out.lines() {
        let toks: Vec<&str> = line.split_whitespace().collect();
        let dev = tok_after(&toks, "dev");
        let over_wifi = dev.as_deref().map(|d| d.starts_with("wl")).unwrap_or(false);
        if over_wifi == is_wifi {
            return Some((tok_after(&toks, "via"), dev, tok_after(&toks, "src")));
        }
    }
    None
}

/// nmcli `-t` terse fields: ':' separates fields, values escape ':' as '\:'.
fn split_terse(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut esc = false;
    for c in line.chars() {
        if esc {
            cur.push(c);
            esc = false;
        } else if c == '\\' {
            esc = true;
        } else if c == ':' {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

/// Values of a single `nmcli device show` field (e.g. all `IP4.DNS[n]`).
fn nmcli_field(dev: &str, field: &str) -> Vec<String> {
    run("nmcli", &["-t", "-f", field, "device", "show", dev])
        .map(|out| {
            out.lines()
                .filter_map(|l| l.splitn(2, ':').nth(1))
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub fn info() -> Network {
    let mut n = Network::default();

    // Ethernet: every physical NIC; the tile shows a connected one, preferring
    // the NIC that carries the wired default route.
    n.ethernet_ports = wired_ifaces().iter().map(|i| ethernet_port(i)).collect();
    let route_dev = default_route(false).and_then(|(_, d, _)| d);
    let on_route = |e: &&Ethernet| e.iface.as_deref().map(l3_dev) == route_dev;
    n.ethernet = n.ethernet_ports.iter().filter(|e| e.connected).find(on_route)
        .or_else(|| n.ethernet_ports.iter().find(|e| e.connected))
        .or_else(|| n.ethernet_ports.first())
        .cloned()
        .unwrap_or_default();

    // Wi-Fi: link from the physical NIC; SSID/signal/security from nmcli.
    n.wifi.enabled = run("nmcli", &["-t", "radio", "wifi"]).map(|s| s.trim() == "enabled").unwrap_or(false);
    if let Some(wl) = first_iface(&["wl"]) {
        n.wifi.connected = sysfs(&wl, "carrier").as_deref() == Some("1");
        if let Some((_, _, src)) = default_route(true) {
            n.wifi.ip = src;
        }
        // Runtime IP details from the device (IP4.ADDRESS is "ip/prefix").
        if let Some(a) = nmcli_field(&wl, "IP4.ADDRESS").into_iter().next() {
            let mut parts = a.splitn(2, '/');
            if let Some(ip) = parts.next() {
                n.wifi.ip = Some(ip.to_string());
            }
            n.wifi.prefix = parts.next().and_then(|p| p.parse().ok());
        }
        n.wifi.gateway = nmcli_field(&wl, "IP4.GATEWAY").into_iter().next();
        n.wifi.dns = nmcli_field(&wl, "IP4.DNS");
        // Prefer a global IPv6 over the link-local (fe80::) one.
        let v6 = nmcli_field(&wl, "IP6.ADDRESS");
        n.wifi.ipv6 = v6.iter().find(|a| !a.to_lowercase().starts_with("fe80")).or_else(|| v6.first()).cloned();
        n.wifi.iface = Some(wl);
        if let Some(out) = run(
            "nmcli",
            &["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY,CHAN,RATE,FREQ", "device", "wifi"],
        ) {
            for line in out.lines() {
                let f = split_terse(line);
                if f.first().map(|s| s == "*").unwrap_or(false) {
                    n.wifi.ssid = f.get(1).filter(|s| !s.is_empty()).cloned();
                    n.wifi.signal = f.get(2).and_then(|s| s.parse().ok());
                    n.wifi.security = f.get(3).filter(|s| !s.is_empty()).cloned();
                    n.wifi.channel = f.get(4).and_then(|s| s.parse().ok());
                    n.wifi.rate = f.get(5).filter(|s| !s.is_empty()).cloned();
                    // FREQ is like "5745 MHz" → band bucket.
                    n.wifi.band = f.get(6).and_then(|s| s.split_whitespace().next()).and_then(|m| m.parse::<u32>().ok()).map(|mhz| {
                        if mhz >= 5925 { "6 GHz" } else if mhz >= 4900 { "5 GHz" } else { "2.4 GHz" }.to_string()
                    });
                    break;
                }
            }
        }
        n.wifi.dbm = wifi_dbm(&n.wifi.iface);
    }
    n.hotspot = hotspot_status();
    n.wireless = wireless();
    n
}

/// Whether there is a wireless card, and whether it can be an access point.
pub fn wireless() -> Wireless {
    let Some(wl) = first_iface(&["wl"]) else { return Wireless::default() };
    let ap = run("nmcli", &["-g", "WIFI-PROPERTIES.AP", "device", "show", &wl])
        .map(|o| o.trim() == "yes")
        .unwrap_or(false);
    Wireless { wifi_available: true, hotspot_available: ap, exclusive: true }
}

// ---- Wi-Fi config (writes go through NetworkManager) ---------------------

/// Run nmcli, returning trimmed stdout on success or the (stderr-derived)
/// error message on failure. Never pass secrets in a way that would be logged;
/// callers keep passwords out of any log line.
fn nmcli_ok(args: &[&str]) -> Result<String, String> {
    let o = Command::new("nmcli")
        .args(args)
        .output()
        .map_err(|e| format!("failed to run nmcli: {e}"))?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&o.stderr);
        let msg = err.trim();
        // nmcli's stderr is usually a single tidy "Error: ..." line.
        Err(if msg.is_empty() { "nmcli failed".into() } else { msg.to_string() })
    }
}

/// Saved Wi-Fi profiles as `(profile_name, ssid)` pairs. A profile's *name*
/// need not equal its SSID (NM appends the device, e.g. `UniFi-MLO-wlp0s20f3`),
/// so we read each wifi profile's actual `802-11-wireless.ssid`.
fn saved_wifi() -> Vec<(String, String)> {
    let names: Vec<String> = run("nmcli", &["-t", "-f", "NAME,TYPE", "connection", "show"])
        .map(|out| {
            out.lines()
                .filter_map(|l| {
                    let f = split_terse(l);
                    // NM reports wifi as "802-11-wireless".
                    match (f.first(), f.get(1)) {
                        (Some(name), Some(ty)) if ty.contains("wireless") => Some(name.clone()),
                        _ => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    names
        .iter()
        .filter_map(|name| {
            let out = run("nmcli", &["-t", "-f", "802-11-wireless.ssid", "connection", "show", name])?;
            // Line is `802-11-wireless.ssid:<ssid>`; the value may contain
            // escaped colons, so parse the whole line and take field 1.
            let line = out.lines().next()?;
            let ssid = split_terse(line).get(1).filter(|s| !s.is_empty()).cloned()?;
            Some((name.clone(), ssid))
        })
        .collect()
}

/// The saved profile NAME for an SSID, if one exists.
fn saved_wifi_profile(ssid: &str) -> Option<String> {
    saved_wifi().into_iter().find(|(_, s)| s == ssid).map(|(name, _)| name)
}

/// Scan for nearby Wi-Fi networks. `rescan` forces a fresh scan (slower) rather
/// than returning NetworkManager's cached list.
pub fn scan(rescan: bool) -> Result<Vec<WifiAp>, String> {
    let saved: Vec<String> = saved_wifi().into_iter().map(|(_, ssid)| ssid).collect();
    let out = nmcli_ok(&[
        "-t",
        "-f",
        "IN-USE,SSID,SIGNAL,SECURITY",
        "device",
        "wifi",
        "list",
        "--rescan",
        if rescan { "yes" } else { "no" },
    ])?;

    // Dedup by SSID, keeping the strongest signal; drop hidden (empty) SSIDs.
    let mut best: std::collections::HashMap<String, WifiAp> = std::collections::HashMap::new();
    for line in out.lines() {
        let f = split_terse(line);
        let ssid = match f.get(1) {
            Some(s) if !s.is_empty() => s.clone(),
            _ => continue,
        };
        let in_use = f.first().map(|s| s == "*").unwrap_or(false);
        let signal = f.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        let security = f.get(3).filter(|s| !s.is_empty()).cloned();
        let saved = saved.iter().any(|s| *s == ssid);
        best.entry(ssid.clone())
            .and_modify(|ap| {
                if signal > ap.signal {
                    ap.signal = signal;
                    ap.security = security.clone();
                }
                ap.in_use |= in_use;
            })
            .or_insert(WifiAp { ssid, signal, security, in_use, saved });
    }

    let mut aps: Vec<WifiAp> = best.into_values().collect();
    // Connected first, then by signal descending.
    aps.sort_by(|a, b| b.in_use.cmp(&a.in_use).then(b.signal.cmp(&a.signal)));
    Ok(aps)
}

/// Join a Wi-Fi network. Reuses a saved profile when `password` is `None` and a
/// profile exists; otherwise (re)creates one. Open networks pass no password.
pub fn connect(ssid: &str, password: Option<&str>) -> Result<(), String> {
    // If there's a saved profile and no new password, just bring it up (by its
    // NM profile name, which may differ from the SSID).
    if password.is_none() {
        if let Some(name) = saved_wifi_profile(ssid) {
            return nmcli_ok(&["connection", "up", "id", &name]).map(|_| ());
        }
    }
    let mut args = vec!["device", "wifi", "connect", ssid];
    if let Some(pw) = password {
        args.push("password");
        args.push(pw);
    }
    nmcli_ok(&args).map(|_| ())
}

/// Disconnect the Wi-Fi radio's current association (keeps the saved profile).
/// Join a WPA-Enterprise (802.1X) network: a user name and password, with
/// the EAP method (default PEAP) and inner authentication (default MSCHAPv2).
pub fn connect_enterprise(ssid: &str, identity: &str, password: &str, eap: &str, phase2: &str) -> Result<(), String> {
    if identity.is_empty() || password.is_empty() {
        return Err("user name and password are required".into());
    }
    let eap = if eap.is_empty() { "peap" } else { eap };
    let phase2 = if phase2.is_empty() { "mschapv2" } else { phase2 };
    let wl = first_iface(&["wl"]).ok_or("no Wi-Fi interface")?;
    // A profile per SSID; replace any earlier one so new credentials apply.
    if let Some(name) = saved_wifi_profile(ssid) {
        let _ = nmcli_ok(&["connection", "delete", "id", &name]);
    }
    nmcli_ok(&[
        "connection", "add", "type", "wifi", "ifname", &wl, "con-name", ssid, "ssid", ssid,
        "wifi-sec.key-mgmt", "wpa-eap",
        "802-1x.eap", eap,
        "802-1x.phase2-auth", phase2,
        "802-1x.identity", identity,
        "802-1x.password", password,
    ])?;
    let up = nmcli_ok(&["--wait", "30", "connection", "up", "id", ssid]);
    if up.is_err() {
        let _ = nmcli_ok(&["connection", "delete", "id", ssid]);
    }
    up.map(|_| ())
}

pub fn disconnect() -> Result<(), String> {
    let iface = first_iface(&["wl"]).ok_or("no Wi-Fi interface")?;
    nmcli_ok(&["device", "disconnect", &iface]).map(|_| ())
}

/// Delete the saved profile for an SSID ("forget this network").
pub fn forget(ssid: &str) -> Result<(), String> {
    let name = saved_wifi_profile(ssid).ok_or("no saved network for that SSID")?;
    nmcli_ok(&["connection", "delete", "id", &name]).map(|_| ())
}

/// Turn the Wi-Fi radio on or off.
pub fn set_radio(on: bool) -> Result<(), String> {
    nmcli_ok(&["radio", "wifi", if on { "on" } else { "off" }]).map(|_| ())
}

/// Whether the saved profile for an SSID auto-joins (connection.autoconnect).
pub fn autojoin(ssid: &str) -> Result<bool, String> {
    let name = saved_wifi_profile(ssid).ok_or("no saved network for that SSID")?;
    let out = nmcli_ok(&["-t", "-f", "connection.autoconnect", "connection", "show", &name])?;
    // Terse output is "connection.autoconnect:yes".
    Ok(out.split(':').nth(1).map(|v| v.trim() == "yes").unwrap_or(true))
}

/// Set whether the saved profile for an SSID auto-joins.
pub fn set_autojoin(ssid: &str, on: bool) -> Result<(), String> {
    let name = saved_wifi_profile(ssid).ok_or("no saved network for that SSID")?;
    nmcli_ok(&["connection", "modify", "id", &name, "connection.autoconnect", if on { "yes" } else { "no" }]).map(|_| ())
}

// ---- Ethernet config (writes go through NetworkManager) ------------------
//
// Configured per NIC. The built-in port's IP lives on fnOS's OVS bridge
// (`<nic>-ovs`), so that's the connection we edit for it; fnOS's
// network_service may later reconcile it back, which is accepted (the panel
// editor is a stopgap). A USB adapter gets the NM profile active on it, else
// a saved one bound to it, else a new one; an unbound profile we edit is bound
// to the NIC so NetworkManager can't bring it up on another adapter instead.

#[derive(Serialize, Default)]
pub struct EthConfig {
    /// NM connection name to edit (e.g. "enp103s0-ovs"), or None if not found.
    pub conn: Option<String>,
    /// Device that connection is on (e.g. "enp103s0-ovs").
    pub iface: Option<String>,
    /// "auto" (DHCP) or "manual" (static).
    pub method: String,
    /// First static address as CIDR (e.g. "10.0.0.5/24"), when manual.
    pub address: Option<String>,
    pub gateway: Option<String>,
    pub dns: Vec<String>,
}

/// The NM connection + device that carry the wired (non-Wi-Fi) default route.
fn wired_conn() -> Option<(String, String)> {
    let (_, dev, _) = default_route(false)?;
    let dev = dev?;
    let conn = device_connection(&dev)?;
    Some((conn, dev))
}

/// The active NM connection name on a device (e.g. "enp103s0-ovs", or a
/// Thunderbolt net iface's connection).
/// Runtime IPv4 address (without prefix) on `dev`, whatever assigned it.
pub(crate) fn iface_ipv4(dev: &str) -> Option<String> {
    nmcli_field(dev, "IP4.ADDRESS").into_iter().next().and_then(|a| a.split('/').next().map(|s| s.to_string())).filter(|s| !s.is_empty())
}

pub(crate) fn device_connection(dev: &str) -> Option<String> {
    run("nmcli", &["-t", "-f", "GENERAL.CONNECTION", "device", "show", dev])?
        .lines()
        .next()
        .and_then(|l| split_terse(l).get(1).cloned())
        .filter(|s| !s.is_empty())
}

/// One terse `connection show` field value (first line), e.g. `ipv4.method`.
pub(crate) fn conn_field(conn: &str, field: &str) -> Option<String> {
    let out = run("nmcli", &["-t", "-f", field, "connection", "show", conn])?;
    split_terse(out.lines().next()?).get(1).filter(|s| !s.is_empty()).cloned()
}

/// Editable IPv4 config of any NM connection (shared by Ethernet + TB net).
#[derive(Serialize, Default)]
pub struct Ipv4Cfg {
    /// "auto" (DHCP) or "manual" (static).
    pub method: String,
    /// First static address as CIDR (e.g. "10.0.0.5/24"), when manual.
    pub address: Option<String>,
    pub gateway: Option<String>,
    pub dns: Vec<String>,
}

/// Read a connection's IPv4 config.
pub fn ipv4_config(conn: &str) -> Ipv4Cfg {
    Ipv4Cfg {
        method: conn_field(conn, "ipv4.method").unwrap_or_else(|| "auto".into()),
        // ipv4.addresses is comma-separated CIDRs; keep the first for the editor.
        address: conn_field(conn, "ipv4.addresses").and_then(|s| s.split(',').next().map(|x| x.trim().to_string())).filter(|s| !s.is_empty()),
        gateway: conn_field(conn, "ipv4.gateway"),
        dns: conn_field(conn, "ipv4.dns").map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default(),
    }
}

/// Set a connection's IPv4 config and re-activate it. `method` is "auto" (DHCP),
/// "manual" (static; `address` CIDR required, `gateway` optional) or
/// "link-local" (169.254/16 auto-address — the right choice for a host-to-host
/// Thunderbolt link, which has no DHCP server). `dns` (may be empty) applies to
/// auto and manual — with DHCP a non-empty list overrides leases.
pub fn set_conn_ipv4(conn: &str, method: &str, address: Option<&str>, gateway: Option<&str>, dns: &[String]) -> Result<(), String> {
    modify_conn_ipv4(conn, method, address, gateway, dns)?;
    nmcli_ok(&["connection", "up", conn]).map(|_| ())
}

/// Write a connection's IPv4 config without re-activating it.
fn modify_conn_ipv4(conn: &str, method: &str, address: Option<&str>, gateway: Option<&str>, dns: &[String]) -> Result<(), String> {
    let dns_joined = dns.join(",");
    let mut args: Vec<String> = vec!["connection".into(), "modify".into(), conn.into()];
    let mut set = |k: &str, v: &str| { args.push(k.into()); args.push(v.into()); };
    match method {
        "auto" => {
            set("ipv4.method", "auto");
            set("ipv4.addresses", "");
            set("ipv4.gateway", "");
            set("ipv4.dns", &dns_joined);
            set("ipv4.ignore-auto-dns", if dns.is_empty() { "no" } else { "yes" });
        }
        "manual" => {
            let addr = address.filter(|s| !s.is_empty()).ok_or("static mode needs an IP address (CIDR)")?;
            set("ipv4.method", "manual");
            set("ipv4.addresses", addr);
            set("ipv4.gateway", gateway.unwrap_or(""));
            set("ipv4.dns", &dns_joined);
        }
        "link-local" => {
            set("ipv4.method", "link-local");
            set("ipv4.addresses", "");
            set("ipv4.gateway", "");
            set("ipv4.dns", "");
        }
        other => return Err(format!("invalid method {other:?} (want auto|manual|link-local)")),
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    nmcli_ok(&argv).map(|_| ())
}

/// Read the editable IPv4 config of wired NIC `iface`, or, with `None`, of
/// the connection carrying the wired default route.
pub fn eth_config(iface: Option<&str>) -> EthConfig {
    let mut c = EthConfig { method: "auto".into(), ..Default::default() };
    let found = match iface {
        Some(i) => port_conn(i).map(|conn| (conn, l3_dev(i))),
        None => wired_conn(),
    };
    let Some((conn, dev)) = found else { return c };
    let ip = ipv4_config(&conn);
    c.method = ip.method;
    c.address = ip.address;
    c.gateway = ip.gateway;
    c.dns = ip.dns;
    c.conn = Some(conn);
    c.iface = Some(dev);
    c
}

/// Set the IPv4 config of wired NIC `iface` (or, with `None`, of the
/// connection carrying the wired default route). An unplugged NIC's profile is
/// only saved; NetworkManager applies it once a cable is in.
pub fn eth_set(iface: Option<&str>, method: &str, address: Option<&str>, gateway: Option<&str>, dns: &[String]) -> Result<(), String> {
    let Some(iface) = iface else {
        let (conn, _) = wired_conn().ok_or("no wired connection found")?;
        return set_conn_ipv4(&conn, method, address, gateway, dns);
    };
    if !wired_ifaces().iter().any(|i| i == iface) {
        return Err(format!("{iface} is not a wired network adapter"));
    }
    if method == "manual" {
        if let Some(ip) = address.and_then(|a| a.split('/').next()) {
            if let Some(other) = ipv4_owner(ip).filter(|d| *d != iface && *d != l3_dev(iface)) {
                return Err(format!("{ip} is already in use on {other}"));
            }
        }
    }
    let conn = match port_conn(iface) {
        Some(conn) => {
            if l3_dev(iface) == iface && conn_field(&conn, "connection.interface-name").is_none() {
                nmcli_ok(&["connection", "modify", &conn, "connection.interface-name", iface])?;
            }
            conn
        }
        None => {
            let name = format!("Wired {iface}");
            nmcli_ok(&["connection", "add", "type", "ethernet", "ifname", iface, "con-name", &name])?;
            name
        }
    };
    modify_conn_ipv4(&conn, method, address, gateway, dns)?;
    if sysfs(iface, "carrier").as_deref() == Some("1") {
        nmcli_ok(&["connection", "up", &conn])?;
    }
    Ok(())
}

/// The NM connection that configures wired NIC `iface` (see the section note).
fn port_conn(iface: &str) -> Option<String> {
    let dev = l3_dev(iface);
    if dev != iface {
        return device_connection(&dev).or_else(|| saved_wired_conn(&dev, None));
    }
    device_connection(iface).or_else(|| saved_wired_conn(iface, sysfs(iface, "address").as_deref()))
}

/// A saved wired profile bound to `dev` by name or MAC (by UUID). Profiles with
/// IPv4 disabled are skipped: those are bridge ports (fnOS binds one to the
/// built-in NIC for OVS), not where the address lives.
fn saved_wired_conn(dev: &str, mac: Option<&str>) -> Option<String> {
    let list = run("nmcli", &["-t", "-f", "UUID,TYPE", "connection", "show"])?;
    list.lines().map(split_terse).find_map(|f| {
        let (uuid, kind) = (f.first()?, f.get(1)?);
        if kind != "802-3-ethernet" && kind != "generic" {
            return None;
        }
        let out = run("nmcli", &["-t", "-f", "connection.interface-name,802-3-ethernet.mac-address,ipv4.method", "connection", "show", uuid])?;
        let field = |k: &str| out.lines().map(split_terse).find(|v| v.first().map(String::as_str) == Some(k)).and_then(|v| v.get(1).cloned()).unwrap_or_default();
        let bound = field("connection.interface-name") == dev
            || mac.is_some_and(|m| !m.is_empty() && field("802-3-ethernet.mac-address").eq_ignore_ascii_case(m));
        (bound && field("ipv4.method") != "disabled").then(|| uuid.clone())
    })
}

/// The interface that currently holds IPv4 address `ip`, if any.
fn ipv4_owner(ip: &str) -> Option<String> {
    let out = run("ip", &["-4", "-o", "addr"])?;
    out.lines().find_map(|l| {
        let toks: Vec<&str> = l.split_whitespace().collect();
        let addr = tok_after(&toks, "inet")?;
        (addr.split('/').next() == Some(ip)).then(|| toks.get(1).map(|d| d.to_string())).flatten()
    })
}

// ---- Wi-Fi hotspot (AP mode) ---------------------------------------------
//
// nmcli AP-mode sequence adapted from fn-wifi-hotspot (Ing/wjz304, MIT) — see
// README acknowledgements. We use NM's `ipv4.method shared` (its own dnsmasq +
// NAT) instead of a bundled dnsmasq/iptables, so it needs `dnsmasq-base` and
// `iptables` on the system. "Approach A": the AP takes over the Wi-Fi card
// (dropping any client association); bringing it down lets NM auto-reconnect
// the saved client network. Runs on the Wi-Fi PHY, so it never touches the
// wired/OVS path fnOS reconciles.

const HOTSPOT_CONN: &str = "t6-hotspot";

/// Current hotspot state (never exposes the PSK).
pub fn hotspot_status() -> Hotspot {
    let mut h = Hotspot::default();
    h.ssid = conn_field(HOTSPOT_CONN, "802-11-wireless.ssid");
    h.band = conn_field(HOTSPOT_CONN, "802-11-wireless.band");
    h.active = run("nmcli", &["-t", "-f", "NAME", "connection", "show", "--active"])
        .map(|o| o.lines().any(|l| l == HOTSPOT_CONN))
        .unwrap_or(false);
    if h.active {
        h.devices = first_iface(&["wl"]).map(|wl| hotspot_clients(&wl).len()).unwrap_or(0);
    }
    h
}

/// Set the hotspot up (name, password, band) and start it, or only save the
/// settings when `start` is false. `band` is "a" (5 GHz) or anything else → 2.4 GHz.
pub fn hotspot_start(ssid: &str, password: &str, band: &str, start: bool) -> Result<(), String> {
    if ssid.is_empty() || ssid.chars().count() > 32 {
        return Err("SSID must be 1–32 characters".into());
    }
    if password.chars().count() < 8 {
        return Err("password must be at least 8 characters (WPA2)".into());
    }
    let band = if matches!(band, "a" | "5" | "5g" | "5ghz") { "a" } else { "bg" };
    let wl = first_iface(&["wl"]).ok_or("no Wi-Fi interface")?;
    // Start clean so a re-start always applies the new settings.
    let _ = nmcli_ok(&["connection", "down", HOTSPOT_CONN]);
    let _ = nmcli_ok(&["connection", "delete", HOTSPOT_CONN]);
    nmcli_ok(&["connection", "add", "type", "wifi", "ifname", &wl, "con-name", HOTSPOT_CONN, "autoconnect", "no", "ssid", ssid])?;
    let modify = nmcli_ok(&[
        "connection", "modify", HOTSPOT_CONN,
        "802-11-wireless.mode", "ap",
        "802-11-wireless.band", band,
        "802-11-wireless.powersave", "2",
        "802-11-wireless-security.key-mgmt", "wpa-psk",
        "802-11-wireless-security.psk", password,
        "802-11-wireless-security.proto", "rsn",
        "802-11-wireless-security.pairwise", "ccmp",
        "ipv4.method", "shared",
        "ipv6.method", "disabled",
    ]);
    if !start {
        return modify.map(|_| ());
    }
    let up = modify.and_then(|_| nmcli_ok(&["--wait", "20", "connection", "up", HOTSPOT_CONN]));
    if let Err(e) = up {
        let _ = nmcli_ok(&["connection", "delete", HOTSPOT_CONN]);
        return Err(e);
    }
    Ok(())
}

/// Stop the hotspot (deactivate; NM reconnects the saved client network).
/// The hotspot with its password, address and the devices on it.
pub fn hotspot_details() -> HotspotDetails {
    let status = hotspot_status();
    let password = run("nmcli", &["-s", "-g", "802-11-wireless-security.psk", "connection", "show", HOTSPOT_CONN])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut d = HotspotDetails { status, password, ..Default::default() };
    if !d.status.active {
        return d;
    }
    let Some(wl) = first_iface(&["wl"]) else { return d };
    d.address = dev_ipv4(&wl).map(|(ip, _)| ip);
    d.clients = hotspot_clients(&wl);
    d
}

/// The devices on the hotspot: NetworkManager's DHCP leases for it, kept
/// only while the kernel still sees them on the link (leases outlive a
/// disconnect).
fn hotspot_clients(wl: &str) -> Vec<HotspotClient> {
    let mut clients = Vec::new();
    let present: Vec<String> = run("ip", &["neigh", "show", "dev", wl])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.contains("FAILED") && !l.contains("INCOMPLETE"))
        .filter_map(|l| l.split_whitespace().next().map(str::to_string))
        .collect();
    let leases = std::fs::read_to_string(format!("/var/lib/NetworkManager/dnsmasq-{wl}.leases")).unwrap_or_default();
    for line in leases.lines() {
        // expiry mac ip hostname client-id
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 || !present.iter().any(|ip| ip == f[2]) {
            continue;
        }
        let name = (f[3] != "*").then(|| f[3].to_string());
        clients.push(HotspotClient { name, ip: f[2].to_string(), mac: f[1].to_string() });
    }
    clients
}

/// Start the hotspot again with the name, password and band it was last set up with.
pub fn hotspot_resume() -> Result<(), String> {
    if conn_field(HOTSPOT_CONN, "802-11-wireless.ssid").is_none() {
        return Err("the hotspot has not been set up yet".into());
    }
    nmcli_ok(&["--wait", "20", "connection", "up", HOTSPOT_CONN]).map(|_| ())
}

pub fn hotspot_stop() -> Result<(), String> {
    nmcli_ok(&["connection", "down", HOTSPOT_CONN]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terse_split_handles_escaped_colons() {
        assert_eq!(split_terse("*:My\\:SSID:72:WPA2"), vec!["*", "My:SSID", "72", "WPA2"]);
        assert_eq!(split_terse(":Open:50:"), vec!["", "Open", "50", ""]);
    }
    #[test]
    fn tok_after_finds_route_fields() {
        let toks: Vec<&str> = "default via 10.0.0.1 dev enp0-ovs proto dhcp src 10.0.0.9".split_whitespace().collect();
        assert_eq!(tok_after(&toks, "via").as_deref(), Some("10.0.0.1"));
        assert_eq!(tok_after(&toks, "dev").as_deref(), Some("enp0-ovs"));
        assert_eq!(tok_after(&toks, "src").as_deref(), Some("10.0.0.9"));
    }
}
