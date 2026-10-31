//! The captive-portal view's way out: a small HTTP proxy on 127.0.0.1 that
//! the panel's sign-in view (a separate Electron session, panel/app/main.js)
//! uses for everything it loads.
//!
//! A sign-in page (a hotel's or café's "Connect" page) only works when it is
//! asked for over the Wi-Fi that needs signing in. The system's routes don't
//! promise that: with Ethernet also up, NetworkManager moves the default route
//! off a Wi-Fi held behind a portal, and names are resolved through whatever
//! the system uses (here Tailscale's resolver), which may not answer before
//! the sign-in. So every connection this proxy opens is bound to the Wi-Fi
//! interface (SO_BINDTODEVICE, root only), and names are looked up with the
//! Wi-Fi network's own DNS servers, over Wi-Fi too. IPv4 only.
//!
//! It runs only while the view is open (`start` / `stop`), stops by itself
//! after `IDLE` without a request, and refuses this machine's own addresses,
//! so a web page can't reach the NAS's services through it. autoaccept.rs
//! runs a private one (`spawn`) for the few requests of an automatic
//! acceptance, and asks Apple's probe page over Wi-Fi with `probe`.
//!
//! Plain HTTP requests are forwarded one per connection (both sides are told
//! `Connection: close`); HTTPS goes through CONNECT tunnels.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, TcpStream, UdpSocket};
use tokio::task::JoinHandle;

/// Stop when nothing has gone through for this long (the view was left open,
/// or the kiosk went away without closing it).
const IDLE: Duration = Duration::from_secs(600);
/// Longest life of one proxied connection.
const CONN_MAX: Duration = Duration::from_secs(600);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DNS_TIMEOUT: Duration = Duration::from_secs(2);
/// Largest request or response head read before giving up.
const HEAD_MAX: usize = 64 * 1024;

/// A running proxy; dropping it stops it and every connection through it.
pub struct Proxy {
    pub port: u16,
    iface: String,
    task: JoinHandle<()>,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The sign-in view's proxy (`start` / `stop`).
static RUNNING: Mutex<Option<Proxy>> = Mutex::new(None);

struct Ctx {
    iface: String,
    dns: Vec<Ipv4Addr>,
    local: Vec<Ipv4Addr>,
    names: Mutex<HashMap<String, Vec<Ipv4Addr>>>,
    last: Mutex<Instant>,
}

async fn uplink() -> Result<t6_hw_rs::network::WifiUplink, String> {
    let up = tokio::task::spawn_blocking(t6_hw_rs::network::wifi_uplink)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Wi-Fi is not connected")?;
    if up.dns.is_empty() {
        return Err("the Wi-Fi network gave no DNS server".into());
    }
    Ok(up)
}

/// Start the sign-in view's proxy (or keep the running one if Wi-Fi hasn't
/// changed) and return its port on 127.0.0.1.
pub async fn start() -> Result<u16, String> {
    let up = uplink().await?;
    {
        let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = running.as_ref() {
            if p.iface == up.iface && !p.task.is_finished() {
                return Ok(p.port);
            }
        }
        running.take();
    }
    let proxy = spawn_on(up).await?;
    let port = proxy.port;
    *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = Some(proxy);
    Ok(port)
}

/// Stop the sign-in view's proxy and every connection through it.
pub fn stop() {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take();
}

/// A proxy of one's own, apart from the view's; it stops when dropped.
pub async fn spawn() -> Result<Proxy, String> {
    spawn_on(uplink().await?).await
}

async fn spawn_on(up: t6_hw_rs::network::WifiUplink) -> Result<Proxy, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let iface = up.iface.clone();
    let task = tokio::spawn(serve_all(listener, Arc::new(Ctx::new(up))));
    Ok(Proxy { port, iface, task })
}

/// What Apple's probe page (the one NetworkManager is set to check) answers
/// over Wi-Fi.
#[derive(Debug, PartialEq)]
pub enum Probe {
    /// Apple's "Success": the internet is reachable.
    Online,
    /// Sent elsewhere: a sign-in page, at this URL.
    Redirect(String),
    /// Anything else (e.g. a portal that answers with its own page).
    Other(String),
}

