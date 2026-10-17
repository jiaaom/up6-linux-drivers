//! Theme "night" (设置 › 主题 › 跟随夜间): dark inside a window of the
//! day, light outside it, by the machine's local time. 夜案 in the control
//! center can hold the other theme until the window's next change
//! (Ridgeline ControlCenter › 夜案). No timer: /api/panel is polled every
//! 2 s and reports the theme in effect, so the panel switches on time.

use chrono::{DateTime, Duration, NaiveTime, TimeZone, Timelike};
use serde_json::{json, Value};

use crate::settings::{Settings, ThemeHold};

const FROM_DEFAULT: &str = "22:00";
const TO_DEFAULT: &str = "07:00";

/// "HH:MM" in 30-minute steps → minutes after midnight.
pub fn parse(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && (m == 0 || m == 30) && hhmm.len() == 5).then_some(h * 60 + m)
}

fn hhmm(min: u32) -> String {
    format!("{:02}:{:02}", min / 60, min % 60)
}

/// The window, in minutes after midnight (from, to); may cross midnight.
pub fn window(s: &Settings) -> (u32, u32) {
    let get = |v: &Option<String>, d: &str| v.as_deref().and_then(parse).unwrap_or_else(|| parse(d).unwrap());
    (get(&s.night_from, FROM_DEFAULT), get(&s.night_to, TO_DEFAULT))
}

fn in_window(min: u32, (from, to): (u32, u32)) -> bool {
    if from < to { from <= min && min < to } else { min >= from || min < to }
}

/// Dark by the window at `now` (ignoring any hold).
fn dark_by_window<Tz: TimeZone>(s: &Settings, now: &DateTime<Tz>) -> bool {
    in_window(now.hour() * 60 + now.minute(), window(s))
}

/// The window's next edge after `now`, as a local time (across a DST change
/// the wall-clock time is kept).
fn next_change<Tz: TimeZone>(s: &Settings, now: &DateTime<Tz>) -> DateTime<Tz> {
    let (from, to) = window(s);
    let tz = now.timezone();
    [from, to]
        .into_iter()
        .filter_map(|edge| {
            let t = NaiveTime::from_hms_opt(edge / 60, edge % 60, 0)?;
            let mut day = now.date_naive();
            if day.and_time(t) <= now.naive_local() {
                day = day.succ_opt()?;
            }
            let naive = day.and_time(t);
            tz.from_local_datetime(&naive).earliest().or_else(|| tz.from_local_datetime(&(naive + Duration::hours(1))).earliest())
        })
        .min()
        .expect("a window has two edges")
}

/// The hold 夜案 starts at `now`: the other theme until the next change.
pub fn hold<Tz: TimeZone>(s: &Settings, now: DateTime<Tz>) -> ThemeHold {
    ThemeHold {
        theme: if dark_by_window(s, &now) { "light" } else { "dark" }.into(),
        until: next_change(s, &now).timestamp(),
    }
}

fn active_hold<'a, Tz: TimeZone>(s: &'a Settings, now: &DateTime<Tz>) -> Option<&'a ThemeHold> {
    s.theme_hold.as_ref().filter(|h| s.theme == "night" && now.timestamp() < h.until)
}

/// The theme in effect: "light" or "dark".
pub fn effective<Tz: TimeZone>(s: &Settings, now: &DateTime<Tz>) -> &'static str {
    match s.theme.as_str() {
        "dark" => "dark",
        "night" => match active_hold(s, now) {
            Some(h) if h.theme == "dark" => "dark",
            Some(_) => "light",
            None if dark_by_window(s, now) => "dark",
            None => "light",
        },
        _ => "light",
    }
}

/// /api/panel's `theme_night`: the window, what it says now, its next
/// change and the hold, for 设置 › 夜间时段 and 夜案's line.
pub fn info<Tz: TimeZone>(s: &Settings, now: &DateTime<Tz>) -> Value {
    let (from, to) = window(s);
    let hold = active_hold(s, now).map(|h| {
        let until = now.timezone().timestamp_opt(h.until, 0).single().map(|t| hhmm(t.hour() * 60 + t.minute())).unwrap_or_default();
        json!({ "theme": h.theme, "until": until })
    });
    let next = next_change(s, now);
    json!({
        "from": hhmm(from),
        "to": hhmm(to),
        "dark": dark_by_window(s, now),
        "next_change": hhmm(next.hour() * 60 + next.minute()),
        "hold": hold,
    })
}

pub fn mode(s: &Settings) -> &str {
    match s.theme.as_str() {
        "dark" | "night" => &s.theme,
        _ => "light",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(h: u32, m: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(-4 * 3600).unwrap().with_ymd_and_hms(2026, 10, 17, h, m, 0).unwrap()
    }
    fn night(from: &str, to: &str) -> Settings {
        Settings { theme: "night".into(), night_from: Some(from.into()), night_to: Some(to.into()), ..Default::default() }
    }

    #[test]
    fn parses_half_hours_only() {
        assert_eq!(parse("22:00"), Some(1320));
        assert_eq!(parse("07:30"), Some(450));
        assert_eq!(parse("07:15"), None);
        assert_eq!(parse("24:00"), None);
        assert_eq!(parse("7:00"), None);
    }

    #[test]
    fn window_across_midnight() {
        let s = night("22:00", "07:00");
        assert_eq!(effective(&s, &at(23, 0)), "dark");
        assert_eq!(effective(&s, &at(3, 0)), "dark");
        assert_eq!(effective(&s, &at(7, 0)), "light");
        assert_eq!(effective(&s, &at(21, 59)), "light");
        assert_eq!(next_change(&s, &at(23, 0)), at(7, 0) + Duration::days(1));
        assert_eq!(next_change(&s, &at(14, 0)), at(22, 0));
        assert_eq!(next_change(&s, &at(3, 0)), at(7, 0));
    }

    #[test]
    fn window_within_a_day() {
        let s = night("13:00", "15:30");
        assert_eq!(effective(&s, &at(14, 0)), "dark");
        assert_eq!(effective(&s, &at(16, 0)), "light");
        assert_eq!(next_change(&s, &at(16, 0)), at(13, 0) + Duration::days(1));
    }

    #[test]
    fn hold_lasts_until_the_next_change() {
        let mut s = night("22:00", "07:00");
        let h = hold(&s, at(23, 30));
        assert_eq!(h.theme, "light");
        assert_eq!(h.until, (at(7, 0) + Duration::days(1)).timestamp());
        s.theme_hold = Some(h);
        assert_eq!(effective(&s, &at(23, 45)), "light");
        assert_eq!(effective(&s, &(at(6, 59) + Duration::days(1))), "light");
        // at 07:00 the window says light anyway, and from 22:00 it is dark again
        assert_eq!(effective(&s, &(at(22, 0) + Duration::days(1))), "dark");
        // a fixed theme ignores the hold
        s.theme = "dark".into();
        assert_eq!(effective(&s, &at(23, 45)), "dark");
    }

    #[test]
    fn defaults() {
        let s = Settings::default();
        assert_eq!(window(&s), (1320, 420));
        assert_eq!(effective(&s, &at(23, 0)), "light");
        assert_eq!(mode(&s), "light");
    }
}
