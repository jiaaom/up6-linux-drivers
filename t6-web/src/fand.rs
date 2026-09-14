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

// --- curve editing -------------------------------------------------------

/// Path to the fan daemon binary, used to validate a proposed config.
const FAND_BIN: &str = "/usr/sbin/t6-fand";

impl Fand {
    /// Replace one zone/profile curve in the config file, validate the
    /// result with `t6-fand --check`, and reload the daemon on success.
    ///
    /// Only the single `<profile> = [...]` line inside `[zones.<zone>.curves]`
    /// is rewritten, so comments and every other setting are preserved.
    pub fn set_curve(&self, zone: &str, profile: &str, points: &[[f64; 2]]) -> Result<(), String> {
        validate_points(points)?;
        let text = std::fs::read_to_string(&self.config)
            .map_err(|e| format!("cannot read {}: {e}", self.config.display()))?;

        let section = format!("[zones.{zone}.curves]");
        let new_line = format!("{profile} = {}", format_points(points));
        let mut out = String::with_capacity(text.len() + 32);
        let mut in_section = false;
        let mut replaced = false;
        for line in text.lines() {
            let t = line.trim_start();
            if t.starts_with('[') {
                in_section = t.trim_end() == section;
            }
            if in_section && !replaced && is_key_line(t, profile) {
                out.push_str(&new_line);
                out.push('\n');
                replaced = true;
            } else {
                out.push_str(line);
                out.push('\n');
            }
        }
        if !replaced {
            return Err(format!("no {profile:?} curve found for zone {zone:?}"));
        }
        self.write_checked(&out)?;
        reload_daemon();
        Ok(())
    }

    /// Write `text` to a sibling temp file, run `t6-fand --check` against it,
    /// and only replace the live config atomically if the check passes.
    fn write_checked(&self, text: &str) -> Result<(), String> {
        let tmp = self.config.with_extension("toml.new");
        std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        let check = std::process::Command::new(FAND_BIN)
            .arg("--check")
            .arg("--config")
            .arg(&tmp)
            .output();
        match check {
            Ok(o) if o.status.success() => {
                std::fs::rename(&tmp, &self.config).map_err(|e| format!("cannot install config: {e}"))
            }
            Ok(o) => {
                let _ = std::fs::remove_file(&tmp);
                let msg = String::from_utf8_lossy(&o.stderr);
                Err(format!("config rejected: {}", msg.trim()))
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                Err(format!("cannot run {FAND_BIN} --check: {e}"))
            }
        }
    }
}

fn reload_daemon() {
    let _ = std::process::Command::new("systemctl").args(["reload", "t6-fand"]).status();
}

fn validate_points(points: &[[f64; 2]]) -> Result<(), String> {
    if points.len() < 2 {
        return Err("a curve needs at least two points".into());
    }
    for w in points.windows(2) {
        if w[1][0] <= w[0][0] {
            return Err("temperatures must ascend".into());
        }
    }
    for p in points {
        if !(-20.0..=150.0).contains(&p[0]) {
            return Err("temperature out of range".into());
        }
        if !(0.0..=100.0).contains(&p[1]) {
            return Err("duty must be 0..=100".into());
        }
    }
    Ok(())
}

/// A top-level key line for `key` (`silent`, `balance`, ...) — `key` then
/// optional spaces then `=`.
fn is_key_line(trimmed: &str, key: &str) -> bool {
    trimmed
        .strip_prefix(key)
        .map(|rest| rest.trim_start().starts_with('='))
        .unwrap_or(false)
}

fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn format_points(points: &[[f64; 2]]) -> String {
    let inner: Vec<String> = points.iter().map(|p| format!("[{}, {}]", fmt_num(p[0]), fmt_num(p[1]))).collect();
    format!("[{}]", inner.join(", "))
}

#[cfg(test)]
mod curve_tests {
    use super::*;

    #[test]
    fn formats_points_as_integers_when_whole() {
        assert_eq!(format_points(&[[45.0, 0.0], [50.5, 8.0]]), "[[45, 0], [50.5, 8]]");
    }

    #[test]
    fn key_line_detection() {
        assert!(is_key_line("silent      = [[1,1]]", "silent"));
        assert!(is_key_line("balance=[[1,1]]", "balance"));
        assert!(!is_key_line("silent_x = 1", "silent"));
        assert!(!is_key_line("# silent = ...", "silent"));
    }

    #[test]
    fn rejects_bad_curves() {
        assert!(validate_points(&[[50.0, 10.0]]).is_err()); // too few
        assert!(validate_points(&[[50.0, 10.0], [40.0, 20.0]]).is_err()); // not ascending
        assert!(validate_points(&[[50.0, 10.0], [60.0, 120.0]]).is_err()); // pwm > 100
        assert!(validate_points(&[[50.0, 10.0], [60.0, 40.0]]).is_ok());
    }
}
