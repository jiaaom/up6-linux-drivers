//! Bluetooth status for the Bluetooth LED, read from the kernel only (no
//! BlueZ calls, so it works whether or not BlueZ is installed). Nothing
//! names an adapter or a USB port: the Wi-Fi/Bluetooth card is
//! user-replaceable.
//!
//! LED mapping (see `State::effect`):
//!   discoverable  blue heartbeat  the adapter can be found (pairing)
//!   connected     blue            at least one device is connected
//!   fault         red             Bluetooth hardware without a working
//!                                 adapter, or hard-blocked (shown in every
//!                                 mode, night mode too)
//!   off           dark            idle, powered off (e.g. no BlueZ),
//!                                 switched off, or no Bluetooth hardware

use crate::leds::Effect;
use crate::wifi::uptime_secs;
use std::path::Path;
use std::time::{Duration, Instant};

/// A fault must last this long before it is shown (adapters restart when
/// BlueZ starts or firmware loads).
const FAULT_AFTER: Duration = Duration::from_secs(10);
/// No faults this soon after boot.
const BOOT_GRACE_SECS: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Off,
    Fault,
    Connected,
    Discoverable,
}

impl State {
    pub fn name(self) -> &'static str {
        match self {
            State::Off => "off",
            State::Fault => "fault",
            State::Connected => "connected",
            State::Discoverable => "discoverable",
        }
    }

    pub fn effect(self) -> Effect {
        match self {
            State::Off => Effect::off(),
            State::Fault => Effect::Solid("red".into()),
            State::Connected => Effect::Solid("blue".into()),
            State::Discoverable => Effect::Heartbeat { color: "blue".into() },
        }
    }

    fn rank(self) -> u8 {
        match self {
            State::Discoverable => 4,
            State::Connected => 3,
            State::Fault => 2,
            State::Off => 1,
        }
    }
}

/// What the Bluetooth LED shows, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub state: State,
    /// Machine-readable reason (the web UI translates it), e.g. `"idle"`,
    /// `"powered-off"`, `"driver-missing"`.
    pub reason: &'static str,
    pub adapter: Option<String>,
    /// Connected devices (all adapters).
    pub connections: usize,
}

impl Report {
    fn new(state: State, reason: &'static str) -> Self {
        Report { state, reason, adapter: None, connections: 0 }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "state": self.state.name(),
            "reason": self.reason,
            "adapter": self.adapter,
            "connections": self.connections,
        })
    }
}

#[derive(Default)]
pub struct Monitor {
    shown: Option<Report>,
    fault_since: Option<Instant>,
}

impl Monitor {
    pub fn sample(&mut self, now: Instant) -> Report {
        // Debug hook: T6_LEDD_FAKE_BT=discoverable|connected|fault|off.
        if let Ok(v) = std::env::var("T6_LEDD_FAKE_BT") {
            if let Some(s) = [State::Off, State::Fault, State::Connected, State::Discoverable].into_iter().find(|s| s.name() == v) {
                return Report::new(s, "fake");
            }
        }
        let r = classify(&scan());
        let r = if r.state == State::Fault && uptime_secs().is_some_and(|u| u < BOOT_GRACE_SECS) {
            Report { state: State::Off, reason: "starting", ..r }
        } else {
            r
        };
        self.debounce(r, now)
    }

    /// Everything shows at once except a fault, which must last
    /// `FAULT_AFTER`.
    fn debounce(&mut self, r: Report, now: Instant) -> Report {
        if r.state != State::Fault {
            self.fault_since = None;
            self.shown = Some(r.clone());
            return r;
        }
        let since = *self.fault_since.get_or_insert(now);
        if now.duration_since(since) >= FAULT_AFTER || self.shown.is_none() {
            self.shown = Some(r.clone());
            return r;
        }
        self.shown.clone().unwrap_or(r)
    }
}

// --- kernel state ------------------------------------------------------------

struct Adapter {
    name: String,
    up: bool,
    discoverable: bool,
    connections: usize,
}

struct UsbController {
    driver_bound: bool,
    has_adapter: bool,
}

