//! t6-webd: HTTP backend of the T6 Control Center.
//!
//! Serves the web UI and a small JSON API over a Unix socket that the
//! FygoOS unified gateway forwards to (`/app/t6-control/...`). The gateway
//! authenticates the NAS user and adds `X-Trim-*` headers; every write
//! endpoint requires the administrator flag from those headers.
//!
//! Hardware is reached the same way a shell would: files under
//! `/run/t6-fand`, `/sys/class/leds`, `/sys/class/backlight`, ...

mod api;
mod fand;
mod gateway;
mod health;
mod ledd;
mod www;

use std::path::PathBuf;
use tokio::net::{TcpListener, UnixListener};

const DEFAULT_PREFIX: &str = "/app/t6-control";

struct Opts {
    prefix: String,
    socket: Option<PathBuf>,
    socket_group: Option<String>,
    listen: Option<String>,
    www_dir: Option<PathBuf>,
}

fn usage() -> ! {
    eprintln!(
        "usage: t6-webd (--socket PATH [--socket-group NAME] | --listen ADDR:PORT) \
         [--prefix /app/t6-control] [--www DIR]"
    );
    std::process::exit(2);
}

fn parse_args() -> Opts {
    let mut o = Opts { prefix: DEFAULT_PREFIX.into(), socket: None, socket_group: None, listen: None, www_dir: None };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut value = || args.next().unwrap_or_else(|| usage());
        match a.as_str() {
            "--socket" => o.socket = Some(PathBuf::from(value())),
            "--socket-group" => o.socket_group = Some(value()),
            "--listen" => o.listen = Some(value()),
            "--prefix" => o.prefix = value().trim_end_matches('/').to_string(),
            "--www" => o.www_dir = Some(PathBuf::from(value())),
            _ => usage(),
        }
    }
    if o.socket.is_none() == o.listen.is_none() {
        usage();
    }
    o
}

fn log(msg: &str) {
    println!("{msg}");
}

#[tokio::main]
async fn main() {
    let opts = parse_args();
    // Without the gateway (TCP development mode) nobody sets the identity
    // headers, so every request counts as an administrator.
    let state = api::AppState::new(opts.www_dir.clone(), opts.listen.is_some());
    let app = api::router(&opts.prefix).with_state(state);

    let shutdown = async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    };

    if let Some(path) = &opts.socket {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path).unwrap_or_else(|e| {
            eprintln!("cannot bind {}: {e}", path.display());
            std::process::exit(1);
        });
        if let Err(e) = gateway::restrict_socket(path, opts.socket_group.as_deref()) {
            eprintln!("cannot set permissions on {}: {e}", path.display());
            std::process::exit(1);
        }
        log(&format!("t6-webd listening on {} (prefix {})", path.display(), opts.prefix));
        let r = axum::serve(listener, app).with_graceful_shutdown(shutdown).await;
        let _ = std::fs::remove_file(path);
        r.expect("server");
    } else {
        let addr = opts.listen.as_deref().unwrap();
        let listener = TcpListener::bind(addr).await.unwrap_or_else(|e| {
            eprintln!("cannot bind {addr}: {e}");
            std::process::exit(1);
        });
        log(&format!("t6-webd listening on http://{addr}{}/ (development mode: every request is admin)", opts.prefix));
        axum::serve(listener, app).with_graceful_shutdown(shutdown).await.expect("server");
    }
    log("t6-webd stopped");
}
