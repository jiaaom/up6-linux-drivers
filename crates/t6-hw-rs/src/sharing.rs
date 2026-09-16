//! Read-only SMB/NFS sharing status.
//!
//! fnOS owns share *config* (its `com.trim.share` RPC service); we only read.
//! SMB shares live in per-user includes `/etc/samba/users/<uid>.share.conf`
//! (+ `smb.custom.conf`), not the `[global]` smb.conf — so we parse those.
//! NFS exports come from `exportfs`. Service on/off is from systemd.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct Share {
    pub name: String,
    pub path: String,
    /// "smb" or "nfs".
    pub protocol: String,
}

/// Full sharing detail (protocol state, active connections, and the share list).
#[derive(Serialize)]
pub struct Sharing {
    pub smb: bool,
    pub nfs: bool,
    pub connections: u32,
    pub shares: Vec<Share>,
}

/// Lightweight summary for the dashboard tile (no per-share paths, no smbstatus).
#[derive(Serialize)]
pub struct SharingSummary {
    pub smb: bool,
    pub nfs: bool,
    pub shares: u32,
}

fn svc_active(unit: &str) -> bool {
    Command::new("systemctl").args(["is-active", "--quiet", unit]).status().map(|s| s.success()).unwrap_or(false)
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(cmd).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// SMB shares from the per-user include files (INI: `[name]` + `path = ...`).
fn smb_shares() -> Vec<Share> {
    let mut out = Vec::new();
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir("/etc/samba/users")
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "conf").unwrap_or(false)).collect())
        .unwrap_or_default();
    files.push("/etc/samba/smb.custom.conf".into());
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let mut section: Option<String> = None;
        for line in text.lines() {
            let l = line.trim();
            if let Some(name) = l.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                section = (name != "global").then(|| name.to_string());
            } else if let Some(rest) = l.strip_prefix("path") {
                if let Some(p) = rest.trim_start().strip_prefix('=') {
                    if let Some(name) = &section {
                        out.push(Share { name: name.clone(), path: p.trim().to_string(), protocol: "smb".into() });
                    }
                }
            }
        }
    }
    out
}

/// NFS exports from `exportfs -v` (first column is the path).
fn nfs_shares() -> Vec<Share> {
    run("exportfs", &["-v"])
        .map(|out| {
            out.lines()
                .filter_map(|l| {
                    let path = l.split_whitespace().next()?;
                    (path.starts_with('/')).then(|| Share {
                        name: path.rsplit('/').next().unwrap_or(path).to_string(),
                        path: path.to_string(),
                        protocol: "nfs".into(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Count of active SMB sessions (best-effort via `smbstatus -b`).
fn smb_sessions() -> u32 {
    run("smbstatus", &["-b"])
        .map(|out| {
            // Data rows carry a PID first column; skip headers/blank/separators.
            out.lines().filter(|l| l.split_whitespace().next().map(|f| f.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)).count() as u32
        })
        .unwrap_or(0)
}

fn all_shares() -> Vec<Share> {
    let mut s = smb_shares();
    s.extend(nfs_shares());
    s
}

/// Full detail (used by the Sharing page).
pub fn info() -> Sharing {
    Sharing {
        smb: svc_active("smbd"),
        nfs: svc_active("nfs-server"),
        connections: smb_sessions(),
        shares: all_shares(),
    }
}

/// Cheap summary for the dashboard poll (no smbstatus, no per-share paths).
pub fn summary() -> SharingSummary {
    SharingSummary {
        smb: svc_active("smbd"),
        nfs: svc_active("nfs-server"),
        shares: all_shares().len() as u32,
    }
}
