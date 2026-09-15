//! HTTP surface: the panel UI (static files) and the `/api/panel` aggregate.

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post, put},
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
    /// TCP port of the local no-login shell, so the authenticated (gateway)
    /// surface knows where "sign out" returns to. `None` on the shell itself.
    shell_port: Option<u16>,
}

/// Build the router with every route under `prefix`.
///
/// The local TCP shell uses an empty prefix (bare `/`, `/api/...`). The gateway
/// surface uses the app's gatewayPrefix (e.g. `/app/t6panel`): FygoOS forwards
/// the *unstripped* path, so routes must live under it, and `prefix` (no
/// trailing slash) redirects to `prefix/` so the page's relative asset/API
/// URLs resolve against the right base.
pub fn router(www: crate::www::Www, prefix: &str, shell_port: Option<u16>) -> Router {
    let state = AppState { www: Arc::new(www), shell_port };
    let p = |s: &str| format!("{prefix}{s}");
    let mut r = Router::new()
        .route(&p("/api/panel"), get(get_panel))
        .route(&p("/api/session"), get(get_session))
        // Screen brightness. Allowed without a login (like a phone's
        // lock-screen brightness); admin-gated writes live on the gateway side.
        .route(&p("/api/display/brightness"), put(put_brightness))
        .route(&p("/api/display/power"), put(put_power))
        .route(&p("/api/settings/screen-timeout"), put(put_screen_timeout))
        .route(&p("/api/settings/dashboard"), put(put_dashboard))
        .route(&p("/api/settings/language"), put(put_language))
        .route(&p("/api/hwinfo"), get(get_hwinfo))
        .route(&p("/api/leds/night"), put(put_led_night))
        .route(&p("/api/power/shutdown"), post(post_shutdown))
        .route(&p("/api/power/restart"), post(post_restart))
        // Wi-Fi config. Not login-gated: joining a network is a physical-access
        // device action (and the bootstrap path before the box is reachable
        // over the web UI). Ethernet stays read-only (fnOS owns the OVS bridge).
        .route(&p("/api/network/wifi/scan"), get(get_wifi_scan))
        .route(&p("/api/network/wifi/connect"), post(post_wifi_connect))
        .route(&p("/api/network/wifi/disconnect"), post(post_wifi_disconnect))
        .route(&p("/api/network/wifi/forget"), post(post_wifi_forget))
        .route(&p("/api/network/wifi/radio"), put(put_wifi_radio))
        // Ethernet (wired) IPv4 config — DHCP/static + DNS on the OVS/wired
        // connection. Not login-gated (same physical-access model as Wi-Fi).
        .route(&p("/api/network/ethernet"), get(get_ethernet))
        .route(&p("/api/network/ethernet"), post(post_ethernet))
        .route(&p("/"), get(index))
        .route(&p("/{file}"), get(static_file));
    if !prefix.is_empty() {
        let slash = format!("{prefix}/");
        r = r.route(prefix, get(move || async move { Redirect::permanent(&slash) }));
    }
    r.with_state(state)
}

/// The signed-in user as a JSON value (null when logged out / no gateway).
/// Only the gateway surface carries `X-Trim-*` headers, so the local TCP
/// shell always resolves to null here.
fn session_value(headers: &HeaderMap, shell_port: Option<u16>) -> Value {
    let u = User::from_headers(headers);
    match &u.username {
        Some(name) => serde_json::json!({
            "username": name, "uid": u.uid, "is_admin": u.is_admin, "shell_port": shell_port,
        }),
        None => Value::Null,
    }
}

async fn get_panel(State(s): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let mut v = crate::panel::build();
    v["session"] = session_value(&headers, s.shell_port);
    Json(v)
}

async fn get_session(State(s): State<AppState>, headers: HeaderMap) -> Json<Value> {
    Json(session_value(&headers, s.shell_port))
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

// ---- Wi-Fi config --------------------------------------------------------

/// Map a `Result<T, String>` from the network layer to a JSON/400 response.
fn net_result<T: serde::Serialize>(r: Result<T, String>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct ScanQuery {
    /// Force a fresh radio scan rather than NetworkManager's cached list.
    #[serde(default)]
    rescan: bool,
}

async fn get_wifi_scan(Query(q): Query<ScanQuery>) -> Response {
    net_result(t6_hw_rs::network::scan(q.rescan))
}

#[derive(Deserialize)]
struct WifiConnectReq {
    ssid: String,
    /// Omitted/empty for an open network or to reuse a saved profile.
    #[serde(default)]
    password: Option<String>,
}

async fn post_wifi_connect(Json(req): Json<WifiConnectReq>) -> Response {
    let pw = req.password.as_deref().filter(|s| !s.is_empty());
    match t6_hw_rs::network::connect(&req.ssid, pw) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "ssid": req.ssid })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn post_wifi_disconnect() -> Response {
    match t6_hw_rs::network::disconnect() {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct WifiForgetReq {
    ssid: String,
}

async fn post_wifi_forget(Json(req): Json<WifiForgetReq>) -> Response {
    match t6_hw_rs::network::forget(&req.ssid) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "ssid": req.ssid })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct WifiRadioReq {
    on: bool,
}

async fn put_wifi_radio(Json(req): Json<WifiRadioReq>) -> Response {
    match t6_hw_rs::network::set_radio(req.on) {
        Ok(()) => Json(serde_json::json!({ "on": req.on })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// ---- Ethernet (wired) config ---------------------------------------------

async fn get_ethernet() -> Response {
    Json(t6_hw_rs::network::eth_config()).into_response()
}

#[derive(Deserialize)]
struct EthReq {
    /// "auto" (DHCP) or "manual" (static).
    method: String,
    /// Static address as CIDR (e.g. "10.0.0.5/24"); required when manual.
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    gateway: Option<String>,
    /// DNS servers; a non-empty list overrides DHCP-leased ones too.
    #[serde(default)]
    dns: Vec<String>,
}

async fn post_ethernet(Json(req): Json<EthReq>) -> Response {
    let addr = req.address.as_deref().filter(|s| !s.is_empty());
    let gw = req.gateway.as_deref().filter(|s| !s.is_empty());
    match t6_hw_rs::network::eth_set(&req.method, addr, gw, &req.dns) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
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
