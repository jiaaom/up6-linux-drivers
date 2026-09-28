//! A virtual keyboard through /dev/uinput, plus the "one key at a time"
//! state that remotes of this kind need.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;

const EV_SYN: u16 = 0x00;
const EV_KEY: u16 = 0x01;
const EV_REP: u16 = 0x14;
const BUS_VIRTUAL: u16 = 0x06;

// _IOW('U', n, size) / _IO('U', n)
const UI_DEV_CREATE: libc::c_ulong = 0x5501;
const UI_DEV_SETUP: libc::c_ulong = 0x405c_5503; // struct uinput_setup = 92 bytes
const UI_SET_EVBIT: libc::c_ulong = 0x4004_5564;
const UI_SET_KEYBIT: libc::c_ulong = 0x4004_5565;

#[repr(C)]
struct UinputSetup {
    bustype: u16,
    vendor: u16,
    product: u16,
    version: u16,
    name: [u8; 80],
    ff_effects_max: u32,
}

pub struct Keyboard {
    dev: File,
    held: Option<u16>,
}

impl Keyboard {
    /// Create the device; it lives until the daemon exits, so input
    /// consumers see one stable keyboard whether or not a remote is connected.
    pub fn create(name: &str, keys: impl IntoIterator<Item = u16>, repeat: bool) -> std::io::Result<Keyboard> {
        let dev = OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open("/dev/uinput")?;
        let fd = dev.as_raw_fd();
        let ioctl = |req, arg: libc::c_ulong| {
            // SAFETY: plain integer-argument uinput ioctls on our own fd.
            if unsafe { libc::ioctl(fd, req, arg) } < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        };
        ioctl(UI_SET_EVBIT, EV_KEY as _)?;
        if repeat {
            // No preset delay/period: the input core does software autorepeat.
            ioctl(UI_SET_EVBIT, EV_REP as _)?;
        }
        for k in keys {
            ioctl(UI_SET_KEYBIT, k as _)?;
        }
        let mut setup = UinputSetup { bustype: BUS_VIRTUAL, vendor: 0, product: 0, version: 1, name: [0; 80], ff_effects_max: 0 };
        let n = name.len().min(79);
        setup.name[..n].copy_from_slice(&name.as_bytes()[..n]);
        // SAFETY: UI_DEV_SETUP reads a struct uinput_setup, which UinputSetup mirrors.
        if unsafe { libc::ioctl(fd, UI_DEV_SETUP, &setup as *const UinputSetup) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        ioctl(UI_DEV_CREATE, 0)?;
        Ok(Keyboard { dev, held: None })
    }

    fn emit(&mut self, kind: u16, code: u16, value: i32) {
        // struct input_event: timeval (set by the kernel), type, code, value.
        let mut ev = [0u8; 24];
        ev[16..18].copy_from_slice(&kind.to_ne_bytes());
        ev[18..20].copy_from_slice(&code.to_ne_bytes());
        ev[20..24].copy_from_slice(&value.to_ne_bytes());
        if let Err(e) = self.dev.write_all(&ev) {
            eprintln!("uinput write: {e}");
        }
    }

    fn key(&mut self, code: u16, down: bool) {
        self.emit(EV_KEY, code, down as i32);
        self.emit(EV_SYN, 0, 0);
    }

    /// Press `code`, releasing whatever else is held; `None` releases all.
    /// The same key again is ignored (still held).
    pub fn hold(&mut self, code: Option<u16>) {
        if self.held == code {
            return;
        }
        if let Some(old) = self.held.take() {
            self.key(old, false);
        }
        if let Some(new) = code {
            self.key(new, true);
            self.held = Some(new);
        }
    }
}
