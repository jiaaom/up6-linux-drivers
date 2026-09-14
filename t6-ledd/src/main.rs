//! t6-ledd: indicator daemon for the ZSpace T6 NAS.
//!
//! Single owner of the `t6:*` LEDs and the beeper. Every LED is either in
//! `auto` mode (a rule evaluated every cycle) or `manual` (a fixed colour);
//! a bay master switch and a night mode (manual or scheduled) override
//! them. Settings live in `/etc/t6-ledd.toml`, changed only through the
//! control socket so the file has one writer.

mod config;
mod control;
mod devices;
mod schedule;

use config::{Config, DeviceSetting, Mode};
use devices::{Auto, Device, LedBank, CATALOG};
use schedule::Window;
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::flag;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_CONFIG: &str = "/etc/t6-ledd.toml";
const RUN_DIR: &str = "/run/t6-ledd";
const BEEP_ATTR: &str = "/sys/devices/platform/t6-platform/beep";
const TICK: Duration = Duration::from_secs(2);

fn log(msg: &str) {
    println!("{msg}");
}

struct Daemon {
    cfg: Config,
    config_path: PathBuf,
    run_dir: PathBuf,
    bank: LedBank,
    /// Effective colour applied per device id (for status).
    effective: Vec<(&'static str, String)>,
    /// Why the configuration file could not be used (defaults are active).
    config_error: Option<String>,
}

impl Daemon {
    fn new(cfg: Config, config_path: PathBuf, run_dir: PathBuf, config_error: Option<String>) -> Self {
        Daemon { cfg, config_path, run_dir, bank: LedBank::new(), effective: Vec::new(), config_error }
    }

    fn night_active(&self) -> (bool, &'static str) {
        if self.cfg.night.manual {
            return (true, "manual");
        }
        if let Some(w) = self.cfg.night.schedule.as_deref().and_then(|s| Window::parse(s).ok()) {
            if w.active_now() {
                return (true, "schedule");
            }
        }
        (false, "")
    }

    /// Colour a device should show now, or `None` to leave it alone.
    fn desired(&self, dev: &Device, night: bool) -> Option<String> {
        if dev.auto == Some(Auto::ChargeControl) {
            return None; // the driver's charge control owns it
        }
        if night || (dev.is_bay() && !self.cfg.bays_enabled) {
            return Some("off".into());
        }
        let s = self.cfg.setting(dev.id);
        match s.mode {
            Mode::Manual => s.color,
            Mode::Auto => dev.auto_color().map(str::to_string),
        }
    }

    fn apply(&mut self) {
        // Push the tray speed to the driver first; colour writes below then
        // pick it up. Non-fatal if the attribute is missing.
        if let Err(e) = devices::set_tray_speed(&self.cfg.tray_speed) {
            log(&format!("tray speed: {e}"));
        }
        let (night, _) = self.night_active();
        let mut effective = Vec::with_capacity(CATALOG.len());
        for dev in CATALOG {
            match self.desired(dev, night) {
                Some(color) => {
                    if let Err(e) = self.bank.set(dev, &color) {
                        log(&format!("{}: {e}", dev.id));
                    }
                    effective.push((dev.id, color));
                }
                None => effective.push((dev.id, "auto".into())),
            }
        }
        self.effective = effective;
        self.write_status();
    }

    fn write_status(&self) {
        let (night, reason) = self.night_active();
        let devices: Vec<serde_json::Value> = CATALOG
            .iter()
            .map(|d| {
                let s = self.cfg.setting(d.id);
                let eff = self.effective.iter().find(|(id, _)| *id == d.id).map(|(_, c)| c.as_str());
                serde_json::json!({
                    "id": d.id,
                    "label": d.label,
                    "mode": s.mode,
                    "color": s.color,
                    "effective": eff,
                    "colors": d.colors.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
                    "auto": d.auto.is_some(),
                    "auto_desc": d.auto_desc,
                    "bay": d.is_bay(),
                    "available": d.leds.iter().all(|l| self.bank.available(l)),
                })
            })
            .collect();
        let status = serde_json::json!({
            "night": { "active": night, "reason": reason, "manual": self.cfg.night.manual, "schedule": self.cfg.night.schedule },
            "bays_enabled": self.cfg.bays_enabled,
            "tray_speed": self.cfg.tray_speed,
            "config_error": self.config_error,
            "devices": devices,
        });
        let tmp = self.run_dir.join("status.json.tmp");
        if std::fs::write(&tmp, status.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, self.run_dir.join("status.json"));
        }
    }

    fn save(&mut self) -> Result<(), String> {
        self.cfg.validate()?;
        self.cfg.save(&self.config_path)?;
        self.config_error = None;
        Ok(())
    }

