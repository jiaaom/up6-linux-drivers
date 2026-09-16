//! SSH (Secure Shell) service control.
//!
//! fnOS runs sshd as a plain `ssh.service` with no reconciler, so we toggle it
//! straight through systemd (the panel daemon is root). We report the *actual*
//! service state, not a stored flag.

use std::process::Command;

/// Whether sshd is currently running.
pub fn enabled() -> bool {
    Command::new("systemctl")
        .args(["is-active", "--quiet", "ssh"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Turn SSH on (enable + start) or off (disable + stop). Existing SSH sessions
/// survive a stop; only new connections are refused.
pub fn set(on: bool) -> Result<(), String> {
    let args: &[&str] = if on {
        &["enable", "--now", "ssh"]
    } else {
        &["disable", "--now", "ssh"]
    };
    let out = Command::new("systemctl").args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
