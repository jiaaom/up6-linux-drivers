//! HTTP surface: the panel UI (static files) and every `/api/...` route.
//!
//! This file owns the router and what every handler shares (`AppState`, the
//! session helper, static serving). The handlers live in one submodule per
//! area:
//!
//! - [`system`]       — device-level: panel aggregate, display, settings, fans, power, local storage/sharing/firmware
//! - [`network`]      — Wi-Fi, wired IPv4, hotspot, Thunderbolt
//! - [`fnos_session`] — fnOS sign-in/out
//! - [`fnos_files`]   — fnOS file manager (list/search/mkdir/rename/trash/copy/move)
//! - [`fnos_disks`]   — external drives + remote mounts, USB reconnect
//! - [`fnos_notify`]  — fnOS health alerts + notification center
//! - [`admin`]        — package web page (gateway only): kiosk on/off, restart

mod admin;
mod fnos_disks;
mod fnos_files;
mod fnos_notify;
mod fnos_session;
mod network;
mod system;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post, put},
    Router,
};
use serde_json::Value;
use std::sync::Arc;

use crate::gateway::User;
use fnos_disks::*;
use fnos_files::*;
use fnos_notify::*;
use fnos_session::*;
use network::*;
use system::*;

#[derive(Clone)]
pub struct AppState {
    www: Arc<crate::www::Www>,
    /// The package's admin web page (`panel/web`); gateway surface only.
    web: Arc<crate::www::Www>,
    /// TCP port of the local no-login shell, so the authenticated (gateway)
    /// surface knows where "sign out" returns to. `None` on the shell itself.
    shell_port: Option<u16>,
}

/// Build the router with every route under `prefix`.
///
/// The local TCP shell uses an empty prefix (bare `/`, `/api/...`). The gateway
/// surface uses the app's gatewayPrefix (e.g. `/app/t6-panel`): FygoOS forwards
/// the *unstripped* path, so routes must live under it, and `prefix` (no
/// trailing slash) redirects to `prefix/` so the page's relative asset/API
/// URLs resolve against the right base.
pub fn router(www: crate::www::Www, web: crate::www::Www, prefix: &str, shell_port: Option<u16>) -> Router {
    let state = AppState { www: Arc::new(www), web: Arc::new(web), shell_port };
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
        .route(&p("/api/settings/theme"), put(put_theme))
        .route(&p("/api/settings/language"), put(put_language))
        .route(&p("/api/settings/color-correction"), put(put_color_correction))
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
        // Admin page + its API: gateway surface only (the local shell has no
        // prefix and never gets these routes).
        let admin_slash = format!("{prefix}/admin/");
        r = r
            .route(&p("/admin"), get(move || async move { Redirect::permanent(&admin_slash) }))
            .route(&p("/admin/"), get(admin_index))
            .route(&p("/admin/{file}"), get(admin_file))
            .route(&p("/api/admin/status"), get(admin::get_status))
            .route(&p("/api/admin/panel"), put(admin::put_panel))
            .route(&p("/api/admin/panel/restart"), post(admin::post_restart));
    }
    r.with_state(state)
}

/// The signed-in user as a JSON value (null when logged out / no gateway).
/// Only the gateway surface carries `X-Trim-*` headers, so the local TCP
/// shell always resolves to null here.
pub(super) fn session_value(headers: &HeaderMap, shell_port: Option<u16>) -> Value {
    let u = User::from_headers(headers);
    match &u.username {
        Some(name) => serde_json::json!({
            "username": name, "uid": u.uid, "is_admin": u.is_admin, "shell_port": shell_port,
        }),
        None => Value::Null,
    }
}

async fn index(State(s): State<AppState>) -> Response {
    serve(&s.www, "index.html")
}

async fn static_file(State(s): State<AppState>, Path(file): Path<String>) -> Response {
    serve(&s.www, &file)
}

async fn admin_index(State(s): State<AppState>) -> Response {
    serve(&s.web, "index.html")
}

async fn admin_file(State(s): State<AppState>, Path(file): Path<String>) -> Response {
    serve(&s.web, &file)
}

fn serve(www: &crate::www::Www, name: &str) -> Response {
    match www.get(name) {
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
