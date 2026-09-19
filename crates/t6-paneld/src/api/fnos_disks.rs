//! External (USB) drives and remote SMB/NFS mounts via fnOS's own storage and
//! mount managers (`stor.*`, `appcgi.mountmgr.*`), plus the local USB
//! re-enumeration that undoes an eject. Format is deliberately not exposed.

use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;

/// Everything the Files landing page needs for its "Devices" card beyond the
/// local volumes: external (USB) disks with their partitions and mount state,
/// and fnOS "Remote Mount" connections (SMB/NFS/WebDAV). All three sources are
/// fnOS's own — `stor.listDisk` (disk inventory, `external:1`), `stor.listRemovable`
/// (the partitions fnOS currently has mounted under /vol00) and
/// `appcgi.mountmgr.list` — so what we show matches the fnOS File Manager.
pub(super) async fn get_fnos_externals() -> Response {
    let disks = match crate::fnos::call("stor.listDisk", serde_json::json!({})).await {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    };
    let removable = crate::fnos::call("stor.listRemovable", serde_json::json!({})).await.unwrap_or_default();
    let remote = crate::fnos::call("appcgi.mountmgr.list", serde_json::json!({})).await.unwrap_or_default();

    // partition name → mounted entry (path is volume-relative, no leading slash)
    let mounted: std::collections::HashMap<String, &serde_json::Value> = removable["removable"]
        .as_array().map(|a| a.iter().filter_map(|r| r["name"].as_str().map(|n| (n.to_string(), r))).collect())
        .unwrap_or_default();

    let out_disks: Vec<serde_json::Value> = disks["disk"].as_array().map(|a| a.iter()
        .filter(|d| d["external"].as_i64() == Some(1))
        .map(|d| {
            let parts: Vec<serde_json::Value> = d["partitions"].as_array().map(|ps| ps.iter().map(|p| {
                let name = p["name"].as_str().unwrap_or("");
                let m = mounted.get(name);
                serde_json::json!({
                    "name": name,
                    "fstype": p["fstype"],
                    "size": p["size"],
                    "mount_name": p["mountName"],
                    "mounted": m.is_some(),
                    "path": m.and_then(|r| r["path"].as_str()).map(|s| format!("/{}", s.trim_start_matches('/'))),
                    "fssize": m.map(|r| r["fssize"].clone()).unwrap_or(p["fssize"].clone()),
                    "frsize": m.map(|r| r["frsize"].clone()).unwrap_or(p["frsize"].clone()),
                })
            }).collect()).unwrap_or_default();
            let any_mounted = parts.iter().any(|p| p["mounted"].as_bool() == Some(true));
            serde_json::json!({
                "name": d["name"],
                "model": d["modelName"].as_str().unwrap_or("External drive").replace('_', " "),
                "serial": d["serialNumber"],
                "interface": d["interface"],
                "usb_version": d["usbVersion"],
                "size": d["size"],
                "mounted": any_mounted,
                "parts": parts,
            })
        }).collect()).unwrap_or_default();

    // Remote mounts: field names are taken from the fnOS web client; the record
    // is passed through mostly as-is because this box has none to validate against.
    let out_remote: Vec<serde_json::Value> = remote["rsp"].as_array().map(|a| a.iter().map(|r| {
        let pick = |keys: &[&str]| keys.iter().find_map(|k| r[k].as_str().filter(|s| !s.is_empty()).map(str::to_string));
        let state = pick(&["status", "state", "mountStatus"]).unwrap_or_default();
        let mount_point = pick(&["mountPoint"]);
        serde_json::json!({
            "id": r["id"].as_str().map(str::to_string).or_else(|| r["id"].as_i64().map(|n| n.to_string())).or_else(|| pick(&["name"])),
            "label": pick(&["comment", "name", "shareName"]).or_else(|| mount_point.clone()),
            "mount_point": mount_point,
            "protocol": pick(&["protocol", "type"]),
            "host": pick(&["host", "server", "addr", "ip", "hostname"]),
            "share": pick(&["shareName", "share", "remotePath", "path"]),
            "state": state,
            "connected": !state.to_lowercase().contains("disconnect") && !state.to_lowercase().contains("unmount") && !state.to_lowercase().contains("fail"),
        })
    }).collect()).unwrap_or_default();

    Json(serde_json::json!({ "disks": out_disks, "remote": out_remote })).into_response()
}

#[derive(Deserialize)]
pub(super) struct DiskBody { disk: String }

