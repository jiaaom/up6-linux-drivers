//! Read-only Ethernet/Wi-Fi info via `ip` and `nmcli`.
//!
//! NetworkManager (with fnOS's `network_service` on top) owns the config, so
//! this module only *reads* — never writes. Writing would diverge from fnOS's
//! authoritative model (OVS bridge, wifi state); config is delegated to fnOS.
//!
//! The wired IP often lives on an OVS bridge interface (fnOS setup) rather than
//! the physical NIC, so we take link/speed from the physical `en*` device but
//! the address/gateway from whichever interface actually carries the default
//! route.

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
