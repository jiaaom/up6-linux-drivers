//! Native fnOS WebSocket RPC client (the `com.trim.main` protocol).
//!
//! Reverse-engineered from the `fnos` npm package and validated live against
//! fnOS 1.2.0605; full protocol writeup in `Workspace/refs/fnos-ws-protocol.md`.
//! Reimplemented here in Rust so the panel never ships a third-party binary and
//! never hands credentials to unaudited code.
//!
//! Flow: connect `ws://host/websocket?type=main` → `util.crypto.getRSAPub`
//! (pub + session id) → `appcgi.sysinfo.getHostName` → hybrid-encrypted
//! `user.loginIntl` (RSA-wrapped AES key + AES-CBC payload) → response carries an
//! AES-encrypted `secret` we decrypt into the HMAC key. Every authenticated call
//! is one WS text frame: `base64(HMAC-SHA256(json, key)) + json`.
//!
//! A background task owns the socket: it routes responses to callers by `reqid`
//! and sends a 30 s heartbeat. Callers use [`FnosClient::request`].

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use rsa::pkcs8::DecodePublicKey;
use rsa::{Pkcs1v15Encrypt, RsaPublicKey};
use sha2::Sha256;

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type HmacSha256 = Hmac<Sha256>;
const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

const WS_URL: &str = "ws://127.0.0.1:5666/websocket?type=main";

/// What a successful login yields. `hmac_key` signs subsequent calls; `ticket`
/// is the persistable credential for reboot-resume (see the module's callers).
#[derive(Clone)]
pub struct Session {
    pub uid: i64,
    pub admin: bool,
    pub username: String,
    pub ticket: String,
    pub machine_id: String,
    hmac_key: Vec<u8>,
    /// The fnOS `ost` session cookie, minted from `ticket` via `POST /app/ticket`
    /// (see `mint_preview_cookie`). Used only to authenticate the embedded
    /// Preview iframe (`/app/trim-preview/`) — a separate, cookie-based auth
    /// surface from our WS/HMAC one. `None` if minting failed (preview simply
    /// won't be available; every other feature is unaffected).
    pub preview_cookie: Option<String>,
}

enum Cmd {
    Request { frame: String, reqid: String, resp: oneshot::Sender<Value> },
    /// A streaming request (e.g. `appcgi.finder.fileSearch`): the server sends
    /// many frames sharing this `reqid` (intermediate ones with `result:"doing"`,
    /// a terminal one with `result != "doing"`). Every frame is forwarded on the
    /// channel; the reader drops the registration on the terminal frame or when
    /// the receiver is gone.
    Stream { frame: String, reqid: String, tx: mpsc::Sender<Value> },
}

/// A live, authenticated fnOS connection. Cloneable handle onto one socket.
#[derive(Clone)]
pub struct FnosClient {
    tx: mpsc::Sender<Cmd>,
    pub session: Session,
}


