//! fnOS sign-in/out (native WS client, see `crate::fnos`) and session-derived bits.

use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct FnosLogin {
    user: String,
    password: String,
}

/// Sign in to fnOS (native WS client). The password is used transiently for the
/// handshake and never stored; only the resume ticket is persisted.
pub(super) async fn post_fnos_login(Json(b): Json<FnosLogin>) -> Response {
    match crate::fnos::do_login(&b.user, &b.password).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

pub(super) async fn get_fnos_status() -> Response {
    Json(crate::fnos::status().await).into_response()
}

pub(super) async fn post_fnos_logout() -> Response {
    crate::fnos::logout().await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// Proof-of-concept authenticated read: live NIC list via the fnOS API.
pub(super) async fn get_fnos_net() -> Response {
    match crate::fnos::call("appcgi.network.net.list", serde_json::json!({})).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// The fnOS `ost` session cookie (minted at login from our WS ticket — see
/// `fnos::mint_preview_cookie`), for the Electron shell to apply to its own
/// cookie jar before embedding the Preview iframe. `cookie:null` if not
/// signed in, or if minting failed.
pub(super) async fn get_fnos_preview_cookie() -> Response {
    Json(serde_json::json!({ "cookie": crate::fnos::preview_cookie().await })).into_response()
}
