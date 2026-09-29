//! The screensaver window while the screen is dark.
//!
//! `appliance-screensaver` (a tool of appliance-compositor, at the path its
//! runtime contract gives) is a black fullscreen window. Its app-id
//! (`t6-panel-screensaver`) has a rule above every other window on the
//! built-in screen (panel/app/compositor.ini), so while it is up it alone gets
//! keys and touches: nothing reaches the panel or the video player behind a
//! dark screen. It only reports input on stdout; what to do
//! with it is decided here:
//!   volume keys           change the default output's volume, screen stays dark
//!   power/sleep keys      ignored (t6-ledd and logind own them)
//!   any other key         wake the screen
//!   double tap            wake the screen
//!
//! Coordination with the backlight (owned by this process):
//!   off from here (timeout, API)  cover first (the window fades in to black,
//!                                 FADE_IN), backlight off once it is black
//!                                 (`screen_off`); a wake meanwhile cancels
//!                                 the switch-off
//!   off from elsewhere (power     cover as soon as the watcher sees it
//!   button, Control Center)       (the kiosk's own key gate covers the gap)
//!   on (any source)               backlight first, then the window fades
//!                                 out and exits (`fade-out` on its stdin)
//! One supervisor task owns the child process; if it dies while the screen is
//! dark (e.g. the compositor restarted) it is started again.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use t6_hw_rs::display::Display;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

// appliance-compositor's runtime contract (its docs/CONTRACT.md).
const RUNTIME_DIR: &str = "/run/user/0";
const WAYLAND_DISPLAY: &str = "wayland-appliance";
const SCREENSAVER: &str = "/usr/local/lib/appliance-compositor/bin/appliance-screensaver";
const APP_ID: &str = "t6-panel-screensaver";
/// How long a cover requested before switching off may wait for the
/// backlight to actually go off.
const PRE_COVER: Duration = Duration::from_secs(3);
/// Fade to black before switching off (the screen is still lit, so the
/// panel visibly dims out), and back out after switching on. A window put up
/// on an already dark screen comes up black at once.
const FADE_IN_MS: u64 = 400;
const FADE_OUT_MS: u64 = 300;
/// Wait at most this much longer than the fade-in for the window to report
/// it is black, and for a fading-out window to exit.
const GRACE: Duration = Duration::from_millis(800);
/// Retry after a failed start (no weston yet, crash) while the screen is dark.
const RETRY: Duration = Duration::from_secs(3);

// evdev key codes
const KEY_MUTE: u32 = 113;
const KEY_VOLUMEDOWN: u32 = 114;
const KEY_VOLUMEUP: u32 = 115;
/// Power-management keys belong to others (the front power button's
/// KEY_SCREENLOCK to t6-ledd, which just switched the screen off with it;
/// POWER/SLEEP/WAKEUP/SUSPEND to logind): never a reason to wake.
const NOT_WAKE: [u32; 5] = [116, 142, 143, 152, 205];

enum Msg {
    /// Put the window up now (the screen is about to go dark); reply once
    /// it is up, or failed.
    Cover(oneshot::Sender<bool>),
    /// The screen was switched on: drop a pending cover.
    Uncover,
    /// The child's stdout ended.
    Exited(u64),
}

static TX: OnceLock<mpsc::UnboundedSender<Msg>> = OnceLock::new();
/// Counts `screen_on` calls, so a switch-off can tell it was overtaken by a
/// wake while the window faded in.
static WAKES: AtomicU64 = AtomicU64::new(0);
/// Serialises the backlight writes of `screen_off` and `screen_on`: a wake
/// that comes right after the cancel check waits for the switch-off and then
/// switches back on, so the last word is always the wake's. Held only around
/// the write, never while waiting for the window (whose events may wake).
static POWER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Start the supervisor (once, from main, after `backlight::start`).
pub fn start() {
    let (tx, rx) = mpsc::unbounded_channel();
    if TX.set(tx).is_err() {
        return;
    }
    // Looked up at each start (spawn): the compositor may be installed or
    // upgraded while we run.
    tokio::spawn(supervise(PathBuf::from(SCREENSAVER), rx));
}