fn reqid() -> String {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut r = [0u8; 6];
    rand::rngs::OsRng.fill_bytes(&mut r);
    format!("{ts}{}", hex(&r))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn gen_did() -> String {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut a = [0u8; 6];
    let mut b = [0u8; 6];
    rand::rngs::OsRng.fill_bytes(&mut a);
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("{}-{}-{}", hex(&ts.to_le_bytes()[..4]), hex(&a), hex(&b))
}

fn rsa_encrypt(data: &[u8], pem: &str) -> Result<String, String> {
    let key = RsaPublicKey::from_public_key_pem(pem.trim()).map_err(|e| format!("bad rsa pub: {e}"))?;
    let enc = key.encrypt(&mut rand::rngs::OsRng, Pkcs1v15Encrypt, data).map_err(|e| format!("rsa enc: {e}"))?;
    Ok(B64.encode(enc))
}

fn aes_cbc_encrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Vec<u8> {
    Aes256CbcEnc::new(key.into(), iv.into()).encrypt_padded_vec_mut::<Pkcs7>(data)
}

fn aes_cbc_decrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, String> {
    Aes256CbcDec::new(key.into(), iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .map_err(|e| format!("aes decrypt: {e}"))
}

fn hmac_b64(json: &str, key: &[u8]) -> String {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac key");
    m.update(json.as_bytes());
    B64.encode(m.finalize().into_bytes())
}

/// Exchange our WS-login `ticket` for the fnOS browser session cookie (`ost`),
/// by calling the same endpoint the web login page's JS calls after a
/// successful sign-in: `POST /app/ticket {"ticket": ...}` → `Set-Cookie: ost=...`.
/// This is a *separate* auth surface from our WS/HMAC one (used only to
/// authenticate the embedded Preview iframe, which speaks plain cookie-gated
/// HTTP) — reverse-engineered and documented in `refs/fnos-preview-app.md`.
/// Shells `curl` (already used for the firmware check) rather than pulling in
/// an HTTP client crate. Best-effort: `None` on any failure.
fn mint_preview_cookie(ticket: &str) -> Option<String> {
    let body = json!({ "ticket": ticket }).to_string();
    let out = std::process::Command::new("curl")
        .args([
            "-s", "-D", "-", "-o", "/dev/null",
            "--connect-timeout", "5", "--max-time", "10",
            "-X", "POST", "http://127.0.0.1:5666/app/ticket",
            "-H", "Content-Type: application/json",
            "-d", &body,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let headers = String::from_utf8_lossy(&out.stdout);
    // Header line looks like: `Set-Cookie: ost=<value>; Path=/; HttpOnly; SameSite=Lax`
    headers.lines().find_map(|line| {
        let rest = line.strip_prefix("Set-Cookie:").or_else(|| line.strip_prefix("set-cookie:"))?;
        let value = rest.trim().split(';').next()?;
        value.strip_prefix("ost=").map(str::to_string)
    })
}

/// Read frames until `pred` returns a value, ignoring `pong`/unrelated frames.
async fn read_until<S, F, T>(read: &mut S, pred: F) -> Result<T, String>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    F: Fn(&Value) -> Option<T>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let msg = tokio::time::timeout_at(deadline, read.next())
            .await
            .map_err(|_| "handshake timeout".to_string())?
            .ok_or("connection closed")?
            .map_err(|e| format!("ws: {e}"))?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            _ => continue,
        };
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(out) = pred(&v) {
                return Ok(out);
            }
        }
    }
}

impl FnosClient {
    /// Connect, complete the handshake, and log in with a password.
    pub async fn login(user: &str, password: &str) -> Result<FnosClient, String> {
        let (ws, _) = tokio_tungstenite::connect_async(WS_URL).await.map_err(|e| format!("connect: {e}"))?;
        let (mut write, mut read) = ws.split();

        // 1) RSA public key + session id
        write.send(Message::Text(json!({"reqid": reqid(), "req": "util.crypto.getRSAPub"}).to_string()))
            .await.map_err(|e| format!("send getRSAPub: {e}"))?;
        let (pubkey, si) = read_until(&mut read, |v| {
            match (v.get("pub").and_then(|x| x.as_str()), v.get("si")) {
                (Some(p), Some(s)) => Some((p.to_string(), s.clone())),
                _ => None,
            }
        }).await?;

        // 2) complete the handshake
        write.send(Message::Text(json!({"reqid": reqid(), "req": "appcgi.sysinfo.getHostName"}).to_string()))
            .await.map_err(|e| format!("send getHostName: {e}"))?;
        read_until(&mut read, |v| v.get("data").and_then(|d| d.get("hostName")).map(|_| ())).await?;

        // 3) hybrid-encrypted login (1.2.0605: req=user.loginIntl, ver:2)
        let mut aes_key = [0u8; 32];
        let mut iv = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut aes_key);
        rand::rngs::OsRng.fill_bytes(&mut iv);
        let login_reqid = reqid();
        let payload = json!({
            "reqid": login_reqid, "user": user, "password": password, "stay": true,
            "deviceType": "Browser", "deviceName": "T6-Panel", "did": gen_did(),
            "ver": 2, "req": "user.loginIntl", "si": si,
        });
        let envelope = json!({
            "req": "encrypted",
            "iv": B64.encode(iv),
            "rsa": rsa_encrypt(&aes_key, &pubkey)?,
            "aes": B64.encode(aes_cbc_encrypt(payload.to_string().as_bytes(), &aes_key, &iv)),
        });
        write.send(Message::Text(envelope.to_string())).await.map_err(|e| format!("send login: {e}"))?;

