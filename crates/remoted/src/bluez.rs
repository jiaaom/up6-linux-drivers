//! Finding matching remotes in BlueZ and subscribing to their key
//! characteristic.
//!
//! Subscription is `AcquireNotify` (BlueZ hands over a socket that carries one
//! notification per read and is closed when the device disconnects). If some
//! other client already subscribed with `StartNotify`, BlueZ refuses that, so
//! remoted falls back to `StartNotify` and the characteristic's `Value`
//! PropertiesChanged signals.

use crate::config::Remote;
use crate::uinput::Keyboard;
use futures_util::StreamExt;
use std::collections::{HashMap, HashSet};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::unix::AsyncFd;
use tokio::sync::{watch, Notify};
use zbus::message::Type as MsgType;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream};

const BLUEZ: &str = "org.bluez";
const DEVICE: &str = "org.bluez.Device1";
const CHAR: &str = "org.bluez.GattCharacteristic1";
const PROPS: &str = "org.freedesktop.DBus.Properties";
/// Look again this often even without a BlueZ signal (e.g. bluetoothd
/// started after us, or a session ended while the device stayed connected).
const RESCAN: Duration = Duration::from_secs(10);

type Props = HashMap<String, OwnedValue>;
type Managed = HashMap<OwnedObjectPath, HashMap<String, Props>>;

fn get_str(p: &Props, key: &str) -> Option<String> {
    p.get(key).and_then(|v| <&str>::try_from(&**v).ok()).map(str::to_string)
}
fn get_bool(p: &Props, key: &str) -> bool {
    p.get(key).and_then(|v| bool::try_from(&**v).ok()).unwrap_or(false)
}

async fn managed(c: &Connection) -> zbus::Result<Managed> {
    let reply = c.call_method(Some(BLUEZ), "/", Some("org.freedesktop.DBus.ObjectManager"), "GetManagedObjects", &()).await?;
    Ok(reply.body().deserialize::<Managed>()?)
}

/// The device's name/alias and address fit `r` (the characteristic is only
/// known once connected, so it isn't checked here).
fn matches(d: &Props, r: &Remote) -> bool {
    if let Some(want) = &r.name {
        if get_str(d, "Name").as_ref() != Some(want) && get_str(d, "Alias").as_ref() != Some(want) {
            return false;
        }
    }
    if let Some(want) = &r.address {
        if get_str(d, "Address").map(|a| a.to_ascii_uppercase()).as_ref() != Some(want) {
            return false;
        }
    }
    true
}

/// For the status file: (paired, connected, address of the connected or
/// else a paired remote). Without a name or address to go by, only
/// connected devices with the key characteristic count.
fn link(m: &Managed, r: &Remote, found: &[(String, String)]) -> (bool, bool, Option<String>) {
    let addr = |path: &str| m.iter().find(|(p, _)| p.as_str() == path).and_then(|(_, i)| i.get(DEVICE)).and_then(|d| get_str(d, "Address"));
    if let Some((dev, _)) = found.first() {
        return (true, true, addr(dev));
    }
    if r.name.is_none() && r.address.is_none() {
        return (false, false, None);
    }
    let paired = m.values().filter_map(|i| i.get(DEVICE)).find(|d| get_bool(d, "Paired") && matches(d, r));
    (paired.is_some(), false, paired.and_then(|d| get_str(d, "Address")))
}

/// Connected, resolved devices matching `r`, each with its key
/// characteristic: (device path, characteristic path).
fn find(m: &Managed, r: &Remote) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (path, ifaces) in m {
        let Some(d) = ifaces.get(DEVICE) else { continue };
        if !get_bool(d, "Connected") || !get_bool(d, "ServicesResolved") || !matches(d, r) {
            continue;
        }
        let prefix = format!("{}/", path.as_str());
        let chr = m.iter().find(|(p, i)| {
            p.as_str().starts_with(&prefix)
                && i.get(CHAR).and_then(|c| get_str(c, "UUID")).is_some_and(|u| u.eq_ignore_ascii_case(&r.characteristic))
        });
        if let Some((cp, _)) = chr {
            out.push((path.to_string(), cp.to_string()));
        }
    }
    out.sort();
    out
}

