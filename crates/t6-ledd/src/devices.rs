//! The indicator devices of the T6 and how each maps onto the `t6:*` LED
//! class devices, plus the automatic rules.

use std::path::{Path, PathBuf};


/// Automatic behaviour of a device.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Auto {
    /// Always this colour.
    Fixed(&'static str),
    /// Dark while the screen is on, white while it is off, red blink when
    /// overheating; see `power.rs`.
    Power,
    /// White while a drive sits in the bay (1-based).
    BayPresent(u8),
    /// Bluetooth status (connected, discoverable, fault); see
    /// `bluetooth.rs`. Drawn by the daemon from the Bluetooth monitor.
    Bluetooth,
    /// Wi-Fi status (online, weak, connecting, hotspot, not usable, fault);
    /// see `wifi.rs`. Drawn by the daemon from the Wi-Fi monitor.
    Wifi,
    /// Driven by the driver's charge control / the EC; never written here.
    ChargeControl,
}

pub struct Device {
    pub id: &'static str,
    pub label: &'static str,
    /// LED class devices, in the order the colour tables reference them.
    pub leds: &'static [&'static str],
    /// Colour name -> LEDs that are on. `off` must be first.
    pub colors: &'static [(&'static str, &'static [&'static str])],
    /// Colours offered for `manual` mode; `None` = every colour. Status
    /// LEDs (power, Wi-Fi, Bluetooth) only offer "off": a fixed colour
    /// would hide the status they show.
    pub manual: Option<&'static [&'static str]>,
    pub auto: Option<Auto>,
    /// What `auto` does, for the UI.
    pub auto_desc: &'static str,
}

macro_rules! rgb_colors {
    ($r:literal, $g:literal, $b:literal) => {
        &[
            ("off", &[]),
            ("red", &[$r]),
            ("green", &[$g]),
            ("blue", &[$b]),
            ("yellow", &[$r, $g]),
            ("cyan", &[$g, $b]),
            ("magenta", &[$r, $b]),
            ("white", &[$r, $g, $b]),
        ]
    };
}

macro_rules! bay {
    ($n:literal, $id:literal, $w:literal, $r:literal) => {
        Device {
            id: $id,
            label: concat!("Bay ", $n),
            leds: &[$w, $r],
            colors: &[("off", &[]), ("white", &[$w]), ("red", &[$r])],
            manual: None,
            auto: Some(Auto::BayPresent($n)),
            auto_desc: "white while a drive is installed",
        }
    };
}

pub const CATALOG: &[Device] = &[
    Device {
        id: "power",
        label: "Power button",
        leds: &["t6:system:white", "t6:system:red", "t6:system:green"],
        colors: &[("off", &[]), ("white", &["t6:system:white"]), ("red", &["t6:system:red"]), ("green", &["t6:system:green"])],
        manual: Some(&["off"]),
        auto: Some(Auto::Power),
        auto_desc: "white while the screen is off, red blink when overheating",
    },
    bay!(1, "bay1", "t6:bay0:white", "t6:bay0:red"),
    bay!(2, "bay2", "t6:bay1:white", "t6:bay1:red"),
    bay!(3, "bay3", "t6:bay2:white", "t6:bay2:red"),
    bay!(4, "bay4", "t6:bay3:white", "t6:bay3:red"),
    bay!(5, "bay5", "t6:bay4:white", "t6:bay4:red"),
    bay!(6, "bay6", "t6:bay5:white", "t6:bay5:red"),
    Device {
        id: "rgb",
        label: "Tray light",
        leds: &["t6:rgb:red", "t6:rgb:green", "t6:rgb:blue"],
        // Effect light: a single colour breathes, two cycle between them,
        // all three is a rainbow, and "off" is a real host-controlled dark
        // state (enable bit, no colour). Default off.
        colors: rgb_colors!("t6:rgb:red", "t6:rgb:green", "t6:rgb:blue"),
        manual: None,
        auto: Some(Auto::Fixed("off")),
        auto_desc: "off",
    },
    Device {
        id: "bt",
        label: "Bluetooth",
        leds: &["t6:bt:red", "t6:bt:green", "t6:bt:blue"],
        colors: rgb_colors!("t6:bt:red", "t6:bt:green", "t6:bt:blue"),
        manual: Some(&["off"]),
        auto: Some(Auto::Bluetooth),
        auto_desc: "shows the Bluetooth status",
    },
    Device {
        id: "wifi",
        label: "Wi-Fi",
        leds: &["t6:wifi:red", "t6:wifi:green", "t6:wifi:blue"],
        colors: rgb_colors!("t6:wifi:red", "t6:wifi:green", "t6:wifi:blue"),
        manual: Some(&["off"]),
        auto: Some(Auto::Wifi),
        auto_desc: "shows the Wi-Fi status",
    },
    Device {
        id: "battery",
        label: "Battery",
        leds: &["t6:battery:orange", "t6:battery:red", "t6:battery:green"],
        // No manual colours: the charge-control worker rewrites the
        // register every 30 s, so a manual setting could not stick.
        colors: &[],
        manual: None,
        auto: Some(Auto::ChargeControl),
        auto_desc: "dark on mains, orange on battery (charge control)",
    },
];