        let resp = read_until(&mut read, |v| {
            if v.get("secret").and_then(|s| s.as_str()).is_some() && (v.get("uid").is_some() || v.get("ticket").is_some()) {
                Some(Ok(v.clone()))
            } else if v.get("result").and_then(|r| r.as_str()) == Some("fail") || v.get("errno").is_some() {
                Some(Err(v.clone()))
            } else {
                None
            }
        }).await?;
        let resp = resp.map_err(|v| {
            let errno = v.get("errno").and_then(|e| e.as_i64()).unwrap_or(0);
            format!("login rejected (errno {errno})")
        })?;

        // The `secret` is AES-encrypted with our session key; decrypt → HMAC key.
        let secret_b64 = resp.get("secret").and_then(|s| s.as_str()).ok_or("no secret")?;
        let hmac_key = aes_cbc_decrypt(&B64.decode(secret_b64).map_err(|e| e.to_string())?, &aes_key, &iv)?;
        let ticket = resp.get("ticket").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let preview_cookie = mint_preview_cookie(&ticket);
        let session = Session {
            uid: resp.get("uid").and_then(|x| x.as_i64()).unwrap_or(-1),
            admin: resp.get("admin").and_then(|x| x.as_bool()).unwrap_or(false),
            username: user.to_string(),
            machine_id: resp.get("machineId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            hmac_key,
            ticket,
            preview_cookie,
        };

        // 4) hand the socket to a background router + heartbeat task
        let (tx, mut rx) = mpsc::channel::<Cmd>(32);
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let streaming: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let pending_rx = pending.clone();
        let streaming_rx = streaming.clone();
        tokio::spawn(async move {
            let mut hb = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    cmd = rx.recv() => match cmd {
                        Some(Cmd::Request { frame, reqid, resp }) => {
                            pending.lock().await.insert(reqid, resp);
                            if write.send(Message::Text(frame)).await.is_err() { break; }
                        }
                        Some(Cmd::Stream { frame, reqid, tx }) => {
                            streaming.lock().await.insert(reqid, tx);
                            if write.send(Message::Text(frame)).await.is_err() { break; }
                        }
                        None => break, // all handles dropped
                    },
                    _ = hb.tick() => {
                        if write.send(Message::Text(json!({"req": "ping"}).to_string())).await.is_err() { break; }
                    }
                }
            }
        });
        tokio::spawn(async move {
            while let Some(Ok(msg)) = read.next().await {
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if let Some(id) = v.get("reqid").and_then(|x| x.as_str()).map(|s| s.to_string()) {
                        // Streaming request? Forward every frame; a frame whose
                        // `result` is present and not "doing" is terminal.
                        let is_stream = streaming_rx.lock().await.contains_key(&id);
                        if is_stream {
                            let terminal = v.get("result").and_then(|r| r.as_str())
                                .map_or(false, |r| r != "doing");
                            let send_ok = match streaming_rx.lock().await.get(&id) {
                                Some(ch) => ch.send(v).await.is_ok(),
                                None => false,
                            };
                            if terminal || !send_ok {
                                streaming_rx.lock().await.remove(&id);
                            }
                            continue;
                        }
                        if let Some(tx) = pending_rx.lock().await.remove(&id) {
                            let _ = tx.send(v);
                        }
                    }
                }
            }
        });

        Ok(FnosClient { tx, session })
    }

    /// Make an authenticated RPC. `params` is merged with `req`/`reqid`, signed,
    /// and sent as one frame; resolves with the JSON response.
    pub async fn request(&self, req: &str, params: Value) -> Result<Value, String> {
        let id = reqid();
        let mut obj = params.as_object().cloned().unwrap_or_default();
        obj.insert("req".into(), json!(req));
        obj.insert("reqid".into(), json!(id));
        let jsontext = Value::Object(obj).to_string();
        let frame = format!("{}{}", hmac_b64(&jsontext, &self.session.hmac_key), jsontext);

        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx.send(Cmd::Request { frame, reqid: id, resp: resp_tx })
            .await.map_err(|_| "fnos connection closed".to_string())?;
        tokio::time::timeout(Duration::from_secs(10), resp_rx)
            .await.map_err(|_| format!("request {req} timed out"))?
            .map_err(|_| "response dropped".to_string())
    }

    /// Make a *streaming* RPC (e.g. `appcgi.finder.fileSearch`). Collects every
    /// frame the server sends under this request's `reqid` until a terminal
    /// frame (`result != "doing"`) arrives or `budget` elapses, then returns all
    /// collected frames in order. On timeout the collected frames so far are
    /// returned (partial results) — callers can treat that as "capped".
    pub async fn request_stream(&self, req: &str, params: Value, budget: Duration) -> Result<Vec<Value>, String> {
        let id = reqid();
        let mut obj = params.as_object().cloned().unwrap_or_default();
        obj.insert("req".into(), json!(req));
        obj.insert("reqid".into(), json!(id));
        let jsontext = Value::Object(obj).to_string();
        let frame = format!("{}{}", hmac_b64(&jsontext, &self.session.hmac_key), jsontext);

        let (tx, mut rx) = mpsc::channel::<Value>(64);
        self.tx.send(Cmd::Stream { frame, reqid: id, tx })
            .await.map_err(|_| "fnos connection closed".to_string())?;

        let mut frames = Vec::new();
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(f)) => {
                    let terminal = f.get("result").and_then(|r| r.as_str())
                        .map_or(false, |r| r != "doing");
                    frames.push(f);
                    if terminal { break; }
                }
                Ok(None) => break,   // registration dropped (shouldn't happen mid-stream)
                Err(_) => break,     // budget elapsed — return partial
            }
        }
        Ok(frames)
    }
}