pub async fn probe() -> Result<Probe, String> {
    let ctx = Ctx::new(uplink().await?);
    let mut s = ctx.connect("captive.apple.com", 80).await?;
    let ask = async {
        s.write_all(b"GET /hotspot-detect.html HTTP/1.1\r\nHost: captive.apple.com\r\nUser-Agent: CaptiveNetworkSupport/1.0 wispr\r\nAccept: */*\r\nConnection: close\r\n\r\n").await?;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = s.read(&mut chunk).await?;
            if n == 0 || buf.len() > HEAD_MAX {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok::<_, std::io::Error>(buf)
    };
    let buf = tokio::time::timeout(Duration::from_secs(10), ask).await.map_err(|_| "probe timed out".to_string())?.map_err(|e| e.to_string())?;
    Ok(parse_probe(&String::from_utf8_lossy(&buf)))
}

fn parse_probe(text: &str) -> Probe {
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text, ""));
    let code = head.split(' ').nth(1).and_then(|c| c.parse::<u16>().ok()).unwrap_or(0);
    let location = head.lines().find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.trim().eq_ignore_ascii_case("location").then(|| value.trim().to_string())
    });
    match (code, location) {
        (200, _) if body.contains("Success") => Probe::Online,
        (300..=399, Some(url)) => Probe::Redirect(url),
        _ => Probe::Other(format!("HTTP {code}")),
    }
}

async fn serve_all(listener: TcpListener, ctx: Arc<Ctx>) {
    // Connections live in the set, so aborting this task ends them too.
    let mut conns = tokio::task::JoinSet::new();
    let mut tick = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((client, _)) = accepted else { continue };
                *ctx.last.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
                let ctx = ctx.clone();
                conns.spawn(async move {
                    let _ = tokio::time::timeout(CONN_MAX, serve(&ctx, client)).await;
                });
            }
            Some(_) = conns.join_next() => {}
            _ = tick.tick() => {
                let idle = ctx.last.lock().unwrap_or_else(|e| e.into_inner()).elapsed();
                if idle > IDLE && conns.is_empty() {
                    break;
                }
            }
        }
    }
}

async fn serve(ctx: &Ctx, mut client: TcpStream) -> Result<(), String> {
    let (head, rest) = read_head(&mut client).await?;
    let head = String::from_utf8(head).map_err(|_| "bad request head")?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target, version) = (first.next().unwrap_or(""), first.next().unwrap_or(""), first.next().unwrap_or("HTTP/1.1"));

    if method == "CONNECT" {
        let (host, port) = host_port(target, 443)?;
        let mut upstream = match ctx.connect(host, port).await {
            Ok(s) => s,
            Err(e) => return refuse(&mut client, &e).await,
        };
        client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.map_err(|e| e.to_string())?;
        upstream.write_all(&rest).await.map_err(|e| e.to_string())?;
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
        return Ok(());
    }

    // An absolute-form request: GET http://host[:port]/path HTTP/1.1
    let Some(url) = target.strip_prefix("http://") else {
        return refuse(&mut client, "only http:// requests and CONNECT").await;
    };
    let (authority, path) = url.find('/').map_or((url, "/"), |i| (&url[..i], &url[i..]));
    let (host, port) = host_port(authority, 80)?;
    let mut upstream = match ctx.connect(host, port).await {
        Ok(s) => s,
        Err(e) => return refuse(&mut client, &e).await,
    };
    let mut out = format!("{method} {path} {version}\r\n");
    for line in lines.filter(|l| !l.is_empty()) {
        if !hop_by_hop(line) {
            out.push_str(line);
            out.push_str("\r\n");
        }
    }
    out.push_str("Connection: close\r\n\r\n");
    upstream.write_all(out.as_bytes()).await.map_err(|e| e.to_string())?;
    upstream.write_all(&rest).await.map_err(|e| e.to_string())?;

    let (mut cr, mut cw) = client.split();
    let (mut ur, mut uw) = upstream.split();
    let request_body = async {
        let _ = tokio::io::copy(&mut cr, &mut uw).await;
    };
    let response = async {
        let _ = relay_response(&mut ur, &mut cw).await;
        let _ = cw.shutdown().await;
    };
    // Done when the response has been passed on, or when the browser hangs up.
    tokio::select! {
        _ = response => {}
        _ = request_body => {}
    }
    Ok(())
}

/// Pass the response on with `Connection: close`, so the browser opens a new
/// proxy connection for its next request (this one stays tied to one host).
async fn relay_response<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(from: &mut R, to: &mut W) -> Result<(), String> {
    let (head, rest) = read_head(from).await?;
    let head = String::from_utf8_lossy(&head);
    let mut out = String::with_capacity(head.len() + 40);
    for line in head.split("\r\n").filter(|l| !l.is_empty()) {
        if !hop_by_hop(line) {
            out.push_str(line);
            out.push_str("\r\n");
        }
    }
    out.push_str("Connection: close\r\nProxy-Connection: close\r\n\r\n");
    to.write_all(out.as_bytes()).await.map_err(|e| e.to_string())?;
    to.write_all(&rest).await.map_err(|e| e.to_string())?;
    tokio::io::copy(from, to).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Read up to the blank line ending an HTTP head: (head, bytes after it).
async fn read_head<R: AsyncRead + Unpin>(r: &mut R) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        let n = r.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("closed before the head ended".into());
        }
        let from = buf.len().saturating_sub(3);
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf[from..].windows(4).position(|w| w == b"\r\n\r\n") {
            let end = from + i + 4;
            let rest = buf.split_off(end);
            return Ok((buf, rest));
        }
        if buf.len() > HEAD_MAX {
            return Err("head too long".into());
        }
    }
}

