//! Read-only device hardware specification (DMI, /proc, sysfs, lspci).
//! On-demand (not per-poll); safe with or without a login.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct Drive {
    pub model: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Default)]
pub struct HwInfo {
    pub model: Option<String>,
    pub vendor: Option<String>,
    pub serial: Option<String>,
    pub bios: Option<String>,
    pub cpu: Option<String>,
    pub cpu_threads: usize,
    pub gpu: Option<String>,
    pub ram_bytes: Option<u64>,
    pub drives: Vec<Drive>,
}

fn read_trim(p: &str) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn dmi(field: &str) -> Option<String> {
    read_trim(&format!("/sys/class/dmi/id/{field}"))
}

fn cpu_model() -> Option<String> {
    for l in std::fs::read_to_string("/proc/cpuinfo").ok()?.lines() {
        if let Some(v) = l.strip_prefix("model name") {
            return Some(v.trim_start_matches(|c: char| c == ' ' || c == '\t' || c == ':').trim().to_string());
        }
    }
    None
}

fn cpu_threads() -> usize {
    std::fs::read_to_string("/proc/cpuinfo").map(|t| t.lines().filter(|l| l.starts_with("processor")).count()).unwrap_or(0)
}

fn ram_bytes() -> Option<u64> {
    for l in std::fs::read_to_string("/proc/meminfo").ok()?.lines() {
        if let Some(v) = l.strip_prefix("MemTotal:") {
            return v.split_whitespace().next()?.parse::<u64>().ok().map(|kb| kb * 1024);
        }
    }
    None
}

fn gpu() -> Option<String> {
    let out = Command::new("lspci").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for l in s.lines() {
        let ll = l.to_lowercase();
        if ll.contains("vga") || ll.contains("3d controller") || ll.contains(" display ") {
            return l.splitn(2, ": ").nth(1).map(|x| x.trim().to_string());
        }
    }
    None
}

fn drives() -> Vec<Drive> {
    let mut names: Vec<String> = match std::fs::read_dir("/sys/block") {
        Ok(it) => it
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with("nvme") && n.ends_with("n1"))
            .collect(),
        Err(_) => return Vec::new(),
    };
    names.sort();
    names
        .into_iter()
        .map(|n| {
            let model = read_trim(&format!("/sys/block/{n}/device/model")).unwrap_or_else(|| n.clone());
            let sectors = read_trim(&format!("/sys/block/{n}/size")).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            Drive { model, size_bytes: sectors * 512 }
        })
        .collect()
}

pub fn info() -> HwInfo {
    HwInfo {
        model: dmi("product_name"),
        vendor: dmi("sys_vendor"),
        serial: dmi("product_serial"),
        bios: dmi("bios_version"),
        cpu: cpu_model(),
        cpu_threads: cpu_threads(),
        gpu: gpu(),
        ram_bytes: ram_bytes(),
        drives: drives(),
    }
}
