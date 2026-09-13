//! Client side of `t6-fand`: its live control surface under `/run/t6-fand`
//! and its configuration file.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const RUN_DIR: &str = "/run/t6-fand";
pub const CONFIG: &str = "/etc/t6-fand.toml";

pub struct Fand {
    run_dir: PathBuf,
    config: PathBuf,
}

/// Configuration as seen by the UI.
pub struct Config {
    /// Parsed file, for display.
    pub value: toml::Value,
    /// `profile` key: the default used when no override is set.
    pub profile: Option<String>,
    /// Profiles for which every zone has a curve.
    pub profiles: Vec<String>,
}

impl Fand {
    pub fn new() -> Self {
        Fand { run_dir: PathBuf::from(RUN_DIR), config: PathBuf::from(CONFIG) }
    }

    /// Live state as written by the daemon each cycle, or `None` if it is
    /// not running.
    pub fn status(&self) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(self.run_dir.join("status.json")).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Runtime profile override, if one is set.
    pub fn profile_override(&self) -> Option<String> {
        let p = std::fs::read_to_string(self.run_dir.join("profile")).ok()?;
        let p = p.trim();
        (!p.is_empty()).then(|| p.to_string())
    }

    pub fn config(&self) -> Result<Config, String> {
        let text = std::fs::read_to_string(&self.config)
            .map_err(|e| format!("cannot read {}: {e}", self.config.display()))?;
        let value: toml::Value = toml::from_str(&text).map_err(|e| format!("{}: {e}", self.config.display()))?;
        let profile = value.get("profile").and_then(|v| v.as_str()).map(str::to_string);
        let profiles = common_profiles(&value);
        Ok(Config { value, profile, profiles })
    }

    /// Switch profile: takes effect on the daemon's next cycle through the
    /// runtime override, and is persisted as the config default so it
    /// survives a reboot (the daemon only reads the file on load/reload).
    pub fn set_profile(&self, profile: &str) -> Result<(), String> {
        let cfg = self.config()?;
        if !cfg.profiles.iter().any(|p| p == profile) {
            return Err(format!("unknown profile {profile:?}; available: {}", cfg.profiles.join(", ")));
        }
        if !self.run_dir.is_dir() {
            return Err("t6-fand is not running".into());
        }
        write_atomic(&self.run_dir.join("profile"), profile)?;
        self.persist_profile(profile)
    }

    /// Rewrite only the `profile = "..."` line, keeping comments and layout.
    fn persist_profile(&self, profile: &str) -> Result<(), String> {
        let text = std::fs::read_to_string(&self.config).map_err(|e| e.to_string())?;
        let mut done = false;
        let mut out = String::with_capacity(text.len() + 32);
        for line in text.lines() {
            if !done && is_profile_line(line) {
                out.push_str(&format!("profile = \"{profile}\"\n"));
                done = true;
            } else {
                out.push_str(line);
                out.push('\n');
            }
        }
        if !done {
            // No top-level key yet: it must precede the first table.
            let idx = out.find("\n[").map(|i| i + 1).unwrap_or(out.len());
            out.insert_str(idx, &format!("profile = \"{profile}\"\n"));
        }
        write_atomic(&self.config, &out)
    }

    #[allow(dead_code)]
    pub fn run_dir(&self) -> &Path {
        &self.run_dir
    }
}

/// Top-level `profile = ...` (only before the first `[table]`, which the
/// caller guarantees by scanning from the top and stopping at the first hit).
fn is_profile_line(line: &str) -> bool {
    let l = line.trim_start();
    l.starts_with("profile") && l["profile".len()..].trim_start().starts_with('=')
}

fn common_profiles(cfg: &toml::Value) -> Vec<String> {
    let zones = match cfg.get("zones").and_then(|z| z.as_table()) {
        Some(z) => z,
        None => return Vec::new(),
    };
    let mut common: Option<BTreeSet<String>> = None;
    for zone in zones.values() {
        let names: BTreeSet<String> = zone
            .get("curves")
            .and_then(|c| c.as_table())
            .map(|c| c.keys().cloned().collect())
            .unwrap_or_default();
        common = Some(match common {
            None => names,
            Some(c) => c.intersection(&names).cloned().collect(),
        });
    }
    common.unwrap_or_default().into_iter().collect()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_line_detection() {
        assert!(is_profile_line("profile = \"balance\""));
        assert!(is_profile_line("  profile=\"x\""));
        assert!(!is_profile_line("profiles = 1"));
        assert!(!is_profile_line("# profile = \"x\""));
    }

    #[test]
    fn common_profiles_is_intersection() {
        let v: toml::Value = toml::from_str(
            "[zones.a.curves]\nsilent=[[1,1]]\nbalance=[[1,1]]\n[zones.b.curves]\nbalance=[[1,1]]\nperf=[[1,1]]\n",
        )
        .unwrap();
        assert_eq!(common_profiles(&v), vec!["balance".to_string()]);
    }
}
