//! HTTP surface: the panel UI (static files) and the `/api/panel` aggregate.

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use t6_hw_rs::display::Display;

use crate::gateway::User;

#[derive(Clone)]
pub struct AppState {
    www: Arc<crate::www::Www>,
}

pub fn router(www: crate::www::Www) -> Router {
    let state = AppState { www: Arc::new(www) };
    Router::new()
        .route("/api/panel", get(get_panel))
        .route("/api/session", get(get_session))
        // Screen brightness. Allowed without a login (like a phone's
        // lock-screen brightness); admin-gated writes live on the gateway side.
        .route("/api/display/brightness", put(put_brightness))
        .route("/api/display/power", put(put_power))
        .route("/api/settings/screen-timeout", put(put_screen_timeout))
        .route("/api/settings/dashboard", put(put_dashboard))
        .route("/api/settings/language", put(put_language))
        .route("/api/hwinfo", get(get_hwinfo))
        .route("/api/leds/night", put(put_led_night))
        .route("/api/power/shutdown", axum::routing::post(post_shutdown))
        .route("/api/power/restart", axum::routing::post(post_restart))
        .route("/", get(index))
        .route("/{file}", get(static_file))
        .with_state(state)
}

/// The signed-in user as a JSON value (null when logged out / no gateway).
/// Only the gateway surface carries `X-Trim-*` headers, so the local TCP
/// shell always resolves to null here.
fn session_value(headers: &HeaderMap) -> Value {
    let u = User::from_headers(headers);
    match &u.username {
        Some(name) => serde_json::json!({ "username": name, "uid": u.uid, "is_admin": u.is_admin }),
        None => Value::Null,
    }
}

async fn get_panel(headers: HeaderMap) -> Json<Value> {
    let mut v = crate::panel::build();
    v["session"] = session_value(&headers);
    Json(v)
}

async fn get_session(headers: HeaderMap) -> Json<Value> {
    Json(session_value(&headers))
}

#[derive(Deserialize)]
struct BrightnessReq {
    /// 10..=100 (below 10 the panel is unreadable; 0 is "power off").
    value: u32,
}

async fn put_brightness(Json(req): Json<BrightnessReq>) -> Response {
    match Display::new().set_brightness(req.value) {
        Ok(v) => Json(serde_json::json!({ "brightness": v })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct PowerReq {
    on: bool,
}

async fn put_power(Json(req): Json<PowerReq>) -> Response {
    match Display::new().set_power(req.on) {
        Ok(v) => Json(serde_json::json!({ "brightness": v, "on": req.on })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct TimeoutReq {
    /// Idle seconds before the panel turns its screen off; 0 = never.
    seconds: u32,
}

async fn put_screen_timeout(Json(req): Json<TimeoutReq>) -> Response {
    match crate::settings::set_screen_timeout(req.seconds) {
        Ok(s) => Json(serde_json::json!({ "timeout_s": s.screen_timeout_s })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct DashboardReq {
    order: Vec<String>,
    #[serde(default)]
    hidden: Vec<String>,
}

async fn put_dashboard(Json(req): Json<DashboardReq>) -> Response {
    match crate::settings::set_dashboard(req.order, req.hidden) {
        Ok(s) => Json(serde_json::json!({ "order": s.dashboard_order, "hidden": s.dashboard_hidden })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct LanguageReq {
    code: String,
}

async fn put_language(Json(req): Json<LanguageReq>) -> Response {
    match crate::settings::set_language(req.code) {
        Ok(s) => Json(serde_json::json!({ "language": s.language })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn get_hwinfo() -> Json<t6_hw_rs::hwinfo::HwInfo> {
    Json(t6_hw_rs::hwinfo::info())
}

#[derive(Deserialize)]
struct NightReq {
    on: bool,
}

async fn put_led_night(Json(req): Json<NightReq>) -> Response {
    let cmd = if req.on { "night on" } else { "night off" };
    match t6_hw_rs::leds::Ledd::new().command(cmd) {
        Ok(()) => Json(serde_json::json!({ "night": req.on })).into_response(),
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

async fn post_shutdown() -> Response {
    run_power("poweroff")
}

async fn post_restart() -> Response {
    run_power("reboot")
}

async fn index(State(s): State<AppState>) -> Response {
    serve(&s, "index.html")
}

async fn static_file(State(s): State<AppState>, Path(file): Path<String>) -> Response {
    serve(&s, &file)
}

fn serve(s: &AppState, name: &str) -> Response {
    match s.www.get(name) {
        // The panel UI is live-reloaded during development and republished on
        // the same URL in production, so never let a client cache a stale page.
        Some((ctype, body)) => (
            [(header::CONTENT_TYPE, ctype), (header::CACHE_CONTROL, "no-store")],
            body,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
