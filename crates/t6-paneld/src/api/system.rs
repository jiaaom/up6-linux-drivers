//! Device-level endpoints: the `/api/panel` aggregate, display, settings,
//! LEDs, SSH, fans, power, plus the local read-only storage/sharing/firmware
//! views. None of these need an fnOS login — physical access to the panel is
//! the authorization.

use axum::{extract::State, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use serde::Deserialize;
use serde_json::Value;
use t6_hw_rs::display::Display;

use super::{session_value, AppState};

/// Local resource monitor snapshot (see t6_hw_rs::sysmon). Deltas need two
/// calls; the System page polls every ~2 s.
pub(super) async fn get_sysmon() -> Json<Value> { Json(t6_hw_rs::sysmon::snapshot()) }

pub(super) async fn get_panel(State(s): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let mut v = crate::panel::build();
    v["session"] = session_value(&headers, s.shell_port);
    Json(v)
}

pub(super) async fn get_session(State(s): State<AppState>, headers: HeaderMap) -> Json<Value> {
    Json(session_value(&headers, s.shell_port))
}

#[derive(Deserialize)]
pub(super) struct BrightnessReq {
    /// 10..=100 (below 10 the panel is unreadable; 0 is "power off").
    value: u32,
}

pub(super) async fn put_brightness(Json(req): Json<BrightnessReq>) -> Response {
    let result = tokio::task::spawn_blocking(move || Display::new().set_brightness(req.value))
        .await.unwrap_or_else(|e| Err(format!("display worker failed: {e}")));
    match result {
        Ok(v) => Json(serde_json::json!({ "brightness": v })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct PowerReq {
    on: bool,
}

pub(super) async fn put_power(Json(req): Json<PowerReq>) -> Response {
    let result = tokio::task::spawn_blocking(move || Display::new().set_power(req.on))
        .await.unwrap_or_else(|e| Err(format!("display worker failed: {e}")));
    match result {
        Ok(v) => Json(serde_json::json!({ "brightness": v, "on": req.on })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

/// Server-sent events: `{"on":bool}` now and on every change of the screen
/// state, whoever switched it.
pub(super) async fn display_events() -> axum::response::sse::Sse<impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    let rx = crate::backlight::subscribe();
    let stream = futures_util::stream::unfold((rx, true), |(mut rx, first)| async move {
        if !first && rx.changed().await.is_err() {
            return None;
        }
        let on = *rx.borrow_and_update();
        Some((Ok(Event::default().data(serde_json::json!({ "on": on }).to_string())), (rx, false)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[derive(Deserialize)]
pub(super) struct TimeoutReq {
    /// Idle seconds before the panel turns its screen off; 0 = never.
    seconds: u32,
}

pub(super) async fn put_screen_timeout(Json(req): Json<TimeoutReq>) -> Response {
    match crate::settings::set_screen_timeout(req.seconds) {
        Ok(s) => {
            crate::idle::settings_changed();
            Json(serde_json::json!({ "timeout_s": s.screen_timeout_s })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct DashboardReq {
    order: Vec<String>,
    #[serde(default)]
    hidden: Vec<String>,
}

pub(super) async fn put_dashboard(Json(req): Json<DashboardReq>) -> Response {
    match crate::settings::set_dashboard(req.order, req.hidden) {
        Ok(s) => Json(serde_json::json!({ "order": s.dashboard_order, "hidden": s.dashboard_hidden })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct LanguageReq {
    code: String,
}

pub(super) async fn put_language(Json(req): Json<LanguageReq>) -> Response {
    match crate::settings::set_language(req.code) {
        Ok(s) => Json(serde_json::json!({ "language": s.language })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct ThemeReq {
    theme: String,
}

pub(super) async fn put_theme(Json(req): Json<ThemeReq>) -> Response {
    match crate::settings::set_theme(req.theme) {
        Ok(s) => Json(serde_json::json!({ "theme": s.theme })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct ColorCorrectionReq {
    on: bool,
}

/// The range is a DRM property that only the DRM master can set, and weston
/// holds master while it runs, so a change takes effect by restarting the
/// kiosk unit (run-kiosk.sh applies it before weston starts). The restart is
/// deferred a moment so this response still reaches the (dying) renderer.
pub(super) async fn put_color_correction(Json(req): Json<ColorCorrectionReq>) -> Response {
    match crate::settings::set_color_correction(req.on) {
        Ok(s) => {
            // Only when the panel app is on: restarting would start a stopped kiosk.
            if s.panel_enabled() {
                tokio::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                    let _ = std::process::Command::new("systemctl").args(["restart", "--no-block", super::admin::KIOSK_UNIT]).status();
                });
            }
            Json(serde_json::json!({ "color_correction": s.color_correction() })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) async fn get_hwinfo() -> Json<t6_hw_rs::hwinfo::HwInfo> {
    Json(t6_hw_rs::hwinfo::info())
}

#[derive(Deserialize)]
pub(super) struct NightReq {
    on: bool,
}

pub(super) async fn put_led_night(Json(req): Json<NightReq>) -> Response {
    let cmd = if req.on { "night on" } else { "night off" };
    match t6_hw_rs::leds::Ledd::new().command(cmd) {
        Ok(()) => Json(serde_json::json!({ "night": req.on })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub(super) async fn put_ssh(Json(req): Json<NightReq>) -> Response {
    match t6_hw_rs::ssh::set(req.on) {
        Ok(()) => Json(serde_json::json!({ "enabled": req.on })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

pub(super) async fn get_fan() -> Response {
    Json(serde_json::json!({
        "profile": t6_hw_rs::fans::profile(),
        "profiles": t6_hw_rs::fans::profiles(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(super) struct FanReq {
    profile: String,
}

pub(super) async fn put_fan(Json(req): Json<FanReq>) -> Response {
    match t6_hw_rs::fans::set_profile(&req.profile) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "profile": req.profile })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

/// Reboot / power off via systemd. The panel confirms first (physical access
/// already implies power control, so these are not login-gated).
fn run_power(action: &str) -> Response {
    match std::process::Command::new("systemctl").arg(action).spawn() {
        Ok(_) => Json(serde_json::json!({ "ok": true, "action": action })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub(super) async fn post_shutdown() -> Response {
    run_power("poweroff")
}

pub(super) async fn post_restart() -> Response {
    run_power("reboot")
}

// ---- Local read-only views (no fnOS login) -------------------------------

pub(super) async fn get_sharing() -> Response {
    Json(t6_hw_rs::sharing::info()).into_response()
}

/// Volumes + physical-disk inventory (local, read-only) for the Volumes detail page.
pub(super) async fn get_storage() -> Response {
    Json(serde_json::json!({
        "volumes": t6_hw_rs::storage::volumes(),
        "disks": t6_hw_rs::storage::disks(),
    })).into_response()
}

/// Firmware-update check (show-only). Hits the public FygoOS update manifest, so
/// it blocks on a network round-trip — run it off the hot poll path.
pub(super) async fn get_firmware() -> Response {
    match tokio::task::spawn_blocking(crate::firmware::status).await {
        Ok(fw) => Json(fw).into_response(),
        Err(_) => Json(crate::firmware::Firmware::default()).into_response(),
    }
}
