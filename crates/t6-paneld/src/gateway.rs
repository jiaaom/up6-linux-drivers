//! FygoOS unified-gateway integration: user identity from the forwarded
//! headers, and socket permissions so only the gateway can connect.

use axum::http::HeaderMap;
use serde::Serialize;
use std::path::Path;

/// Identity of the NAS user behind a request, as asserted by the gateway.
#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub uid: Option<u32>,
    pub username: Option<String>,
    pub is_admin: bool,
}

impl User {
    pub fn from_headers(h: &HeaderMap) -> Self {
        let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
        User {
            uid: get("x-trim-userid").and_then(|s| s.parse().ok()),
            username: get("x-trim-username"),
            is_admin: get("x-trim-isadmin").as_deref() == Some("true"),
        }
    }
}

/// Make the socket reachable only by its owner (root) and optionally one
/// group, so nobody can bypass the gateway and forge `X-Trim-*` headers.
/// On fnOS the gateway process runs as root, so no group is needed.
pub fn restrict_socket(path: &Path, group: Option<&str>) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = match group {
        Some(name) => {
            let gid = lookup_gid(name).ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, format!("group {name} not found"))
            })?;
            std::os::unix::fs::chown(path, None, Some(gid))?;
            0o660
        }
        None => 0o600,
    };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

fn lookup_gid(name: &str) -> Option<u32> {
    let text = std::fs::read_to_string("/etc/group").ok()?;
    text.lines().find_map(|l| {
        let mut f = l.split(':');
        (f.next()? == name).then(|| f.nth(1)?.parse().ok())?
    })
}