struct Scan {
    adapters: Vec<Adapter>,
    /// USB Bluetooth devices (interface class e0/01/01).
    controllers: Vec<UsbController>,
    rfkill_soft: bool,
    rfkill_hard: bool,
}

fn read_trim(p: impl AsRef<Path>) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

fn scan() -> Scan {
    // /sys/class/bluetooth holds adapters ("hci0") and, while connected,
    // one entry per connection ("hci0:11").
    let mut names = Vec::new();
    let mut conns = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/sys/class/bluetooth") {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            match n.split_once(':') {
                Some((hci, _)) => conns.push(hci.to_string()),
                None if n.starts_with("hci") => names.push(n),
                None => {}
            }
        }
    }
    names.sort();
    let adapters = names
        .into_iter()
        .map(|name| {
            let flags = name.strip_prefix("hci").and_then(|i| i.parse().ok()).and_then(hci_flags).unwrap_or(0);
            Adapter {
                up: flags & HCI_UP != 0,
                discoverable: flags & HCI_ISCAN != 0,
                connections: conns.iter().filter(|c| **c == name).count(),
                name,
            }
        })
        .collect();

    // USB Bluetooth devices, grouped per device ("3-10" for "3-10:1.0").
    let mut controllers: Vec<(String, UsbController)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/sys/bus/usb/devices") {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let Some((dev, _)) = n.split_once(':') else { continue };
            let p = e.path();
            let class = (read_trim(p.join("bInterfaceClass")), read_trim(p.join("bInterfaceSubClass")), read_trim(p.join("bInterfaceProtocol")));
            if class != (Some("e0".into()), Some("01".into()), Some("01".into())) {
                continue;
            }
            let bound = p.join("driver").exists();
            let adapter = std::fs::read_dir(p.join("bluetooth")).map(|mut it| it.next().is_some()).unwrap_or(false);
            match controllers.iter_mut().find(|(d, _)| d == dev) {
                Some((_, c)) => {
                    c.driver_bound |= bound;
                    c.has_adapter |= adapter;
                }
                None => controllers.push((dev.to_string(), UsbController { driver_bound: bound, has_adapter: adapter })),
            }
        }
    }

    let (mut soft, mut hard) = (false, false);
    if let Ok(rd) = std::fs::read_dir("/sys/class/rfkill") {
        for e in rd.flatten() {
            if read_trim(e.path().join("type")).as_deref() != Some("bluetooth") {
                continue;
            }
            soft |= read_trim(e.path().join("soft")).as_deref() == Some("1");
            hard |= read_trim(e.path().join("hard")).as_deref() == Some("1");
        }
    }
    Scan { adapters, controllers: controllers.into_iter().map(|(_, c)| c).collect(), rfkill_soft: soft, rfkill_hard: hard }
}

fn classify(s: &Scan) -> Report {
    if let Some(c) = s.controllers.iter().find(|c| !c.has_adapter) {
        if s.adapters.is_empty() {
            return Report::new(State::Fault, if c.driver_bound { "no-adapter" } else { "driver-missing" });
        }
    }
    if s.adapters.is_empty() {
        return Report::new(State::Off, "no-hardware");
    }
    if s.rfkill_hard {
        return Report::new(State::Fault, "hard-blocked");
    }
    if s.rfkill_soft {
        return Report::new(State::Off, "disabled");
    }
    let connections = s.adapters.iter().map(|a| a.connections).sum();
    let mut best: Option<Report> = None;
    for a in &s.adapters {
        let r = if !a.up {
            Report::new(State::Off, "powered-off")
        } else if a.discoverable {
            Report::new(State::Discoverable, "discoverable")
        } else if a.connections > 0 {
            Report::new(State::Connected, "connected")
        } else {
            Report::new(State::Off, "idle")
        };
        let r = Report { adapter: Some(a.name.clone()), connections, ..r };
        if best.as_ref().is_none_or(|b| r.state.rank() > b.state.rank() || (r.reason == "idle" && b.reason == "powered-off")) {
            best = Some(r);
        }
    }
    best.unwrap_or_else(|| Report::new(State::Off, "no-hardware"))
}

