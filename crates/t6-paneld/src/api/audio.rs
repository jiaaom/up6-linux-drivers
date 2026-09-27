//! Audio outputs for the panel: the sound server is PipeWire, run system-wide
//! as root by the t6-audio units (see `packaging/fpk/t6-panel/cmd/common`),
//! sharing root's runtime dir with weston and the kiosk. The video player
//! (mpv, `ao=pipewire`) and the kiosk (Chromium, via pipewire-pulse) both play
//! into PipeWire's default output, so choosing an output here means setting
//! that default; WirePlumber remembers it and each output's volume.
//!
//! We drive PipeWire through its own CLI tools rather than a client library:
//! `pw-dump` (JSON graph) to list outputs, `wpctl` to read/set the default and
//! volumes. Volumes are WirePlumber's 0..1 (cubic) scale.
//!
//! - `GET  /api/audio`                 components, services, outputs
//! - `PUT  /api/audio/default`         `{id}` — make an output the default
//! - `PUT  /api/audio/volume`          `{id, volume}` — 0..1
//! - `POST /api/admin/audio/repair`    admin: (re)install packages, restart
use axum::{http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;
use std::sync::Mutex;

const RUNTIME_DIR: &str = "/run/user/0";
/// Same list as the fpk's `AUDIO_PKGS` (cmd/common); bluez is optional
/// (Bluetooth outputs only).
const PACKAGES: [&str; 5] = ["pipewire", "pipewire-pulse", "wireplumber", "libspa-0.2-bluetooth", "pipewire-bin"];
const UNITS: [&str; 3] = ["t6-audio", "t6-audio-session", "t6-audio-pulse"];

fn tool(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .env("XDG_RUNTIME_DIR", RUNTIME_DIR)
        .output()
        .map_err(|e| format!("{cmd}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!("{cmd} {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn pkg_version(pkg: &str) -> Option<String> {
    let out = Command::new("dpkg-query")
        .args(["-W", "-f=${Status}|${Version}", pkg])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let (status, ver) = s.split_once('|')?;
    status.contains("install ok installed").then(|| ver.to_string())
}

fn unit_active(unit: &str) -> bool {
    Command::new("systemctl")
        .args(["is-active", "--quiet", unit])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[derive(Serialize)]
struct Output {
    id: u64,
    /// What the user sees: the monitor's name for HDMI (ELD), the product
    /// name for USB/Bluetooth.
    name: String,
    /// usb | hdmi | bluetooth | other
    kind: &'static str,
    default: bool,
    volume: Option<f64>,
    muted: bool,
}

/// "Volume: 0.40 [MUTED]" → (0.40, true)
fn parse_volume(s: &str) -> Option<(f64, bool)> {
    let rest = s.trim().strip_prefix("Volume:")?.trim();
    let v = rest.split_whitespace().next()?.parse().ok()?;
    Some((v, rest.contains("[MUTED]")))
}

/// "id 39, type PipeWire:Interface:Node" → 39
fn default_sink() -> Option<u64> {
    let s = tool("wpctl", &["inspect", "@DEFAULT_AUDIO_SINK@"]).ok()?;
    s.lines().next()?.strip_prefix("id ")?.split(',').next()?.trim().parse().ok()
}

fn outputs() -> Result<Vec<Output>, String> {
    let dump: Vec<Value> = serde_json::from_str(&tool("pw-dump", &[])?).map_err(|e| format!("pw-dump: {e}"))?;
    let props = |o: &Value| o.pointer("/info/props").cloned().unwrap_or(Value::Null);
    let devices: std::collections::HashMap<u64, Value> = dump
        .iter()
        .filter(|o| o["type"] == "PipeWire:Interface:Device")
        .filter_map(|o| Some((o["id"].as_u64()?, props(o))))
        .collect();
    let default = default_sink();
    let mut out = Vec::new();
    for o in dump.iter().filter(|o| o["type"] == "PipeWire:Interface:Node") {
        let p = props(o);
        if p["media.class"] != "Audio/Sink" {
            continue;
        }
        let Some(id) = o["id"].as_u64() else { continue };
        // WirePlumber's stand-in when there is no real output ("Dummy
        // Output"): it keeps the player's clock running (the T6 has no
        // speaker), but there is nothing to choose.
        if p["node.name"] == "auto_null" {
            continue;
        }
        let dev = p["device.id"].as_u64().and_then(|d| devices.get(&d)).cloned().unwrap_or(Value::Null);
        let node_name = p["node.name"].as_str().unwrap_or("");
        let kind = if p["device.api"] == "bluez5" {
            "bluetooth"
        } else if node_name.contains(".hdmi-") {
            "hdmi"
        } else if dev["device.bus"] == "usb" {
            "usb"
        } else {
            "other"
        };
        // HDMI nodes carry the monitor's name (from its EDID) as node.nick.
        let name = [&p["node.nick"], &dev["device.description"], &p["node.description"]]
            .iter()
            .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
            .unwrap_or(node_name)
            .to_string();
        let (volume, muted) = match tool("wpctl", &["get-volume", &id.to_string()]).ok().as_deref().and_then(parse_volume) {
            Some((v, m)) => (Some(v), m),
            None => (None, false),
        };
        out.push(Output { id, name, kind, default: default == Some(id), volume, muted });
    }
    // Stable order: USB, HDMI, Bluetooth, other; then by name.
    let rank = |k: &str| ["usb", "hdmi", "bluetooth", "other"].iter().position(|x| *x == k).unwrap_or(9);
    out.sort_by(|a, b| rank(a.kind).cmp(&rank(b.kind)).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// The PipeWire output of a Bluetooth device (by its address, as WirePlumber
/// labels bluez nodes), if it has one yet.
fn bluez_sink(address: &str) -> Option<u64> {
    let dump: Vec<Value> = serde_json::from_str(&tool("pw-dump", &[]).ok()?).ok()?;
    dump.iter()
        .filter(|o| o["type"] == "PipeWire:Interface:Node")
        .find(|o| {
            let p = &o["info"]["props"];
            p["media.class"] == "Audio/Sink"
                && p["api.bluez5.address"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(address))
        })
        .and_then(|o| o["id"].as_u64())
}

/// Make a Bluetooth device the default output, waiting up to `wait` for
/// WirePlumber to create its output after the connection (a few seconds).
/// Blocking; call from spawn_blocking. Returns whether it was switched.
pub(super) fn use_bluetooth_output(address: &str, wait: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + wait;
    loop {
        if let Some(id) = bluez_sink(address) {
            return tool("wpctl", &["set-default", &id.to_string()]).is_ok();
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Result of the last admin repair, reported by `GET /api/audio`.
static REPAIR: Mutex<Option<(String, String)>> = Mutex::new(None); // (state, message)

pub(super) async fn get_audio() -> Response {
    let body = tokio::task::spawn_blocking(|| {
        let components: serde_json::Map<String, Value> = PACKAGES
            .iter()
            .chain(["bluez"].iter())
            .map(|p| (p.to_string(), pkg_version(p).map(Value::String).unwrap_or(Value::Null)))
            .collect();
        let services: serde_json::Map<String, Value> =
            UNITS.iter().chain(["bluetooth"].iter()).map(|u| (u.to_string(), Value::Bool(unit_active(u)))).collect();
        let running = UNITS.iter().all(|u| unit_active(u));
        let (outputs, error) = if running {
            match outputs() {
                Ok(o) => (o, None),
                Err(e) => (Vec::new(), Some(e)),
            }
        } else {
            (Vec::new(), None)
        };
        let repair = REPAIR.lock().unwrap().clone().map(|(state, message)| serde_json::json!({ "state": state, "message": message }));
        serde_json::json!({
            "running": running,
            "components": components,
            "pulseaudio": pkg_version("pulseaudio").is_some(),
            "services": services,
            "outputs": outputs,
            "error": error,
            "repair": repair,
        })
    })
    .await;
    match body {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct DefaultReq {
    id: u64,
}

pub(super) async fn put_default(Json(req): Json<DefaultReq>) -> Response {
    let r = tokio::task::spawn_blocking(move || tool("wpctl", &["set-default", &req.id.to_string()])).await;
    match r {
        Ok(Ok(_)) => Json(serde_json::json!({ "id": req.id })).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct VolumeReq {
    id: u64,
    volume: f64,
}

pub(super) async fn put_volume(Json(req): Json<VolumeReq>) -> Response {
    let v = req.volume.clamp(0.0, 1.0);
    let r = tokio::task::spawn_blocking(move || tool("wpctl", &["set-volume", &req.id.to_string(), &format!("{v:.3}")])).await;
    match r {
        Ok(Ok(_)) => Json(serde_json::json!({ "id": req.id, "volume": v })).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Admin: reinstall the audio packages (from bookworm-backports, like the
/// fpk's install check) and restart the sound server. Runs in the background;
/// `GET /api/audio` reports `repair.state` = running | ok | failed.
/// Refuses next to PulseAudio (see the fpk's check_audio).
pub(super) async fn post_repair(headers: HeaderMap) -> Response {
    if !super::admin::is_admin(&headers) {
        return super::admin::forbidden();
    }
    if pkg_version("pulseaudio").is_some() {
        return (StatusCode::CONFLICT, "PulseAudio is installed; uninstall the app that installed it first").into_response();
    }
    {
        let mut st = REPAIR.lock().unwrap();
        if st.as_ref().is_some_and(|(s, _)| s == "running") {
            return (StatusCode::CONFLICT, "a repair is already running").into_response();
        }
        *st = Some(("running".into(), String::new()));
    }
    tokio::task::spawn_blocking(|| {
        let result = repair();
        *REPAIR.lock().unwrap() = Some(match result {
            Ok(()) => ("ok".into(), String::new()),
            Err(e) => ("failed".into(), e),
        });
    });
    (StatusCode::ACCEPTED, Json(serde_json::json!({ "state": "running" }))).into_response()
}

fn repair() -> Result<(), String> {
    let apt = |args: &[&str]| -> Result<(), String> {
        let out = Command::new("apt-get")
            .args(["-q", "-o", "DPkg::Lock::Timeout=120"])
            .args(args)
            .env("DEBIAN_FRONTEND", "noninteractive")
            .output()
            .map_err(|e| format!("apt-get: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(err.lines().filter(|l| l.starts_with("E:")).last().unwrap_or("apt-get failed").to_string())
        }
    };
    let mut install = vec!["-y", "--no-install-recommends", "-t", "bookworm-backports", "install"];
    install.extend(PACKAGES);
    if apt(&install).is_err() {
        // Stale package lists are the usual cause; refresh once and retry.
        apt(&["update"])?;
        apt(&install)?;
    }
    let mut restart = vec!["restart"];
    restart.extend(UNITS.iter().map(|u| *u));
    let out = Command::new("systemctl").args(&restart).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("restarting the sound server failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_volume;

    #[test]
    fn volume_line() {
        assert_eq!(parse_volume("Volume: 0.40\n"), Some((0.40, false)));
        assert_eq!(parse_volume("Volume: 0.15 [MUTED]"), Some((0.15, true)));
        assert_eq!(parse_volume("nonsense"), None);
    }
}