// ---------------------------------------------------------------------------
// Process-wide session + panel-facing API.
//
// One signed-in fnOS session at a time (the panel is single-user, physical
// access). The `ticket` is persisted so a future reboot-resume can re-auth
// without the password; the HMAC secret is NEVER persisted.
// ---------------------------------------------------------------------------

const SESSION_FILE: &str = "/var/lib/t6-paneld/fnos-session.json";

#[derive(serde::Serialize, serde::Deserialize)]
struct Persisted {
    uid: i64,
    ticket: String,
    machine_id: String,
}

fn cell() -> &'static Mutex<Option<FnosClient>> {
    static CLIENT: OnceLock<Mutex<Option<FnosClient>>> = OnceLock::new();
    CLIENT.get_or_init(|| Mutex::new(None))
}

fn persist(s: &Session) {
    let p = Persisted { uid: s.uid, ticket: s.ticket.clone(), machine_id: s.machine_id.clone() };
    if let Ok(json) = serde_json::to_vec(&p) {
        let _ = std::fs::create_dir_all("/var/lib/t6-paneld");
        let tmp = format!("{SESSION_FILE}.tmp");
        if std::fs::write(&tmp, &json).is_ok() {
            // ticket is a credential — keep it root-only.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(&tmp, SESSION_FILE);
        }
    }
}

fn load_persisted() -> Option<Persisted> {
    std::fs::read(SESSION_FILE).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// Sign in with a password; on success the session is held process-wide and the
/// ticket persisted. Returns a non-secret summary for the UI.
pub async fn do_login(user: &str, password: &str) -> Result<Value, String> {
    let client = FnosClient::login(user, password).await?;
    persist(&client.session);
    let summary = json!({ "signedIn": true, "uid": client.session.uid, "admin": client.session.admin, "username": client.session.username });
    *cell().lock().await = Some(client);
    Ok(summary)
}

/// Non-secret sign-in status (and whether a persisted ticket exists to resume).
pub async fn status() -> Value {
    auto_sign_in().await;
    let auto = crate::autologin::meta().map(|m| json!({ "user": m.user }));
    match &*cell().lock().await {
        Some(c) => json!({ "signedIn": true, "uid": c.session.uid, "admin": c.session.admin, "username": c.session.username, "autoLogin": auto }),
        None => json!({ "signedIn": false, "canResume": load_persisted().is_some(), "autoLogin": auto }),
    }
}

/// Sign in, and remember (seal) or forget the credentials for automatic
/// sign-in. A sign-in without "remember" also drops any older remembered one.
pub async fn login_remember(user: &str, password: &str, remember: bool) -> Result<Value, String> {
    let mut v = do_login(user, password).await?;
    if remember {
        match crate::autologin::save(user, password) {
            Ok(m) => v["autoLogin"] = json!({ "user": m.user }),
            Err(e) => v["autoLoginError"] = json!(e),
        }
    } else {
        crate::autologin::clear();
    }
    Ok(v)
}

/// If signed out but credentials are remembered, sign in with them. One
/// attempt at a time, and after a failure (e.g. fnOS still starting at boot)
/// wait 30 s before trying again. A rejected password (changed in fnOS) drops
/// the remembered credentials so the panel asks again.
pub async fn auto_sign_in() -> bool {
    static GATE: OnceLock<Mutex<Option<std::time::Instant>>> = OnceLock::new();
    let mut last_fail = GATE.get_or_init(|| Mutex::new(None)).lock().await;
    if cell().lock().await.is_some() {
        return true;
    }
    if last_fail.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
        return false;
    }
    let Some((user, password)) = crate::autologin::load() else { return false };
    match do_login(&user, &password).await {
        Ok(_) => {
            *last_fail = None;
            true
        }
        Err(e) => {
            if e.starts_with("login rejected") {
                crate::autologin::clear();
            }
            *last_fail = Some(std::time::Instant::now());
            false
        }
    }
}

