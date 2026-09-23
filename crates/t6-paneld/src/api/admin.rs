//! Admin endpoints behind the package's web page (`panel/web`, served at
//! `/app/t6-panel/admin/`): turn the on-device kiosk on/off and restart it.
//! Mounted on the gateway surface only, and every handler also checks the
//! gateway-asserted admin flag, so the local no-login shell can't reach them.
//! Brightness, screen power and colour correction reuse the existing
//! `/api/display/*` and `/api/settings/color-correction` routes.

use axum::{http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use serde::Deserialize;
use std::process::Command;
use t6_hw_rs::display::Display;

use crate::gateway::User;

pub(crate) const KIOSK_UNIT: &str = "t6-panel-kiosk.service";

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "administrator sign-in required").into_response()
}

fn is_admin(h: &HeaderMap) -> bool {
    let u = User::from_headers(h);
    u.username.is_some() && u.is_admin
}

fn kiosk_active() -> bool {
    Command::new("systemctl").args(["is-active", "--quiet", KIOSK_UNIT]).status().map(|s| s.success()).unwrap_or(false)
}

fn systemctl(args: &[&str]) -> Result<(), String> {
    let out = Command::new("systemctl").args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("systemctl {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

pub(super) async fn get_status(headers: HeaderMap) -> Response {
    if !is_admin(&headers) {
        return forbidden();
    }
    let set = crate::settings::load();
    let disp = Display::new().info();
    Json(serde_json::json!({
        "panel": { "enabled": set.panel_enabled(), "active": kiosk_active() },
        "display": { "present": disp.present, "on": disp.on, "brightness": disp.brightness, "on_level": disp.on_level, "min_on": disp.min_on },
        "color_correction": set.color_correction(),
        "version": crate::panel::app_version(),
        "host": t6_hw_rs::sensors::hostname(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(super) struct PanelReq {
    enabled: bool,
}

/// Off = stop + disable the kiosk unit and switch the backlight off; on =
/// backlight on, enable + start. The choice is persisted first so the
/// package scripts honour it on the next start/upgrade/boot.
pub(super) async fn put_panel(headers: HeaderMap, Json(req): Json<PanelReq>) -> Response {
    if !is_admin(&headers) {
        return forbidden();
    }
    if let Err(e) = crate::settings::set_panel_enabled(req.enabled) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    let res = if req.enabled {
        let _ = Display::new().set_power(true);
        systemctl(&["enable", "--now", KIOSK_UNIT])
    } else {
        let r = systemctl(&["disable", "--now", KIOSK_UNIT]);
        // Electron exits with SIGTRAP on SIGTERM, so a clean stop reads as
        // "failed"; clear that (a real crash still restarts via on-failure).
        let _ = systemctl(&["reset-failed", KIOSK_UNIT]);
        let _ = Display::new().set_power(false);
        r
    };
    match res {
        Ok(()) => Json(serde_json::json!({ "enabled": req.enabled, "active": kiosk_active() })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) async fn post_restart(headers: HeaderMap) -> Response {
    if !is_admin(&headers) {
        return forbidden();
    }
    if !crate::settings::load().panel_enabled() {
        return (StatusCode::CONFLICT, "the panel app is turned off").into_response();
    }
    match systemctl(&["restart", "--no-block", KIOSK_UNIT]) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}