/// Switch the screen off with the screensaver up (faded to black) first.
/// A wake while it fades in (a key, a double tap, the API) cancels it.
pub async fn screen_off() -> Result<u32, String> {
    let wakes = WAKES.load(Ordering::SeqCst);
    if let Some(tx) = TX.get() {
        let (reply, wait) = oneshot::channel();
        if tx.send(Msg::Cover(reply)).is_ok() {
            let _ = wait.await; // off anyway if it couldn't come up
        }
    }
    let r = {
        let _power = POWER.lock().await;
        if WAKES.load(Ordering::SeqCst) != wakes {
            return Err("switch-off cancelled: the screen was woken meanwhile".into());
        }
        tokio::task::spawn_blocking(|| Display::new().set_power(false))
            .await
            .unwrap_or_else(|e| Err(format!("display worker failed: {e}")))
    };
    crate::backlight::refresh();
    r
}

/// Switch the screen on; the window then fades out.
pub async fn screen_on() -> Result<u32, String> {
    WAKES.fetch_add(1, Ordering::SeqCst);
    let r = {
        let _power = POWER.lock().await;
        tokio::task::spawn_blocking(|| Display::new().set_power(true))
            .await
            .unwrap_or_else(|e| Err(format!("display worker failed: {e}")))
    };
    if let Some(tx) = TX.get() {
        let _ = tx.send(Msg::Uncover);
    }
    crate::backlight::refresh(); // don't wait for the watcher's next poll
    r
}

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    id: u64,
}

