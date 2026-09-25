//! Wi-Fi status for the Wi-Fi LED.
//!
//! A background thread samples the Wi-Fi hardware (sysfs) every couple of
//! seconds and NetworkManager (through `nmcli`) every ten, or at once when
//! `nmcli monitor` reports a change, and publishes one debounced [`Report`]. Nothing here names an interface or a PCI address:
//! the Wi-Fi card is user-replaceable, so every wireless interface and every
//! PCI network controller (class 0x0280) is considered.
//!
//! LED mapping (see `State::effect`):
//!   online      blue            connected, internet reachable
//!   weak        cyan            online, but the signal is below -75 dBm
//!   connecting  cyan, slow blink  NetworkManager is connecting (at most 60 s)
//!   hotspot     blue heartbeat  this machine is an access point
//!   limited     yellow          on, but not usable (not connected, no IP,
//!                               no internet)
//!   fault       red             hardware or software fault (shown in night
//!                               mode too)
//!   off         dark            turned off on purpose, no Wi-Fi hardware,
//!                               or no Wi-Fi network saved

use crate::leds::Effect;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SAMPLE_EVERY: Duration = Duration::from_secs(2);
/// How quickly a NetworkManager event is picked up.
const EVENT_TICK: Duration = Duration::from_millis(250);
/// NetworkManager is asked this often while nothing changes...
const NM_EVERY: Duration = Duration::from_secs(10);
/// ...and on every sample while something is changing.
const NM_EVERY_BUSY: Duration = Duration::from_secs(2);
const NMCLI_TIMEOUT: Duration = Duration::from_secs(3);
/// Longest time "connecting" is shown before it counts as not connected.
const CONNECTING_MAX: Duration = Duration::from_secs(60);
/// NetworkManager must be gone this long before it is a fault (fnOS
/// restarts it when network settings change).
const NM_DOWN_AFTER: Duration = Duration::from_secs(20);
/// No faults this soon after boot: drivers and services are still starting.
const BOOT_GRACE_SECS: f64 = 60.0;
/// Signal hysteresis: weak below `WEAK_BELOW`, strong again above `STRONG_ABOVE`.
const WEAK_BELOW: i32 = -75;
const STRONG_ABOVE: i32 = -70;
/// A worse state must last this long before it is shown (NetworkManager
/// scans for ~3 s after Wi-Fi is switched on, briefly "disconnected")...
const WORSE_AFTER: Duration = Duration::from_secs(5);
/// ...and a fault this long (the card is briefly "unavailable" too).
const FAULT_AFTER: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Off,
    Fault,
    Limited,
    Connecting,
    Weak,
    Online,
    Hotspot,
}

impl State {
    pub fn name(self) -> &'static str {
        match self {
            State::Off => "off",
            State::Fault => "fault",
            State::Limited => "limited",
            State::Connecting => "connecting",
            State::Weak => "weak",
            State::Online => "online",
            State::Hotspot => "hotspot",
        }
    }

    pub fn effect(self) -> Effect {
        match self {
            State::Off => Effect::off(),
            State::Fault => Effect::Solid("red".into()),
            State::Limited => Effect::Solid("yellow".into()),
            State::Connecting => Effect::Blink { color: "cyan".into(), period_ms: 1000 },
            State::Weak => Effect::Solid("cyan".into()),
            State::Online => Effect::Solid("blue".into()),
            State::Hotspot => Effect::Heartbeat { color: "blue".into() },
        }
    }
}

/// What the Wi-Fi LED shows, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub state: State,
    /// Machine-readable reason (the web UI translates it), e.g.
    /// `"no-internet"`, `"driver-missing"`, `"disabled"`.
    pub reason: &'static str,
    pub iface: Option<String>,
    /// NetworkManager connection (usually the network name).
    pub connection: Option<String>,
    pub signal_dbm: Option<i32>,
}

impl Report {
    fn new(state: State, reason: &'static str) -> Self {
        Report { state, reason, iface: None, connection: None, signal_dbm: None }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "state": self.state.name(),
            "reason": self.reason,
            "iface": self.iface,
            "connection": self.connection,
            "signal_dbm": self.signal_dbm,
        })
    }
}