/// A counter that goes up whenever a BlueZ device connects, disconnects or
/// resolves its services, or objects appear (bluetoothd (re)start, pairing).
pub fn watch_changes(conn: Connection) -> watch::Receiver<u64> {
    let (tx, rx) = watch::channel(0u64);
    tokio::spawn(async move {
        loop {
            if let Err(e) = watch_once(&conn, &tx).await {
                eprintln!("BlueZ signals: {e}");
            }
            tokio::time::sleep(RESCAN).await;
        }
    });
    rx
}

async fn watch_once(conn: &Connection, tx: &watch::Sender<u64>) -> zbus::Result<()> {
    let changed = MatchRule::builder()
        .msg_type(MsgType::Signal)
        .interface(PROPS)?
        .member("PropertiesChanged")?
        .path_namespace("/org/bluez")?
        .arg(0, DEVICE)?
        .build();
    let added = MatchRule::builder()
        .msg_type(MsgType::Signal)
        .interface("org.freedesktop.DBus.ObjectManager")?
        .member("InterfacesAdded")?
        .build();
    let changed = MessageStream::for_match_rule(changed, conn, Some(64)).await?;
    let added = MessageStream::for_match_rule(added, conn, Some(64)).await?;
    let mut all = futures_util::stream::select(changed, added);
    while let Some(msg) = all.next().await {
        let Ok(msg) = msg else { continue };
        let relevant = match msg.header().member().map(|m| m.as_str()) {
            Some("PropertiesChanged") => msg
                .body()
                .deserialize::<(String, Props, Vec<String>)>()
                .is_ok_and(|(_, p, _)| p.contains_key("Connected") || p.contains_key("ServicesResolved")),
            _ => true,
        };
        if relevant {
            tx.send_modify(|n| *n += 1);
        }
    }
    Ok(())
}

/// Serve one `[[remote]]`: keep a session on every matching connected device.
pub async fn serve(conn: Connection, idx: usize, r: Remote, kb: Arc<Mutex<Keyboard>>, mut changes: watch::Receiver<u64>, verbose: bool) {
    let r = Arc::new(r);
    let active: Arc<Mutex<HashSet<String>>> = Default::default();
    let ended = Arc::new(Notify::new());
    loop {
        changes.borrow_and_update();
        match managed(&conn).await {
            Ok(m) => {
                let found = find(&m, &r);
                let (paired, connected, address) = link(&m, &r, &found);
                crate::status::set_link(idx, paired, connected, address);
                for (dev, chr) in found {
                    if !active.lock().unwrap().insert(dev.clone()) {
                        continue;
                    }
                    let (conn, r, kb, active, ended) = (conn.clone(), r.clone(), kb.clone(), active.clone(), ended.clone());
                    tokio::spawn(async move {
                        eprintln!("{}: connected ({dev})", r.label());
                        let why = session(&conn, idx, &dev, &chr, &r, &kb, verbose).await;
                        kb.lock().unwrap().hold(None);
                        eprintln!("{}: {why} ({dev})", r.label());
                        active.lock().unwrap().remove(&dev);
                        ended.notify_one();
                    });
                }
            }
            Err(e) => {
                crate::status::set_link(idx, false, false, None);
                if verbose {
                    eprintln!("BlueZ: {e}");
                }
            }
        }
        tokio::select! {
            _ = changes.changed() => {}
            _ = ended.notified() => tokio::time::sleep(Duration::from_secs(1)).await,
            _ = tokio::time::sleep(RESCAN) => {}
        }
    }
}

/// Feed one notification to the keyboard.
fn on_notify(idx: usize, r: &Remote, kb: &Mutex<Keyboard>, data: &[u8], verbose: bool) {
    let Some(&code) = data.get(r.code_byte) else { return };
    let key = if code == r.release { None } else { r.keys.get(&code).copied() };
    if verbose {
        let hex: Vec<String> = data.iter().map(|b| format!("{b:02x}")).collect();
        match key {
            Some(k) => eprintln!("{}: {} -> key {k}", r.label(), hex.join(" ")),
            None => eprintln!("{}: {} -> release", r.label(), hex.join(" ")),
        }
    } else if key.is_none() && code != r.release {
        eprintln!("{}: unmapped code 0x{code:02x}", r.label());
    }
    kb.lock().unwrap().hold(key);
    crate::status::on_code(idx, code, code == r.release, key);
}