fn hop_by_hop(line: &str) -> bool {
    let name = line.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(name.as_str(), "connection" | "proxy-connection" | "keep-alive" | "proxy-authorization")
}

/// "host:port" or "host" (with `default`); IPv6 literals are refused.
fn host_port(authority: &str, default: u16) -> Result<(&str, u16), String> {
    if authority.starts_with('[') {
        return Err("IPv6 addresses are not supported".into());
    }
    match authority.rsplit_once(':') {
        Some((h, p)) => Ok((h, p.parse().map_err(|_| format!("bad port in {authority}"))?)),
        None => Ok((authority, default)),
    }
}

async fn refuse(client: &mut TcpStream, why: &str) -> Result<(), String> {
    let body = format!("t6-paneld portal proxy: {why}\n");
    let reply = format!(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    client.write_all(reply.as_bytes()).await.map_err(|e| e.to_string())
}

impl Ctx {
    fn new(up: t6_hw_rs::network::WifiUplink) -> Self {
        Ctx { iface: up.iface, dns: up.dns, local: up.local, names: Mutex::new(HashMap::new()), last: Mutex::new(Instant::now()) }
    }

    /// A TCP connection to host:port over the Wi-Fi interface.
    async fn connect(&self, host: &str, port: u16) -> Result<TcpStream, String> {
        let mut why = format!("{host}: no address");
        for ip in self.resolve(host).await? {
            if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() || self.local.contains(&ip) {
                why = format!("{host} is this machine");
                continue;
            }
            let socket = TcpSocket::new_v4().map_err(|e| e.to_string())?;
            socket.bind_device(Some(self.iface.as_bytes())).map_err(|e| format!("bind to {}: {e}", self.iface))?;
            match tokio::time::timeout(CONNECT_TIMEOUT, socket.connect(SocketAddr::new(ip.into(), port))).await {
                Ok(Ok(s)) => return Ok(s),
                Ok(Err(e)) => why = format!("{host} ({ip}): {e}"),
                Err(_) => why = format!("{host} ({ip}): timed out"),
            }
        }
        Err(why)
    }

    /// IPv4 addresses for `host`, from the Wi-Fi network's DNS servers.
    async fn resolve(&self, host: &str) -> Result<Vec<Ipv4Addr>, String> {
        if let Ok(ip) = host.parse::<Ipv4Addr>() {
            return Ok(vec![ip]);
        }
        let name = host.trim_end_matches('.').to_ascii_lowercase();
        if let Some(ips) = self.names.lock().unwrap_or_else(|e| e.into_inner()).get(&name) {
            return Ok(ips.clone());
        }
        let mut why = format!("{name}: no DNS answer");
        for &server in &self.dns {
            match dns_query(server, &name, &self.iface).await {
                Ok(ips) if !ips.is_empty() => {
                    self.names.lock().unwrap_or_else(|e| e.into_inner()).insert(name, ips.clone());
                    return Ok(ips);
                }
                Ok(_) => why = format!("{name}: no address"),
                Err(e) => why = format!("{name}: {e}"),
            }
        }
        Err(why)
    }
}

/// One A query to `server` over the Wi-Fi interface (two tries).
async fn dns_query(server: Ipv4Addr, name: &str, iface: &str) -> Result<Vec<Ipv4Addr>, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    socket.bind_device(Some(iface.as_bytes())).map_err(|e| e.to_string())?;
    socket.connect((server, 53)).await.map_err(|e| e.to_string())?;
    let id: u16 = rand::random();
    let query = dns_packet(id, name)?;
    let mut buf = [0u8; 1500];
    for _ in 0..2 {
        socket.send(&query).await.map_err(|e| e.to_string())?;
        if let Ok(Ok(n)) = tokio::time::timeout(DNS_TIMEOUT, socket.recv(&mut buf)).await {
            if let Some(answer) = dns_answer(&buf[..n], id) {
                return answer;
            }
        }
    }
    Err(format!("no answer from {server}"))
}

