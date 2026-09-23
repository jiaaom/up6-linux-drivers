//! Static UI files. Embedded in the binary for deployment; served from a
//! directory instead when `--www DIR` is given (edit, refresh, no rebuild).

use std::path::PathBuf;

const EMBEDDED: &[(&str, &str, &[u8])] = &[
    ("index.html", "text/html; charset=utf-8", include_bytes!("../www/index.html")),
    ("app.js", "application/javascript; charset=utf-8", include_bytes!("../www/app.js")),
    ("style.css", "text/css; charset=utf-8", include_bytes!("../www/style.css")),
    // fnOS desktop SDK (TrimApp), vendored verbatim: theme + language from the host.
    ("web-app.js", "application/javascript; charset=utf-8", include_bytes!("../www/web-app.js")),
    // Dashboard hero photo: assets/product-up6-alpha.png cropped to the device
    // and scaled to 480 px tall (~150 KB).
    ("device-up6.png", "image/png", include_bytes!("../www/device-up6.png")),
];

pub struct Www {
    dir: Option<PathBuf>,
}

impl Www {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Www { dir }
    }

    /// Returns (content type, body) for a UI file, or `None` if unknown.
    /// `index.html` gets its `?v=__V__` asset URLs stamped with a hash of the
    /// assets, so a webview that ignores `no-store` (the fnOS mobile app
    /// kept serving a stale app.js/style.css) still loads the current files.
    pub fn get(&self, name: &str) -> Option<(&'static str, Vec<u8>)> {
        let name = if name.is_empty() { "index.html" } else { name };
        if name.contains("..") || name.contains('/') {
            return None;
        }
        let ctype = mime_for(name)?;
        let body = self.raw(name)?;
        if name != "index.html" {
            return Some((ctype, body));
        }
        let html = String::from_utf8_lossy(&body).replace("?v=__V__", &format!("?v={}", self.asset_version()));
        Some((ctype, html.into_bytes()))
    }

    fn raw(&self, name: &str) -> Option<Vec<u8>> {
        if let Some(dir) = &self.dir {
            return std::fs::read(dir.join(name)).ok();
        }
        EMBEDDED.iter().find(|(n, _, _)| *n == name).map(|(_, _, body)| body.to_vec())
    }

    /// Short content hash of the assets index.html references.
    fn asset_version(&self) -> String {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for f in ["app.js", "style.css", "web-app.js", "device-up6.png"] {
            self.raw(f).hash(&mut h);
        }
        let v = format!("{:016x}", h.finish());
        v[..10].to_string()
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
