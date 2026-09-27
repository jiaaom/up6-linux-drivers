//! Bluetooth for the panel (Settings → Bluetooth): pair and connect audio and
//! input devices (headphones, speakers, keyboards, remotes, game pads)
//! through BlueZ on the system D-Bus.
//!
//! Coexistence with other Bluetooth apps (e.g. fnOS's "Bluetooth" app, which
//! registers itself as BlueZ's *default* agent): we register our own agent
//! on our own connection but never ask to be the default. BlueZ routes the
//! questions of a pairing to the agent of whoever called `Device1.Pair()`, so
//! pairings started here are answered here and theirs there; requests that
//! come in from outside go to the default agent, which the panel doesn't need
//! (it never makes the NAS discoverable). Discovery is per-client in BlueZ as
//! well: our scan is a lease that the open page renews, and stopping it never
//! stops someone else's.
//!
//! - `GET    /api/bluetooth`                       adapter + devices
//! - `PUT    /api/bluetooth/power`                 `{on}`
//! - `POST   /api/bluetooth/scan`                  `{secs}` scan lease; 0 stops
//! - `POST   /api/bluetooth/device/{addr}/pair`    pair, trust, connect
//! - `POST   /api/bluetooth/device/{addr}/connect`
//! - `POST   /api/bluetooth/device/{addr}/disconnect`
//! - `POST   /api/bluetooth/device/{addr}/audio`   use as the audio output
//! - `DELETE /api/bluetooth/device/{addr}`         forget
//! - `POST   /api/bluetooth/prompt`                `{id, accept, passkey?}`
//!   answers the pairing question in `GET`'s `prompt` (a code to compare or
//!   to enter; codes to type on a keyboard need no answer)
use axum::{extract::Path, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::OnceCell;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::Connection;

const BLUEZ: &str = "org.bluez";
const AGENT_PATH: &str = "/org/t6panel/bluetooth/agent";
/// The stock remote of the ZSpace/UnifyDrive T6 (a BLE HID device).
const T6_REMOTE_NAME: &str = "T2_remote_RC001";

type Managed = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedValue>>>;

static BUS: OnceCell<Connection> = OnceCell::const_new();

/// Our system-bus connection, with the pairing agent exported on it.
async fn bus() -> Result<&'static Connection, String> {
    BUS.get_or_try_init(|| async {
        let c = Connection::system().await.map_err(|e| format!("D-Bus: {e}"))?;
        c.object_server().at(AGENT_PATH, Agent).await.map_err(|e| format!("D-Bus: {e}"))?;
        Ok::<_, String>(c)
    })
    .await
}

/// (Re)register our agent; bluetoothd forgets it when it restarts.
async fn ensure_agent(c: &Connection) {
    let path = zbus::zvariant::ObjectPath::try_from(AGENT_PATH).unwrap();
    let _ = c
        .call_method(Some(BLUEZ), "/org/bluez", Some("org.bluez.AgentManager1"), "RegisterAgent", &(path, "KeyboardDisplay"))
        .await; // AlreadyExists is fine
}

// ---- pairing codes -------------------------------------------------------

/// A pairing question for the person at the panel, shown by the Bluetooth
/// page (it polls `GET /api/bluetooth`) and answered with
/// `POST /api/bluetooth/prompt`.
#[derive(Serialize, Clone)]
struct Prompt {
    id: u64,
    address: String,
    /// `type`: type `code` on the device (a keyboard) then Enter — nothing to
    /// answer, it goes away when pairing ends. `confirm`: does the device show
    /// `code` too? `enter`: type the code the device shows.
    kind: &'static str,
    code: Option<String>,
    /// Digits typed on the keyboard so far (`type` with a passkey).
    entered: Option<u16>,
}

enum Answer {
    Accept,
    Passkey(u32),
}

static PROMPT: Mutex<Option<(Prompt, Option<tokio::sync::oneshot::Sender<Answer>>)>> = Mutex::new(None);
static PROMPT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// How long a question waits for an answer; BlueZ gives up at about the same.
const ANSWER_WAIT: Duration = Duration::from_secs(60);

