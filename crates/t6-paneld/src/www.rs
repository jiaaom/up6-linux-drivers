//! Static UI files, served from a directory given with `--www DIR` (edit,
//! refresh, no rebuild). A later production build can embed them like t6-webd.

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
        if name.contains("..") || name.contains('/') {
            return None;
        }
        let ctype = mime_for(name)?;
        let dir = self.dir.as_ref()?;
        std::fs::read(dir.join(name)).ok().map(|b| (ctype, b))
    }
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
