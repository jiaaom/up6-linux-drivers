//! Assemble the `/api/panel` aggregate the front-panel UI polls.
//!
//! Everything here is *public* telemetry — safe to show with no login, and
//! not tied to any user's identity: temperatures, fans, battery, brightness.
//! User- and permission-dependent data (storage, network, files) is added
//! later once a session exists.

use serde_json::{json, Value};
use t6_hw_rs::{battery::Battery, display::Display, fans, net, network, sensors, sharing, ssh, storage, thunderbolt};

/// Round an optional temperature to a whole degree for display.
fn deg(t: Option<f64>) -> Value {
    match t {
        Some(v) => json!(v.round() as i64),
        None => Value::Null,
    }
}

/// Seconds since boot (local, no fnOS session needed).
fn uptime_s() -> Option<u64> {
    std::fs::read_to_string("/proc/uptime").ok()?
        .split_whitespace().next()?.parse::<f64>().ok().map(|s| s as u64)
}

/// The home-screen health banner, derived from what the panel can see locally
/// every poll (no fnOS round-trip): temperatures, fans, battery, volume fill,
/// memory. The front end overlays fnOS-side signals (unread warning
/// notifications, `resmon.alert.getBeepReasons`) on top and shows the most
/// severe. Levels: "ok" | "warn" | "err".
fn health_status(
    cpu: Option<f64>, gpu: Option<f64>, drives: Option<f64>, mem_pct: Option<u32>,
    fans: &[fans::Fan], vols: &[storage::Volume], bat: &t6_hw_rs::battery::Info,
) -> Value {
    let mut warn: Vec<String> = Vec::new();
    let mut err: Vec<String> = Vec::new();
    // thermal
    if let Some(t) = cpu { if t >= 95.0 { err.push(format!("CPU overheating ({t:.0}°)")); } else if t >= 85.0 { warn.push(format!("CPU running hot ({t:.0}°)")); } }
    if let Some(t) = gpu { if t >= 95.0 { err.push(format!("GPU overheating ({t:.0}°)")); } else if t >= 85.0 { warn.push(format!("GPU running hot ({t:.0}°)")); } }
    if let Some(t) = drives { if t >= 70.0 { err.push(format!("Drives overheating ({t:.0}°)")); } else if t >= 60.0 { warn.push(format!("Drives running warm ({t:.0}°)")); } }
    // fans: commanded to spin but reading 0 rpm
    for f in fans {
        if let (Some(rpm), Some(pwm)) = (f.rpm, f.pwm_percent) {
            if rpm == 0 && pwm > 0 { err.push(format!("{} stopped", f.name)); }
        }
    }
    // battery / mains
    if bat.present {
        let on_batt = bat.ac_online == Some(false);
        let cap = bat.capacity.unwrap_or(100);
        if on_batt && cap < 15 { err.push(format!("Battery low ({cap}%) — on battery")); }
        else if on_batt { warn.push(format!("On battery power ({cap}%)")); }
    }
    // volumes nearly full
    for v in vols {
        if v.total_bytes == 0 { continue; }
        let pct = v.used_bytes as f64 / v.total_bytes as f64 * 100.0;
        if pct >= 99.0 { err.push(format!("{} is full ({pct:.0}%)", v.name)); }
        else if pct >= 92.0 { warn.push(format!("{} nearly full ({pct:.0}%)", v.name)); }
    }
    if let Some(m) = mem_pct { if m >= 97 { warn.push(format!("Memory nearly full ({m}%)")); } }

    let (level, text) = if let Some(e) = err.first() { ("err", e.clone()) }
        else if let Some(w) = warn.first() { ("warn", w.clone()) }
        else { ("ok", "All systems normal".to_string()) };
    let issues = err.len() + warn.len();
    json!({ "level": level, "text": text, "issues": issues, "uptime_s": uptime_s() })
}

/// Installed t6-panel package version: fnOS puts it in the unit's environment
/// (TRIM_APPVER); else the installed manifest; else this crate's version
/// (dev runs outside the App Center).
pub(crate) fn app_version() -> String {
    if let Ok(v) = std::env::var("TRIM_APPVER") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    std::fs::read_to_string("/var/apps/t6-panel/manifest")
        .ok()
        .and_then(|t| {
            t.lines().find_map(|l| {
                let (k, v) = l.split_once('=')?;
                (k.trim() == "version").then(|| v.trim().trim_matches('"').to_string())
            })
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

pub fn build() -> Value {
    let bat = Battery::new().info();
    let disp = Display::new().info();
    let set = crate::settings::load();
    let cpu = sensors::cpu_temp_c();
    let gpu = sensors::gpu_temp_c();
    let drives = sensors::drives_temp_c();
    let mem = sensors::mem_used_pct();
    let fan_list = fans::fans();
    let vols = storage::volumes();
    let status = health_status(cpu, gpu, drives, mem, &fan_list, &vols, &bat);
    let led = t6_hw_rs::leds::Ledd::new().status();
    let leds = json!({
        "available": led.is_some(),
        // night mode on = indicator lights stay off (design's "reduce light pollution")
        "night": led.as_ref().and_then(|s| s.get("night")).and_then(|n| n.get("active")).and_then(|v| v.as_bool()).unwrap_or(false),
    });

    json!({
        "host": {
            "name": sensors::hostname(),
        },
        "app": {
            "version": app_version(),
        },
        "storage": vols,
        "net": net::counters(),
        "network": network::info(),
        "thunderbolt": thunderbolt::info(),
        "sharing": sharing::summary(),
        "ssh": { "enabled": ssh::enabled() },
        "dashboard": {
            "order": set.dashboard_order,
            "hidden": set.dashboard_hidden,
        },
        // Colour theme; empty/unset means dark (theme.js falls back the same way).
        "theme": if set.theme.is_empty() { "dark".to_string() } else { set.theme.clone() },
        // No active FygoOS session yet — the account chip shows "Sign in".
        "session": Value::Null,
        "system": {
            "cpu_c": deg(cpu),
            "gpu_c": deg(gpu),
            "drives_c": deg(drives),
            "mem_pct": mem,
            "fans": fan_list,
        },
        "battery": {
            "present": bat.present,
            "capacity": bat.capacity,
            "status": bat.status,
            "ac": bat.ac_online,
        },
        "display": {
            "on": disp.on,
            "brightness": disp.brightness,
        },
        // Panel-app (device) settings, persisted by t6-paneld.
        "screen": {
            "timeout_s": set.screen_timeout_s,
            "color_correction": set.color_correction(),
        },
        "language": if set.language.is_empty() { "en".to_string() } else { set.language.clone() },
        "leds": leds,
        "status": status,
    })
}