// HCI device flags (include/net/bluetooth/hci.h: HCI_UP = bit 0, HCI_ISCAN = bit 4).
const HCI_UP: u32 = 1 << 0;
const HCI_ISCAN: u32 = 1 << 4;

/// `hdev->flags` of adapter `hciN` via the HCIGETDEVINFO ioctl on a raw HCI
/// socket (no privileges needed, nothing is sent to the adapter).
fn hci_flags(dev_id: u16) -> Option<u32> {
    const BTPROTO_HCI: libc::c_int = 1;
    const HCIGETDEVINFO: libc::c_ulong = 0x8004_48d3; // _IOR('H', 211, int)
    // struct hci_dev_info is 92 bytes: dev_id u16, name[8], bdaddr[6], flags u32 @16, ...
    let mut info = [0u8; 128];
    info[..2].copy_from_slice(&dev_id.to_ne_bytes());
    // SAFETY: plain socket/ioctl/close on a descriptor we own; the buffer is
    // larger than the struct the kernel writes.
    unsafe {
        let fd = libc::socket(libc::AF_BLUETOOTH, libc::SOCK_RAW | libc::SOCK_CLOEXEC, BTPROTO_HCI);
        if fd < 0 {
            return None;
        }
        let rc = libc::ioctl(fd, HCIGETDEVINFO as _, info.as_mut_ptr());
        libc::close(fd);
        if rc < 0 {
            return None;
        }
    }
    Some(u32::from_ne_bytes(info[16..20].try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(up: bool, discoverable: bool, connections: usize) -> Adapter {
        Adapter { name: "hci0".into(), up, discoverable, connections }
    }

    fn scan_of(adapters: Vec<Adapter>) -> Scan {
        Scan { adapters, controllers: vec![UsbController { driver_bound: true, has_adapter: true }], rfkill_soft: false, rfkill_hard: false }
    }

    #[test]
    fn states() {
        assert_eq!(classify(&scan_of(vec![adapter(false, false, 0)])).reason, "powered-off");
        assert_eq!(classify(&scan_of(vec![adapter(true, false, 0)])).reason, "idle");
        assert_eq!(classify(&scan_of(vec![adapter(true, false, 2)])).state, State::Connected);
        // Discoverable (pairing) wins over connected.
        assert_eq!(classify(&scan_of(vec![adapter(true, true, 1)])).state, State::Discoverable);
        let blocked = Scan { rfkill_soft: true, ..scan_of(vec![adapter(true, false, 1)]) };
        assert_eq!(classify(&blocked).reason, "disabled");
        let hard = Scan { rfkill_hard: true, ..scan_of(vec![adapter(true, false, 1)]) };
        assert_eq!(classify(&hard).state, State::Fault);
    }

    #[test]
    fn faults_and_missing_hardware() {
        let none = Scan { adapters: vec![], controllers: vec![], rfkill_soft: false, rfkill_hard: false };
        assert_eq!(classify(&none).reason, "no-hardware");
        let unbound = Scan { controllers: vec![UsbController { driver_bound: false, has_adapter: false }], ..none };
        assert_eq!(classify(&unbound).reason, "driver-missing");
        let no_hci = Scan { controllers: vec![UsbController { driver_bound: true, has_adapter: false }], ..unbound };
        assert_eq!(classify(&no_hci).reason, "no-adapter");
    }

    #[test]
    fn fault_waits() {
        let mut m = Monitor::default();
        let t = Instant::now();
        let s = |x| t + Duration::from_secs(x);
        assert_eq!(m.debounce(Report::new(State::Off, "idle"), s(0)).state, State::Off);
        assert_eq!(m.debounce(Report::new(State::Fault, "no-adapter"), s(1)).state, State::Off);
        assert_eq!(m.debounce(Report::new(State::Fault, "no-adapter"), s(12)).state, State::Fault);
        assert_eq!(m.debounce(Report::new(State::Connected, "connected"), s(13)).state, State::Connected);
    }
}