fn address_of(device: &OwnedObjectPath) -> String {
    device.as_str().rsplit('/').next().unwrap_or("").trim_start_matches("dev_").replace('_', ":")
}

fn show(device: &OwnedObjectPath, kind: &'static str, code: Option<String>, entered: Option<u16>) -> Option<tokio::sync::oneshot::Receiver<Answer>> {
    let address = address_of(device);
    let mut p = PROMPT.lock().unwrap();
    // DisplayPasskey repeats for every key typed: keep the id, update the count.
    let id = match p.as_ref() {
        Some((old, _)) if old.address == address && old.kind == kind && old.code == code => old.id,
        _ => PROMPT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    };
    let prompt = Prompt { id, address, kind, code, entered };
    if kind == "type" {
        *p = Some((prompt, None));
        None
    } else {
        let (tx, rx) = tokio::sync::oneshot::channel();
        *p = Some((prompt, Some(tx)));
        Some(rx)
    }
}

fn clear_prompt(address: Option<&str>) {
    let mut p = PROMPT.lock().unwrap();
    if address.is_none_or(|a| p.as_ref().is_some_and(|(q, _)| q.address.eq_ignore_ascii_case(a))) {
        *p = None;
    }
}

async fn wait(rx: tokio::sync::oneshot::Receiver<Answer>) -> Result<Answer, AgentError> {
    let r = tokio::time::timeout(ANSWER_WAIT, rx).await;
    clear_prompt(None);
    match r {
        Ok(Ok(a)) => Ok(a),
        Ok(Err(_)) => Err(AgentError::Rejected("declined at the panel".into())),
        Err(_) => Err(AgentError::Canceled("no answer at the panel".into())),
    }
}

#[derive(zbus::DBusError, Debug)]
#[zbus(prefix = "org.bluez.Error")]
enum AgentError {
    #[zbus(error)]
    ZBus(zbus::Error),
    Rejected(String),
    Canceled(String),
}

/// A keyboard (legacy PIN pairing types the PIN on the keyboard itself).
async fn is_keyboard(device: &OwnedObjectPath) -> bool {
    let Ok(c) = bus().await else { return false };
    let Ok(reply) = c
        .call_method(Some(BLUEZ), device.as_str(), Some("org.freedesktop.DBus.Properties"), "GetAll", &("org.bluez.Device1",))
        .await
    else {
        return false;
    };
    let Ok(d) = reply.body().deserialize::<HashMap<String, OwnedValue>>() else { return false };
    let uuids: Vec<String> = d.get("UUIDs").and_then(|v| Vec::<String>::try_from(v.try_clone().ok()?).ok()).unwrap_or_default();
    let k = kind(&get_str(&d, "Alias").unwrap_or_default(), &get_str(&d, "Icon").unwrap_or_default(), get::<u32>(&d, "Class"), &uuids);
    k == "keyboard"
}

/// The pairing agent, registered as KeyboardDisplay: headphones, speakers and
/// remotes still pair with "Just Works" (they have no keys or screen), while
/// keyboards get the usual "type this code on the keyboard" and devices with a
/// screen a code to compare. Every question is shown on the panel.
struct Agent;

