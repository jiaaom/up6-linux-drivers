//! t6-ledd: indicator daemon for the ZSpace T6 NAS.
//!
//! Single owner of the `t6:*` LEDs and the beeper. Every LED is either in
//! `auto` mode (a rule evaluated every cycle) or `manual` (a fixed colour);
//! a bay master switch and a night mode (manual or scheduled) override
//! them. Settings live in `/etc/t6-ledd.toml`, changed only through the
//! control socket so the file has one writer.

mod beeper;
mod config;
mod control;
mod devices;
mod events;
mod leds;
mod schedule;

use beeper::{Beeper, Pattern};
use config::{Config, DeviceSetting, Mode};
use std::collections::BTreeSet;
use std::time::Instant;
use events::EventWatcher;
use devices::{sources, Auto, Device, CATALOG};
use leds::{Effect, LedBank};
use schedule::Window;
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::flag;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_CONFIG: &str = "/etc/t6-ledd.toml";
const RUN_DIR: &str = "/run/t6-ledd";
const RENDER_TICK: Duration = Duration::from_millis(100);
const POLICY_EVERY: Duration = Duration::from_secs(2);

fn log(msg: &str) {
    println!("{msg}");
}

struct Daemon {
    cfg: Config,
    config_path: PathBuf,
    run_dir: PathBuf,
    bank: LedBank,
    /// Per-device effect chosen by the policy pass; the render loop draws it.
    plan: Vec<(&'static Device, Effect)>,
    /// Bays with a faulted drive (status + fault-blink policy).
    faults: BTreeSet<u8>,
    /// Daemon start, for animation phase.
    start: Instant,
    /// Why the configuration file could not be used (defaults are active).
    config_error: Option<String>,
    beeper: Beeper,
    events: EventWatcher,
}

impl Daemon {
    fn new(cfg: Config, config_path: PathBuf, run_dir: PathBuf, config_error: Option<String>) -> Self {
        Daemon {
            cfg,
            config_path,
            run_dir,
            bank: LedBank::new(),
            plan: Vec::new(),
            faults: BTreeSet::new(),
            start: Instant::now(),
            config_error,
            beeper: Beeper::new(),
            events: EventWatcher::default(),
        }
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

    /// Policy pass: choose an effect for every device. Reads sensors and the
    /// config; runs every couple of seconds, not every frame.
    fn evaluate(&mut self) {
        // Push the tray speed to the driver; colour writes then pick it up.
        if let Err(e) = leds::set_tray_speed(&self.cfg.tray_speed) {
            log(&format!("tray speed: {e}"));
        }
        let (night, _) = self.night_active();
        self.faults = if self.cfg.bay_fault_blink { sources::drive_faults() } else { BTreeSet::new() };

        let mut plan = Vec::with_capacity(CATALOG.len());
        for dev in CATALOG {
            if dev.auto == Some(Auto::ChargeControl) {
                continue; // the driver's charge control owns the battery LED
            }
            let effect = if let Some(bay) = dev.bay_number() {
                // Bays are automatic: red blink on fault (wins over everything),
                // otherwise white while a drive is present, else off.
                if self.faults.contains(&bay) {
                    Effect::Blink { color: "red".into(), period_ms: 500 }
                } else if night || !self.cfg.bays_enabled || !sources::bay_present(bay) {
                    Effect::off()
                } else {
                    Effect::Solid("white".into())
                }
            } else if night {
                Effect::off()
            } else {
                let s = self.cfg.setting(dev.id);
                let color = match s.mode {
                    Mode::Manual => s.color.unwrap_or_else(|| "off".into()),
                    Mode::Auto => dev.auto_color().unwrap_or("off").to_string(),
                };
                Effect::Solid(color)
            };
            plan.push((dev, effect));
        }
        self.plan = plan;
    }

    /// Draw one frame. The LED bank skips unchanged writes, so steady LEDs
    /// cost nothing here and only a blink actually toggles the hardware.
    fn render(&mut self) {
        let now = self.start.elapsed();
        let plan = self.plan.clone();
        for (dev, effect) in &plan {
            let color = effect.frame_color(now);
            if let Err(e) = self.bank.set(dev, color) {
                log(&format!("{}: {e}", dev.id));
            }
        }
    }

    /// Recompute policy, draw, and republish status — used after a change.
    fn refresh_now(&mut self) {
        self.evaluate();
        self.render();
        self.write_status();
    }

    fn write_status(&self) {
        let (night, reason) = self.night_active();
        let devices: Vec<serde_json::Value> = CATALOG
            .iter()
            .map(|d| {
                let s = self.cfg.setting(d.id);
                let effective = self
                    .plan
                    .iter()
                    .find(|(dev, _)| dev.id == d.id)
                    .map(|(_, e)| e.describe())
                    .unwrap_or_else(|| "auto".into());
                serde_json::json!({
                    "id": d.id,
                    "label": d.label,
                    "mode": s.mode,
                    "color": s.color,
                    "effective": effective,
                    "colors": d.colors.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
                    "auto": d.auto.is_some(),
                    "auto_desc": d.auto_desc,
                    "bay": d.is_bay(),
                    "bay_number": d.bay_number(),
                    "available": d.leds.iter().all(|l| self.bank.available(l)),
                })
            })
            .collect();
        let status = serde_json::json!({
            "night": { "active": night, "reason": reason, "manual": self.cfg.night.manual, "schedule": self.cfg.night.schedule },
            "bays_enabled": self.cfg.bays_enabled,
            "bay_fault_blink": self.cfg.bay_fault_blink,
            "faults": self.faults.iter().copied().collect::<Vec<u8>>(),
            "bays_present": (1u8..=6).filter(|n| sources::bay_present(*n)).collect::<Vec<u8>>(),
            "tray_speed": self.cfg.tray_speed,
            "beep": {
                "startup": self.cfg.beep.startup,
                "ac_loss": self.cfg.beep.ac_loss,
                "drive_fault": self.cfg.beep.drive_fault,
            },
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
                self.refresh_now();
                Ok("ok".into())
            }
            ["bays", on @ ("on" | "off")] => {
                self.cfg.bays_enabled = *on == "on";
                self.save()?;
                self.refresh_now();
                Ok("ok".into())
            }
            ["bay-fault-blink", on @ ("on" | "off")] => {
                self.cfg.bay_fault_blink = *on == "on";
                self.save()?;
                self.refresh_now();
                Ok("ok".into())
            }
            ["beep-on", event, on @ ("on" | "off")] => {
                if !self.cfg.beep.set(event, *on == "on") {
                    return Err(format!("unknown beep event {event:?} (startup/ac_loss/drive_fault)"));
                }
                self.save()?;
                self.write_status();
                Ok("ok".into())
            }
            ["tray-speed", speed] => {
                if !config::TRAY_SPEEDS.contains(speed) {
                    return Err(format!("tray-speed must be one of {:?}", config::TRAY_SPEEDS));
                }
                self.cfg.tray_speed = speed.to_string();
                self.save()?;
                self.refresh_now();
                Ok("ok".into())
            }
            ["night", on @ ("on" | "off")] => {
                self.cfg.night.manual = *on == "on";
                self.save()?;
                self.refresh_now();
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
                self.refresh_now();
                Ok("ok".into())
            }
            ["beep", pattern] => {
                self.beeper.play(Pattern::parse(pattern)?)?;
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
                self.refresh_now();
                log("configuration reloaded");
            }
            Err(e) => {
                log(&format!("reload failed, keeping current config: {e}"));
                self.config_error = Some(e);
                self.write_status();
            }
        }
    }

    /// Sample the event watcher and sound any triggered beeps.
    fn check_events(&mut self) {
        for ev in self.events.poll(&self.cfg.beep) {
            log(&format!("event beep: {}", ev.reason));
            if let Err(e) = self.beeper.play(ev.pattern) {
                log(&format!("event beep failed: {e}"));
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
        let _ = self.beeper.silence();
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
    daemon.evaluate();
    daemon.render();
    daemon.write_status();
    log("t6-ledd started");
    let mut last_policy = Instant::now();

    // Short beep once per boot, like the stock firmware. The marker lives in
    // the runtime dir (tmpfs, cleared on reboot but kept across service
    // restarts via RuntimeDirectoryPreserve), so upgrades and reloads are
    // silent.
    let boot_marker = run_dir.join("booted");
    let first_this_boot = !boot_marker.exists();
    let _ = std::fs::write(&boot_marker, b"1\n");
    if first_this_boot && daemon.cfg.beep.startup {
        if let Err(e) = daemon.beeper.short() {
            log(&format!("startup beep: {e}"));
        }
    }

    while !term.load(Ordering::Relaxed) {
        if hup.swap(false, Ordering::Relaxed) {
            daemon.reload();
        }
        match requests.recv_timeout(RENDER_TICK) {
            Ok(req) => {
                let reply = match daemon.command(&req.line) {
                    Ok(r) => r,
                    Err(e) => format!("error: {e}"),
                };
                let _ = req.reply.send(reply);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                daemon.render();
                if last_policy.elapsed() >= POLICY_EVERY {
                    daemon.evaluate();
                    daemon.check_events();
                    daemon.write_status();
                    last_policy = Instant::now();
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    daemon.park();
    let _ = std::fs::remove_file(run_dir.join("status.json"));
    let _ = std::fs::remove_file(run_dir.join("ctl"));
    log("t6-ledd stopped, LEDs left in automatic state");
}
