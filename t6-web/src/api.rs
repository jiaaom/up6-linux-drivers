//! HTTP routes. Everything is mounted under the gateway prefix.
//!
//! Reads are open to any NAS user the gateway let through; writes require
//! the administrator flag from the gateway headers.

use crate::battery::{Battery, Thresholds};
use crate::display::Display;
use crate::fand::Fand;
use crate::gateway::User;
use crate::ledd::Ledd;
use crate::www::Www;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Redirect, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    www: Www,
    fand: Fand,
    battery: Battery,
    display: Display,
    ledd: Ledd,
    /// Development mode (TCP listener, no gateway): treat every request as
    /// an administrator so writes can be exercised locally.
    trust_all: bool,
}

impl AppState {
    pub fn new(www_dir: Option<PathBuf>, state_dir: &FsPath, trust_all: bool) -> Self {
        AppState {
            inner: Arc::new(Inner {
                www: Www::new(www_dir),
                fand: Fand::new(),
                battery: Battery::new(),
                display: Display::new(state_dir),
                ledd: Ledd::new(),
                trust_all,
            }),
        }
    }

    fn user(&self, headers: &HeaderMap) -> User {
        let mut u = User::from_headers(headers);
        if self.inner.trust_all {
            u.is_admin = true;
            u.username.get_or_insert_with(|| "local".into());
        }
        u
    }
}

/// Routes under `prefix` (no trailing slash), e.g. `/app/t6control`.
/// The bare prefix redirects to `prefix/` so the page's relative URLs
/// resolve inside the prefix.
pub fn router(prefix: &str) -> Router<AppState> {
    let slash = format!("{prefix}/");
    let p = |s: &str| format!("{prefix}{s}");
    Router::new()
        .route(prefix, get(move || async move { Redirect::permanent(&slash) }))
        .route(&p("/"), get(index))
        .route(&p("/{file}"), get(static_file))
        .route(&p("/api/status"), get(status))
        .route(&p("/api/whoami"), get(whoami))
        .route(&p("/api/fan/profile"), get(get_profile).put(put_profile))
        .route(&p("/api/fan/config"), get(get_config))
        .route(&p("/api/battery"), get(get_battery))
        .route(&p("/api/battery/thresholds"), get(get_thresholds).put(put_thresholds))
        .route(&p("/api/display"), get(get_display))
        .route(&p("/api/display/brightness"), get(get_display).put(put_brightness))
        .route(&p("/api/display/power"), axum::routing::put(put_display_power))
        .route(&p("/api/leds"), get(get_leds))
        .route(&p("/api/leds/bays"), axum::routing::put(put_bays))
        .route(&p("/api/leds/night"), axum::routing::put(put_night))
        .route(&p("/api/leds/{device}"), axum::routing::put(put_led))
        .route(&p("/api/beep"), axum::routing::post(post_beep))
        .route(&p("/api/system"), get(get_system))
}

type ApiResult = Result<Json<serde_json::Value>, ApiError>;

/// Error with an HTTP status, rendered as `{"error": "..."}`.
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn bad_request(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

fn require_admin(s: &AppState, headers: &HeaderMap) -> Result<User, ApiError> {
    let u = s.user(headers);
    if u.is_admin {
        Ok(u)
    } else {
        Err(ApiError(StatusCode::FORBIDDEN, "administrator required".into()))
    }
}

async fn index(State(s): State<AppState>) -> Response {
    serve(&s, "index.html")
}

async fn static_file(State(s): State<AppState>, Path(file): Path<String>) -> Response {
    serve(&s, &file)
}

fn serve(s: &AppState, name: &str) -> Response {
    match s.inner.www.get(name) {
        Some((ctype, body)) => ([(header::CONTENT_TYPE, ctype), (header::CACHE_CONTROL, "no-cache")], body).into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

/// Everything the dashboard needs in one poll.
async fn status(State(s): State<AppState>, headers: HeaderMap) -> Json<serde_json::Value> {
    let fand = &s.inner.fand;
    let cfg = fand.config().ok();
    Json(json!({
        "user": s.user(&headers),
        "fan": {
            "running": fand.status().is_some(),
            "profile_override": fand.profile_override(),
            "config_profile": cfg.as_ref().and_then(|c| c.profile.clone()),
            "profiles": cfg.as_ref().map(|c| c.profiles.clone()).unwrap_or_default(),
            "status": fand.status(),
        },
        "battery": s.inner.battery.info(),
        "display": s.inner.display.info(),
        "leds": s.inner.ledd.status(),
    }))
}

async fn whoami(State(s): State<AppState>, headers: HeaderMap) -> Json<User> {
    Json(s.user(&headers))
}

async fn get_profile(State(s): State<AppState>) -> ApiResult {
    let fand = &s.inner.fand;
    let cfg = fand.config().map_err(bad_request)?;
    let active = fand.status().and_then(|st| st["profile"].as_str().map(str::to_string));
    Ok(Json(json!({
        "active": active,
        "override": fand.profile_override(),
        "default": cfg.profile,
        "profiles": cfg.profiles,
    })))
}

#[derive(Deserialize)]
struct ProfileBody {
    profile: String,
}

async fn put_profile(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<ProfileBody>) -> ApiResult {
    let user = require_admin(&s, &headers)?;
    s.inner.fand.set_profile(&body.profile).map_err(bad_request)?;
    println!("profile set to {:?} by {}", body.profile, user.username.as_deref().unwrap_or("?"));
    Ok(Json(json!({ "ok": true, "profile": body.profile })))
}

async fn get_config(State(s): State<AppState>) -> ApiResult {
    let cfg = s.inner.fand.config().map_err(bad_request)?;
    Ok(Json(json!({ "path": crate::fand::CONFIG, "profiles": cfg.profiles, "config": cfg.value })))
}

async fn get_battery(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(json!(s.inner.battery.info()))
}

async fn get_thresholds(State(s): State<AppState>) -> ApiResult {
    let t = s.inner.battery.thresholds().ok_or_else(|| bad_request("charge thresholds not available".into()))?;
    Ok(Json(json!({ "start": t.start, "end": t.end, "ec_policy": t.is_ec_policy() })))
}

#[derive(Deserialize)]
struct ThresholdsBody {
    start: u32,
    end: u32,
}

async fn put_thresholds(State(s): State<AppState>, headers: HeaderMap, Json(b): Json<ThresholdsBody>) -> ApiResult {
    let user = require_admin(&s, &headers)?;
    let t = Thresholds { start: b.start, end: b.end };
    s.inner.battery.set_thresholds(t).map_err(bad_request)?;
    println!("charge thresholds set to {}/{} by {}", t.start, t.end, user.username.as_deref().unwrap_or("?"));
    Ok(Json(json!({ "ok": true, "start": t.start, "end": t.end, "ec_policy": t.is_ec_policy() })))
}

async fn get_display(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(json!(s.inner.display.info()))
}

#[derive(Deserialize)]
struct BrightnessBody {
    brightness: u32,
}

async fn put_brightness(State(s): State<AppState>, headers: HeaderMap, Json(b): Json<BrightnessBody>) -> ApiResult {
    require_admin(&s, &headers)?;
    let v = s.inner.display.set_brightness(b.brightness).map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "brightness": v })))
}