/// A recursive query for `name`'s A records.
fn dns_packet(id: u16, name: &str) -> Result<Vec<u8>, String> {
    let mut p = Vec::with_capacity(name.len() + 18);
    p.extend_from_slice(&id.to_be_bytes());
    p.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]); // RD; one question
    for label in name.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(format!("bad host name {name}"));
        }
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.push(0);
    p.extend_from_slice(&[0, 1, 0, 1]); // A, IN
    Ok(p)
}

/// The A records in a reply to query `id`; None if it isn't one (ignore it).
fn dns_answer(r: &[u8], id: u16) -> Option<Result<Vec<Ipv4Addr>, String>> {
    if r.len() < 12 || u16::from_be_bytes([r[0], r[1]]) != id || r[2] & 0x80 == 0 {
        return None;
    }
    let rcode = r[3] & 0x0f;
    if rcode != 0 {
        return Some(Err(if rcode == 3 { "no such name".into() } else { format!("DNS error {rcode}") }));
    }
    let questions = u16::from_be_bytes([r[4], r[5]]);
    let answers = u16::from_be_bytes([r[6], r[7]]);
    let mut at = 12;
    for _ in 0..questions {
        at = skip_name(r, at)? + 4;
    }
    let mut ips = Vec::new();
    for _ in 0..answers {
        at = skip_name(r, at)?;
        let field = r.get(at..at + 10)?;
        let (kind, class) = (u16::from_be_bytes([field[0], field[1]]), u16::from_be_bytes([field[2], field[3]]));
        let len = u16::from_be_bytes([field[8], field[9]]) as usize;
        at += 10;
        let data = r.get(at..at + len)?;
        if kind == 1 && class == 1 && len == 4 {
            ips.push(Ipv4Addr::new(data[0], data[1], data[2], data[3]));
        }
        at += len;
    }
    Some(Ok(ips))
}

/// The offset just past a (possibly compressed) name at `at`.
fn skip_name(r: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let len = *r.get(at)? as usize;
        if len == 0 {
            return Some(at + 1);
        }
        if len & 0xc0 == 0xc0 {
            return Some(at + 2);
        }
        at += 1 + len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_packet() {
        let p = dns_packet(0x1234, "captive.apple.com").unwrap();
        assert_eq!(&p[..12], &[0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&p[12..20], b"\x07captive");
        assert_eq!(&p[p.len() - 5..], &[0, 0, 1, 0, 1]);
        assert!(dns_packet(1, "bad..name").is_err());
    }

    /// A reply with a CNAME (pointing back into the question) then an A record,
    /// as the hotel's resolver answers for eu.network-auth.com.
    #[test]
    fn answer_with_cname() {
        let mut r = dns_packet(7, "a.example").unwrap();
        r[2] = 0x81;
        r[3] = 0x80; // response, RD, RA, no error
        r[7] = 2; // two answers
        // CNAME: name = pointer to the question (offset 12), type 5, class 1, ttl, rdlength 2, rdata = pointer
        r.extend_from_slice(&[0xc0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, 2, 0xc0, 12]);
        // A: 158.115.147.196
        r.extend_from_slice(&[0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 158, 115, 147, 196]);
        assert_eq!(dns_answer(&r, 7).unwrap().unwrap(), vec![Ipv4Addr::new(158, 115, 147, 196)]);
        assert!(dns_answer(&r, 8).is_none()); // another query's reply
        assert!(dns_answer(&r[..20], 7).is_none()); // cut short: ignored
        r[3] = 0x83; // NXDOMAIN
        assert!(dns_answer(&r, 7).unwrap().is_err());
    }

    #[test]
    fn host_and_port() {
        assert_eq!(host_port("example.com:8443", 443).unwrap(), ("example.com", 8443));
        assert_eq!(host_port("example.com", 80).unwrap(), ("example.com", 80));
        assert!(host_port("[::1]:80", 80).is_err());
    }

    #[test]
    fn probe_answers() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>\n";
        assert_eq!(parse_probe(ok), Probe::Online);
        let meraki = "HTTP/1.1 307 Temporary Redirect\r\nlocation: https://eu.network-auth.com/splash/x/?a=1\r\n\r\n";
        assert_eq!(parse_probe(meraki), Probe::Redirect("https://eu.network-auth.com/splash/x/?a=1".into()));
        assert_eq!(parse_probe("HTTP/1.1 200 OK\r\n\r\n<html>Welcome</html>"), Probe::Other("HTTP 200".into()));
    }

    #[test]
    fn hop_by_hop_headers() {
        assert!(hop_by_hop("Proxy-Connection: keep-alive"));
        assert!(hop_by_hop("connection: Upgrade"));
        assert!(!hop_by_hop("Content-Length: 12"));
    }
}
