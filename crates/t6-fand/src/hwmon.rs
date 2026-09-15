//! Discovery and access of hwmon fans and temperature sensors.

use std::fs;
use std::path::{Path, PathBuf};

const HWMON_ROOT: &str = "/sys/class/hwmon";

/// T6 NVMe bay → PCIe root port (recovered from the vendor nvme LED patch).
const BAY_ROOT_PORTS: [(u8, &str); 6] = [
    (1, "0000:00:06.1"),
    (2, "0000:00:06.2"),
    (3, "0000:00:06.0"),
    (4, "0000:00:1c.0"),
    (5, "0000:00:1c.2"),
    (6, "0000:00:1c.6"),
];

fn read_trim(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// All hwmon devices with the given `name`.
fn hwmon_by_name(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(HWMON_ROOT) {
        for e in entries.flatten() {
            if read_trim(&e.path().join("name")).as_deref() == Some(name) {
                out.push(e.path());
            }
        }
    }
    out.sort();
    out
}

/// Find `<prefix>N` whose `<prefix>N_label` equals `label`; returns N.
fn channel_by_label(dev: &Path, prefix: &str, label: &str) -> Option<u32> {
    for n in 1..=32 {
        let p = dev.join(format!("{prefix}{n}_label"));
        if !p.exists() {
            continue;
        }
        if read_trim(&p).as_deref() == Some(label) {
            return Some(n);
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct Fan {
    pub label: String,
    pwm: PathBuf,
    enable: PathBuf,
    input: PathBuf,
}

impl Fan {
    pub fn find(hwmon_name: &str, label: &str) -> Result<Self, String> {
        let dev = hwmon_by_name(hwmon_name)
            .into_iter()
            .next()
            .ok_or_else(|| format!("hwmon device {hwmon_name:?} not found"))?;
        let n = channel_by_label(&dev, "fan", label)
            .ok_or_else(|| format!("{hwmon_name}: no fan labelled {label:?}"))?;
        Ok(Fan {
            label: label.to_string(),
            pwm: dev.join(format!("pwm{n}")),
            enable: dev.join(format!("pwm{n}_enable")),
            input: dev.join(format!("fan{n}_input")),
        })
    }

    /// Put the channel under host control (idempotent).
    pub fn take_control(&self) -> Result<(), String> {
        if read_trim(&self.enable).as_deref() != Some("1") {
            fs::write(&self.enable, "1").map_err(|e| format!("{}: {e}", self.enable.display()))?;
        }
        Ok(())
    }

    pub fn set_percent(&self, percent: u8) -> Result<(), String> {
        let raw = (u32::from(percent.min(100)) * 255 + 50) / 100;
        fs::write(&self.pwm, raw.to_string()).map_err(|e| format!("{}: {e}", self.pwm.display()))
    }

    pub fn rpm(&self) -> Option<u32> {
        read_trim(&self.input)?.parse().ok()
    }
}

#[derive(Debug, Clone)]
pub struct Sensor {
    pub name: String,
    input: PathBuf,
}

impl Sensor {
    /// Resolve a sensor spec. Missing NVMe bays resolve to `None` (empty bay);
    /// anything else that cannot be found is an error.
    pub fn resolve(spec: &str) -> Result<Option<Self>, String> {
        let (dev, sel) = spec
            .split_once('/')
            .ok_or_else(|| format!("sensor {spec:?}: expected <hwmon>/<label|tempN> or bay/<n>"))?;

        if dev == "bay" {
            let bay: u8 = sel.parse().map_err(|_| format!("sensor {spec:?}: bad bay number"))?;
            let port = BAY_ROOT_PORTS
                .iter()
                .find(|(b, _)| *b == bay)
                .map(|(_, p)| *p)
                .ok_or_else(|| format!("sensor {spec:?}: bays are 1..=6"))?;
            return Ok(nvme_in_root_port(port).map(|(dev, model)| Sensor {
                name: format!("bay {bay} ({model})"),
                input: dev.join("temp1_input"),
            }));
        }

        let devs = hwmon_by_name(dev);
        if devs.is_empty() {
            return Err(format!("sensor {spec:?}: hwmon device {dev:?} not found"));
        }
        for d in &devs {
            let n = if let Some(num) = sel.strip_prefix("temp").and_then(|s| s.parse::<u32>().ok()) {
                Some(num)
            } else {
                channel_by_label(d, "temp", sel)
            };
            if let Some(n) = n {
                let input = d.join(format!("temp{n}_input"));
                if input.exists() {
                    return Ok(Some(Sensor { name: format!("{dev}/{sel}"), input }));
                }
            }
        }
        Err(format!("sensor {spec:?}: no such channel"))
    }

    /// Temperature in °C, or `None` when the kernel reports no data.
    pub fn celsius(&self) -> Option<f64> {
        read_trim(&self.input)?.parse::<f64>().ok().map(|m| m / 1000.0)
    }
}

/// hwmon directory and model of the NVMe controller behind a root port, if any.
fn nvme_in_root_port(port: &str) -> Option<(PathBuf, String)> {
    for dev in hwmon_by_name("nvme") {
        // hwmonN/device -> nvme controller (nvmeX); nvmeX/device -> PCI function; parent -> root port
        let ctrl = fs::canonicalize(dev.join("device")).ok()?;
        let pci = fs::canonicalize(ctrl.join("device")).ok()?;
        let parent = pci.parent()?.file_name()?.to_string_lossy().to_string();
        if parent == port {
            let model = read_trim(&ctrl.join("model")).unwrap_or_default();
            return Some((dev, model));
        }
    }
    None
}