/// Subscribe and forward notifications until the device goes away. Returns
/// why it ended.
async fn session(conn: &Connection, idx: usize, dev: &str, chr: &str, r: &Remote, kb: &Mutex<Keyboard>, verbose: bool) -> String {
    let opts: HashMap<&str, Value> = HashMap::new();
    let acquired = conn.call_method(Some(BLUEZ), chr, Some(CHAR), "AcquireNotify", &(opts,)).await;
    match acquired.and_then(|m| m.body().deserialize::<(zbus::zvariant::OwnedFd, u16)>().map_err(Into::into)) {
        Ok((fd, _mtu)) => read_socket(OwnedFd::from(fd), idx, r, kb, verbose).await,
        Err(e) => {
            if verbose {
                eprintln!("{}: AcquireNotify: {e}; using StartNotify", r.label());
            }
            match start_notify(conn, idx, dev, chr, r, kb, verbose).await {
                Ok(why) => why,
                Err(e) => format!("subscribe failed: {e}"),
            }
        }
    }
}

async fn read_socket(fd: OwnedFd, idx: usize, r: &Remote, kb: &Mutex<Keyboard>, verbose: bool) -> String {
    // SAFETY: fcntl on a descriptor we own.
    unsafe {
        let fl = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
        libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, fl | libc::O_NONBLOCK);
    }
    let afd = match AsyncFd::new(fd) {
        Ok(a) => a,
        Err(e) => return format!("notify socket: {e}"),
    };
    let mut buf = [0u8; 512];
    loop {
        let mut guard = match afd.readable().await {
            Ok(g) => g,
            Err(e) => return format!("notify socket: {e}"),
        };
        let res = guard.try_io(|inner| {
            // SAFETY: reading into our own buffer from a descriptor we own.
            let n = unsafe { libc::read(inner.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
            if n < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        });
        match res {
            Ok(Ok(0)) => return "disconnected".into(),
            Ok(Ok(n)) => on_notify(idx, r, kb, &buf[..n], verbose),
            Ok(Err(e)) => return format!("disconnected ({e})"),
            Err(_would_block) => continue,
        }
    }
}

async fn start_notify(conn: &Connection, idx: usize, dev: &str, chr: &str, r: &Remote, kb: &Mutex<Keyboard>, verbose: bool) -> zbus::Result<String> {
    // Value changes on the characteristic, Connected on the device.
    let rule = MatchRule::builder()
        .msg_type(MsgType::Signal)
        .interface(PROPS)?
        .member("PropertiesChanged")?
        .path_namespace(dev)?
        .build();
    let mut stream = MessageStream::for_match_rule(rule, conn, Some(64)).await?;
    conn.call_method(Some(BLUEZ), chr, Some(CHAR), "StartNotify", &()).await?;
    let mut check = tokio::time::interval(Duration::from_secs(30));
    let why = loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { break "signal stream ended".to_string() };
                let path = msg.header().path().map(|p| p.to_string()).unwrap_or_default();
                let Ok((iface, props, _)) = msg.body().deserialize::<(String, Props, Vec<String>)>() else { continue };
                if path == chr && iface == CHAR {
                    if let Some(v) = props.get("Value").and_then(|v| v.try_clone().ok()) {
                        if let Ok(data) = Vec::<u8>::try_from(v) {
                            on_notify(idx, r, kb, &data, verbose);
                        }
                    }
                } else if path == dev && iface == DEVICE && props.get("Connected").is_some_and(|v| bool::try_from(&**v) == Ok(false)) {
                    break "disconnected".to_string();
                }
            }
            _ = check.tick() => {
                // The device object vanishing (unpaired, bluetoothd restart)
                // sends no PropertiesChanged.
                let alive = conn.call_method(Some(BLUEZ), dev, Some(PROPS), "Get", &(DEVICE, "Connected")).await
                    .ok()
                    .and_then(|m| m.body().deserialize::<Value>().ok().and_then(|v| bool::try_from(&v).ok()))
                    .unwrap_or(false);
                if !alive {
                    break "disconnected".to_string();
                }
            }
        }
    };
    let _ = conn.call_method(Some(BLUEZ), chr, Some(CHAR), "StopNotify", &()).await;
    Ok(why)
}