async fn supervise(bin: PathBuf, mut rx: mpsc::UnboundedReceiver<Msg>) {
    let mut screen = crate::backlight::subscribe();
    let mut running: Option<Running> = None;
    let mut next_id = 0u64;
    let mut cover_until: Option<Instant> = None;
    let mut retry_at: Option<Instant> = None;
    let mut waiting: Vec<oneshot::Sender<bool>> = Vec::new();

    loop {
        let on = *screen.borrow_and_update();
        let pre_cover = cover_until.is_some_and(|t| Instant::now() < t);
        if !on {
            cover_until = None; // the requested off happened
        }
        let want = (!on || pre_cover) && crate::settings::load().panel_enabled();

        if want && running.is_none() && retry_at.is_none_or(|t| Instant::now() >= t) {
            next_id += 1;
            // Fade in only over a lit screen; on a dark one, black at once.
            let fade_in = if on { FADE_IN_MS } else { 0 };
            match spawn(&bin, next_id, fade_in).await {
                Some(r) => {
                    running = Some(r);
                    retry_at = None;
                }
                None => retry_at = Some(Instant::now() + RETRY),
            }
        }
        if !want {
            if let Some(r) = running.take() {
                tokio::spawn(dismiss(r, on));
            }
            retry_at = None;
        }
        for w in waiting.drain(..) {
            let _ = w.send(running.is_some());
        }

        let retry = async {
            match (want && running.is_none(), retry_at) {
                (true, Some(t)) => tokio::time::sleep_until(t.into()).await,
                _ => std::future::pending().await,
            }
        };
        let pre_cover_end = async {
            match cover_until {
                Some(t) => tokio::time::sleep_until(t.into()).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            r = screen.changed() => if r.is_err() { return },
            msg = rx.recv() => match msg {
                Some(Msg::Cover(reply)) => {
                    cover_until = Some(Instant::now() + PRE_COVER);
                    retry_at = None; // try now
                    waiting.push(reply);
                }
                Some(Msg::Uncover) => cover_until = None,
                Some(Msg::Exited(id)) => {
                    if running.as_ref().is_some_and(|r| r.id == id) {
                        if let Some(mut r) = running.take() {
                            let status = r.child.wait().await;
                            eprintln!("screensaver: exited ({status:?})");
                        }
                        retry_at = Some(Instant::now() + RETRY);
                    }
                }
                None => return,
            },
            _ = retry => {}
            _ = pre_cover_end => cover_until = None,
        }
    }
}

/// Start the window and wait until it reports `ready`. Its events are then
/// handled by a reader task.
/// Take the window down: fade out if the screen is lit (it exits by itself
/// when done), at once if it is dark; killed if it doesn't go in time.
async fn dismiss(mut r: Running, lit: bool) {
    let mut asked = false;
    if lit {
        if let Some(stdin) = r.stdin.as_mut() {
            asked = stdin.write_all(b"fade-out\n").await.is_ok() && stdin.flush().await.is_ok();
        }
    }
    let wait = if asked { Duration::from_millis(FADE_OUT_MS) + GRACE } else { Duration::ZERO };
    if tokio::time::timeout(wait, r.child.wait()).await.is_err() || !asked {
        let _ = r.child.start_kill();
        let _ = r.child.wait().await;
    }
}

async fn spawn(bin: &PathBuf, id: u64, fade_in_ms: u64) -> Option<Running> {
    if !std::path::Path::new(RUNTIME_DIR).join(WAYLAND_DISPLAY).exists() {
        return None; // the compositor isn't running (stopped or starting)
    }
    if !bin.is_file() {
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| eprintln!("screensaver: {} missing; input isn't blocked while the screen is dark", bin.display()));
        return None;
    }
    let mut child = Command::new(bin)
        .args(["--app-id", APP_ID, "--watch-stdin", "--fade-in", &fade_in_ms.to_string(), "--fade-out", &FADE_OUT_MS.to_string()])
        .env("XDG_RUNTIME_DIR", RUNTIME_DIR)
        .env("WAYLAND_DISPLAY", WAYLAND_DISPLAY)
        .stdin(Stdio::piped()) // EOF when we go: it exits with us
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| eprintln!("screensaver: {}: {e}", bin.display()))
        .ok()?;
    let mut lines = BufReader::new(child.stdout.take()?).lines();
    let stdin = child.stdin.take();
    let ready = tokio::time::timeout(Duration::from_millis(fade_in_ms) + GRACE, async {
        while let Ok(Some(l)) = lines.next_line().await {
            if l == "ready" {
                return true;
            }
            // Input while it fades in counts too: a key here cancels the
            // switch-off that is waiting for this window.
            on_event(&l).await;
        }
        false
    })
    .await
    .unwrap_or(false);
    if !ready {
        eprintln!("screensaver: window did not come up");
        let _ = child.start_kill();
        let _ = child.wait().await;
        return None;
    }
    tokio::spawn(async move {
        while let Ok(Some(l)) = lines.next_line().await {
            on_event(&l).await;
        }
        if let Some(tx) = TX.get() {
            let _ = tx.send(Msg::Exited(id));
        }
    });
    Some(Running { child, stdin, id })
}

async fn on_event(line: &str) {
    let mut words = line.split_whitespace();
    let wake = match (words.next(), words.next().and_then(|c| c.parse::<u32>().ok())) {
        (Some("key"), Some(KEY_VOLUMEUP)) => {
            crate::api::audio::step_volume(0.05).await;
            false
        }
        (Some("key"), Some(KEY_VOLUMEDOWN)) => {
            crate::api::audio::step_volume(-0.05).await;
            false
        }
        (Some("key"), Some(KEY_MUTE)) => {
            crate::api::audio::toggle_mute().await;
            false
        }
        (Some("key"), Some(code)) => !NOT_WAKE.contains(&code),
        (Some("doubletap"), _) => true,
        _ => false,
    };
    if wake {
        if let Err(e) = screen_on().await {
            eprintln!("screensaver: wake: {e}");
        }
    }
}