#[derive(Deserialize)]
struct PowerBody {
    on: bool,
}

async fn put_display_power(State(s): State<AppState>, headers: HeaderMap, Json(b): Json<PowerBody>) -> ApiResult {
    require_admin(&s, &headers)?;
    let v = s.inner.display.set_power(b.on).map_err(bad_request)?;
    Ok(Json(json!({ "ok": true, "on": b.on, "brightness": v })))
}

async fn get_leds(State(s): State<AppState>) -> ApiResult {
    s.inner.ledd.status().map(Json).ok_or_else(|| bad_request("t6-ledd is not running".into()))
}

#[derive(Deserialize)]
struct LedBody {
    /// `"auto"` or a colour name.
    value: String,
}

async fn put_led(State(s): State<AppState>, headers: HeaderMap, Path(device): Path<String>, Json(b): Json<LedBody>) -> ApiResult {
    require_admin(&s, &headers)?;
    let cmd = format!("set {} {}", Ledd::word(&device).map_err(bad_request)?, Ledd::word(&b.value).map_err(bad_request)?);
    s.inner.ledd.command(&cmd).map_err(bad_request)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct OnBody {
    on: bool,
}

async fn put_bays(State(s): State<AppState>, headers: HeaderMap, Json(b): Json<OnBody>) -> ApiResult {
    require_admin(&s, &headers)?;
    s.inner.ledd.command(if b.on { "bays on" } else { "bays off" }).map_err(bad_request)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct NightBody {
    /// Manual night mode on/off.
    on: Option<bool>,
    /// `"HH:MM-HH:MM"`, or `""`/null to clear the schedule. Only applied
    /// when the field is present.
    #[serde(default, deserialize_with = "deserialize_some")]
    schedule: Option<Option<String>>,
}

/// Distinguishes an absent field from an explicit null.
fn deserialize_some<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

async fn put_night(State(s): State<AppState>, headers: HeaderMap, Json(b): Json<NightBody>) -> ApiResult {
    require_admin(&s, &headers)?;
    let ledd = &s.inner.ledd;
    if let Some(on) = b.on {
        ledd.command(if on { "night on" } else { "night off" }).map_err(bad_request)?;
    }
    if let Some(schedule) = b.schedule {
        let spec = match schedule.as_deref().map(str::trim) {
            None | Some("") => "off".to_string(),
            Some(w) => Ledd::word(w).map_err(bad_request)?.to_string(),
        };
        ledd.command(&format!("schedule {spec}")).map_err(bad_request)?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct BeepBody {
    /// 0 off, 1 short, 2 long, 4 double, 8 continuous.
    pattern: u8,
}

async fn post_beep(State(s): State<AppState>, headers: HeaderMap, Json(b): Json<BeepBody>) -> ApiResult {
    require_admin(&s, &headers)?;
    s.inner.ledd.command(&format!("beep {}", b.pattern)).map_err(bad_request)?;
    Ok(Json(json!({ "ok": true })))
}

/// Versions and service health for the System tab.
async fn get_system(State(s): State<AppState>) -> Json<serde_json::Value> {
    let read = |p: &str| std::fs::read_to_string(p).ok().map(|t| t.trim().to_string());
    let module = |name: &str| {
        let dir = format!("/sys/module/{name}");
        json!({
            "loaded": std::path::Path::new(&dir).is_dir(),
            "version": read(&format!("{dir}/version")),
        })
    };
    Json(json!({
        "kernel": read("/proc/sys/kernel/osrelease"),
        // FygoOS exports the package version to the app's processes.
        "app_version": std::env::var("TRIM_APPVER").ok().or_else(|| option_env!("CARGO_PKG_VERSION").map(str::to_string)),
        "modules": { "t6_platform": module("t6_platform"), "ft8722_ts": module("ft8722_ts") },
        "daemons": {
            "t6-fand": s.inner.fand.status().is_some(),
            "t6-ledd": s.inner.ledd.status().is_some(),
        },
    }))
}
