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
        "display": { "present": disp.present, "on": disp.on },
        // Front-panel theme; empty/unset means dark (as in /api/panel).
        "theme": if set.theme.is_empty() { "dark".to_string() } else { set.theme.clone() },
        "color_correction": set.color_correction(),
        "screen_timeout_s": set.screen_timeout_s,
        "version": crate::panel::app_version(),
        "host": t6_hw_rs::sensors::hostname(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(super) struct PanelReq {
    enabled: bool,
}

/// Sleep before stopping the video source; start it before waking the panel.
/// The choice is persisted first so package scripts honour it on the next
/// start/upgrade/boot. Failed power transitions are reported, never hidden.
pub(super) async fn put_panel(headers: HeaderMap, Json(req): Json<PanelReq>) -> Response {
    if !is_admin(&headers) {
        return forbidden();
    }
    let res = tokio::task::spawn_blocking(move || {
        crate::settings::set_panel_enabled(req.enabled)?;
        if req.enabled {
            systemctl(&["enable", "--now", KIOSK_UNIT])?;
            Display::new().set_power(true)?;
        } else {
            let power = Display::new().set_power(false);
            let stop = systemctl(&["disable", "--now", KIOSK_UNIT]);
            // Electron exits with SIGTRAP on SIGTERM; clear the resulting
            // failed state, but still report any stop or display failure.
            let _ = systemctl(&["reset-failed", KIOSK_UNIT]);
            match (power, stop) {
                (Err(power), Err(stop)) => return Err(format!("{power}; {stop}")),
                (Err(e), _) | (_, Err(e)) => return Err(e),
                (Ok(_), Ok(())) => {}
            }
        }
        Ok(kiosk_active())
    }).await.unwrap_or_else(|e| Err(format!("panel worker failed: {e}")));
    crate::idle::settings_changed();
    match res {
        Ok(active) => Json(serde_json::json!({ "enabled": req.enabled, "active": active })).into_response(),
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