    /// Execute one control command; returns the reply text.
    fn command(&mut self, line: &str) -> Result<String, String> {
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            ["set", id, value] => {
                let dev = devices::by_id(id).ok_or_else(|| format!("unknown device {id:?}"))?;
                let setting = if *value == "auto" {
                    DeviceSetting { mode: Mode::Auto, color: None }
                } else {
                    DeviceSetting { mode: Mode::Manual, color: Some(value.to_string()) }
                };
                setting.validate_for(dev)?;
                self.cfg.devices.insert(id.to_string(), setting);
                self.save()?;
                self.apply();
                Ok("ok".into())
            }
            ["bays", on @ ("on" | "off")] => {
                self.cfg.bays_enabled = *on == "on";
                self.save()?;
                self.apply();
                Ok("ok".into())
            }
            ["tray-speed", speed] => {
                if !config::TRAY_SPEEDS.contains(speed) {
                    return Err(format!("tray-speed must be one of {:?}", config::TRAY_SPEEDS));
                }
                self.cfg.tray_speed = speed.to_string();
                self.save()?;
                self.apply();
                Ok("ok".into())
            }
            ["night", on @ ("on" | "off")] => {
                self.cfg.night.manual = *on == "on";
                self.save()?;
                self.apply();
                Ok("ok".into())
            }
            ["schedule", spec] => {
                self.cfg.night.schedule = if *spec == "off" {
                    None
                } else {
                    Window::parse(spec)?;
                    Some(spec.to_string())
                };
                self.save()?;
                self.apply();
                Ok("ok".into())
            }
            ["beep", pattern] => {
                let p: u8 = pattern.parse().map_err(|_| "beep pattern must be 0..=255".to_string())?;
                std::fs::write(BEEP_ATTR, format!("{p}\n")).map_err(|e| format!("beeper: {e}"))?;
                Ok("ok".into())
            }
            ["reload"] => {
                self.reload();
                Ok("ok".into())
            }
            ["status"] => std::fs::read_to_string(self.run_dir.join("status.json")).map_err(|e| e.to_string()),
            _ => Err(format!("unknown command {line:?}")),
        }
    }

    fn reload(&mut self) {
        match Config::load(&self.config_path) {
            Ok(c) => {
                self.cfg = c;
                self.config_error = None;
                self.bank.invalidate();
                self.apply();
                log("configuration reloaded");
            }
            Err(e) => {
                log(&format!("reload failed, keeping current config: {e}"));
                self.config_error = Some(e);
                self.write_status();
            }
        }
    }

    /// Leave the LEDs in their automatic state and silence the beeper.
    fn park(&mut self) {
        for dev in CATALOG {
            if let Some(c) = dev.auto_color() {
                let _ = self.bank.set(dev, c);
            }
        }
        let _ = std::fs::write(BEEP_ATTR, "0\n");
    }
}

fn usage() -> ! {
    eprintln!("usage: t6-ledd [--config PATH] [--check]");
    std::process::exit(2);
}

/// The configuration, or the defaults with the reason they are in use.
/// A broken file must not leave the LEDs unmanaged at boot.
fn load_or_default(path: &Path) -> (Config, Option<String>) {
    if !path.exists() {
        let cfg = Config::default();
        match cfg.save(path) {
            Ok(()) => log(&format!("wrote default configuration to {}", path.display())),
            Err(e) => log(&e),
        }
        return (cfg, None);
    }
    match Config::load(path) {
        Ok(c) => (c, None),
        Err(e) => {
            log(&format!("{e}; using defaults until the file is fixed"));
            (Config::default(), Some(e))
        }
    }
}

fn main() {
    let mut config_path = PathBuf::from(DEFAULT_CONFIG);
    let mut check_only = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--config" | "-c" => config_path = PathBuf::from(args.next().unwrap_or_else(|| usage())),
            "--check" => check_only = true,
            _ => usage(),
        }
    }

    if check_only {
        match Config::load(&config_path) {
            Ok(_) => {
                println!("config OK");
                return;
            }
            Err(e) => {
                eprintln!("config error: {e}");
                std::process::exit(1);
            }
        }
    }

    let (cfg, config_error) = load_or_default(&config_path);

    let run_dir = PathBuf::from(RUN_DIR);
    if let Err(e) = std::fs::create_dir_all(&run_dir) {
        eprintln!("cannot create {}: {e}", run_dir.display());
        std::process::exit(1);
    }
    let requests = match control::serve(&run_dir.join("ctl")) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("cannot open control socket: {e}");
            std::process::exit(1);
        }
    };

    let term = Arc::new(AtomicBool::new(false));
    let hup = Arc::new(AtomicBool::new(false));
    for sig in [SIGTERM, SIGINT] {
        flag::register(sig, Arc::clone(&term)).expect("signal handler");
    }
    flag::register(SIGHUP, Arc::clone(&hup)).expect("signal handler");

    let mut daemon = Daemon::new(cfg, config_path, run_dir.clone(), config_error);
    daemon.apply();
    log("t6-ledd started");

    while !term.load(Ordering::Relaxed) {
        if hup.swap(false, Ordering::Relaxed) {
            daemon.reload();
        }
        match requests.recv_timeout(TICK) {
            Ok(req) => {
                let reply = match daemon.command(&req.line) {
                    Ok(r) => r,
                    Err(e) => format!("error: {e}"),
                };
                let _ = req.reply.send(reply);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => daemon.apply(),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    daemon.park();
    let _ = std::fs::remove_file(run_dir.join("status.json"));
    let _ = std::fs::remove_file(run_dir.join("ctl"));
    log("t6-ledd stopped, LEDs left in automatic state");
}
