//! Accepting a Wi-Fi network's sign-in page by itself, for the kind of page
//! that asks for nothing but one tap: Cisco Meraki's click-through splash
//! page (`https://<shard>.network-auth.com/splash/<id>/…`, whose "Continue to
//! the Internet" button is a link to `…/splash/<id>/grant?continue_url=…`).
//! Hotels and venues show it again from time to time (the first one seen came
//! back after half an hour), and until it is accepted again nothing gets
//! through.
//!
//! On by default for a network once its page is recognised; the user can
//! turn it off per network (settings `portal_kinds` and `portal_auto_off`;
//! the Wi-Fi page's switch, PUT /api/network/portal/auto).
//!
//! Every `EVERY`, while Wi-Fi is connected:
//! - on a network with automatic acceptance on, Apple's probe page is asked
//!   over Wi-Fi (portal::probe), so the page coming back is caught within
//!   `EVERY` rather than NetworkManager's 60 s;
//! - on any other network only while NetworkManager reports a portal, and
//!   once per such episode, to recognise the page.
//!
//! A recognised page is accepted as a tap on its button would: the splash
//! page is loaded and its grant link followed, with the page's cookie, by
//! curl (TLS and certificates) through a private portal proxy (Wi-Fi only,
//! the Wi-Fi's DNS). Nothing is typed or submitted, no other host is
//! followed. NetworkManager then checks again, so the LED and the panel
//! follow at once. At most one try per `RETRY`; after `MAX_FAILS` failed
//! tries in a row it waits until Wi-Fi changes network or the user turns it
//! on again (`wake`). The last outcome per network is kept for the Wi-Fi
//! page (`status`).
//!
//! Testing (panel/tools/fake-captive-portal.sh up meraki): with
//! T6_PANELD_FAKE_PORTAL_HOST set, a page on that host over plain http
//! counts as a Meraki page too.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

use crate::portal::{self, Probe};
use t6_hw_rs::network::Connectivity;

const EVERY: Duration = Duration::from_secs(15);
const RETRY: Duration = Duration::from_secs(60);
const MAX_FAILS: u32 = 3;
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// The last try on one network. `why` is empty when it worked, else one of
/// signon (the page asks for an account), unknown (not a page this accepts),
/// network (the page didn't load), grant (the grant was refused), still
/// (still no internet afterwards).
#[derive(Clone, Serialize)]
struct Outcome {
    at: String,
    ok: bool,
    why: &'static str,
}

#[derive(Default)]
struct State {
    ssid: String,
    fails: u32,
    next_try: Option<Instant>,
    /// The page of this portal episode on a not yet recognised network was looked at.
    looked: bool,
    last: HashMap<String, Outcome>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static WAKE: Notify = Notify::const_new();

fn with<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(State::default))
}

pub fn start() {
    tokio::spawn(async {
        loop {
            round().await;
            tokio::select! {
                _ = tokio::time::sleep(EVERY) => {}
                _ = WAKE.notified() => {}
            }
        }
    });
}

/// Look now, with a clean slate (automatic acceptance was just turned on).
pub fn wake() {
    with(|st| {
        st.fails = 0;
        st.next_try = None;
        st.looked = false;
    });
    WAKE.notify_one();
}

/// For /api/panel's `network.wifi.portal_auto`: whether `ssid`'s sign-in
/// page can be accepted automatically, whether it is, and the last try.
pub fn status(set: &crate::settings::Settings, ssid: &str) -> Value {
    let supported = set.portal_kinds.contains_key(ssid);
    let on = supported && !set.portal_auto_off.iter().any(|x| x == ssid);
    let last = with(|st| st.last.get(ssid).cloned());
    json!({ "supported": supported, "on": on, "last": last })
}

async fn round() {
    let link = tokio::task::spawn_blocking(t6_hw_rs::network::wifi_link).await.ok().flatten();
    let Some(link) = link else {
        with(|st| {
            st.ssid.clear();
            st.fails = 0;
            st.next_try = None;
            st.looked = false;
        });
        return;
    };
    let set = crate::settings::load();
    let known = set.portal_kinds.contains_key(&link.ssid);
    let off = set.portal_auto_off.iter().any(|x| x == &link.ssid);
    let behind = link.connectivity == Connectivity::Portal;
    let go = with(|st| {
        if st.ssid != link.ssid {
            st.ssid = link.ssid.clone();
            st.fails = 0;
            st.next_try = None;
            st.looked = false;
        }
        if !behind {
            st.looked = false;
        }
        if st.fails >= MAX_FAILS || st.next_try.is_some_and(|t| Instant::now() < t) {
            return false;
        }
        (known && !off) || (behind && !known && !st.looked)
    });
    if !go {
        return;
    }
    let url = match portal::probe().await {
        Ok(Probe::Online) => {
            with(|st| st.fails = 0);
            return;
        }
        Ok(Probe::Redirect(url)) => url,
        // can't tell from here; NetworkManager will say
        Ok(Probe::Other(_)) | Err(_) => {
            with(|st| st.looked = true);
            return;
        }
    };
    with(|st| {
        st.looked = true;
        st.next_try = Some(Instant::now() + RETRY);
    });
    let ssid = link.ssid;
    let outcome = attempt(&ssid, &url, !off).await;
    let recognised = crate::settings::load().portal_kinds.contains_key(&ssid);
    let at = chrono::Local::now().format("%H:%M").to_string();
    match outcome {
        Ok(true) => {
            eprintln!("portal: {ssid}: accepted the sign-in page");
            with(|st| {
                st.fails = 0;
                st.last.insert(ssid, Outcome { at, ok: true, why: "" });
            });
        }
        Ok(false) => eprintln!("portal: {ssid}: sign-in page recognised; automatic acceptance is off"),
        Err(why) => {
            eprintln!("portal: {ssid}: sign-in page not accepted ({why}): {url}");
            with(|st| {
                st.fails += 1;
                // a network without the switch has nowhere to show it
                if recognised {
                    st.last.insert(ssid, Outcome { at, ok: false, why });
                }
            });
        }
    }
    crate::netinfo::invalidate();
}

