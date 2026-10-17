//! Static UI files, served from a directory given with `--www DIR` (edit,
//! refresh, no rebuild). A later production build can embed them like t6-webd.
//! Files may sit in subdirectories (`fonts/…`, `ridgeline/1.12.0/…`); every
//! path segment must be a plain name, so a request can never leave the root.

use std::path::PathBuf;

pub struct Www {
    dir: Option<PathBuf>,
}

impl Www {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Www { dir }
    }

    /// Returns (content type, body) for a UI file, or `None` if unknown/missing.
    pub fn get(&self, name: &str) -> Option<(&'static str, Vec<u8>)> {
        let name = if name.is_empty() { "index.html" } else { name };
        if !safe_path(name) {
            return None;
        }
        let ctype = mime_for(name)?;
        let dir = self.dir.as_ref()?;
        let body = std::fs::read(dir.join(name)).ok()?;
        if name != "index.html" {
            return Some((ctype, body));
        }
        // Stamp `?v=__V__` asset URLs with a content hash (the admin page uses
        // them) so a webview that ignores no-store can't pair a new page with
        // a stale script; pages without the marker are served untouched.
        let html = String::from_utf8_lossy(&body);
        if !html.contains("?v=__V__") {
            return Some((ctype, body));
        }
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for f in ["app.js", "style.css", "web-app.js"] {
            std::fs::read(dir.join(f)).ok().hash(&mut h);
        }
        let v = format!("{:016x}", h.finish());
        Some((ctype, html.replace("?v=__V__", &format!("?v={}", &v[..10])).into_bytes()))
    }
}

/// True when every `/`-separated segment is a plain file or directory name.
fn safe_path(name: &str) -> bool {
    name.split('/').all(|seg| {
        !seg.is_empty() && seg != "." && seg != ".." && !seg.contains('\\') && !seg.contains('\0')
    })
}

/// Vendored files under a versioned directory (`ridgeline/<version>/…`) never
/// change in place — a new version gets a new directory — so clients may keep
/// them. Everything else is the live UI and must not be cached.
pub fn is_immutable(name: &str) -> bool {
    name.starts_with("ridgeline/")
}

fn mime_for(name: &str) -> Option<&'static str> {
    Some(match name.rsplit('.').next()? {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert!(safe_path("index.html"));
        assert!(safe_path("ridgeline/1.12.0/fonts/EBGaramond-Variable.woff2"));
        for bad in ["../x", "a/../b", "a//b", "/a", "a/", "./a", "a\\b", "a\0b"] {
            assert!(!safe_path(bad), "{bad:?}");
        }
        assert!(is_immutable("ridgeline/1.12.0/tokens.css"));
        assert!(!is_immutable("app.js"));
    }
}
