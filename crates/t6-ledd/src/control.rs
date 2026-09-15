//! Control socket (`/run/t6-ledd/ctl`): one text command per connection,
//! one text reply. Used by t6-webd; also handy from a shell with `socat`.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};

pub struct Request {
    pub line: String,
    pub reply: Sender<String>,
}

/// Accept connections on a thread; each request is handed to the main
/// loop through the returned channel.
pub fn serve(path: &Path) -> std::io::Result<Receiver<Request>> {
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    let (tx, rx) = mpsc::channel::<Request>();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut line = String::new();
            let mut reader = BufReader::new(&stream);
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let (rtx, rrx) = mpsc::channel();
            if tx.send(Request { line: line.trim().to_string(), reply: rtx }).is_err() {
                break;
            }
            let reply = rrx.recv().unwrap_or_else(|_| "error: daemon stopped".into());
            let mut stream = stream;
            let _ = stream.write_all(reply.as_bytes());
            let _ = stream.write_all(b"\n");
        }
    });
    Ok(rx)
}
