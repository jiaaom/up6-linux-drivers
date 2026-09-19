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
        // Local resource monitor (CPU/mem/GPU/NPU/disks/procs) — sysfs+procfs, no login.
        .route(&p("/api/sysmon"), get(get_sysmon))
        .route(&p("/api/leds/night"), put(put_led_night))
        .route(&p("/api/settings/ssh"), put(put_ssh))
        // Fan profile (silent/balance/performance/custom). Device-level, no login.
        .route(&p("/api/fan"), get(get_fan))
        .route(&p("/api/fan"), put(put_fan))
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
        .route(&p("/api/network/wifi/profile"), get(get_wifi_profile))
        .route(&p("/api/network/wifi/profile"), put(put_wifi_profile))
        // Ethernet (wired) IPv4 config — DHCP/static + DNS on the OVS/wired
        // connection. Not login-gated (same physical-access model as Wi-Fi).
        .route(&p("/api/network/ethernet"), get(get_ethernet))
        .route(&p("/api/network/ethernet"), post(post_ethernet))
        // Wi-Fi hotspot (AP mode). Not login-gated (physical-access model).
        .route(&p("/api/network/hotspot"), get(get_hotspot))
        .route(&p("/api/network/hotspot"), post(post_hotspot))
        // Thunderbolt: status + device authorization, and IPv4 config for a
        // host-to-host TB net interface (SMB over TB). Not login-gated.
        .route(&p("/api/thunderbolt"), get(get_thunderbolt))
        .route(&p("/api/thunderbolt/device"), post(post_tb_device))
        .route(&p("/api/thunderbolt/net"), get(get_tb_net))
        .route(&p("/api/thunderbolt/net"), post(post_tb_net))
        // Sharing (SMB/NFS) — read-only status + share list.
        .route(&p("/api/sharing"), get(get_sharing))
        .route(&p("/api/storage"), get(get_storage))
        .route(&p("/api/firmware"), get(get_firmware))
        .route(&p("/api/fnos/login"), post(post_fnos_login))
        .route(&p("/api/fnos/status"), get(get_fnos_status))
        .route(&p("/api/fnos/logout"), post(post_fnos_logout))
        .route(&p("/api/fnos/net"), get(get_fnos_net))
        .route(&p("/api/fnos/files"), get(get_fnos_files))
        .route(&p("/api/fnos/team-files"), get(get_fnos_team_files))
        .route(&p("/api/fnos/trash"), get(get_fnos_trash))
        .route(&p("/api/fnos/favorites"), get(get_fnos_favorites))
        .route(&p("/api/fnos/search"), get(get_fnos_search))
        .route(&p("/api/fnos/recent"), get(get_fnos_recent))
        .route(&p("/api/fnos/health"), get(get_fnos_health))
        // External (USB) drives + remote mounts, via fnOS's own storage/mount managers.
        .route(&p("/api/fnos/externals"), get(get_fnos_externals))
        .route(&p("/api/fnos/disk/eject"), post(post_fnos_disk_eject))
        .route(&p("/api/fnos/disk/mount"), post(post_fnos_disk_mount))
        .route(&p("/api/fnos/remote/connect"), post(post_fnos_remote_connect))
        .route(&p("/api/fnos/remote/disconnect"), post(post_fnos_remote_disconnect))
        // Local (no login): re-enumerate an ejected USB reader so fnOS picks it up again.
        .route(&p("/api/usb/reconnect"), post(post_usb_reconnect))
        .route(&p("/api/fnos/folder-size"), get(get_fnos_folder_size))
        .route(&p("/api/fnos/files/mkdir"), post(post_fnos_mkdir))
        .route(&p("/api/fnos/files/rename"), post(post_fnos_rename))
        .route(&p("/api/fnos/files/fav"), post(post_fnos_fav))
        .route(&p("/api/fnos/files/trash"), post(post_fnos_trash))
        .route(&p("/api/fnos/trash/restore"), post(post_fnos_trash_restore))
        .route(&p("/api/fnos/files/copy"), post(post_fnos_copy))
        .route(&p("/api/fnos/files/move"), post(post_fnos_move))
        .route(&p("/api/fnos/notifications"), get(get_fnos_notifications))
        .route(&p("/api/fnos/notifications/read-all"), post(post_fnos_notifications_read_all))
        .route(&p("/api/fnos/preview-cookie"), get(get_fnos_preview_cookie))
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

