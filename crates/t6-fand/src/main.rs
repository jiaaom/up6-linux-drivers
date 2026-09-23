//! t6-fand: fan policy daemon for UnifyDrive UP6/T6.
//!
//! Drives the `t6_platform` hwmon PWM channels from temperature curves.
//! Everything goes through standard hwmon sysfs, so it also works with any
//! other board whose fans and sensors are exposed the same way.

mod config;
mod curve;
mod hwmon;

use config::{Config, Zone};
use curve::{Controller, Event, Params};
use hwmon::{Fan, Sensor};
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::flag;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEFAULT_CONFIG: &str = "/etc/t6-fand.toml";
const RUN_DIR: &str = "/run/t6-fand";

struct ZoneState {
    name: String,
    cfg: Zone,
    fan: Fan,
    sensors: Vec<Sensor>,
    ctl: Controller,
    last_temp: Option<f64>,
    last_pwm: u8,
}

struct Daemon {
    cfg: Config,
    zones: Vec<ZoneState>,
    run_dir: PathBuf,
}

fn log(msg: &str) {
    println!("{msg}");
}

impl Daemon {
    fn new(cfg: Config, run_dir: PathBuf) -> Result<Self, String> {
        let mut zones = Vec::new();
        for (name, z) in &cfg.zones {
            let fan = Fan::find(&cfg.fan_hwmon, &z.fan)?;
            let mut sensors = Vec::new();
            for spec in &z.sensors {
                match Sensor::resolve(spec)? {
                    Some(s) => sensors.push(s),
                    None => log(&format!("zone {name}: {spec} is empty, skipped")),
                }
            }
            if sensors.is_empty() {
                log(&format!(
                    "zone {name}: no readable sensor, will hold failsafe {}%",
                    cfg.failsafe_pwm
                ));
            }
            let mut ctl = Controller::default();
            ctl.force(cfg.failsafe_pwm);
            log(&format!(
                "zone {name}: fan {:?} <- [{}]",
                fan.label,
                sensors.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")
            ));
            zones.push(ZoneState {
                name: name.clone(),
                cfg: z.clone(),
                fan,
                sensors,
                ctl,
                last_temp: None,
                last_pwm: cfg.failsafe_pwm,
            });
        }
        Ok(Daemon { cfg, zones, run_dir })
    }

    /// Profile from `/run/t6-fand/profile` if it names a curve every zone has, else the configured one.
    fn active_profile(&self) -> String {
        if let Ok(p) = std::fs::read_to_string(self.run_dir.join("profile")) {
            let p = p.trim();
            if !p.is_empty() && self.zones.iter().all(|z| z.cfg.curves.contains_key(p)) {
                return p.to_string();
            }
        }
        self.cfg.profile.clone()
    }

    fn step(&mut self, dt: f64) -> Result<(), String> {
        let profile = self.active_profile();
        let failsafe = self.cfg.failsafe_pwm;
        for z in &mut self.zones {
            let temp = z.sensors.iter().filter_map(Sensor::celsius).fold(None, |m: Option<f64>, t| {
                Some(m.map_or(t, |m| m.max(t)))
            });
            let pwm = match temp {
                Some(t) => {
                    let curve = &z.cfg.curves[&profile];
                    let p = Params {
                        tau: z.cfg.tau_secs,
                        emergency_temp: z.cfg.emergency_temp,
                        emergency_secs: z.cfg.emergency_secs,
                        emergency_ramp: z.cfg.emergency_ramp,
                        hysteresis: z.cfg.hysteresis,
                        ramp_up: z.cfg.ramp_up,
                        ramp_down: z.cfg.ramp_down,
                        min_pwm: f64::from(z.cfg.min_pwm),
                        start_pwm: f64::from(z.cfg.start_pwm),
                        kick_secs: z.cfg.kick_secs,
                    };
                    let (pwm, event) = z.ctl.step(curve, &p, t, z.fan.rpm(), dt);
                    match event {
                        Event::Started => log(&format!("zone {}: fan started ({t:.0} °C)", z.name)),
                        Event::Stopped => log(&format!("zone {}: fan stopped ({t:.0} °C)", z.name)),
                        Event::StallRecovery => log(&format!("zone {}: no tach signal at {}% - re-kicking", z.name, z.last_pwm)),
                        Event::None => {}
                    }
                    pwm
                }
                None => z.ctl.force(failsafe),
            };
            z.last_temp = temp;
            if pwm != z.last_pwm {
                z.fan.take_control()?;
                z.fan.set_percent(pwm)?;
                z.last_pwm = pwm;
            }
        }
        self.write_status(&profile);
        Ok(())
    }