/// Load the sign-in page at `url`; if it is a Meraki click-through page,
/// remember the network as such and, if `grant`, accept it. Ok(true):
/// accepted and the internet is reachable; Ok(false): recognised only.
async fn attempt(ssid: &str, url: &str, grant: bool) -> Result<bool, &'static str> {
    let Some((origin, id)) = meraki_page(url) else { return Err("unknown") };
    let proxy = portal::spawn().await.map_err(|_| "network")?;
    let jar = Jar::new();
    let html = curl(proxy.port, &jar, url, true).await.map_err(|e| {
        eprintln!("portal: {ssid}: loading the sign-in page: {e}");
        "network"
    })?;
    let link = match classify(&html, &origin, &id) {
        Page::Click(link) => link,
        Page::SignOn => return Err("signon"),
        Page::Unknown => return Err("unknown"),
    };
    if let Err(e) = crate::settings::set_portal_kind(ssid, "meraki") {
        eprintln!("portal: {ssid}: remembering the page: {e}");
    }
    if !grant {
        return Ok(false);
    }
    curl(proxy.port, &jar, &link, false).await.map_err(|e| {
        eprintln!("portal: {ssid}: accepting: {e}");
        "grant"
    })?;
    drop(proxy);
    // NetworkManager checks again (the LED and the panel follow), and so do we.
    let nm = tokio::task::spawn_blocking(t6_hw_rs::network::check_connectivity).await.ok().and_then(Result::ok);
    if nm == Some(Connectivity::Full) || portal::probe().await == Ok(Probe::Online) {
        Ok(true)
    } else {
        Err("still")
    }
}

/// curl through the portal proxy on `port`, with the cookie jar. A page
/// must answer 200 and is returned; otherwise any 2xx or 3xx will do.
async fn curl(port: u16, jar: &Jar, url: &str, page: bool) -> Result<String, String> {
    let out = tokio::process::Command::new("curl")
        .args(["-sS", "--max-time", "20", "--max-filesize", "1048576", "--noproxy", "", "-A", UA, "-w", "\n%{http_code}"])
        .arg("--proxy")
        .arg(format!("http://127.0.0.1:{port}"))
        .arg("--cookie")
        .arg(&jar.0)
        .arg("--cookie-jar")
        .arg(&jar.0)
        .arg(url)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("curl: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (body, code) = stdout.rsplit_once('\n').unwrap_or(("", &stdout));
    let code: u16 = code.trim().parse().unwrap_or(0);
    let fine = if page { code == 200 } else { (200..400).contains(&code) };
    if !fine {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("HTTP {code} {}", err.trim()));
    }
    Ok(body.to_string())
}

/// A cookie file for one try, removed afterwards.
struct Jar(std::path::PathBuf);

impl Jar {
    fn new() -> Self {
        Jar(std::env::temp_dir().join(format!("t6-paneld-portal-{:016x}.cookies", rand::random::<u64>())))
    }
}

impl Drop for Jar {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The Meraki splash page `url` points at: its origin ("https://host") and
/// splash id. None for anything else.
fn meraki_page(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let (host, path) = rest.split_once('/')?;
    let host = host.to_ascii_lowercase();
    let meraki = scheme == "https" && host.ends_with(".network-auth.com");
    let fake = scheme == "http" && std::env::var("T6_PANELD_FAKE_PORTAL_HOST").is_ok_and(|h| !h.is_empty() && h == host);
    if !meraki && !fake {
        return None;
    }
    let mut parts = path.split('/');
    if parts.next()? != "splash" {
        return None;
    }
    let id = parts.next().filter(|id| !id.is_empty())?;
    Some((format!("{scheme}://{host}"), id.to_string()))
}

#[derive(Debug, PartialEq)]
enum Page {
    /// One tap: the grant link.
    Click(String),
    /// Asks for an account (Meraki's sign-on splash).
    SignOn,
    Unknown,
}

/// What the splash page asks for. Only a page with no form at all and a
/// grant link on the same host and splash id counts as one tap.
fn classify(html: &str, origin: &str, id: &str) -> Page {
    let lower = html.to_ascii_lowercase();
    if ["type=\"password\"", "type='password'", "type=password"].iter().any(|p| lower.contains(p)) {
        return Page::SignOn;
    }
    if lower.contains("<form") {
        return Page::Unknown;
    }
    let absolute = format!("{origin}/splash/{id}/grant?");
    let relative = format!("/splash/{id}/grant?");
    for href in hrefs(html) {
        let href = unescape(href);
        if href.starts_with(&absolute) {
            return Page::Click(href);
        }
        if href.starts_with(&relative) {
            return Page::Click(format!("{origin}{href}"));
        }
    }
    Page::Unknown
}

/// The values of every href="…" / href='…' in `html`.
fn hrefs(html: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("href=") {
        rest = &rest[i + 5..];
        let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue };
        rest = &rest[1..];
        let Some(end) = rest.find(quote) else { break };
        out.push(&rest[..end]);
        rest = &rest[end + 1..];
    }
    out
}