/// Start the sampler; the returned handle always holds the latest report.
pub fn spawn() -> Arc<Mutex<Report>> {
    let changed = Arc::new(AtomicBool::new(false));
    watch_nm(Arc::clone(&changed));
    let mut mon = Monitor::default();
    let first = mon.sample(Instant::now(), false);
    let shared = Arc::new(Mutex::new(first));
    let out = Arc::clone(&shared);
    std::thread::spawn(move || {
        let mut last = Instant::now();
        loop {
            std::thread::sleep(EVENT_TICK);
            let event = changed.swap(false, Ordering::Relaxed);
            if !event && last.elapsed() < SAMPLE_EVERY {
                continue;
            }
            last = Instant::now();
            let r = mon.sample(last, event);
            if let Ok(mut g) = out.lock() {
                *g = r;
            }
        }
    });
    shared
}

/// Keep an `nmcli monitor` running and raise `changed` on every line it
/// prints (device states, connectivity, NetworkManager start/stop). Cheap:
/// one idle process instead of polling nmcli every couple of seconds.
fn watch_nm(changed: Arc<AtomicBool>) {
    std::thread::spawn(move || loop {
        let child = Command::new("nmcli").arg("monitor").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
        match child {
            Ok(mut c) => {
                if let Some(out) = c.stdout.take() {
                    for _ in BufReader::new(out).lines().map_while(Result::ok) {
                        changed.store(true, Ordering::Relaxed);
                    }
                }
                let _ = c.wait();
                changed.store(true, Ordering::Relaxed);
            }
            // No NetworkManager on this system: polling covers the rest.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => {}
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}

// --- sampling --------------------------------------------------------------

/// What NetworkManager said, cached between queries.
#[derive(Debug, Clone, Default)]
struct NmView {
    /// nmcli exists (false: no NetworkManager on this system).
    installed: bool,
    running: bool,
    radio_enabled: bool,
    /// A saved Wi-Fi connection that connects automatically.
    configured: bool,
    devices: Vec<NmDevice>,
}

#[derive(Debug, Clone, Default)]
struct NmDevice {
    iface: String,
    /// NMDeviceState number (10 unmanaged, 20 unavailable, 30 disconnected,
    /// 40-90 activating, 100 activated, 110 deactivating, 120 failed).
    state: u32,
    /// Best of IPv4/IPv6 NMConnectivityState (0 unknown, 1 none, 2 portal,
    /// 3 limited, 4 full).
    connectivity: u32,
    has_ip: bool,
    connection: Option<String>,
    access_point: bool,
}

impl NmDevice {
    fn activating(&self) -> bool {
        (40..=90).contains(&self.state)
    }
}

#[derive(Default)]
struct Monitor {
    nm: Option<NmView>,
    nm_at: Option<Instant>,
    /// Interface operstates at the last NetworkManager query; a change
    /// triggers an early query.
    nm_seen_oper: Vec<(String, String)>,
    nm_down_since: Option<Instant>,
    connecting_since: Option<Instant>,
    weak: bool,
    shown: Option<Report>,
    /// A worse state waiting out its delay, and since when it was seen.
    candidate: Option<(State, &'static str, Instant)>,
}

impl Monitor {
    /// `nm_event`: NetworkManager reported a change, ask it now.
    fn sample(&mut self, now: Instant, nm_event: bool) -> Report {
        // Debug hook: T6_LEDD_FAKE_WIFI=hotspot|fault|limited|connecting|weak
        // forces a state, so each LED pattern can be checked on the hardware.
        if let Some(state) = std::env::var("T6_LEDD_FAKE_WIFI").ok().and_then(|v| fake_state(&v)) {
            return Report::new(state, "fake");
        }
        let hw = Hardware::scan();
        let oper = hw.operstates();
        // Ask again soon while something is in flux: a connection being set
        // up, or NetworkManager missing (to time the outage).
        let busy = self
            .nm
            .as_ref()
            .is_some_and(|v| (v.installed && !v.running) || v.devices.iter().any(NmDevice::activating));
        let due = match self.nm_at {
            None => true,
            Some(t) => now.duration_since(t) >= if busy { NM_EVERY_BUSY } else { NM_EVERY },
        };
        if due || nm_event || oper != self.nm_seen_oper {
            self.nm = Some(query_nm());
            self.nm_at = Some(now);
            self.nm_seen_oper = oper;
        }
        let nm = self.nm.clone().unwrap_or_default();

        // NetworkManager down: only a fault once it has stayed down a while.
        if nm.installed && !nm.running {
            self.nm_down_since.get_or_insert(now);
        } else {
            self.nm_down_since = None;
        }
        let nm_down_long = self.nm_down_since.is_some_and(|t| now.duration_since(t) >= NM_DOWN_AFTER);

        let mut r = self.classify(&hw, &nm, nm_down_long, now);

        if r.state == State::Fault && uptime_secs().is_some_and(|u| u < BOOT_GRACE_SECS) {
            r = Report { state: State::Off, reason: "starting", ..r };
        }
        self.debounce(r, now)
    }

    fn classify(&mut self, hw: &Hardware, nm: &NmView, nm_down_long: bool, now: Instant) -> Report {
        if hw.ifaces.is_empty() {
            self.connecting_since = None;
            return match hw.controllers.iter().find(|c| !c.has_wireless_iface) {
                Some(c) if !c.driver_bound => Report::new(State::Fault, "driver-missing"),
                Some(_) => Report::new(State::Fault, "no-interface"),
                None => Report::new(State::Off, "no-hardware"),
            };
        }
        if hw.rfkill_hard {
            return Report::new(State::Fault, "hard-blocked");
        }
        if hw.rfkill_soft {
            return Report::new(State::Off, "disabled");
        }
        if nm.installed && !nm.running {
            // Brief outages keep what was shown; long ones are a fault.
            if nm_down_long {
                return Report::new(State::Fault, "nm-down");
            }
            return self.shown.clone().unwrap_or_else(|| Report::new(State::Off, "starting"));
        }
        if nm.installed && !nm.radio_enabled {
            return Report::new(State::Off, "disabled");
        }

        let mut best: Option<Report> = None;
        for iface in &hw.ifaces {
            let r = match nm.devices.iter().find(|d| d.iface == iface.name) {
                Some(d) if nm.installed && d.state != 10 => self.classify_nm(iface, d, nm.configured, now),
                // Not managed by NetworkManager (or no NetworkManager at all):
                // all we know is whether the link is up.
                _ => {
                    if iface.operstate == "up" {
                        self.signal_state(iface, "connected")
                    } else {
                        Report::new(State::Off, "not-managed")
                    }
                }
            };
            let r = Report { iface: Some(iface.name.clone()), signal_dbm: iface.signal_dbm, ..r };
            if best.as_ref().is_none_or(|b| rank(r.state) > rank(b.state)) {
                best = Some(r);
            }
        }
        if best.as_ref().is_none_or(|b| b.state != State::Connecting) {
            self.connecting_since = None;
        }
        best.unwrap_or_else(|| Report::new(State::Off, "no-hardware"))
    }

    fn classify_nm(&mut self, iface: &Iface, d: &NmDevice, configured: bool, now: Instant) -> Report {
        let with_conn = |mut r: Report| {
            r.connection = d.connection.clone();
            r
        };
        match d.state {
            20 => Report::new(State::Fault, "unavailable"),
            30 | 120 => {
                if configured {
                    Report::new(State::Limited, "not-connected")
                } else {
                    Report::new(State::Off, "not-configured")
                }
            }
            s if (40..=90).contains(&s) || s == 110 => {
                let since = *self.connecting_since.get_or_insert(now);
                if now.duration_since(since) < CONNECTING_MAX {
                    with_conn(Report::new(State::Connecting, "connecting"))
                } else {
                    with_conn(Report::new(State::Limited, "not-connected"))
                }
            }
            100 if d.access_point => with_conn(Report::new(State::Hotspot, "hotspot")),
            100 => with_conn(match d.connectivity {
                // Unknown = the connectivity check is off: trust the link.
                0 | 4 => self.signal_state(iface, "connected"),
                2 => Report::new(State::Limited, "portal"),
                _ if !d.has_ip => Report::new(State::Limited, "no-ip"),
                _ => Report::new(State::Limited, "no-internet"),
            }),
            _ => Report::new(State::Off, "not-managed"),
        }
    }

    /// Online, or weak with hysteresis on the signal level.
    fn signal_state(&mut self, iface: &Iface, reason: &'static str) -> Report {
        if let Some(dbm) = iface.signal_dbm {
            if dbm < WEAK_BELOW {
                self.weak = true;
            } else if dbm > STRONG_ABOVE {
                self.weak = false;
            }
        } else {
            self.weak = false;
        }
        if self.weak {
            Report::new(State::Weak, "weak-signal")
        } else {
            Report::new(State::Online, reason)
        }
    }

    /// Working states (and switching Wi-Fi off) show at once; a warning,
    /// a fault or any other step down only once it has lasted `WORSE_AFTER`
    /// / `FAULT_AFTER`, so a blip does not flash the LED. Details (signal,
    /// names) of the shown state update immediately.
    fn debounce(&mut self, r: Report, now: Instant) -> Report {
        let Some(shown) = self.shown.clone() else {
            self.shown = Some(r.clone());
            return r;
        };
        let same = (r.state, r.reason) == (shown.state, shown.reason);
        let at_once = match r.state {
            State::Fault | State::Limited => false,
            State::Off => r.reason == "disabled",
            _ => rank(r.state) > rank(shown.state),
        };
        if same || at_once {
            self.candidate = None;
            self.shown = Some(r.clone());
            return r;
        }
        let since = match self.candidate {
            Some((s, why, t)) if (s, why) == (r.state, r.reason) => t,
            _ => now,
        };
        let wait = if r.state == State::Fault { FAULT_AFTER } else { WORSE_AFTER };
        if now.duration_since(since) >= wait {
            self.candidate = None;
            self.shown = Some(r.clone());
            r
        } else {
            self.candidate = Some((r.state, r.reason, since));
            shown
        }
    }
}

fn fake_state(name: &str) -> Option<State> {
    [State::Off, State::Fault, State::Limited, State::Connecting, State::Weak, State::Online, State::Hotspot]
        .into_iter()
        .find(|s| s.name() == name)
}

/// Which interface wins when there is more than one: the most useful one.
fn rank(s: State) -> u8 {
    match s {
        State::Hotspot | State::Online => 6,
        State::Weak => 5,
        State::Connecting => 4,
        State::Limited => 3,
        State::Fault => 2,
        State::Off => 1,
    }
}

// --- sysfs -----------------------------------------------------------------

struct Iface {
    name: String,
    operstate: String,
    signal_dbm: Option<i32>,
}

struct Controller {
    driver_bound: bool,
    has_wireless_iface: bool,
}

struct Hardware {
    ifaces: Vec<Iface>,
    /// PCI network controllers (class 0x0280: Wi-Fi cards).
    controllers: Vec<Controller>,
    rfkill_soft: bool,
    rfkill_hard: bool,
}

fn read_trim(p: impl AsRef<Path>) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

fn is_wireless(net: &Path) -> bool {
    net.join("wireless").is_dir() || net.join("phy80211").exists()
}

impl Hardware {
    fn scan() -> Self {
        let signals = read_signals();
        let mut ifaces = Vec::new();
        if let Ok(rd) = std::fs::read_dir("/sys/class/net") {
            for e in rd.flatten() {
                if !is_wireless(&e.path()) {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                ifaces.push(Iface {
                    operstate: read_trim(e.path().join("operstate")).unwrap_or_default(),
                    signal_dbm: signals.iter().find(|(n, _)| *n == name).map(|(_, s)| *s),
                    name,
                });
            }
        }
        ifaces.sort_by(|a, b| a.name.cmp(&b.name));

        let mut controllers = Vec::new();
        if let Ok(rd) = std::fs::read_dir("/sys/bus/pci/devices") {
            for e in rd.flatten() {
                let dev = e.path();
                if !read_trim(dev.join("class")).is_some_and(|c| c.starts_with("0x0280")) {
                    continue;
                }
                let has_wireless_iface = std::fs::read_dir(dev.join("net"))
                    .map(|it| it.flatten().any(|n| is_wireless(&n.path())))
                    .unwrap_or(false);
                controllers.push(Controller { driver_bound: dev.join("driver").exists(), has_wireless_iface });
            }
        }

        let (mut soft, mut hard) = (false, false);
        let mut any = false;
        if let Ok(rd) = std::fs::read_dir("/sys/class/rfkill") {
            for e in rd.flatten() {
                if read_trim(e.path().join("type")).as_deref() != Some("wlan") {
                    continue;
                }
                any = true;
                soft |= read_trim(e.path().join("soft")).as_deref() == Some("1");
                hard |= read_trim(e.path().join("hard")).as_deref() == Some("1");
            }
        }
        Hardware { ifaces, controllers, rfkill_soft: any && soft, rfkill_hard: any && hard }
    }

    fn operstates(&self) -> Vec<(String, String)> {
        self.ifaces.iter().map(|i| (i.name.clone(), i.operstate.clone())).collect()
    }
}

/// Signal level per interface from `/proc/net/wireless` (dBm).
fn read_signals() -> Vec<(String, i32)> {
    let Ok(text) = std::fs::read_to_string("/proc/net/wireless") else { return Vec::new() };
    parse_signals(&text)
}

fn parse_signals(text: &str) -> Vec<(String, i32)> {
    text.lines()
        .skip(2)
        .filter_map(|l| {
            let (name, rest) = l.split_once(':')?;
            let level = rest.split_whitespace().nth(2)?.trim_end_matches('.');
            let dbm: i32 = level.parse().ok()?;
            // 0 (or a positive number) means "no reading yet".
            (dbm < 0).then(|| (name.trim().to_string(), dbm))
        })
        .collect()
}

pub(crate) fn uptime_secs() -> Option<f64> {
    read_trim("/proc/uptime")?.split_whitespace().next()?.parse().ok()
}

// --- NetworkManager --------------------------------------------------------

enum Nmcli {
    Missing,
    Failed,
    Ok(String),
}

/// Run nmcli with a timeout, so a wedged NetworkManager cannot stall us.
fn nmcli(args: &[&str]) -> Nmcli {
    let child = Command::new("nmcli").args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Nmcli::Missing,
        Err(_) => return Nmcli::Failed,
    };
    let deadline = Instant::now() + NMCLI_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_string(&mut out);
                }
                return if status.success() { Nmcli::Ok(out) } else { Nmcli::Failed };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Nmcli::Failed;
            }
        }
    }
}