    fn write_status(&self, profile: &str) {
        let zones: Vec<serde_json::Value> = self
            .zones
            .iter()
            .map(|z| {
                serde_json::json!({
                    "zone": z.name,
                    "fan": z.fan.label,
                    "temp_c": z.last_temp,
                    "temp_filtered_c": z.ctl.filtered,
                    "pwm_percent": z.last_pwm,
                    "rpm": z.fan.rpm(),
                    "sensors": z.sensors.iter().map(|s| serde_json::json!({"name": s.name, "temp_c": s.celsius()})).collect::<Vec<_>>(),
                })
            })
            .collect();
        let status = serde_json::json!({ "profile": profile, "zones": zones });
        let tmp = self.run_dir.join("status.json.tmp");
        if std::fs::write(&tmp, status.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, self.run_dir.join("status.json"));
        }
    }

    /// Park every fan at the fail-safe duty (used on exit and before reload).
    fn park(&mut self) {
        let failsafe = self.cfg.failsafe_pwm;
        for z in &mut self.zones {
            let pwm = z.ctl.force(failsafe);
            if let Err(e) = z.fan.take_control().and_then(|_| z.fan.set_percent(pwm)) {
                log(&format!("zone {}: park failed: {e}", z.name));
            }
            z.last_pwm = pwm;
        }
    }
}

fn usage() -> ! {
    eprintln!("usage: t6-fand [--config PATH] [--check]");
    std::process::exit(2);
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

    let cfg = match Config::load(&config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(1);
        }
    };
    if check_only {
        match Daemon::new(cfg, std::env::temp_dir()) {
            Ok(_) => {
                println!("config OK");
                return;
            }
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
    }

    let run_dir = PathBuf::from(RUN_DIR);
    if let Err(e) = std::fs::create_dir_all(&run_dir) {
        eprintln!("cannot create {}: {e}", run_dir.display());
        std::process::exit(1);
    }

    let term = Arc::new(AtomicBool::new(false));
    let hup = Arc::new(AtomicBool::new(false));
    for sig in [SIGTERM, SIGINT] {
        flag::register(sig, Arc::clone(&term)).expect("signal handler");
    }
    flag::register(SIGHUP, Arc::clone(&hup)).expect("signal handler");

    let mut daemon = match Daemon::new(cfg, run_dir.clone()) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };
    daemon.park();
    log(&format!("t6-fand started, profile {:?}", daemon.active_profile()));

    let mut last = Instant::now();
    while !term.load(Ordering::Relaxed) {
        if hup.swap(false, Ordering::Relaxed) {
            match Config::load(&config_path).and_then(|c| Daemon::new(c, run_dir.clone())) {
                Ok(mut d) => {
                    d.park();
                    daemon = d;
                    log("configuration reloaded");
                }
                Err(e) => log(&format!("reload failed, keeping current config: {e}")),
            }
        }
        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f64().max(0.1);
        last = now;
        if let Err(e) = daemon.step(dt) {
            log(&format!("control step failed: {e}"));
        }
        std::thread::sleep(Duration::from_secs(daemon.cfg.interval_secs));
    }

    daemon.park();
    log("t6-fand stopped, fans parked at failsafe duty");
    let _ = std::fs::remove_file(Path::new(RUN_DIR).join("status.json"));
}