#[zbus::interface(name = "org.bluez.Agent1")]
impl Agent {
    fn release(&self) {}
    /// Legacy (pre-2.1) PIN pairing: a keyboard gets a fresh PIN to type on
    /// it; anything else (old headsets) the usual fixed 0000.
    async fn request_pin_code(&self, device: OwnedObjectPath) -> String {
        if is_keyboard(&device).await {
            let pin = format!("{:06}", rand::random::<u32>() % 1_000_000);
            show(&device, "type", Some(pin.clone()), None);
            pin
        } else {
            "0000".into()
        }
    }
    fn display_pin_code(&self, device: OwnedObjectPath, pincode: String) {
        show(&device, "type", Some(pincode), None);
    }
    fn display_passkey(&self, device: OwnedObjectPath, passkey: u32, entered: u16) {
        show(&device, "type", Some(format!("{passkey:06}")), Some(entered));
    }
    async fn request_passkey(&self, device: OwnedObjectPath) -> Result<u32, AgentError> {
        let rx = show(&device, "enter", None, None).unwrap();
        match wait(rx).await? {
            Answer::Passkey(n) => Ok(n),
            Answer::Accept => Err(AgentError::Rejected("no passkey".into())),
        }
    }
    async fn request_confirmation(&self, device: OwnedObjectPath, passkey: u32) -> Result<(), AgentError> {
        let rx = show(&device, "confirm", Some(format!("{passkey:06}")), None).unwrap();
        wait(rx).await.map(|_| ())
    }
    // "Just Works" and services of a device we paired: fine.
    fn request_authorization(&self, _device: OwnedObjectPath) {}
    fn authorize_service(&self, _device: OwnedObjectPath, _uuid: String) {}
    fn cancel(&self) {
        clear_prompt(None);
    }
}

async fn call(c: &Connection, path: &str, iface: &str, method: &str) -> Result<(), String> {
    c.call_method(Some(BLUEZ), path, Some(iface), method, &())
        .await
        .map(|_| ())
        .map_err(bluez_error)
}

async fn set_prop(c: &Connection, path: &str, iface: &str, name: &str, value: Value<'_>) -> Result<(), String> {
    c.call_method(Some(BLUEZ), path, Some("org.freedesktop.DBus.Properties"), "Set", &(iface, name, value))
        .await
        .map(|_| ())
        .map_err(bluez_error)
}

/// BlueZ errors in words a panel user can act on.
fn bluez_error(e: zbus::Error) -> String {
    let s = e.to_string();
    let hint = if s.contains("AuthenticationFailed") || s.contains("AuthenticationCanceled") || s.contains("AuthenticationRejected") {
        "Pairing was refused. Put the device in pairing mode and try again."
    } else if s.contains("AuthenticationTimeout") || s.contains("ConnectionAttemptFailed") || s.contains("Page Timeout") {
        "The device did not answer. Make sure it is on, nearby and in pairing mode."
    } else if s.contains("InProgress") {
        "Busy with this device already; try again in a moment."
    } else if s.contains("NotReady") {
        "Bluetooth is off."
    } else if s.contains("DoesNotExist") || s.contains("UnknownObject") {
        "The device is gone; scan again."
    } else {
        return s;
    };
    hint.to_string()
}

async fn managed(c: &Connection) -> Result<Managed, String> {
    let reply = c
        .call_method(Some(BLUEZ), "/", Some("org.freedesktop.DBus.ObjectManager"), "GetManagedObjects", &())
        .await
        .map_err(|e| format!("Bluetooth service not available: {e}"))?;
    reply.body().deserialize::<Managed>().map_err(|e| e.to_string())
}

fn adapter_path(m: &Managed) -> Option<String> {
    let mut paths: Vec<&str> = m.iter().filter(|(_, i)| i.contains_key("org.bluez.Adapter1")).map(|(p, _)| p.as_str()).collect();
    paths.sort();
    paths.first().map(|p| p.to_string())
}

fn device_path(adapter: &str, addr: &str) -> String {
    format!("{adapter}/dev_{}", addr.to_ascii_uppercase().replace(':', "_"))
}

fn get<'a, T: TryFrom<&'a Value<'a>>>(props: &'a HashMap<String, OwnedValue>, key: &str) -> Option<T> {
    props.get(key).and_then(|v| T::try_from(v).ok())
}
fn get_str(props: &HashMap<String, OwnedValue>, key: &str) -> Option<String> {
    props.get(key).and_then(|v| <&str>::try_from(&**v).ok()).map(str::to_string)
}

