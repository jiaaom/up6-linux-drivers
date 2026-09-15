//! Ethernet/Wi-Fi info via `ip` and `nmcli`, plus Wi-Fi *config* (scan/connect).
//!
//! Ethernet config is deliberately left to fnOS: the wired IP lives on an OVS
//! bridge (`en*-ovs`) that fnOS's `network_service` owns, so we only *read* it
//! (link/speed from the physical `en*` device, address/gateway from whichever
//! interface actually carries the default route). Wi-Fi, by contrast, is a
//! standalone NetworkManager device with no OVS entanglement, so the panel can
//! safely drive it directly — this matters for the headless bootstrap case
//! (join a network from the panel before the box is reachable over the web UI).
//! Those writes go through NetworkManager, which fnOS observes.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Default)]
pub struct Ethernet {
    pub connected: bool,
    pub iface: Option<String>,
    pub speed_mbps: Option<i64>,
    pub ip: Option<String>,
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
}

#[derive(Serialize, Default)]
pub struct Network {
    pub ethernet: Ethernet,
    pub wifi: Wifi,
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

fn tok_after(toks: &[&str], key: &str) -> Option<String> {
    toks.iter().position(|&t| t == key).and_then(|i| toks.get(i + 1)).map(|s| s.to_string())
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

    // Ethernet: link/speed from the physical NIC; address from the default route.
    if let Some(eth) = first_iface(&["en", "eth"]) {
        n.ethernet.connected = sysfs(&eth, "carrier").as_deref() == Some("1");
        n.ethernet.speed_mbps = sysfs(&eth, "speed").and_then(|s| s.parse().ok()).filter(|&s| s > 0);
        n.ethernet.iface = Some(eth);
    }
    if let Some((gw, dev, src)) = default_route(false) {
        n.ethernet.ip = src;
        n.ethernet.gateway = gw;
        if let Some(d) = dev {
            n.ethernet.dns = nmcli_field(&d, "IP4.DNS");
        }
    }

    // Wi-Fi: link from the physical NIC; SSID/signal/security from nmcli.
    n.wifi.enabled = run("nmcli", &["-t", "radio", "wifi"]).map(|s| s.trim() == "enabled").unwrap_or(false);
    if let Some(wl) = first_iface(&["wl"]) {
        n.wifi.connected = sysfs(&wl, "carrier").as_deref() == Some("1");
        if let Some((_, _, src)) = default_route(true) {
            n.wifi.ip = src;
        }
        n.wifi.iface = Some(wl);
        if let Some(out) = run("nmcli", &["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi"]) {
            for line in out.lines() {
                let f = split_terse(line);
                if f.first().map(|s| s == "*").unwrap_or(false) {
                    n.wifi.ssid = f.get(1).filter(|s| !s.is_empty()).cloned();
                    n.wifi.signal = f.get(2).and_then(|s| s.parse().ok());
                    n.wifi.security = f.get(3).filter(|s| !s.is_empty()).cloned();
                    break;
                }
            }
        }
    }
    n
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
