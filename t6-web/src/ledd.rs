//! Client side of `t6-ledd`: live state from `/run/t6-ledd/status.json`,
//! changes through its control socket (the daemon persists them).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

pub const RUN_DIR: &str = "/run/t6-ledd";

pub struct Ledd {
    run_dir: PathBuf,
}

impl Ledd {
    pub fn new() -> Self {
        Ledd { run_dir: PathBuf::from(RUN_DIR) }
    }

    pub fn status(&self) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(self.run_dir.join("status.json")).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Send one command line; `Ok` on the daemon's `ok`, its message otherwise.
    pub fn command(&self, line: &str) -> Result<(), String> {
        if line.contains('\n') {
            return Err("invalid command".into());
        }
        let mut stream = UnixStream::connect(self.run_dir.join("ctl")).map_err(|_| "t6-ledd is not running".to_string())?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        stream.write_all(format!("{line}\n").as_bytes()).map_err(|e| e.to_string())?;
        let mut reply = String::new();
        BufReader::new(&stream).read_line(&mut reply).map_err(|e| e.to_string())?;
        let reply = reply.trim();
        if reply == "ok" {
            Ok(())
        } else {
            Err(reply.strip_prefix("error: ").unwrap_or(reply).to_string())
        }
    }

    /// A single word safe to put on a command line.
    pub fn word(s: &str) -> Result<&str, String> {
        if !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ':') {
            Ok(s)
        } else {
            Err(format!("invalid value {s:?}"))
        }
    }
}