/// What a device is, from BlueZ's icon, then the class of device, then the
/// services it offers. Only audio and input kinds can be paired here.
fn kind(name: &str, icon: &str, class: Option<u32>, uuids: &[String]) -> &'static str {
    if name == T6_REMOTE_NAME {
        return "remote";
    }
    match icon {
        i if i.starts_with("audio-") => return "audio",
        "input-keyboard" => return "keyboard",
        "input-mouse" | "input-tablet" => return "mouse",
        "input-gaming" => return "gamepad",
        "phone" => return "phone",
        "computer" => return "computer",
        _ => {}
    }
    match class.map(|c| (c >> 8) & 0x1f) {
        Some(4) => return "audio",
        Some(5) => return "keyboard", // peripheral
        _ => {}
    }
    let has = |short: &str| uuids.iter().any(|u| u.starts_with(&format!("0000{short}")));
    if has("110b") || has("111e") || has("1108") {
        "audio" // A2DP sink, hands-free, headset
    } else if has("1124") || has("1812") {
        "keyboard" // HID, HID over GATT
    } else {
        "other"
    }
}

#[derive(Serialize)]
struct Device {
    address: String,
    name: String,
    /// BlueZ has no name for it (the alias is just the address).
    unnamed: bool,
    kind: &'static str,
    /// Audio or input: pairable from the panel.
    supported: bool,
    paired: bool,
    connected: bool,
    rssi: Option<i16>,
    battery: Option<u8>,
}

fn devices(m: &Managed, adapter: &str) -> Vec<Device> {
    let prefix = format!("{adapter}/");
    let mut out: Vec<Device> = m
        .iter()
        .filter(|(p, _)| p.as_str().starts_with(&prefix))
        .filter_map(|(_, ifaces)| {
            let d = ifaces.get("org.bluez.Device1")?;
            let address = get_str(d, "Address")?;
            let alias = get_str(d, "Alias").unwrap_or_default();
            let has_name = d.contains_key("Name");
            let unnamed = !has_name && alias.replace('-', ":").eq_ignore_ascii_case(&address);
            let uuids: Vec<String> = d.get("UUIDs").and_then(|v| Vec::<String>::try_from(v.try_clone().ok()?).ok()).unwrap_or_default();
            let icon = get_str(d, "Icon").unwrap_or_default();
            let kind = kind(&alias, &icon, get::<u32>(d, "Class"), &uuids);
            let battery = ifaces.get("org.bluez.Battery1").and_then(|b| get::<u8>(b, "Percentage"));
            Some(Device {
                name: if unnamed { address.clone() } else { alias },
                address,
                unnamed,
                kind,
                supported: !matches!(kind, "phone" | "computer" | "other"),
                paired: get::<bool>(d, "Paired").unwrap_or(false),
                connected: get::<bool>(d, "Connected").unwrap_or(false),
                rssi: get::<i16>(d, "RSSI"),
                battery,
            })
        })
        .collect();
    out.sort_by(|a, b| b.connected.cmp(&a.connected).then(b.rssi.cmp(&a.rssi)).then(a.name.cmp(&b.name)));
    out
}

// ---- scan lease ----------------------------------------------------------

/// When our discovery lease ends; None = not scanning.
static SCAN_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

async fn scan_watchdog() {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let expired = {
            let mut until = SCAN_UNTIL.lock().unwrap();
            match *until {
                Some(t) if Instant::now() >= t => {
                    *until = None;
                    true
                }
                None => return,
                _ => false,
            }
        };
        if expired {
            if let Ok(c) = bus().await {
                if let Ok(m) = managed(c).await {
                    if let Some(a) = adapter_path(&m) {
                        let _ = call(c, &a, "org.bluez.Adapter1", "StopDiscovery").await;
                    }
                }
            }
            return;
        }
    }
}

// ---- handlers ------------------------------------------------------------

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, msg.into()).into_response()
}

