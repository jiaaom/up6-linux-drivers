//! Daily time window, `"HH:MM-HH:MM"`, possibly crossing midnight.

use chrono::{NaiveTime, Timelike};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    start: u32, // minutes since midnight
    end: u32,
}

impl Window {
    pub fn parse(spec: &str) -> Result<Self, String> {
        let (a, b) = spec.split_once('-').ok_or_else(|| format!("{spec:?}: expected HH:MM-HH:MM"))?;
        let m = |s: &str| {
            NaiveTime::parse_from_str(s.trim(), "%H:%M")
                .map(|t| t.hour() * 60 + t.minute())
                .map_err(|_| format!("{s:?}: expected HH:MM"))
        };
        let (start, end) = (m(a)?, m(b)?);
        if start == end {
            return Err("start and end must differ".into());
        }
        Ok(Window { start, end })
    }

    /// Whether `now` (minutes since midnight) falls inside the window.
    pub fn contains(&self, now: u32) -> bool {
        if self.start < self.end {
            (self.start..self.end).contains(&now)
        } else {
            now >= self.start || now < self.end
        }
    }

    pub fn active_now(&self) -> bool {
        let t = chrono::Local::now().time();
        self.contains(t.hour() * 60 + t.minute())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_day_window() {
        let w = Window::parse("09:00-17:30").unwrap();
        assert!(w.contains(9 * 60));
        assert!(w.contains(17 * 60 + 29));
        assert!(!w.contains(17 * 60 + 30));
        assert!(!w.contains(8 * 60 + 59));
    }

    #[test]
    fn overnight_window() {
        let w = Window::parse("23:00-07:00").unwrap();
        assert!(w.contains(23 * 60));
        assert!(w.contains(0));
        assert!(w.contains(6 * 60 + 59));
        assert!(!w.contains(7 * 60));
        assert!(!w.contains(12 * 60));
    }

    #[test]
    fn rejects_bad_specs() {
        assert!(Window::parse("23:00").is_err());
        assert!(Window::parse("25:00-07:00").is_err());
        assert!(Window::parse("07:00-07:00").is_err());
    }
}
