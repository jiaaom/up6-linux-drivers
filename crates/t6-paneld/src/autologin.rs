//! "Sign in automatically": the fnOS username + password, sealed with
//! `systemd-creds` so the panel can sign itself back in (after a reboot, a
//! service restart or an expired session) without anyone typing them.
//!
//! Sealed with the host key (`--with-key=host`, i.e. the root-only
//! /var/lib/systemd/credential.secret): a copy of this file alone can't be
//! decrypted, but someone with the whole disk (or root on this machine) can.
//! TPM sealing isn't used: FygoOS doesn't ship the tpm2-tss libraries that
//! systemd needs for it. Nothing that signs in unattended can keep the
//! password from root anyway.
//!
//! The password never leaves t6-paneld: the page only sends it once, at sign-in.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};

const DIR: &str = "/var/lib/t6-paneld";
const CRED_FILE: &str = "/var/lib/t6-paneld/fnos-login.cred";
/// Non-secret sidecar: who is remembered.
const META_FILE: &str = "/var/lib/t6-paneld/fnos-login.json";
/// Bound into the credential: decrypting under any other name fails.
const CRED_NAME: &str = "t6-panel-fnos-login";

#[derive(Serialize, Deserialize)]
struct Secret {
    user: String,
    password: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Meta {
    pub user: String,
}

fn seal(plain: &[u8]) -> bool {
    let tmp = format!("{CRED_FILE}.tmp");
    let child = Command::new("systemd-creds")
        .args(["encrypt", "--with-key=host", &format!("--name={CRED_NAME}"), "-", &tmp])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return false };
    let wrote = child.stdin.take().map(|mut s| s.write_all(plain).is_ok()).unwrap_or(false);
    let ok = wrote && child.wait().map(|s| s.success()).unwrap_or(false);
    if ok {
        set_private(&tmp);
        std::fs::rename(&tmp, CRED_FILE).is_ok()
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}

fn set_private(path: &str) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

/// Seal the credentials with the host key.
pub fn save(user: &str, password: &str) -> Result<Meta, String> {
    let _ = std::fs::create_dir_all(DIR);
    let plain = serde_json::to_vec(&Secret { user: user.into(), password: password.into() }).map_err(|e| e.to_string())?;
    if !seal(&plain) {
        return Err("could not seal the credentials (systemd-creds failed)".into());
    }
    let meta = Meta { user: user.into() };
    let _ = std::fs::write(META_FILE, serde_json::to_vec(&meta).unwrap_or_default());
    set_private(META_FILE);
    Ok(meta)
}

/// Decrypt the remembered credentials. `None` when there are none or they can
/// no longer be opened (e.g. the system key changed); unusable blobs are
/// removed so the panel falls back to a normal sign-in.
pub fn load() -> Option<(String, String)> {
    if !std::path::Path::new(CRED_FILE).exists() {
        return None;
    }
    let out = Command::new("systemd-creds")
        .args(["decrypt", &format!("--name={CRED_NAME}"), CRED_FILE, "-"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let secret: Option<Secret> = out.status.success().then(|| serde_json::from_slice(&out.stdout).ok()).flatten();
    match secret {
        Some(s) => Some((s.user, s.password)),
        None => {
            clear();
            None
        }
    }
}

pub fn meta() -> Option<Meta> {
    if !std::path::Path::new(CRED_FILE).exists() {
        return None;
    }
    std::fs::read(META_FILE).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn clear() {
    let _ = std::fs::remove_file(CRED_FILE);
    let _ = std::fs::remove_file(META_FILE);
}