pub fn by_id(id: &str) -> Option<&'static Device> {
    CATALOG.iter().find(|d| d.id == id)
}

impl Device {
    pub fn is_bay(&self) -> bool {
        matches!(self.auto, Some(Auto::BayPresent(_)))
    }

    /// Physical bay number (1-6) for a bay device.
    pub fn bay_number(&self) -> Option<u8> {
        match self.auto {
            Some(Auto::BayPresent(n)) => Some(n),
            _ => None,
        }
    }

    /// Colours that `manual` mode may use.
    pub fn manual_colors(&self) -> Vec<&'static str> {
        match self.manual {
            Some(m) => m.to_vec(),
            None => self.colors.iter().map(|(n, _)| *n).collect(),
        }
    }

    pub fn leds_for(&self, color: &str) -> Option<&'static [&'static str]> {
        self.colors.iter().find(|(n, _)| *n == color).map(|(_, l)| *l)
    }

    /// Colour the automatic rule wants right now, or `None` when the rule
    /// is not a plain sysfs check (Bluetooth, Wi-Fi, battery) or leaves the
    /// LED alone.
    pub fn auto_color(&self) -> Option<&'static str> {
        match self.auto? {
            Auto::Fixed(c) => Some(c),
            Auto::BayPresent(n) => Some(if sources::bay_present(n) { "white" } else { "off" }),
            // White: what the LED is left at when the daemon exits.
            Auto::Power => Some("white"),
            Auto::Bluetooth | Auto::Wifi | Auto::ChargeControl => None,
        }
    }
}

/// State sources for the automatic rules. All read from sysfs.
pub mod sources {
    use super::*;

    /// T6 NVMe bay -> PCIe root port (same table as t6-fand).
    const BAY_ROOT_PORTS: [(u8, &str); 6] = [
        (1, "0000:00:06.1"),
        (2, "0000:00:06.2"),
        (3, "0000:00:06.0"),
        (4, "0000:00:1c.0"),
        (5, "0000:00:1c.2"),
        (6, "0000:00:1c.6"),
    ];

