//! Static UI files, served from a directory given with `--www DIR` (edit,
//! refresh, no rebuild). A later production build can embed them like t6-webd.
//! Files may sit in subdirectories (`fonts/…`, `ridgeline/1.12.0/…`); every
//! path segment must be a plain name, so a request can never leave the root.
//! Videos (`.mp4`, `.webm`) are served in parts (HTTP Range), as a `<video>`
//! asks for them, never read whole.

use std::io::{Read, Seek, SeekFrom};
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
        if is_video(name) {
            return None;
        }
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

/// Part of a video file, for a `Range` request (or all of it, for none).
pub struct Part {
    pub ctype: &'static str,
    /// The file's size.
    pub total: u64,
    pub start: u64,
    pub body: Vec<u8>,
    /// Answer 206 with Content-Range (the request had a Range).
    pub partial: bool,
}

pub enum PartError {
    NotFound,
    /// 416: the range starts past the end (carries the file's size).
    Unsatisfiable(u64),
}

/// The most one answer carries: a `<video>` asks for `bytes=N-` and takes
/// what comes, then asks for the rest.
const MAX_PART: u64 = 4 << 20;

impl Www {
    /// A video file, or the part of it `range` (the Range header) asks for.
    pub fn video(&self, name: &str, range: Option<&str>) -> Result<Part, PartError> {
        if !safe_path(name) || !is_video(name) {
            return Err(PartError::NotFound);
        }
        let ctype = mime_for(name).ok_or(PartError::NotFound)?;
        let dir = self.dir.as_ref().ok_or(PartError::NotFound)?;
        let mut f = std::fs::File::open(dir.join(name)).map_err(|_| PartError::NotFound)?;
        let total = f.metadata().map_err(|_| PartError::NotFound)?.len();
        let (start, end, partial) = match range.and_then(parse_range) {
            Some(r) => {
                let (start, end) = r.resolve(total).ok_or(PartError::Unsatisfiable(total))?;
                (start, end.min(start + MAX_PART - 1), true)
            }
            // no (usable) Range: the whole file
            None => (0, total.saturating_sub(1), false),
        };
        let mut body = Vec::new();
        if total > 0 {
            f.seek(SeekFrom::Start(start)).map_err(|_| PartError::NotFound)?;
            f.take(end - start + 1).read_to_end(&mut body).map_err(|_| PartError::NotFound)?;
        }
        Ok(Part { ctype, total, start, body, partial })
    }
}

/// One `bytes=` range; several ranges are not supported (served whole).
#[derive(Debug, PartialEq)]
enum Range {
    /// `bytes=a-b` or `bytes=a-`
    From(u64, Option<u64>),
    /// `bytes=-n`: the last n bytes
    Last(u64),
}

impl Range {
    /// First and last byte within a file of `total` bytes, if any.
    fn resolve(&self, total: u64) -> Option<(u64, u64)> {
        match *self {
            Range::From(a, b) if a < total => Some((a, b.unwrap_or(u64::MAX).min(total - 1))),
            Range::Last(n) if n > 0 && total > 0 => Some((total - n.min(total), total - 1)),
            _ => None,
        }
    }
}

fn parse_range(h: &str) -> Option<Range> {
    let spec = h.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.trim().split_once('-')?;
    match (a.trim(), b.trim()) {
        ("", n) => Some(Range::Last(n.parse().ok()?)),
        (a, "") => Some(Range::From(a.parse().ok()?, None)),
        (a, b) => {
            let (a, b) = (a.parse().ok()?, b.parse().ok()?);
            (a <= b).then_some(Range::From(a, Some(b)))
        }
    }
}

pub fn is_video(name: &str) -> bool {
    matches!(name.rsplit('.').next(), Some("mp4" | "webm"))
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
        "mp4" => "video/mp4",
        "webm" => "video/webm",
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

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-"), Some(Range::From(0, None)));
        assert_eq!(parse_range("bytes=10-19"), Some(Range::From(10, Some(19))));
        assert_eq!(parse_range("bytes=-5"), Some(Range::Last(5)));
        for bad in ["bytes=5-1", "bytes=0-1,4-5", "items=0-1", "bytes=x-", "bytes=-"] {
            assert_eq!(parse_range(bad), None, "{bad:?}");
        }
        assert_eq!(Range::From(10, None).resolve(100), Some((10, 99)));
        assert_eq!(Range::From(10, Some(500)).resolve(100), Some((10, 99)));
        assert_eq!(Range::From(100, None).resolve(100), None);
        assert_eq!(Range::Last(30).resolve(100), Some((70, 99)));
        assert_eq!(Range::Last(300).resolve(100), Some((0, 99)));
    }

    #[test]
    fn video_parts() {
        let dir = std::env::temp_dir().join(format!("t6-www-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let data: Vec<u8> = (0..=255).collect();
        std::fs::write(dir.join("v.mp4"), &data).unwrap();
        let w = Www::new(Some(dir.clone()));
        let p = w.video("v.mp4", Some("bytes=16-31")).ok().unwrap();
        assert!(p.partial && p.start == 16 && p.total == 256 && p.body == data[16..32]);
        let p = w.video("v.mp4", None).ok().unwrap();
        assert!(!p.partial && p.body == data);
        assert!(matches!(w.video("v.mp4", Some("bytes=256-")), Err(PartError::Unsatisfiable(256))));
        assert!(w.get("v.mp4").is_none()); // never read whole through get
        std::fs::remove_dir_all(dir).unwrap();
    }
}
