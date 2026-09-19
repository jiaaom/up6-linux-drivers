//! t6-paneld: backend for the T6 front-panel touch app.
//!
//! Two listeners, one router:
//!   - `--listen ADDR:PORT` — the local, no-login shell served to the Chromium
//!     kiosk (and, in development, to a phone over Tailscale). No gateway means
//!     no identity headers, so every request there is "logged out".
//!   - `--gateway-socket PATH` — the FygoOS unified gateway forwards requests
//!     for `/app/t6panel` here after validating the user's session, adding the
//!     `X-Trim-*` identity headers. This is the authenticated surface (account,
//!     personal files, admin config).
//!
//! Handlers read identity from the request headers, so the same routes serve
//! both surfaces; only the gateway one ever carries a signed-in user.

mod api;
mod firmware;
mod fnos;
mod gateway;
mod panel;
mod settings;
mod www;

use std::path::PathBuf;
use tokio::net::{TcpListener, UnixListener};

const DEFAULT_PREFIX: &str = "/app/t6panel";

struct Opts {
    listen: Option<String>,
    gateway_socket: Option<PathBuf>,
    socket_group: Option<String>,
    www_dir: Option<PathBuf>,
    prefix: String,
}

fn usage() -> ! {
    eprintln!(
        "usage: t6-paneld (--listen ADDR:PORT | --gateway-socket PATH [--socket-group NAME])... \
         [--prefix /app/t6panel] [--www DIR]"
    );
    std::process::exit(2);
}

fn parse_args() -> Opts {
    let mut o = Opts {
        listen: None,
        gateway_socket: None,
        socket_group: None,
        www_dir: None,
        prefix: DEFAULT_PREFIX.into(),
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut value = || args.next().unwrap_or_else(|| usage());
        match a.as_str() {
            "--listen" => o.listen = Some(value()),
            "--gateway-socket" => o.gateway_socket = Some(PathBuf::from(value())),
            "--socket-group" => o.socket_group = Some(value()),
            "--prefix" => o.prefix = value().trim_end_matches('/').to_string(),
            "--www" => o.www_dir = Some(PathBuf::from(value())),
            _ => usage(),
        }
    }
    if o.listen.is_none() && o.gateway_socket.is_none() {
        usage();
    }
    o
}

#[tokio::main]
async fn main() {
    // Dev-only: validate the native fnOS client against the live box.
    if std::env::args().any(|a| a == "--fnos-selftest") {
        let user = std::env::var("FNOS_USER").unwrap_or_default();
        let pass = std::env::var("FNOS_PASS").unwrap_or_default();
        match fnos::FnosClient::login(&user, &pass).await {
            Ok(c) => {
                println!("LOGIN OK uid={} admin={} ticket=<{}ch> machineId={}", c.session.uid, c.session.admin, c.session.ticket.len(), c.session.machine_id);
                match c.request("appcgi.network.net.list", serde_json::json!({})).await {
                    Ok(v) => {
                        let ifs = v.get("data").and_then(|d| d.get("net")).and_then(|n| n.get("ifs")).and_then(|x| x.as_array()).cloned().unwrap_or_default();
                        println!("net.list OK: {} interfaces", ifs.len());
                        for i in &ifs {
                            println!("  {} ipv4={:?} ssid={:?}", i.get("name").and_then(|x| x.as_str()).unwrap_or("?"), i.get("ipv4Addr").and_then(|x| x.as_str()), i.get("ssid").and_then(|x| x.as_str()));
                        }
                    }
                    Err(e) => println!("net.list ERR: {e}"),
                }
            }
            Err(e) => println!("LOGIN ERR: {e}"),
        }
        return;
    }
    // Dev-only: `--fnos-call <method> [json-params]` prints the raw reply.
    if let Some(i) = std::env::args().position(|a| a == "--fnos-call") {
        let args: Vec<String> = std::env::args().collect();
        let method = args.get(i + 1).cloned().unwrap_or_default();
        let params: serde_json::Value = args.get(i + 2).map(|s| serde_json::from_str(s).expect("bad json")).unwrap_or(serde_json::json!({}));
        let user = std::env::var("FNOS_USER").unwrap_or_default();
        let pass = std::env::var("FNOS_PASS").unwrap_or_default();
        match fnos::FnosClient::login(&user, &pass).await {
            Ok(c) => match c.request(&method, params).await {
                Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
                Err(e) => println!("ERR: {e}"),
            },
            Err(e) => println!("LOGIN ERR: {e}"),
        }
        return;
    }

    let opts = parse_args();
    // Port of the local shell, reported to the gateway surface so "sign out"
    // knows where to return.
    let shell_port = opts.listen.as_deref().and_then(|a| a.rsplit(':').next()).and_then(|p| p.parse::<u16>().ok());

    // Local TCP surface (no-login shell): bare routes, so the kiosk loads it at
    // localhost and its relative fetches hit `/api/...`.
    if let Some(addr) = &opts.listen {
        let app = api::router(www::Www::new(opts.www_dir.clone()), "", None);
        let listener = TcpListener::bind(addr).await.unwrap_or_else(|e| {
            eprintln!("cannot bind {addr}: {e}");
            std::process::exit(1);
        });
        println!("t6-paneld listening on http://{addr}/ (local, no-login)");
        tokio::spawn(async move { axum::serve(listener, app).await });
    }

    // Gateway unix socket (authenticated surface): routes under the gatewayPrefix.
    if let Some(path) = &opts.gateway_socket {
        let app = api::router(www::Www::new(opts.www_dir.clone()), &opts.prefix, shell_port);
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path).unwrap_or_else(|e| {
            eprintln!("cannot bind {}: {e}", path.display());
            std::process::exit(1);
        });
        if let Err(e) = gateway::restrict_socket(path, opts.socket_group.as_deref()) {
            eprintln!("cannot set permissions on {}: {e}", path.display());
            std::process::exit(1);
        }
        println!("t6-paneld listening on {} (gateway, prefix {})", path.display(), opts.prefix);
        tokio::spawn(async move { axum::serve(listener, app).await });
    }

    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    if let Some(path) = &opts.gateway_socket {
        let _ = std::fs::remove_file(path);
    }
    println!("t6-paneld stopped");
}
