//! Panel-app settings that belong to the device, not to any hardware daemon —
//! persisted so they survive a reboot. Stored as JSON under /var/lib so the
//! (root) daemon owns it; unknown/missing keys fall back to defaults.

use serde::{Deserialize, Serialize};

const DIR: &str = "/var/lib/t6-paneld";
const PATH: &str = "/var/lib/t6-paneld/settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Before 2.0: idle seconds before the screen turned off (0 = never).
    /// Read only to carry the choice over (see `dim_after_s`, `off_after_s`);
    /// dropped once the new settings are saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_timeout_s: Option<u32>,
    /// Idle seconds before the screen dims; 0 = never dims. None = default
    /// (or carried over from `screen_timeout_s`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dim_after_s: Option<u32>,
    /// The dimmed level, in percent of the normal brightness (10, 25, 50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dim_percent: Option<u32>,
    /// Idle seconds (counted from the last touch, not from dimming) before
    /// the screen turns off; 0 = never.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off_after_s: Option<u32>,
    /// The normal brightness while the screen is dimmed (idle.rs), so it can
    /// be put back after a restart that happened while dim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimmed_from: Option<u32>,
    /// Dashboard widget order (widget ids), top to bottom.
    #[serde(default)]
    pub dashboard_order: Vec<String>,
    /// Widget ids the user has hidden.
    #[serde(default)]
    pub dashboard_hidden: Vec<String>,
    /// UI language code: "zh" or "en". Empty = default (zh).
    #[serde(default)]
    pub language: String,
    /// Panel colour theme: "light" (default) or "dark". Empty = light.
    #[serde(default)]
    pub theme: String,
    /// Send limited-range RGB to the front panel (panel/app/compositor-pre-start
    /// reads this key before the compositor starts). None = default = on; see
    /// set-drm-prop.py.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_correction: Option<bool>,
    /// Run the on-device kiosk (front-panel app). None = default = on. The
    /// package's start/install scripts and t6-paneld's own startup read it,
    /// so "off" survives App Center restarts, upgrades and reboots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_enabled: Option<bool>,
}

/// The choices offered (seconds; percent). Anything else is refused.
pub const DIM_AFTER_CHOICES: [u32; 5] = [0, 60, 120, 300, 900];
pub const DIM_PERCENT_CHOICES: [u32; 3] = [10, 25, 50];
pub const OFF_AFTER_CHOICES: [u32; 4] = [0, 3600, 43200, 86400];
const DIM_AFTER_DEFAULT: u32 = 120;
const DIM_PERCENT_DEFAULT: u32 = 25;
const OFF_AFTER_DEFAULT: u32 = 3600;

impl Settings {
    /// Idle seconds before dimming; 0 = never. A pre-2.0 screen timeout
    /// becomes the nearest dimming time at or below it.
    pub fn dim_after_s(&self) -> u32 {
        self.dim_after_s.unwrap_or_else(|| match self.screen_timeout_s {
            Some(n) if n > 0 => DIM_AFTER_CHOICES.iter().copied().filter(|&c| c > 0 && c <= n).max().unwrap_or(60),
            _ => DIM_AFTER_DEFAULT,
        })
    }

    pub fn dim_percent(&self) -> u32 {
        self.dim_percent.unwrap_or(DIM_PERCENT_DEFAULT)
    }

    /// Idle seconds before the screen turns off; 0 = never. A pre-2.0
    /// "never" stays never; any other old timeout becomes the default hour.
    pub fn off_after_s(&self) -> u32 {
        self.off_after_s.unwrap_or(match self.screen_timeout_s {
            Some(0) => 0,
            _ => OFF_AFTER_DEFAULT,
        })
    }

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

/// Persist when the screen dims and turns off, and how dim it gets. Each
/// value must be one of the choices offered; None keeps the current one.
pub fn set_screen_idle(dim_after_s: Option<u32>, dim_percent: Option<u32>, off_after_s: Option<u32>) -> Result<Settings, String> {
    let check = |v: Option<u32>, ok: &[u32], what: &str| match v {
        Some(x) if !ok.contains(&x) => Err(format!("invalid {what} {x} (want one of {ok:?})")),
        _ => Ok(()),
    };
    check(dim_after_s, &DIM_AFTER_CHOICES, "dim_after_s")?;
    check(dim_percent, &DIM_PERCENT_CHOICES, "dim_percent")?;
    check(off_after_s, &OFF_AFTER_CHOICES, "off_after_s")?;
    let mut s = load();
    // write all three out, so the pre-2.0 value is no longer needed
    s.dim_after_s = Some(dim_after_s.unwrap_or(s.dim_after_s()));
    s.dim_percent = Some(dim_percent.unwrap_or(s.dim_percent()));
    s.off_after_s = Some(off_after_s.unwrap_or(s.off_after_s()));
    s.screen_timeout_s = None;
    save(&s)?;
    Ok(s)
}

/// Remember the normal brightness while dimmed (None once it is back).
pub fn set_dimmed_from(level: Option<u32>) -> Result<(), String> {
    let mut s = load();
    if s.dimmed_from == level {
        return Ok(());
    }
    s.dimmed_from = level;
    save(&s)
}

/// Persist the dashboard layout (widget order + hidden set).
pub fn set_dashboard(order: Vec<String>, hidden: Vec<String>) -> Result<Settings, String> {
    let mut s = load();
    s.dashboard_order = order;
    s.dashboard_hidden = hidden;
    save(&s)?;
    Ok(s)
}

/// Persist the UI language code ("zh" | "en").
pub fn set_language(code: String) -> Result<Settings, String> {
    if code != "zh" && code != "en" {
        return Err(format!("invalid language {code:?} (want zh|en)"));
    }
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

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn carries_the_old_timeout_over() {
        let fresh = Settings::default();
        assert_eq!((fresh.dim_after_s(), fresh.dim_percent(), fresh.off_after_s()), (120, 25, 3600));
        let never = Settings { screen_timeout_s: Some(0), ..Default::default() };
        assert_eq!((never.dim_after_s(), never.off_after_s()), (120, 0));
        let half_hour = Settings { screen_timeout_s: Some(1800), ..Default::default() };
        assert_eq!((half_hour.dim_after_s(), half_hour.off_after_s()), (900, 3600));
        let one_min = Settings { screen_timeout_s: Some(60), ..Default::default() };
        assert_eq!(one_min.dim_after_s(), 60);
        let set = Settings { screen_timeout_s: Some(60), dim_after_s: Some(0), off_after_s: Some(86400), ..Default::default() };
        assert_eq!((set.dim_after_s(), set.off_after_s()), (0, 86400));
    }
}
