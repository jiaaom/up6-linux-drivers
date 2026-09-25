//! Front power button: switches the built-in screen on and off, like a
//! phone's side button.
//!
//! t6_platform reports the button as `KEY_SCREENLOCK` on the "T6
//! front-panel buttons" input device (one tap per press, ~1 s after release;
//! see docs/power-button-ec-event.md). A thread reads that device and flips
//! the backlight through the standard `bl_power` switch, so it works under
//! whatever runs on the screen (the front-panel kiosk, a desktop, nothing).
//! A desktop sees the same key and locks its session.

use std::io::Read;
use std::os::unix::fs::FileTypeExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use t6_hw_rs::display::Display;

const DEVICE_NAME: &str = "T6 front-panel buttons";
const EV_KEY: u16 = 1;
const KEY_SCREENLOCK: u16 = 152;
/// struct input_event on 64-bit: timeval (16) + type (2) + code (2) + value (4).
const EVENT_SIZE: usize = 24;

/// `/dev/input/eventN` of the button device, if the driver registered it.
fn find_device() -> Option<PathBuf> {
    for e in std::fs::read_dir("/sys/class/input").ok()?.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if !n.starts_with("event") {
            continue;
        }
        let name = std::fs::read_to_string(e.path().join("device/name")).unwrap_or_default();
        if name.trim() == DEVICE_NAME {
            let dev = PathBuf::from("/dev/input").join(&n);
            if std::fs::metadata(&dev).is_ok_and(|m| m.file_type().is_char_device()) {
                return Some(dev);
            }
        }
    }
    None
}

/// Start the reader. `enabled` is the "power button switches the screen"
/// setting; a press while it is off is ignored. The device is looked up
/// again whenever it goes away (driver reload).
pub fn spawn(enabled: Arc<AtomicBool>, log: fn(&str)) {
    std::thread::spawn(move || loop {
        let Some(path) = find_device() else {
            std::thread::sleep(Duration::from_secs(10));
            continue;
        };
        let mut f = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                log(&format!("power button: {}: {e}", path.display()));
                std::thread::sleep(Duration::from_secs(10));
                continue;
            }
        };
        log(&format!("power button: listening on {}", path.display()));
        let mut buf = [0u8; EVENT_SIZE * 8];
        loop {
            let n = match f.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for ev in buf[..n].chunks_exact(EVENT_SIZE) {
                let typ = u16::from_ne_bytes([ev[16], ev[17]]);
                let code = u16::from_ne_bytes([ev[18], ev[19]]);
                let value = i32::from_ne_bytes([ev[20], ev[21], ev[22], ev[23]]);
                if typ != EV_KEY || code != KEY_SCREENLOCK || value != 1 {
                    continue;
                }
                if !enabled.load(Ordering::Relaxed) {
                    continue;
                }
                match Display::new().toggle() {
                    Ok(on) => log(&format!("power button: screen {}", if on { "on" } else { "off" })),
                    Err(e) => log(&format!("power button: {e}")),
                }
            }
        }
        log("power button: device gone, looking for it again");
        std::thread::sleep(Duration::from_secs(2));
    });
}