/// The HTML character references a URL in an attribute uses (`&amp;` last,
/// so nothing is unescaped twice).
fn unescape(s: &str) -> String {
    s.replace("&#x2F;", "/")
        .replace("&#x2f;", "/")
        .replace("&#47;", "/")
        .replace("&#x3A;", ":")
        .replace("&#x3a;", ":")
        .replace("&#58;", ":")
        .replace("&#x3D;", "=")
        .replace("&#61;", "=")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hotel's real click-through page (2026-10-30), its query values
    /// replaced: the button is a plain link, the page's script mentions
    /// /grant and /login only in templates.
    const MERAKI_CLICK: &str = r#"<html><head><base href="https://eu.network-auth.com/splash/-Q-Jscgd.5.1125/asset/" /></head><body>
<h1>Welcome to MICRO 2026 Athens</h1>
<a class="button" href="https://eu.network-auth.com/splash/-Q-Jscgd.5.1125/grant?continue_url=https:&#x2F;&#x2F;www.example.com" onclick = "javascript:(function(continue_button) {
  var url = 'https://eu.network-auth.com/splash/-Q-Jscgd.5.1125/grant?continue_url=CONTINUE_URL_PLACEHOLDER';
})(this)">Continue to the Internet</a>
<script>var u = '/splash/-Q-Jscgd.5.1125/login?continue_url=CONTINUE_URL_PLACEHOLDER';
var sign_in_button = document.getElementById('sign_in') || document.getElementById('submit_button');</script>
</body></html>"#;

    const ORIGIN: &str = "https://eu.network-auth.com";
    const ID: &str = "-Q-Jscgd.5.1125";

    #[test]
    fn recognises_the_click_through_page() {
        assert_eq!(
            classify(MERAKI_CLICK, ORIGIN, ID),
            Page::Click("https://eu.network-auth.com/splash/-Q-Jscgd.5.1125/grant?continue_url=https://www.example.com".into())
        );
        // another splash id's link is not ours to follow
        assert_eq!(classify(MERAKI_CLICK, ORIGIN, "other.1"), Page::Unknown);
        // a relative link
        let rel = r#"<a href="/splash/abc/grant?continue_url=x&amp;duration=3600">Continue</a>"#;
        assert_eq!(classify(rel, ORIGIN, "abc"), Page::Click("https://eu.network-auth.com/splash/abc/grant?continue_url=x&duration=3600".into()));
    }

    #[test]
    fn leaves_pages_that_ask_for_more() {
        let signon = r#"<form action="/splash/abc/login" method="post"><input name="email"><input type="password" name="password"></form>"#;
        assert_eq!(classify(signon, ORIGIN, "abc"), Page::SignOn);
        let terms = r#"<form action="/splash/abc/grant"><input type="checkbox" name="agree"><button>Go</button></form>"#;
        assert_eq!(classify(terms, ORIGIN, "abc"), Page::Unknown);
        assert_eq!(classify("<html>Welcome</html>", ORIGIN, "abc"), Page::Unknown);
    }

    #[test]
    fn only_meraki_splash_pages() {
        let url = "https://eu.network-auth.com/splash/-Q-Jscgd.5.1125/?mac=6C%3AC3&continue_url=http%3A%2F%2Fcaptive.apple.com%2F";
        assert_eq!(meraki_page(url), Some((ORIGIN.into(), ID.into())));
        assert_eq!(meraki_page("http://eu.network-auth.com/splash/x/"), None); // not https
        assert_eq!(meraki_page("https://network-auth.com.evil.example/splash/x/"), None);
        assert_eq!(meraki_page("https://n1.network-auth.com/login/x/"), None);
        assert_eq!(meraki_page("https://portal.example.com/splash/x/"), None);
    }

    #[test]
    fn href_values() {
        assert_eq!(hrefs(r#"<a href="a">x</a><a href='b'>y</a><link href=c>"#), vec!["a", "b"]);
        assert_eq!(unescape("a&amp;#x2F;b&#x2F;c"), "a&#x2F;b/c");
    }
}