fn query_nm() -> NmView {
    let general = match nmcli(&["-t", "-f", "RUNNING,WIFI", "general"]) {
        Nmcli::Missing => return NmView::default(),
        Nmcli::Failed => return NmView { installed: true, ..Default::default() },
        Nmcli::Ok(s) => s,
    };
    let mut view = NmView { installed: true, ..Default::default() };
    let mut f = general.trim().split(':');
    view.running = f.next() == Some("running");
    view.radio_enabled = f.next() == Some("enabled");
    if !view.running {
        return view;
    }

    if let Nmcli::Ok(s) = nmcli(&["-t", "-f", "TYPE,AUTOCONNECT", "connection", "show"]) {
        view.configured = s.lines().any(|l| l == "802-11-wireless:yes");
    }
    if let Nmcli::Ok(s) = nmcli(&["-t", "-f", "DEVICE,TYPE", "device"]) {
        for line in s.lines() {
            let Some(iface) = line.strip_suffix(":wifi") else { continue };
            if let Some(d) = query_device(iface) {
                view.devices.push(d);
            }
        }
    }
    view
}

fn query_device(iface: &str) -> Option<NmDevice> {
    let fields = "GENERAL.STATE,GENERAL.IP4-CONNECTIVITY,GENERAL.IP6-CONNECTIVITY,GENERAL.CONNECTION,IP4.ADDRESS,IP6.ADDRESS";
    let Nmcli::Ok(s) = nmcli(&["-g", fields, "device", "show", iface]) else { return None };
    let mut d = parse_device(iface, &s);
    if d.state == 100 {
        if let Some(conn) = d.connection.clone() {
            if let Nmcli::Ok(m) = nmcli(&["-g", "802-11-wireless.mode", "connection", "show", "id", &conn]) {
                d.access_point = m.trim() == "ap";
            }
        }
    }
    Some(d)
}