/// Local resource monitor snapshot (see t6_hw_rs::sysmon). Deltas need two
/// calls; the System page polls every ~2 s.
async fn get_sysmon() -> Json<Value> { Json(t6_hw_rs::sysmon::snapshot()) }

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

async fn put_ssh(Json(req): Json<NightReq>) -> Response {
    match t6_hw_rs::ssh::set(req.on) {
        Ok(()) => Json(serde_json::json!({ "enabled": req.on })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

async fn get_fan() -> Response {
    Json(serde_json::json!({
        "profile": t6_hw_rs::fans::profile(),
        "profiles": t6_hw_rs::fans::profiles(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct FanReq {
    profile: String,
}

async fn put_fan(Json(req): Json<FanReq>) -> Response {
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

#[derive(Deserialize)]
struct WifiProfileQ {
    ssid: String,
}

/// Read a saved network's auto-join state (for the Wi-Fi network-detail page).
async fn get_wifi_profile(Query(q): Query<WifiProfileQ>) -> Response {
    match t6_hw_rs::network::autojoin(&q.ssid) {
        Ok(a) => Json(serde_json::json!({ "ssid": q.ssid, "autoconnect": a })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct WifiProfileReq {
    ssid: String,
    autoconnect: bool,
}

async fn put_wifi_profile(Json(req): Json<WifiProfileReq>) -> Response {
    match t6_hw_rs::network::set_autojoin(&req.ssid, req.autoconnect) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "autoconnect": req.autoconnect })).into_response(),
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

// ---- Wi-Fi hotspot -------------------------------------------------------

async fn get_hotspot() -> Response {
    Json(t6_hw_rs::network::hotspot_status()).into_response()
}

#[derive(Deserialize)]
struct HotspotReq {
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

async fn post_hotspot(Json(req): Json<HotspotReq>) -> Response {
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

async fn get_thunderbolt() -> Response {
    Json(t6_hw_rs::thunderbolt::info_full()).into_response()
}

async fn get_sharing() -> Response {
    Json(t6_hw_rs::sharing::info()).into_response()
}

/// Volumes + physical-disk inventory (local, read-only) for the Volumes detail page.
async fn get_storage() -> Response {
    Json(serde_json::json!({
        "volumes": t6_hw_rs::storage::volumes(),
        "disks": t6_hw_rs::storage::disks(),
    })).into_response()
}

/// Firmware-update check (show-only). Hits the public FygoOS update manifest, so
/// it blocks on a network round-trip — run it off the hot poll path.
async fn get_firmware() -> Response {
    match tokio::task::spawn_blocking(crate::firmware::status).await {
        Ok(fw) => Json(fw).into_response(),
        Err(_) => Json(crate::firmware::Firmware::default()).into_response(),
    }
}

#[derive(Deserialize)]
struct FnosLogin {
    user: String,
    password: String,
}

/// Sign in to fnOS (native WS client). The password is used transiently for the
/// handshake and never stored; only the resume ticket is persisted.
async fn post_fnos_login(Json(b): Json<FnosLogin>) -> Response {
    match crate::fnos::do_login(&b.user, &b.password).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

async fn get_fnos_status() -> Response {
    Json(crate::fnos::status().await).into_response()
}

async fn post_fnos_logout() -> Response {
    crate::fnos::logout().await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// Proof-of-concept authenticated read: live NIC list via the fnOS API.
async fn get_fnos_net() -> Response {
    match crate::fnos::call("appcgi.network.net.list", serde_json::json!({})).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
struct FilesQ {
    // Omitted (not empty-string) makes `file.ls`/`file.team.lsDir` return the
    // caller's own home dir / team-folder root — see refs/fnos-api-catalog.md.
    path: Option<String>,
}

fn ls_params(path: &Option<String>) -> serde_json::Value {
    match path {
        Some(p) => serde_json::json!({ "path": p }),
        None => serde_json::json!({}),
    }
}

/// Read-only directory listing via the fnOS file API (`file.ls`). Requires sign-in.
/// No `path` = the caller's personal home dir (Personal Folder).
async fn get_fnos_files(Query(q): Query<FilesQ>) -> Response {
    match crate::fnos::call("file.ls", ls_params(&q.path)).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Team Folder listing. The team *root* is NOT `file.team.lsDir` with no path
/// (that returns empty) — the fnOS web client gets it from
/// `appcgi.filestor.getTeamDirList`. Sub-paths list normally via `file.ls`.
/// Result normalized to the browser's `{files:[{name,dir,...}]}` shape.
async fn get_fnos_team_files(Query(q): Query<FilesQ>) -> Response {
    match &q.path {
        Some(p) => match crate::fnos::call("file.ls", serde_json::json!({ "path": p })).await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
        },
        None => match crate::fnos::call("appcgi.filestor.getTeamDirList", serde_json::json!({})).await {
            Ok(v) => {
                // getTeamDirList returns team share dirs; normalize whichever
                // array key it uses into {files:[{name,path,dir:1}]}.
                let arr = v.get("teamDirList")
                    .or_else(|| v.get("list"))
                    .or_else(|| v.get("dirs"))
                    .or_else(|| v.get("teamDir"))
                    .and_then(|a| a.as_array())
                    .cloned()
                    .unwrap_or_default();
                let files: Vec<serde_json::Value> = arr.into_iter().map(|mut it| {
                    let path = it.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
                    let name = it.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
                        .unwrap_or_else(|| path.rsplit('/').next().unwrap_or("").to_string());
                    if let Some(o) = it.as_object_mut() {
                        o.insert("name".into(), serde_json::json!(name));
                        o.insert("dir".into(), serde_json::json!(1));
                    }
                    it
                }).collect();
                Json(serde_json::json!({ "files": files })).into_response()
            }
            Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
        },
    }
}

/// Personal trash (`file.trash.list`) — flat, includes deletion metadata
/// (`rmTime`/`rmUid`). Read-only: no restore/empty actions exposed yet.
async fn get_fnos_trash() -> Response {
    match crate::fnos::call("file.trash.list", serde_json::json!({})).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Starred items (`file.fav.list`) — flat, full absolute paths (not scoped to
/// one folder). Normalized to the same `{files:[{name,path,dir,...}]}` shape
/// the file browser already renders, since fnOS returns it as `{fav:[...]}`
/// with no `name` field.
async fn get_fnos_favorites() -> Response {
    match crate::fnos::call("file.fav.list", serde_json::json!({})).await {
        Ok(v) => {
            let items = v.get("fav").and_then(|f| f.as_array()).cloned().unwrap_or_default();
            let files: Vec<serde_json::Value> = items
                .into_iter()
                .map(|mut it| {
                    let name = it
                        .get("path")
                        .and_then(|p| p.as_str())
                        .and_then(|p| p.rsplit('/').next())
                        .unwrap_or("")
                        .to_string();
                    if let Some(obj) = it.as_object_mut() {
                        obj.insert("name".into(), serde_json::json!(name));
                    }
                    it
                })
                .collect();
            Json(serde_json::json!({ "files": files })).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Recently-opened items (`file.recent.list`) — server-side, shared with the
/// fnOS web client. Shape: `{recent:[{path,dir,...}]}`.
/// fnOS-side health for the home banner: the resource monitor's active alert
/// ("beep") reasons — what fnOS itself would sound the buzzer for (disk
/// failure, degraded storage, overheat, UPS…). `succ` with no payload = no
/// active alerts. The non-empty shape isn't documented, so any list/strings in
/// the payload are surfaced generically as `alerts:[..]`. Cheap; the UI polls
/// it on the 30 s notification cadence.
async fn get_fnos_health() -> Response {
    match crate::fnos::call("appcgi.resmon.alert.getBeepReasons", serde_json::json!({})).await {
        Ok(v) => {
            let mut alerts: Vec<String> = Vec::new();
            fn collect(v: &serde_json::Value, out: &mut Vec<String>) {
                match v {
                    serde_json::Value::String(s) => { if !s.is_empty() { out.push(s.clone()); } }
                    serde_json::Value::Array(a) => { for x in a { collect(x, out); } }
                    serde_json::Value::Object(o) => {
                        for (k, x) in o {
                            if ["req", "reqid", "result", "rev", "errno"].contains(&k.as_str()) { continue; }
                            collect(x, out);
                        }
                    }
                    _ => {}
                }
            }
            collect(&v, &mut alerts);
            Json(serde_json::json!({ "alerts": alerts, "raw": v })).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

async fn get_fnos_recent() -> Response {
    match crate::fnos::call("file.recent.list", serde_json::json!({})).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Recursive size of a folder (or files) via `file.calc({files:[path]})`.
async fn get_fnos_folder_size(Query(q): Query<FilesQ>) -> Response {
    let path = match &q.path {
        Some(p) => p.clone(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "path required" }))).into_response(),
    };
    match crate::fnos::call("file.calc", serde_json::json!({ "files": [path] })).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
struct MkdirBody { path: String, name: String }
/// Create a folder: `file.mkdir({path})`.
async fn post_fnos_mkdir(Json(b): Json<MkdirBody>) -> Response {
    let full = format!("{}/{}", b.path.trim_end_matches('/'), b.name);
    match crate::fnos::call("file.mkdir", serde_json::json!({ "path": full })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true, "path": full })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
struct RenameBody { path: String, #[serde(rename = "newName")] new_name: String }
/// Rename in place: `file.rename({path, newName})`.
async fn post_fnos_rename(Json(b): Json<RenameBody>) -> Response {
    match crate::fnos::call("file.rename", serde_json::json!({ "path": b.path, "newName": b.new_name })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
struct FavBody { path: String, on: bool }
/// Toggle a favorite: `file.fav.add` / `file.fav.del` ({path}).
async fn post_fnos_fav(Json(b): Json<FavBody>) -> Response {
    let method = if b.on { "file.fav.add" } else { "file.fav.del" };
    match crate::fnos::call(method, serde_json::json!({ "path": b.path })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/* ---------- External drives & remote mounts (fnOS stor.* / appcgi.mountmgr.*) ---------- */

/// Everything the Files landing page needs for its "Devices" card beyond the
/// local volumes: external (USB) disks with their partitions and mount state,
/// and fnOS "Remote Mount" connections (SMB/NFS/WebDAV). All three sources are
/// fnOS's own — `stor.listDisk` (disk inventory, `external:1`), `stor.listRemovable`
/// (the partitions fnOS currently has mounted under /vol00) and
/// `appcgi.mountmgr.list` — so what we show matches the fnOS File Manager.
async fn get_fnos_externals() -> Response {
    let disks = match crate::fnos::call("stor.listDisk", serde_json::json!({})).await {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    };
    let removable = crate::fnos::call("stor.listRemovable", serde_json::json!({})).await.unwrap_or_default();
    let remote = crate::fnos::call("appcgi.mountmgr.list", serde_json::json!({})).await.unwrap_or_default();

    // partition name → mounted entry (path is volume-relative, no leading slash)
    let mounted: std::collections::HashMap<String, &serde_json::Value> = removable["removable"]
        .as_array().map(|a| a.iter().filter_map(|r| r["name"].as_str().map(|n| (n.to_string(), r))).collect())
        .unwrap_or_default();

    let out_disks: Vec<serde_json::Value> = disks["disk"].as_array().map(|a| a.iter()
        .filter(|d| d["external"].as_i64() == Some(1))
        .map(|d| {
            let parts: Vec<serde_json::Value> = d["partitions"].as_array().map(|ps| ps.iter().map(|p| {
                let name = p["name"].as_str().unwrap_or("");
                let m = mounted.get(name);
                serde_json::json!({
                    "name": name,
                    "fstype": p["fstype"],
                    "size": p["size"],
                    "mount_name": p["mountName"],
                    "mounted": m.is_some(),
                    "path": m.and_then(|r| r["path"].as_str()).map(|s| format!("/{}", s.trim_start_matches('/'))),
                    "fssize": m.map(|r| r["fssize"].clone()).unwrap_or(p["fssize"].clone()),
                    "frsize": m.map(|r| r["frsize"].clone()).unwrap_or(p["frsize"].clone()),
                })
            }).collect()).unwrap_or_default();
            let any_mounted = parts.iter().any(|p| p["mounted"].as_bool() == Some(true));
            serde_json::json!({
                "name": d["name"],
                "model": d["modelName"].as_str().unwrap_or("External drive").replace('_', " "),
                "serial": d["serialNumber"],
                "interface": d["interface"],
                "usb_version": d["usbVersion"],
                "size": d["size"],
                "mounted": any_mounted,
                "parts": parts,
            })
        }).collect()).unwrap_or_default();

    // Remote mounts: field names are taken from the fnOS web client; the record
    // is passed through mostly as-is because this box has none to validate against.
    let out_remote: Vec<serde_json::Value> = remote["rsp"].as_array().map(|a| a.iter().map(|r| {
        let pick = |keys: &[&str]| keys.iter().find_map(|k| r[k].as_str().filter(|s| !s.is_empty()).map(str::to_string));
        let state = pick(&["status", "state", "mountStatus"]).unwrap_or_default();
        let mount_point = pick(&["mountPoint"]);
        serde_json::json!({
            "id": r["id"].as_str().map(str::to_string).or_else(|| r["id"].as_i64().map(|n| n.to_string())).or_else(|| pick(&["name"])),
            "label": pick(&["comment", "name", "shareName"]).or_else(|| mount_point.clone()),
            "mount_point": mount_point,
            "protocol": pick(&["protocol", "type"]),
            "host": pick(&["host", "server", "addr", "ip", "hostname"]),
            "share": pick(&["shareName", "share", "remotePath", "path"]),
            "state": state,
            "connected": !state.to_lowercase().contains("disconnect") && !state.to_lowercase().contains("unmount") && !state.to_lowercase().contains("fail"),
        })
    }).collect()).unwrap_or_default();

    Json(serde_json::json!({ "disks": out_disks, "remote": out_remote })).into_response()
}

#[derive(Deserialize)]
struct DiskBody { disk: String }

/// fnOS's own guard (mirrors its web UI): never eject a disk that is a member
/// of a storage pool or carries the system.
async fn external_disk_ok(name: &str) -> Result<(), String> {
    let disks = crate::fnos::call("stor.listDisk", serde_json::json!({})).await?;
    let d = disks["disk"].as_array().and_then(|a| a.iter().find(|d| d["name"].as_str() == Some(name)))
        .ok_or_else(|| format!("no such disk: {name}"))?;
    if d["external"].as_i64() != Some(1) { return Err("not an external drive".into()); }
    if d["sys"].as_i64() == Some(1) { return Err("that is the system disk".into()); }
    if d["storage"].as_array().map(|a| !a.is_empty()).unwrap_or(false) { return Err("disk belongs to a storage pool".into()); }
    Ok(())
}

fn fnos_action_response(r: Result<serde_json::Value, String>) -> Response {
    match r {
        Ok(v) if v["result"].as_str() == Some("succ") => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(v) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({
            "ok": false, "errno": v["errno"], "error": v["errmsg"].as_str().unwrap_or("fnOS refused the request")
        }))).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "ok": false, "error": e }))).into_response(),
    }
}

/// Safe removal of an external disk (fnOS "Eject"): `stor.eject({disk})`.
/// The UI confirms first; format is deliberately not exposed.
async fn post_fnos_disk_eject(Json(b): Json<DiskBody>) -> Response {
    if let Err(e) = external_disk_ok(&b.disk).await {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": e }))).into_response();
    }
    fnos_action_response(crate::fnos::call("stor.eject", serde_json::json!({ "disk": b.disk })).await)
}

/// Mount an external disk fnOS knows about but hasn't mounted: `stor.diskMount({disk})`.
async fn post_fnos_disk_mount(Json(b): Json<DiskBody>) -> Response {
    if let Err(e) = external_disk_ok(&b.disk).await {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": e }))).into_response();
    }
    fnos_action_response(crate::fnos::call("stor.diskMount", serde_json::json!({ "disk": b.disk })).await)
}

#[derive(Deserialize)]
struct RemoteBody { name: String }

/// Remote mount Connect / Disconnect (`appcgi.mountmgr.mount|umount({name})`).
/// Disconnect keeps the saved record (no `deleteRecord`) — same as the web UI's
/// "Disconnect", not its "Remove".
async fn post_fnos_remote_connect(Json(b): Json<RemoteBody>) -> Response {
    fnos_action_response(crate::fnos::call("appcgi.mountmgr.mount", serde_json::json!({ "name": b.name })).await)
}
async fn post_fnos_remote_disconnect(Json(b): Json<RemoteBody>) -> Response {
    fnos_action_response(crate::fnos::call("appcgi.mountmgr.umount", serde_json::json!({ "name": b.name })).await)
}

#[derive(Deserialize)]
struct UsbBody { serial: String }
/// Undo of Eject for a USB reader that is still physically attached: power-cycle
/// its port via sysfs `authorized`, then wait (≤10 s) for media to come back.
/// Keyed by the USB serial because the sdX node is gone after an eject.
/// Refused if any block device on that USB device still has media or a mount,
/// so it can never yank a drive that is in use.
async fn post_usb_reconnect(Json(b): Json<UsbBody>) -> Response {
    let bad = |m: String| (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": m }))).into_response();
    let Some(dir) = t6_hw_rs::storage::usb_device_by_serial(&b.serial) else { return bad("no such USB device".into()) };
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    for (name, size) in t6_hw_rs::storage::block_devices_under(&dir) {
        if size > 0 || mounts.lines().any(|l| l.starts_with(&format!("/dev/{name}"))) {
            return bad(format!("{name} is present and in use — eject it first"));
        }
    }
    if let Err(e) = t6_hw_rs::storage::usb_set_authorized(&dir, false) { return bad(e); }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    if let Err(e) = t6_hw_rs::storage::usb_set_authorized(&dir, true) { return bad(e); }
    let mut found = Vec::new();
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        found = t6_hw_rs::storage::block_devices_under(&dir).into_iter().filter(|d| d.1 > 0).collect();
        if !found.is_empty() { break; }
    }
    Json(serde_json::json!({ "ok": true, "disks": found.iter().map(|d| serde_json::json!({ "name": d.0, "size_bytes": d.1 })).collect::<Vec<_>>() })).into_response()
}

#[derive(Deserialize)]
struct PathsBody { paths: Vec<String> }
/// Move items to Trash (reversible): `file.rm({files, moveToTrashbin:true})`.
/// Permanent delete (moveToTrashbin:false) is intentionally NOT exposed.
async fn post_fnos_trash(Json(b): Json<PathsBody>) -> Response {
    if b.paths.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "no paths" }))).into_response();
    }
    match crate::fnos::call("file.rm", serde_json::json!({ "files": b.paths, "moveToTrashbin": true })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Restore items from Trash: `file.trash.restore({files})`.
async fn post_fnos_trash_restore(Json(b): Json<PathsBody>) -> Response {
    if b.paths.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "no paths" }))).into_response();
    }
    match crate::fnos::call("file.trash.restore", serde_json::json!({ "files": b.paths })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
struct TransferBody {
    /// Absolute source paths.
    paths: Vec<String>,
    /// Absolute destination directory.
    to: String,
    /// fnOS conflict strategy (numeric enum): 0 = Skip (server default —
    /// silently skips conflicts yet reports "succ"!), 1 = Replace, 2 = Rename
    /// (keep both). The UI pre-checks name collisions and asks the user.
    #[serde(default)]
    overwrite: Option<i64>,
    /// Debug: include the raw task frames.
    #[serde(default)]
    debug: Option<u8>,
}

/// Copy or move via fnOS's own task API (`file.cp` / `file.mv`). These are
/// long-running tasks: the server streams progress frames (`result:"doing"`)
/// and a terminal `succ`/`fail` under the request's reqid, so we collect them
/// with `call_stream` (like finder search) to report real completion + errors.
/// Params mirror the web client: `{files, pathTo, overwrite, details:{name,dir,count}}`.
async fn file_transfer(method: &str, b: &TransferBody) -> Response {
    if b.paths.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "no paths" }))).into_response();
    }
    let first = b.paths[0].rsplit('/').next().unwrap_or("").to_string();
    let mut params = serde_json::json!({
        "files": b.paths,
        "pathTo": b.to,
        "details": { "name": first, "count": b.paths.len() },
    });
    if let Some(ow) = b.overwrite {
        params["overwrite"] = serde_json::json!(ow);
    }
    let budget = std::time::Duration::from_secs(90);
    let frames = match crate::fnos::call_stream(method, params, budget).await {
        Ok(f) => f,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    };
    // Interpret: terminal frame = result present && != "doing".
    let mut task_id = serde_json::Value::Null;
    let mut terminal: Option<&serde_json::Value> = None;
    for fr in &frames {
        if task_id.is_null() { if let Some(t) = fr.get("taskId") { task_id = t.clone(); } }
        if fr.get("result").and_then(|r| r.as_str()).map_or(false, |r| r != "doing") { terminal = Some(fr); }
    }
    let mut out = serde_json::json!({ "taskId": task_id, "frames": frames.len() });
    match terminal {
        Some(t) => {
            let res = t.get("result").and_then(|r| r.as_str()).unwrap_or("");
            out["finished"] = serde_json::json!(true);
            out["ok"] = serde_json::json!(res == "succ");
            out["result"] = serde_json::json!(res);
            if let Some(e) = t.get("errno") { out["errno"] = e.clone(); }
            if let Some(m) = t.get("errmsg").or_else(|| t.get("msg")) { out["errmsg"] = m.clone(); }
            // conflict/detail payloads the web client uses for its dialog
            for k in ["failedFiles", "failedFilesCount", "conflict", "conflictFiles"] {
                if let Some(v) = t.get(k) { out[k] = v.clone(); }
            }
        }
        None => {
            // budget elapsed before a terminal frame — task may still be running
            out["finished"] = serde_json::json!(false);
            out["ok"] = serde_json::json!(false);
            out["pending"] = serde_json::json!(true);
        }
    }
    if b.debug.is_some() { out["raw"] = serde_json::json!(frames); }
    Json(out).into_response()
}
async fn post_fnos_copy(Json(b): Json<TransferBody>) -> Response { file_transfer("file.cp", &b).await }
async fn post_fnos_move(Json(b): Json<TransferBody>) -> Response { file_transfer("file.mv", &b).await }

#[derive(Deserialize)]
struct SearchQ {
    /// Search keyword (name substring).
    q: String,
    /// fnOS finder scope: `my-files` (all the user's files, every volume),
    /// `all-files`, `team-files`, … Defaults to `my-files`.
    #[serde(default)]
    scope: Option<String>,
    /// Optional absolute path to restrict the search to one subtree.
    #[serde(default)]
    path: Option<String>,
}

/// Indexed name search via fnOS's finder (`appcgi.finder.fileSearch`). Unlike a
/// `file.ls` walk this is server-side, indexed, and spans all volumes. It
/// *streams*: the server sends many frames under one reqid (intermediate ones
/// `result:"doing"` carrying `matchedFiles`, a terminal `result:"succ"`), which
/// `call_stream` collects. We aggregate + de-dup `matchedFiles`, cap the count,
/// and give each hit a `loc` (containing folder) for the results UI. Read-only.
async fn get_fnos_search(Query(q): Query<SearchQ>) -> Response {
    const MAX_RESULTS: usize = 200;
    let budget = std::time::Duration::from_millis(6000);

    let needle = q.q.trim();
    if needle.is_empty() {
        return Json(serde_json::json!({ "files": [], "capped": false })).into_response();
    }
    // fnOS finder params: `{key: <keyword>, path: [<dir>,…]}`. `path` is an
    // ARRAY of search roots (omit to search everything the user can access,
    // across all volumes). There is no `scope` field.
    let mut obj = serde_json::Map::new();
    obj.insert("key".into(), serde_json::json!(needle));
    if let Some(p) = &q.path {
        obj.insert("path".into(), serde_json::json!([p]));
    }
    let params = Value::Object(obj);
    let _ = &q.scope; // scope kept in the query for the UI; not an RPC field

    let frames = match crate::fnos::call_stream("appcgi.finder.fileSearch", params, budget).await {
        Ok(f) => f,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    };

    // Each frame's `data` is an incremental batch of hits. An item's `path` is
    // its CONTAINING folder, volume-relative and WITHOUT a leading slash
    // (e.g. "vol1/1000/Workspace"); `name` is the entry. Normalize to an
    // absolute full path (`/vol1/1000/Workspace/<name>`) and a `loc` (parent)
    // so the results UI can navigate/preview and show a location line.
    let mut files: Vec<serde_json::Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut finished = false;
    for fr in &frames {
        if fr.get("result").and_then(|r| r.as_str()).map_or(false, |r| r != "doing") {
            finished = true;
        }
        let batch = fr.get("data").and_then(|m| m.as_array());
        if let Some(arr) = batch {
            for it in arr {
                if files.len() >= MAX_RESULTS { break; }
                let name = it.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name.is_empty() { continue; }
                let parent = it.get("path").and_then(|p| p.as_str()).unwrap_or("").trim_start_matches('/');
                let full = if parent.is_empty() { format!("/{name}") } else { format!("/{parent}/{name}") };
                if !seen.insert(full.clone()) { continue; }
                let loc = if parent.is_empty() { "/".to_string() } else { format!("/{parent}") };
                let mut e = it.clone();
                if let Some(obj) = e.as_object_mut() {
                    obj.insert("path".into(), serde_json::json!(full));
                    obj.insert("loc".into(), serde_json::json!(loc));
                }
                files.push(e);
            }
        }
    }
    let capped = !finished || files.len() >= MAX_RESULTS;
    Json(serde_json::json!({ "files": files, "capped": capped })).into_response()
}

#[derive(Deserialize)]
struct NotifQ {
    #[serde(default = "default_notif_limit")]
    limit: i64,
}
fn default_notif_limit() -> i64 {
    30
}

/// fnOS notification center: recent system notifications (`notify.list`) plus
/// the unread badge count (`notify.unreadTotal`). Normalized to
/// `{unread, total, items:[{id,title,content,datetime,level,read,from}]}`.
async fn get_fnos_notifications(Query(q): Query<NotifQ>) -> Response {
    let list = match crate::fnos::call(
        "notify.list",
        serde_json::json!({ "start": 0, "limit": q.limit }),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response()
        }
    };
    // unreadTotal is authoritative for the badge; fall back to counting the
    // page's unread rows if that call fails (e.g. method quirk), never fatal.
    let unread = match crate::fnos::call("notify.unreadTotal", serde_json::json!({})).await {
        Ok(v) => v.get("unreadTotal").and_then(|x| x.as_i64()).unwrap_or(0),
        Err(_) => list
            .get("notifyList")
            .and_then(|l| l.as_array())
            .map(|a| a.iter().filter(|n| n.get("read").and_then(|r| r.as_i64()) == Some(0)).count() as i64)
            .unwrap_or(0),
    };
    let items: Vec<serde_json::Value> = list
        .get("notifyList")
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|n| {
            serde_json::json!({
                "id": n.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "title": n.get("title").cloned().unwrap_or(serde_json::Value::Null),
                "content": n.get("content").cloned().unwrap_or(serde_json::Value::Null),
                "datetime": n.get("datetime").cloned().unwrap_or(serde_json::Value::Null),
                "level": n.get("level").cloned().unwrap_or(serde_json::json!(0)),
                "read": n.get("read").cloned().unwrap_or(serde_json::json!(1)),
                "from": n.get("from").cloned().unwrap_or(serde_json::Value::Null),
            })
        })
        .collect();
    Json(serde_json::json!({
        "unread": unread,
        "total": list.get("total").cloned().unwrap_or(serde_json::json!(items.len())),
        "items": items,
    }))
    .into_response()
}

/// Mark every notification read (`notify.setReadAll`). User-initiated only.
async fn post_fnos_notifications_read_all() -> Response {
    match crate::fnos::call("notify.setReadAll", serde_json::json!({})).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// The fnOS `ost` session cookie (minted at login from our WS ticket — see
/// `fnos::mint_preview_cookie`), for the Electron shell to apply to its own
/// cookie jar before embedding the Preview iframe. `cookie:null` if not
/// signed in, or if minting failed.
async fn get_fnos_preview_cookie() -> Response {
    Json(serde_json::json!({ "cookie": crate::fnos::preview_cookie().await })).into_response()
}

#[derive(Deserialize)]
struct TbDeviceReq {
    /// "authorize" | "enroll" | "forget".
    action: String,
    uuid: String,
}

async fn post_tb_device(Json(req): Json<TbDeviceReq>) -> Response {
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
struct TbNetQuery {
    /// NM connection name of the TB net interface.
    conn: String,
}

async fn get_tb_net(Query(q): Query<TbNetQuery>) -> Response {
    Json(t6_hw_rs::network::ipv4_config(&q.conn)).into_response()
}

#[derive(Deserialize)]
struct TbNetSetReq {
    conn: String,
    method: String,
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    gateway: Option<String>,
    #[serde(default)]
    dns: Vec<String>,
}

async fn post_tb_net(Json(req): Json<TbNetSetReq>) -> Response {
    let addr = req.address.as_deref().filter(|s| !s.is_empty());
    let gw = req.gateway.as_deref().filter(|s| !s.is_empty());
    match t6_hw_rs::network::set_conn_ipv4(&req.conn, &req.method, addr, gw, &req.dns) {
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