pub(super) async fn get_bluetooth() -> Response {
    let c = match bus().await {
        Ok(c) => c,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    let m = match managed(c).await {
        Ok(m) => m,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    let Some(adapter) = adapter_path(&m) else {
        return Json(serde_json::json!({ "adapter": false })).into_response();
    };
    let a = &m[&OwnedObjectPath::try_from(adapter.as_str()).unwrap()]["org.bluez.Adapter1"];
    Json(serde_json::json!({
        "adapter": true,
        "powered": get::<bool>(a, "Powered").unwrap_or(false),
        "scanning": SCAN_UNTIL.lock().unwrap().is_some(),
        "devices": devices(&m, &adapter),
        "prompt": PROMPT.lock().unwrap().as_ref().map(|(p, _)| p.clone()),
    }))
    .into_response()
}

async fn adapter(c: &Connection) -> Result<String, Response> {
    let m = managed(c).await.map_err(|e| err(StatusCode::SERVICE_UNAVAILABLE, e))?;
    adapter_path(&m).ok_or_else(|| err(StatusCode::NOT_FOUND, "no Bluetooth adapter"))
}

#[derive(Deserialize)]
pub(super) struct PowerReq {
    on: bool,
}

pub(super) async fn put_power(Json(req): Json<PowerReq>) -> Response {
    let c = match bus().await {
        Ok(c) => c,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    let a = match adapter(c).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    match set_prop(c, &a, "org.bluez.Adapter1", "Powered", Value::from(req.on)).await {
        Ok(()) => Json(serde_json::json!({ "on": req.on })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
pub(super) struct ScanReq {
    secs: u64,
}

pub(super) async fn post_scan(Json(req): Json<ScanReq>) -> Response {
    let c = match bus().await {
        Ok(c) => c,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    let a = match adapter(c).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let secs = req.secs.min(120);
    if secs == 0 {
        let was = SCAN_UNTIL.lock().unwrap().take().is_some();
        if was {
            let _ = call(c, &a, "org.bluez.Adapter1", "StopDiscovery").await;
        }
        return Json(serde_json::json!({ "scanning": false })).into_response();
    }
    let started = {
        let mut until = SCAN_UNTIL.lock().unwrap();
        let was = until.is_some();
        *until = Some(Instant::now() + Duration::from_secs(secs));
        !was
    };
    if started {
        if let Err(e) = call(c, &a, "org.bluez.Adapter1", "StartDiscovery").await {
            *SCAN_UNTIL.lock().unwrap() = None;
            return err(StatusCode::BAD_REQUEST, e);
        }
        tokio::spawn(scan_watchdog());
    }
    Json(serde_json::json!({ "scanning": true, "secs": secs })).into_response()
}

async fn device(addr: &str) -> Result<(&'static Connection, String, String), Response> {
    if addr.len() != 17 || !addr.split(':').all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit())) {
        return Err(err(StatusCode::BAD_REQUEST, "bad address"));
    }
    let c = bus().await.map_err(|e| err(StatusCode::SERVICE_UNAVAILABLE, e))?;
    let a = adapter(c).await?;
    let path = device_path(&a, addr);
    Ok((c, a, path))
}

/// Trust (so it reconnects by itself), connect, and for audio devices switch
/// the output to it.
async fn trust_connect(c: &Connection, path: &str, addr: &str, audio: bool) -> Result<(), String> {
    set_prop(c, path, "org.bluez.Device1", "Trusted", Value::from(true)).await?;
    call(c, path, "org.bluez.Device1", "Connect").await?;
    if audio {
        let addr = addr.to_string();
        tokio::task::spawn_blocking(move || super::audio::use_bluetooth_output(&addr, Duration::from_secs(10)));
    }
    Ok(())
}

async fn is_audio(c: &Connection, a: &str, addr: &str) -> bool {
    managed(c)
        .await
        .map(|m| devices(&m, a).iter().any(|d| d.address.eq_ignore_ascii_case(addr) && d.kind == "audio"))
        .unwrap_or(false)
}

pub(super) async fn post_pair(Path(addr): Path<String>) -> Response {
    let (c, a, path) = match device(&addr).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    ensure_agent(c).await;
    let audio = is_audio(c, &a, &addr).await;
    // A scan in progress slows pairing down on many adapters.
    if SCAN_UNTIL.lock().unwrap().take().is_some() {
        let _ = call(c, &a, "org.bluez.Adapter1", "StopDiscovery").await;
    }
    let paired = call(c, &path, "org.bluez.Device1", "Pair").await;
    clear_prompt(Some(&addr));
    match paired {
        Ok(()) => {}
        Err(e) if e.contains("AlreadyExists") => {}
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    }
    match trust_connect(c, &path, &addr, audio).await {
        Ok(()) => Json(serde_json::json!({ "paired": true, "connected": true })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, format!("Paired, but connecting failed: {e}")),
    }
}

#[derive(Deserialize)]
pub(super) struct PromptReq {
    id: u64,
    accept: bool,
    passkey: Option<u32>,
}

pub(super) async fn post_prompt(Json(req): Json<PromptReq>) -> Response {
    let mut p = PROMPT.lock().unwrap();
    let Some((q, tx)) = p.as_mut().filter(|(q, _)| q.id == req.id) else {
        return err(StatusCode::CONFLICT, "That pairing request is over.");
    };
    if !req.accept {
        // Dropping the sender rejects it; for a code to type there is no
        // question pending, so cancel the pairing itself.
        let (addr, typed) = (q.address.clone(), tx.is_none());
        *p = None;
        drop(p);
        if typed {
            tokio::spawn(async move {
                if let Ok((c, _, path)) = device(&addr).await {
                    let _ = call(c, &path, "org.bluez.Device1", "CancelPairing").await;
                }
            });
        }
        return Json(serde_json::json!({ "ok": true })).into_response();
    }
    let answer = match (q.kind, req.passkey) {
        ("enter", Some(n)) if n <= 999_999 => Answer::Passkey(n),
        ("enter", _) => return err(StatusCode::BAD_REQUEST, "Enter the 6-digit code."),
        _ => Answer::Accept,
    };
    if let Some(tx) = tx.take() {
        let _ = tx.send(answer);
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

pub(super) async fn post_connect(Path(addr): Path<String>) -> Response {
    let (c, a, path) = match device(&addr).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let audio = is_audio(c, &a, &addr).await;
    match trust_connect(c, &path, &addr, audio).await {
        Ok(()) => Json(serde_json::json!({ "connected": true })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

pub(super) async fn post_disconnect(Path(addr): Path<String>) -> Response {
    let (c, _, path) = match device(&addr).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    match call(c, &path, "org.bluez.Device1", "Disconnect").await {
        Ok(()) => Json(serde_json::json!({ "connected": false })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

pub(super) async fn post_audio(Path(addr): Path<String>) -> Response {
    if let Err(r) = device(&addr).await {
        return r;
    }
    let switched = tokio::task::spawn_blocking(move || super::audio::use_bluetooth_output(&addr, Duration::from_secs(2)))
        .await
        .unwrap_or(false);
    if switched {
        Json(serde_json::json!({ "default": true })).into_response()
    } else {
        err(StatusCode::CONFLICT, "This device has no audio output right now; connect it first.")
    }
}

pub(super) async fn delete_device(Path(addr): Path<String>) -> Response {
    let (c, a, path) = match device(&addr).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let p = zbus::zvariant::ObjectPath::try_from(path.as_str()).unwrap();
    match c.call_method(Some(BLUEZ), a.as_str(), Some("org.bluez.Adapter1"), "RemoveDevice", &(p,)).await {
        Ok(_) => Json(serde_json::json!({ "removed": true })).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, bluez_error(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::kind;

    #[test]
    fn kinds() {
        assert_eq!(kind("WH-1000XM4", "audio-headset", None, &[]), "audio");
        assert_eq!(kind("K380", "input-keyboard", None, &[]), "keyboard");
        assert_eq!(kind("T2_remote_RC001", "", None, &[]), "remote");
        assert_eq!(kind("iPhone", "phone", None, &[]), "phone");
        // no icon: class of device (major 4 = audio/video)
        assert_eq!(kind("Speaker", "", Some(0x240414), &[]), "audio");
        // no icon or class: services
        assert_eq!(kind("Pad", "", None, &["00001812-0000-1000-8000-00805f9b34fb".into()]), "keyboard");
        assert_eq!(kind("Tag", "", None, &[]), "other");
    }
}