/// Parse `nmcli -g STATE,IP4-CONN,IP6-CONN,CONNECTION,IP4.ADDRESS,IP6.ADDRESS`
/// (one value per line; multiple addresses are ` | `-separated).
fn parse_device(iface: &str, text: &str) -> NmDevice {
    let lines: Vec<&str> = text.lines().collect();
    let num = |i: usize| -> u32 {
        lines.get(i).and_then(|l| l.split_whitespace().next()).and_then(|n| n.parse().ok()).unwrap_or(0)
    };
    let connection = lines.get(3).map(|l| l.trim().replace("\\:", ":")).filter(|c| !c.is_empty() && c != "--");
    // A usable address: any IPv4, or an IPv6 that is not link-local.
    let v4 = lines.get(4).is_some_and(|l| !l.trim().is_empty());
    let v6 = lines
        .get(5)
        .is_some_and(|l| l.split(" | ").any(|a| !a.trim().is_empty() && !a.trim().to_ascii_lowercase().starts_with("fe80")));
    NmDevice {
        iface: iface.to_string(),
        state: num(0),
        connectivity: num(1).max(num(2)),
        has_ip: v4 || v6,
        connection,
        access_point: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signals() {
        let t = "Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n \
                 face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n\
                 wlp0s20f3: 0000   70.  -37.  -256        0      0      0      0    274        0\n\
                 wlan1: 0000   0.  0.  -256        0      0      0      0    0        0\n";
        assert_eq!(parse_signals(t), vec![("wlp0s20f3".to_string(), -37)]);
    }

    #[test]
    fn device() {
        let t = "100 (connected)\n4 (full)\n1 (none)\nMy\\:Net\n10.0.0.158/24\nfe80\\:\\:1/64\n";
        let d = parse_device("wlan0", t);
        assert_eq!((d.state, d.connectivity, d.has_ip), (100, 4, true));
        assert_eq!(d.connection.as_deref(), Some("My:Net"));
        let t = "30 (disconnected)\n1 (none)\n1 (none)\n\n\nfe80\\:\\:1/64\n";
        let d = parse_device("wlan0", t);
        assert_eq!((d.state, d.has_ip, d.connection), (30, false, None));
    }

    fn iface(dbm: Option<i32>) -> Iface {
        Iface { name: "wlan0".into(), operstate: "up".into(), signal_dbm: dbm }
    }

    fn dev(state: u32, connectivity: u32) -> NmDevice {
        NmDevice { iface: "wlan0".into(), state, connectivity, has_ip: true, connection: Some("Home".into()), access_point: false }
    }

    #[test]
    fn nm_states() {
        let mut m = Monitor::default();
        let t = Instant::now();
        let i = iface(Some(-40));
        assert_eq!(m.classify_nm(&i, &dev(100, 4), true, t).state, State::Online);
        assert_eq!(m.classify_nm(&i, &dev(100, 0), true, t).state, State::Online);
        assert_eq!(m.classify_nm(&i, &dev(100, 2), true, t).reason, "portal");
        assert_eq!(m.classify_nm(&i, &dev(100, 3), true, t).reason, "no-internet");
        assert_eq!(m.classify_nm(&i, &NmDevice { has_ip: false, ..dev(100, 1) }, true, t).reason, "no-ip");
        assert_eq!(m.classify_nm(&i, &NmDevice { access_point: true, ..dev(100, 1) }, true, t).state, State::Hotspot);
        assert_eq!(m.classify_nm(&i, &dev(30, 0), true, t).state, State::Limited);
        assert_eq!(m.classify_nm(&i, &dev(30, 0), false, t).state, State::Off);
        assert_eq!(m.classify_nm(&i, &dev(20, 0), true, t).state, State::Fault);
    }

    #[test]
    fn connecting_times_out() {
        let mut m = Monitor::default();
        let t = Instant::now();
        let i = iface(None);
        assert_eq!(m.classify_nm(&i, &dev(70, 0), true, t).state, State::Connecting);
        assert_eq!(m.classify_nm(&i, &dev(70, 0), true, t + Duration::from_secs(59)).state, State::Connecting);
        assert_eq!(m.classify_nm(&i, &dev(70, 0), true, t + Duration::from_secs(61)).state, State::Limited);
    }

    #[test]
    fn weak_signal_hysteresis() {
        let mut m = Monitor::default();
        assert_eq!(m.signal_state(&iface(Some(-74)), "connected").state, State::Online);
        assert_eq!(m.signal_state(&iface(Some(-76)), "connected").state, State::Weak);
        assert_eq!(m.signal_state(&iface(Some(-72)), "connected").state, State::Weak);
        assert_eq!(m.signal_state(&iface(Some(-69)), "connected").state, State::Online);
    }

    #[test]
    fn debounce_delays_only_getting_worse() {
        let mut m = Monitor::default();
        let t = Instant::now();
        let s = |x| t + Duration::from_secs(x);
        let limited = || Report::new(State::Limited, "no-internet");
        assert_eq!(m.debounce(Report::new(State::Online, "connected"), s(0)).state, State::Online);
        // A blip is ignored...
        assert_eq!(m.debounce(limited(), s(1)).state, State::Online);
        assert_eq!(m.debounce(Report::new(State::Online, "connected"), s(3)).state, State::Online);
        // ...a lasting one is shown after WORSE_AFTER.
        assert_eq!(m.debounce(limited(), s(4)).state, State::Online);
        assert_eq!(m.debounce(limited(), s(8)).state, State::Online);
        assert_eq!(m.debounce(limited(), s(9)).state, State::Limited);
        // Recovery is immediate.
        assert_eq!(m.debounce(Report::new(State::Connecting, "connecting"), s(10)).state, State::Connecting);
        assert_eq!(m.debounce(Report::new(State::Online, "connected"), s(11)).state, State::Online);
    }

    #[test]
    fn fault_waits_even_from_off() {
        let mut m = Monitor::default();
        let t = Instant::now();
        let s = |x| t + Duration::from_secs(x);
        let fault = || Report::new(State::Fault, "unavailable");
        assert_eq!(m.debounce(Report::new(State::Off, "disabled"), s(0)).state, State::Off);
        assert_eq!(m.debounce(fault(), s(1)).state, State::Off);
        assert_eq!(m.debounce(fault(), s(9)).state, State::Off);
        assert_eq!(m.debounce(fault(), s(11)).state, State::Fault);
    }

    #[test]
    fn scan_after_switch_on_is_not_yellow() {
        let mut m = Monitor::default();
        let t = Instant::now();
        let s = |x| t + Duration::from_secs(x);
        assert_eq!(m.debounce(Report::new(State::Online, "connected"), s(0)).state, State::Online);
        // Switching Wi-Fi off shows at once.
        assert_eq!(m.debounce(Report::new(State::Off, "disabled"), s(1)).state, State::Off);
        // Back on: ~3 s "disconnected" while scanning stays dark.
        assert_eq!(m.debounce(Report::new(State::Limited, "not-connected"), s(2)).state, State::Off);
        assert_eq!(m.debounce(Report::new(State::Limited, "not-connected"), s(5)).state, State::Off);
        assert_eq!(m.debounce(Report::new(State::Connecting, "connecting"), s(5)).state, State::Connecting);
        assert_eq!(m.debounce(Report::new(State::Online, "connected"), s(6)).state, State::Online);
    }
}
