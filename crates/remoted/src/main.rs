//! remoted: Bluetooth LE remotes that send their keys as GATT notifications
//! (instead of as a HID keyboard) become an ordinary Linux keyboard.
//!
//! For every `[[remote]]` in the config there is one uinput keyboard, created
//! at start and kept for the daemon's lifetime. Whenever BlueZ has a matching
//! device connected with its services resolved, remoted subscribes to the key
//! characteristic (again after every reconnect or bluetoothd restart) and
//! turns each code into a key press. Pairing is left to BlueZ and its UIs.

mod bluez;
mod config;
mod keys;
mod status;
mod uinput;

use std::sync::{Arc, Mutex};

const DEFAULT_CONFIG: &str = "/etc/remoted.toml";

fn usage() -> ! {
    eprintln!(
        "usage: remoted [--config FILE] [-v]\n\
         \n  --config FILE  remotes and key maps (default {DEFAULT_CONFIG})\
         \n  -v, --verbose  log every notification (to learn a remote's codes)"
    );
    std::process::exit(2);
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut path = DEFAULT_CONFIG.to_string();
    let mut verbose = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--config" | "-c" => path = args.next().unwrap_or_else(|| usage()),
            "-v" | "--verbose" => verbose = true,
            _ => usage(),
        }
    }
    let remotes = std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|t| config::parse(&t))
        .unwrap_or_else(|e| {
            eprintln!("{path}: {e}");
            std::process::exit(1);
        });

    let conn = match zbus::Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("system bus: {e}");
            std::process::exit(1);
        }
    };
    let changes = bluez::watch_changes(conn.clone());
    status::init(&remotes);

    for (idx, remote) in remotes.into_iter().enumerate() {
        let name = format!("{} (remoted)", remote.label());
        let kb = match uinput::Keyboard::create(&name, remote.keys.values().copied(), remote.repeat) {
            Ok(k) => Arc::new(Mutex::new(k)),
            Err(e) => {
                eprintln!("/dev/uinput: {e} (is the uinput module loaded?)");
                std::process::exit(1);
            }
        };
        eprintln!("{}: keyboard \"{name}\", {} keys; waiting for the remote", remote.label(), remote.keys.len());
        tokio::spawn(bluez::serve(conn.clone(), idx, remote, kb, changes.clone(), verbose));
    }

    // Exiting closes the uinput devices; the kernel releases held keys.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