/// Make an authenticated RPC on the current session (error if not signed in).
///
/// Clone the client handle out of the lock, then release the lock *before* the
/// WS round-trip. `FnosClient` is a cheap cloneable handle onto the one socket
/// (an mpsc sender + session), and the background task already pipelines
/// concurrent requests by reqid — so holding the lock across `request().await`
/// would needlessly serialize every `/api/fnos/*` call behind whichever one is
/// currently in flight (e.g. a slow `notify.list`, or one nearing the 10s
/// timeout), stalling folder listings. Cloning out first lets them run in
/// parallel.
pub async fn call(req: &str, params: Value) -> Result<Value, String> {
    for attempt in 0..2 {
        let client = current_client().await?;
        let resp = client.request(req, params.clone()).await?;
        if !is_session_expired(&resp) {
            return Ok(resp);
        }
        invalidate_session().await;
        if attempt == 0 && auto_sign_in().await {
            continue; // signed back in with the remembered credentials: retry once
        }
        break;
    }
    Err(SESSION_EXPIRED.to_string())
}

/// The live session's client, signing in automatically first if possible.
async fn current_client() -> Result<FnosClient, String> {
    if let Some(c) = cell().lock().await.as_ref() {
        return Ok(c.clone());
    }
    auto_sign_in().await;
    cell().lock().await.as_ref().cloned().ok_or_else(|| "not signed in to fnOS".to_string())
}

/// Streaming variant of [`call`] — see [`FnosClient::request_stream`]. Returns
/// every frame collected within `budget`.
pub async fn call_stream(req: &str, params: Value, budget: Duration) -> Result<Vec<Value>, String> {
    let client = current_client().await?;
    let frames = client.request_stream(req, params, budget).await?;
    if frames.iter().any(is_session_expired) {
        invalidate_session().await;
        return Err(SESSION_EXPIRED.to_string());
    }
    Ok(frames)
}

/// fnOS `errno` for "not logged in" (没有登录): the session ticket is no longer
/// valid server-side even though our WS socket is still open. Our own
/// `status()` can't see this (it only checks the in-memory handle), so a stale
/// session would otherwise surface as an *empty* folder listing rather than a
/// sign-in prompt. Detect it centrally and drop the session.
const ERRNO_NOT_LOGGED_IN: i64 = 4224;
pub const SESSION_EXPIRED: &str = "fnOS session expired — please sign in again";
fn is_session_expired(v: &Value) -> bool {
    v.get("result").and_then(|r| r.as_str()) == Some("fail")
        && v.get("errno").and_then(|e| e.as_i64()) == Some(ERRNO_NOT_LOGGED_IN)
}
/// Drop the dead session so `status()` honestly reports signed-out and the panel
/// re-authenticates instead of showing empty data.
async fn invalidate_session() {
    *cell().lock().await = None;
    let _ = std::fs::remove_file(SESSION_FILE);
}

/// The `ost` cookie value for the current session, if signed in and minting
/// succeeded — for the panel's Electron shell to apply to its own cookie jar
/// before opening the Preview iframe. Not a secret in the same class as the
/// WS HMAC key (it's exactly what a normal browser login would hold), but
/// still a live session credential — callers should treat it as such.
pub async fn preview_cookie() -> Option<String> {
    cell().lock().await.as_ref().and_then(|c| c.session.preview_cookie.clone())
}

/// Sign out: revoke server-side (`user.logout`), drop the live session, and
/// forget the persisted ticket. The RPC is best-effort — we clear locally
/// regardless so the panel never gets stuck "signed in".
pub async fn logout() {
    let mut guard = cell().lock().await;
    if let Some(c) = guard.as_ref() {
        let _ = c.request("user.logout", json!({})).await;
    }
    *guard = None;
    let _ = std::fs::remove_file(SESSION_FILE);
    crate::autologin::clear();
}
