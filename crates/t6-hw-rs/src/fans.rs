//! Fan speeds from the t6-fand daemon's run file.
//!
//! t6-fand writes `/run/t6-fand/status.json` each control tick with one entry
//! per fan zone (measured rpm, pwm, and the sensors that drive it). We surface
//! the per-fan rpm the panel shows; the richer per-sensor detail stays in the
//! JSON for anyone who wants it. Parsing is split into a pure `parse(&str)` so
//! it can be unit-tested without the daemon running.

use serde::{Deserialize, Serialize};

const STATUS: &str = "/run/t6-fand/status.json";

#[derive(Debug, Deserialize)]
struct Zone {
    fan: String,
    #[serde(default)]
    rpm: Option<i64>,
    #[serde(default)]
    pwm_percent: Option<i64>,
    #[serde(default)]
    temp_c: Option<f64>,
    #[serde(default)]
    zone: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Status {
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    zones: Vec<Zone>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Fan {
    pub name: String,
    pub rpm: Option<i64>,
    pub pwm_percent: Option<i64>,
    pub zone: Option<String>,
    pub temp_c: Option<f64>,
}

/// Parse a t6-fand `status.json` document into the fan list and profile.
/// Returns `None` if the document is not valid t6-fand status JSON.
fn parse(text: &str) -> Option<(Option<String>, Vec<Fan>)> {
    let s: Status = serde_json::from_str(text).ok()?;
    let fans = s
        .zones
        .into_iter()
        .map(|z| Fan { name: z.fan, rpm: z.rpm, pwm_percent: z.pwm_percent, zone: z.zone, temp_c: z.temp_c })
        .collect();
    Some((s.profile, fans))
}

fn load() -> Option<(Option<String>, Vec<Fan>)> {
    parse(&std::fs::read_to_string(STATUS).ok()?)
}

/// One entry per fan, in the daemon's order. Empty if t6-fand is not running.
pub fn fans() -> Vec<Fan> {
    load().map(|(_, f)| f).unwrap_or_default()
}

/// The active fan profile name (e.g. `performance`), if the daemon is running.
pub fn profile() -> Option<String> {
    load().and_then(|(p, _)| p)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"profile":"performance","zones":[
        {"fan":"CPU fan","pwm_percent":31,"rpm":1757,"temp_c":50.0,"zone":"cpu",
         "sensors":[{"name":"coretemp/Package id 0","temp_c":50.0}]},
        {"fan":"SSD bay 1-2 fan","pwm_percent":24,"rpm":2642,"temp_c":39.85,"zone":"ssd12","sensors":[]}
    ]}"#;

    #[test]
    fn parses_fans_and_profile() {
        let (profile, fans) = parse(SAMPLE).unwrap();
        assert_eq!(profile.as_deref(), Some("performance"));
        assert_eq!(fans.len(), 2);
        assert_eq!(
            fans[0],
            Fan { name: "CPU fan".into(), rpm: Some(1757), pwm_percent: Some(31), zone: Some("cpu".into()), temp_c: Some(50.0) }
        );
        assert_eq!(fans[1].name, "SSD bay 1-2 fan");
        assert_eq!(fans[1].rpm, Some(2642));
    }

    #[test]
    fn tolerates_missing_fields_and_bad_input() {
        // rpm absent (fan spun down / not yet measured) is fine.
        let (_, fans) = parse(r#"{"zones":[{"fan":"CPU fan"}]}"#).unwrap();
        assert_eq!(fans[0].rpm, None);
        assert_eq!(fans[0].name, "CPU fan");
        // not our JSON / garbage -> None, callers fall back to empty.
        assert!(parse("not json").is_none());
        assert!(parse("{}").unwrap().1.is_empty());
    }
}