/// fnOS's own guard (mirrors its web UI): never eject a disk that is a member
/// of a storage pool or carries the system.
pub(super) async fn external_disk_ok(name: &str) -> Result<(), String> {
    let disks = crate::fnos::call("stor.listDisk", serde_json::json!({})).await?;
    let d = disks["disk"].as_array().and_then(|a| a.iter().find(|d| d["name"].as_str() == Some(name)))
        .ok_or_else(|| format!("no such disk: {name}"))?;
    if d["external"].as_i64() != Some(1) { return Err("not an external drive".into()); }
    if d["sys"].as_i64() == Some(1) { return Err("that is the system disk".into()); }
    if d["storage"].as_array().map(|a| !a.is_empty()).unwrap_or(false) { return Err("disk belongs to a storage pool".into()); }
    Ok(())
}

fn fnos_action_response(r: Result<serde_json::Value, String>) -> Response {
    match r {
        Ok(v) if v["result"].as_str() == Some("succ") => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok(v) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({
            "ok": false, "errno": v["errno"], "error": v["errmsg"].as_str().unwrap_or("fnOS refused the request")
        }))).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "ok": false, "error": e }))).into_response(),
    }
}

/// Safe removal of an external disk (fnOS "Eject"): `stor.eject({disk})`.
/// The UI confirms first; format is deliberately not exposed.
pub(super) async fn post_fnos_disk_eject(Json(b): Json<DiskBody>) -> Response {
    if let Err(e) = external_disk_ok(&b.disk).await {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": e }))).into_response();
    }
    fnos_action_response(crate::fnos::call("stor.eject", serde_json::json!({ "disk": b.disk })).await)
}

/// Mount an external disk fnOS knows about but hasn't mounted: `stor.diskMount({disk})`.
pub(super) async fn post_fnos_disk_mount(Json(b): Json<DiskBody>) -> Response {
    if let Err(e) = external_disk_ok(&b.disk).await {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": e }))).into_response();
    }
    fnos_action_response(crate::fnos::call("stor.diskMount", serde_json::json!({ "disk": b.disk })).await)
}

#[derive(Deserialize)]
pub(super) struct RemoteBody { name: String }

/// Remote mount Connect / Disconnect (`appcgi.mountmgr.mount|umount({name})`).
/// Disconnect keeps the saved record (no `deleteRecord`) — same as the web UI's
/// "Disconnect", not its "Remove".
pub(super) async fn post_fnos_remote_connect(Json(b): Json<RemoteBody>) -> Response {
    fnos_action_response(crate::fnos::call("appcgi.mountmgr.mount", serde_json::json!({ "name": b.name })).await)
}
pub(super) async fn post_fnos_remote_disconnect(Json(b): Json<RemoteBody>) -> Response {
    fnos_action_response(crate::fnos::call("appcgi.mountmgr.umount", serde_json::json!({ "name": b.name })).await)
}

#[derive(Deserialize)]
pub(super) struct UsbBody { serial: String }
/// Undo of Eject for a USB reader that is still physically attached: power-cycle
/// its port via sysfs `authorized`, then wait (≤10 s) for media to come back.
/// Keyed by the USB serial because the sdX node is gone after an eject.
/// Refused if any block device on that USB device still has media or a mount,
/// so it can never yank a drive that is in use.
pub(super) async fn post_usb_reconnect(Json(b): Json<UsbBody>) -> Response {
    let bad = |m: String| (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": m }))).into_response();
    let Some(dir) = t6_hw_rs::storage::usb_device_by_serial(&b.serial) else { return bad("no such USB device".into()) };
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    for (name, size) in t6_hw_rs::storage::block_devices_under(&dir) {
        if size > 0 || mounts.lines().any(|l| l.starts_with(&format!("/dev/{name}"))) {
            return bad(format!("{name} is present and in use — eject it first"));
        }
    }
    if let Err(e) = t6_hw_rs::storage::usb_set_authorized(&dir, false) { return bad(e); }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    if let Err(e) = t6_hw_rs::storage::usb_set_authorized(&dir, true) { return bad(e); }
    let mut found = Vec::new();
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        found = t6_hw_rs::storage::block_devices_under(&dir).into_iter().filter(|d| d.1 > 0).collect();
        if !found.is_empty() { break; }
    }
    Json(serde_json::json!({ "ok": true, "disks": found.iter().map(|d| serde_json::json!({ "name": d.0, "size_bytes": d.1 })).collect::<Vec<_>>() })).into_response()
}
