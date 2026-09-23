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
    /// Panel colour theme: "dark" (default) or "light". Empty = dark.
    #[serde(default)]
    pub theme: String,
    /// Send limited-range RGB to the front panel (run-kiosk.sh reads this key
    /// before starting weston). None = default = on; see set-drm-prop.py.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_correction: Option<bool>,
    /// Run the on-device kiosk (front-panel app). None = default = on. The
    /// package's start/install scripts and t6-paneld's own startup read it,
    /// so "off" survives App Center restarts, upgrades and reboots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_enabled: Option<bool>,
}

impl Settings {
    pub fn color_correction(&self) -> bool {
        self.color_correction.unwrap_or(true)
    }

    pub fn panel_enabled(&self) -> bool {
        self.panel_enabled.unwrap_or(true)
    }
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

/// Persist the panel colour theme ("dark" | "light").
pub fn set_theme(theme: String) -> Result<Settings, String> {
    if theme != "dark" && theme != "light" {
        return Err(format!("invalid theme {theme:?} (want dark|light)"));
    }
    let mut s = load();
    s.theme = theme;
    save(&s)?;
    Ok(s)
}

/// Persist the front-panel colour-range correction on/off.
pub fn set_color_correction(on: bool) -> Result<Settings, String> {
    let mut s = load();
    s.color_correction = Some(on);
    save(&s)?;
    Ok(s)
}

/// Persist whether the on-device kiosk should run.
pub fn set_panel_enabled(on: bool) -> Result<Settings, String> {
    let mut s = load();
    s.panel_enabled = Some(on);
    save(&s)?;
    Ok(s)
}
