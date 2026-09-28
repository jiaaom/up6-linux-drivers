//! Linux key names (linux/input-event-codes.h) accepted in the config. A
//! number is accepted too, for anything not listed.

const KEYS: &[(&str, u16)] = &[
    ("KEY_ESC", 1),
    ("KEY_1", 2),
    ("KEY_2", 3),
    ("KEY_3", 4),
    ("KEY_4", 5),
    ("KEY_5", 6),
    ("KEY_6", 7),
    ("KEY_7", 8),
    ("KEY_8", 9),
    ("KEY_9", 10),
    ("KEY_0", 11),
    ("KEY_BACKSPACE", 14),
    ("KEY_TAB", 15),
    ("KEY_ENTER", 28),
    ("KEY_SPACE", 57),
    ("KEY_F1", 59),
    ("KEY_F2", 60),
    ("KEY_F3", 61),
    ("KEY_F4", 62),
    ("KEY_F5", 63),
    ("KEY_F6", 64),
    ("KEY_F7", 65),
    ("KEY_F8", 66),
    ("KEY_F9", 67),
    ("KEY_F10", 68),
    ("KEY_F11", 87),
    ("KEY_F12", 88),
    ("KEY_HOME", 102),
    ("KEY_UP", 103),
    ("KEY_PAGEUP", 104),
    ("KEY_LEFT", 105),
    ("KEY_RIGHT", 106),
    ("KEY_END", 107),
    ("KEY_DOWN", 108),
    ("KEY_PAGEDOWN", 109),
    ("KEY_MUTE", 113),
    ("KEY_VOLUMEDOWN", 114),
    ("KEY_VOLUMEUP", 115),
    ("KEY_PAUSE", 119),
    ("KEY_COMPOSE", 127),
    ("KEY_MENU", 139),
    ("KEY_SETUP", 141),
    ("KEY_SCREENLOCK", 152),
    ("KEY_BACK", 158),
    ("KEY_NEXTSONG", 163),
    ("KEY_PLAYPAUSE", 164),
    ("KEY_PREVIOUSSONG", 165),
    ("KEY_STOPCD", 166),
    ("KEY_REWIND", 168),
    ("KEY_HOMEPAGE", 172),
    ("KEY_PLAY", 207),
    ("KEY_FASTFORWARD", 208),
    ("KEY_SEARCH", 217),
    ("KEY_OK", 352),
    ("KEY_SELECT", 353),
    ("KEY_INFO", 358),
    ("KEY_SUBTITLE", 370),
    ("KEY_CHANNELUP", 402),
    ("KEY_CHANNELDOWN", 403),
    ("KEY_VOICECOMMAND", 582),
];

/// Keys systemd-logind acts on (power off, suspend, hibernate, reboot) for
/// any input device that has them: never on a virtual keyboard, where a
/// mis-mapped remote code would shut the machine down.
const REFUSED: [u16; 6] = [116, 142, 143, 205, 356, 0x198]; // POWER SLEEP WAKEUP SUSPEND POWER2 RESTART

/// Highest code a uinput keyboard may declare (KEY_MAX).
pub const KEY_MAX: u16 = 0x2ff;

pub fn parse(s: &str) -> Option<u16> {
    let s = s.trim();
    let code = match crate::config::parse_int(s) {
        Some(n) => u16::try_from(n).ok()?,
        None => {
            let name = s.to_ascii_uppercase();
            let name = if name.starts_with("KEY_") { name } else { format!("KEY_{name}") };
            KEYS.iter().find(|(n, _)| *n == name)?.1
        }
    };
    (code > 0 && code <= KEY_MAX && !REFUSED.contains(&code)).then_some(code)
}

/// The name for a code ("KEY_UP"), or the number if it isn't listed.
pub fn name(code: u16) -> String {
    KEYS.iter().find(|(_, c)| *c == code).map_or_else(|| code.to_string(), |(n, _)| n.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn names_and_numbers() {
        assert_eq!(parse("KEY_UP"), Some(103));
        assert_eq!(parse("homepage"), Some(172));
        assert_eq!(parse("158"), Some(158));
        assert_eq!(parse("0x9e"), Some(158));
        assert_eq!(parse("KEY_NOPE"), None);
        assert_eq!(parse("0"), None);
        assert_eq!(parse("4096"), None);
        assert_eq!(parse("116"), None); // KEY_POWER
        assert_eq!(parse("KEY_SLEEP"), None);
        assert_eq!(super::name(172), "KEY_HOMEPAGE");
        assert_eq!(super::name(700), "700");
    }
}