    /// A drive is present when the root port has a PCI child device
    /// (`0000:BB:DD.F`; the port's own `...:pcieNNN` service entry does
    /// not count).
    pub fn bay_present(bay: u8) -> bool {
        let Some((_, port)) = BAY_ROOT_PORTS.iter().find(|(b, _)| *b == bay) else { return false };
        let dir = Path::new("/sys/bus/pci/devices").join(port);
        std::fs::read_dir(dir)
            .map(|it| {
                it.flatten().any(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    n.starts_with("0000:") && !n.contains(":pcie") && e.path().join("vendor").exists()
                })
            })
            .unwrap_or(false)
    }

    fn read_trim(p: PathBuf) -> Option<String> {
        std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
    }

    /// AC adapter connected. `None` if no adapter is exposed.
    pub fn ac_online() -> Option<bool> {
        std::fs::read_dir("/sys/class/power_supply")
            .ok()?
            .flatten()
            .find(|e| read_trim(e.path().join("type")).as_deref() == Some("Mains"))
            .map(|e| read_trim(e.path().join("online")).as_deref() == Some("1"))
    }

    /// Bays (1-6) whose drive an md array reports faulty. Reads the standard
    /// mdraid member state (`md/dev-*/state`) and maps the failed block
    /// device back to a bay through its PCIe root port. Covers every array
    /// type, redundant or linear.
    pub fn drive_faults() -> std::collections::BTreeSet<u8> {
        let mut faults = std::collections::BTreeSet::new();
        // Debug hook: T6_LEDD_FAKE_FAULT="2,5" forces those bays to blink,
        // so the fault animation can be tested without failing a real drive.
        if let Ok(v) = std::env::var("T6_LEDD_FAKE_FAULT") {
            for n in v.split(',').filter_map(|x| x.trim().parse::<u8>().ok()) {
                if (1..=6).contains(&n) {
                    faults.insert(n);
                }
            }
        }
        let blocks = match std::fs::read_dir("/sys/block") {
            Ok(d) => d,
            Err(_) => return faults,
        };
        for e in blocks.flatten() {
            if !e.file_name().to_string_lossy().starts_with("md") {
                continue;
            }
            let members = match std::fs::read_dir(e.path().join("md")) {
                Ok(d) => d,
                Err(_) => continue,
            };
            for m in members.flatten() {
                let name = m.file_name().to_string_lossy().to_string();
                let Some(dev) = name.strip_prefix("dev-") else { continue };
                let state = read_trim(m.path().join("state")).unwrap_or_default();
                if state.contains("faulty") || state.contains("failed") {
                    if let Some(bay) = bay_of_block(dev) {
                        faults.insert(bay);
                    }
                }
            }
        }
        faults
    }

    /// Which bay a block device sits in, via its PCIe root port.
    fn bay_of_block(dev: &str) -> Option<u8> {
        let disk = whole_disk(dev);
        let real = std::fs::canonicalize(format!("/sys/block/{disk}/device")).ok()?;
        bay_of_path(&real.to_string_lossy())
    }

    /// Which bay a sysfs device path (below its PCIe root port) belongs to.
    pub fn bay_of_path(path: &str) -> Option<u8> {
        BAY_ROOT_PORTS.iter().find(|(_, port)| path.contains(port)).map(|(bay, _)| *bay)
    }

    /// Reduce a partition name to its whole disk (`nvme1n1p3` -> `nvme1n1`).
    fn whole_disk(dev: &str) -> String {
        if let Some(pos) = dev.rfind('p') {
            let (head, tail) = (&dev[..pos], &dev[pos + 1..]);
            if !tail.is_empty()
                && tail.chars().all(|c| c.is_ascii_digit())
                && head.chars().last().is_some_and(|c| c.is_ascii_digit())
            {
                return head.to_string();
            }
        }
        let trimmed = dev.trim_end_matches(|c: char| c.is_ascii_digit());
        if trimmed != dev && trimmed.starts_with("sd") {
            return trimmed.to_string();
        }
        dev.to_string()
    }

    /// True if any md RAID array is degraded (a member drive failed or
    /// dropped). Kept for the drive-fault event beep.
    pub fn array_degraded() -> bool {
        std::fs::read_dir("/sys/block")
            .map(|it| {
                it.flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("md"))
                    .any(|e| read_trim(e.path().join("md/degraded")).as_deref().is_some_and(|v| v != "0"))
            })
            .unwrap_or(false)
    }
}
