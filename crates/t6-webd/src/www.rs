//! Static UI files. Embedded in the binary for deployment; served from a
//! directory instead when `--www DIR` is given (edit, refresh, no rebuild).

use std::path::PathBuf;

const EMBEDDED: &[(&str, &str, &str)] = &[
    ("index.html", "text/html; charset=utf-8", include_str!("../www/index.html")),
    ("app.js", "application/javascript; charset=utf-8", include_str!("../www/app.js")),
    ("style.css", "text/css; charset=utf-8", include_str!("../www/style.css")),
];

pub struct Www {
    dir: Option<PathBuf>,
}

impl Www {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Www { dir }
    }

    /// Returns (content type, body) for a UI file, or `None` if unknown.
    pub fn get(&self, name: &str) -> Option<(&'static str, Vec<u8>)> {
        let name = if name.is_empty() { "index.html" } else { name };
        if name.contains("..") || name.contains('/') {
            return None;
        }
        let ctype = mime_for(name)?;
        if let Some(dir) = &self.dir {
            return std::fs::read(dir.join(name)).ok().map(|b| (ctype, b));
        }
        EMBEDDED.iter().find(|(n, _, _)| *n == name).map(|(_, t, body)| (*t, body.as_bytes().to_vec()))
    }
}

fn mime_for(name: &str) -> Option<&'static str> {
    Some(match name.rsplit('.').next()? {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => return None,
    })
}
