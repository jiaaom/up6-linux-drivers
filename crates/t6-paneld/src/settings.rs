//! Panel-app settings that belong to the device, not to any hardware daemon —
//! persisted so they survive a reboot. Stored as JSON under /var/lib so the
//! (root) daemon owns it; unknown/missing keys fall back to defaults.

use serde::{Deserialize, Serialize};

const DIR: &str = "/var/lib/t6-paneld";
const PATH: &str = "/var/lib/t6-paneld/settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Idle seconds before the panel screen turns off; 0 = never.
    #[serde(default)]
    pub screen_timeout_s: u32,
    /// Dashboard widget order (widget ids), top to bottom.
    #[serde(default)]
    pub dashboard_order: Vec<String>,
    /// Widget ids the user has hidden.
    #[serde(default)]
    pub dashboard_hidden: Vec<String>,
    /// UI language code, e.g. "en", "ja", "zh". Empty = default (en).
    #[serde(default)]
    pub language: String,
}

pub fn load() -> Settings {
    std::fs::read_to_string(PATH).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(s: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(DIR).map_err(|e| format!("{DIR}: {e}"))?;
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let tmp = format!("{PATH}.tmp");
    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, PATH)).map_err(|e| format!("{PATH}: {e}"))
}

/// Persist a new screen-timeout (seconds; 0 = never) and return the result.
pub fn set_screen_timeout(secs: u32) -> Result<Settings, String> {
    let mut s = load();
    s.screen_timeout_s = secs;
    save(&s)?;
    Ok(s)
}

/// Persist the dashboard layout (widget order + hidden set).
pub fn set_dashboard(order: Vec<String>, hidden: Vec<String>) -> Result<Settings, String> {
    let mut s = load();
    s.dashboard_order = order;
    s.dashboard_hidden = hidden;
    save(&s)?;
    Ok(s)
}

/// Persist the UI language code.
pub fn set_language(code: String) -> Result<Settings, String> {
    let mut s = load();
    s.language = code;
    save(&s)?;
    Ok(s)
}
