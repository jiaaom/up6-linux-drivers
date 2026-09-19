//! Network endpoints: Wi-Fi (scan/join/forget/radio/profile), wired IPv4,
//! hotspot, and Thunderbolt (status, device authorization, TB-net IPv4).
//! Not login-gated: joining a network is a physical-access device action and
//! the bootstrap path before the box is reachable over the web UI.

use axum::{extract::Query, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;

// ---- Wi-Fi config --------------------------------------------------------

/// Map a `Result<T, String>` from the network layer to a JSON/400 response.
fn net_result<T: serde::Serialize>(r: Result<T, String>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct ScanQuery {
    /// Force a fresh radio scan rather than NetworkManager's cached list.
    #[serde(default)]
    rescan: bool,
}

pub(super) async fn get_wifi_scan(Query(q): Query<ScanQuery>) -> Response {
    net_result(t6_hw_rs::network::scan(q.rescan))
}

#[derive(Deserialize)]
pub(super) struct WifiConnectReq {
    ssid: String,
    /// Omitted/empty for an open network or to reuse a saved profile.
    #[serde(default)]
    password: Option<String>,
}

pub(super) async fn post_wifi_connect(Json(req): Json<WifiConnectReq>) -> Response {
    let pw = req.password.as_deref().filter(|s| !s.is_empty());
    match t6_hw_rs::network::connect(&req.ssid, pw) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "ssid": req.ssid })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub(super) async fn post_wifi_disconnect() -> Response {
    match t6_hw_rs::network::disconnect() {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct WifiForgetReq {
    ssid: String,
}

pub(super) async fn post_wifi_forget(Json(req): Json<WifiForgetReq>) -> Response {
    match t6_hw_rs::network::forget(&req.ssid) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "ssid": req.ssid })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct WifiRadioReq {
    on: bool,
}

pub(super) async fn put_wifi_radio(Json(req): Json<WifiRadioReq>) -> Response {
    match t6_hw_rs::network::set_radio(req.on) {
        Ok(()) => Json(serde_json::json!({ "on": req.on })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct WifiProfileQ {
    ssid: String,
}

/// Read a saved network's auto-join state (for the Wi-Fi network-detail page).
pub(super) async fn get_wifi_profile(Query(q): Query<WifiProfileQ>) -> Response {
    match t6_hw_rs::network::autojoin(&q.ssid) {
        Ok(a) => Json(serde_json::json!({ "ssid": q.ssid, "autoconnect": a })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct WifiProfileReq {
    ssid: String,
    autoconnect: bool,
}

pub(super) async fn put_wifi_profile(Json(req): Json<WifiProfileReq>) -> Response {
    match t6_hw_rs::network::set_autojoin(&req.ssid, req.autoconnect) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "autoconnect": req.autoconnect })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// ---- Ethernet (wired) config ---------------------------------------------

pub(super) async fn get_ethernet() -> Response {
    Json(t6_hw_rs::network::eth_config()).into_response()
}

#[derive(Deserialize)]
pub(super) struct EthReq {
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

pub(super) async fn post_ethernet(Json(req): Json<EthReq>) -> Response {
    let addr = req.address.as_deref().filter(|s| !s.is_empty());
    let gw = req.gateway.as_deref().filter(|s| !s.is_empty());
    match t6_hw_rs::network::eth_set(&req.method, addr, gw, &req.dns) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// ---- Wi-Fi hotspot -------------------------------------------------------

pub(super) async fn get_hotspot() -> Response {
    Json(t6_hw_rs::network::hotspot_status()).into_response()
}

#[derive(Deserialize)]
pub(super) struct HotspotReq {
    /// true = start (needs ssid + password), false = stop.
    enabled: bool,
    #[serde(default)]
    ssid: String,
    #[serde(default)]
    password: String,
    /// "a" (5 GHz) or "bg"/anything (2.4 GHz).
    #[serde(default)]
    band: String,
}

pub(super) async fn post_hotspot(Json(req): Json<HotspotReq>) -> Response {
    let r = if req.enabled {
        t6_hw_rs::network::hotspot_start(&req.ssid, &req.password, &req.band)
    } else {
        t6_hw_rs::network::hotspot_stop()
    };
    match r {
        Ok(()) => Json(serde_json::json!({ "ok": true, "enabled": req.enabled })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// ---- Thunderbolt ---------------------------------------------------------

pub(super) async fn get_thunderbolt() -> Response {
    Json(t6_hw_rs::thunderbolt::info_full()).into_response()
}

#[derive(Deserialize)]
pub(super) struct TbDeviceReq {
    /// "authorize" | "enroll" | "forget".
    action: String,
    uuid: String,
}

pub(super) async fn post_tb_device(Json(req): Json<TbDeviceReq>) -> Response {
    let r = match req.action.as_str() {
        "authorize" => t6_hw_rs::thunderbolt::authorize(&req.uuid),
        "enroll" => t6_hw_rs::thunderbolt::enroll(&req.uuid),
        "forget" => t6_hw_rs::thunderbolt::forget(&req.uuid),
        other => Err(format!("unknown action {other:?}")),
    };
    match r {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct TbNetQuery {
    /// NM connection name of the TB net interface.
    conn: String,
}

pub(super) async fn get_tb_net(Query(q): Query<TbNetQuery>) -> Response {
    Json(t6_hw_rs::network::ipv4_config(&q.conn)).into_response()
}

#[derive(Deserialize)]
pub(super) struct TbNetSetReq {
    conn: String,
    method: String,
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    gateway: Option<String>,
    #[serde(default)]
    dns: Vec<String>,
}

pub(super) async fn post_tb_net(Json(req): Json<TbNetSetReq>) -> Response {
    let addr = req.address.as_deref().filter(|s| !s.is_empty());
    let gw = req.gateway.as_deref().filter(|s| !s.is_empty());
    match t6_hw_rs::network::set_conn_ipv4(&req.conn, &req.method, addr, gw, &req.dns) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
