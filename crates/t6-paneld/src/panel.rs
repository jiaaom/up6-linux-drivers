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

pub fn build() -> Value {
    let bat = Battery::new().info();
    let disp = Display::new().info();
    let set = crate::settings::load();
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
        "storage": storage::volumes(),
        "net": net::counters(),
        "network": network::info(),
        "thunderbolt": thunderbolt::info(),
        "sharing": sharing::summary(),
        "ssh": { "enabled": ssh::enabled() },
        "dashboard": {
            "order": set.dashboard_order,
            "hidden": set.dashboard_hidden,
        },
        // No active FygoOS session yet — the account chip shows "Sign in".
        "session": Value::Null,
        "system": {
            "cpu_c": deg(sensors::cpu_temp_c()),
            "gpu_c": deg(sensors::gpu_temp_c()),
            "drives_c": deg(sensors::drives_temp_c()),
            "mem_pct": sensors::mem_used_pct(),
            "fans": fans::fans(),
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
            "on_level": disp.on_level,
        },
        // Panel-app (device) settings, persisted by t6-paneld.
        "screen": {
            "timeout_s": set.screen_timeout_s,
        },
        "language": if set.language.is_empty() { "en".to_string() } else { set.language.clone() },
        "leds": leds,
        "status": { "level": "ok", "text": "All systems normal" },
    })
}
