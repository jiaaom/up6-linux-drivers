//! Copies and moves that keep running when the person leaves the page: the
//! status bar's task chip and the task sheet read them (`/api/fnos/tasks`).
//!
//! Each task streams fnOS's `file.cp` / `file.mv` progress frames
//! (`{percent, size, sizeTotal, speed, time}`) into a shared list. Finished
//! tasks stay listed for a minute, so the panel can say what was done.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Longest a single copy may run before we stop listening for it.
const BUDGET: Duration = Duration::from_secs(12 * 3600);
const KEEP_FINISHED_S: u64 = 60;

#[derive(Serialize, Clone)]
pub struct Task {
    pub id: u64,
    /// "copy" or "move".
    pub op: &'static str,
    /// The first item's name, and how many items.
    pub name: String,
    pub count: usize,
    /// Destination folder.
    pub to: String,
    pub percent: f64,
    pub size: u64,
    pub size_total: u64,
    /// Bytes per second, and seconds left, as fnOS reports them.
    pub speed: u64,
    pub time_left: u64,
    /// "running", "done", "failed" or "cancelled".
    pub state: &'static str,
    pub error: Option<String>,
    /// When it ended (unix s).
    pub ended: Option<u64>,
    #[serde(skip)]
    fnos_id: Option<String>,
}

static TASKS: Mutex<Vec<Task>> = Mutex::new(Vec::new());
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn update(id: u64, f: impl FnOnce(&mut Task)) {
    if let Some(t) = TASKS.lock().unwrap().iter_mut().find(|t| t.id == id) {
        f(t);
    }
}

/// Start a copy or move in the background; returns its id at once.
/// `overwrite`: 0 skip duplicates (fnOS's default), 1 replace, 2 keep both.
pub fn start(op: &'static str, paths: Vec<String>, to: String, overwrite: Option<i64>) -> Result<u64, String> {
    if paths.is_empty() {
        return Err("no paths".into());
    }
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = paths[0].rsplit('/').next().unwrap_or("").to_string();
    TASKS.lock().unwrap().push(Task {
        id, op, name: name.clone(), count: paths.len(), to: to.clone(),
        percent: 0.0, size: 0, size_total: 0, speed: 0, time_left: 0,
        state: "running", error: None, ended: None, fnos_id: None,
    });
    let method = if op == "move" { "file.mv" } else { "file.cp" };
    let mut params = json!({ "files": paths, "pathTo": to, "details": { "name": name, "count": paths.len() } });
    if let Some(o) = overwrite {
        params["overwrite"] = json!(o);
    }
    tokio::spawn(async move {
        let mut outcome: Option<(&'static str, Option<String>)> = None;
        let r = crate::fnos::call_each(method, params, BUDGET, |f: &Value| {
            if let Some(tid) = f.get("taskId").and_then(|v| v.as_str()) {
                let tid = tid.to_string();
                update(id, |t| t.fnos_id = Some(tid));
            }
            if let Some(p) = f.get("percent").and_then(|v| v.as_f64()) {
                let g = |k: &str| f.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                update(id, |t| {
                    t.percent = p;
                    t.size = g("size");
                    t.size_total = g("sizeTotal");
                    t.speed = g("speed");
                    t.time_left = g("time");
                });
            }
            match f.get("result").and_then(|v| v.as_str()) {
                Some("succ") => outcome = Some(("done", None)),
                Some("doing") | None => {}
                Some(_) => {
                    let msg = f.get("errmsg").or_else(|| f.get("msg")).and_then(|v| v.as_str())
                        .map(str::to_string)
                        .or_else(|| f.get("errno").map(|e| format!("errno {e}")));
                    outcome = Some(("failed", msg));
                }
            }
        })
        .await;
        let (state, error) = match (r, outcome) {
            (Err(e), _) => ("failed", Some(e)),
            (Ok(()), Some(o)) => o,
            (Ok(()), None) => ("failed", Some("no answer from fnOS".to_string())),
        };
        update(id, |t| {
            // a cancel already said how it ended
            if t.state == "running" {
                t.state = state;
                t.error = error;
                if state == "done" {
                    t.percent = 100.0;
                }
            }
            t.ended = Some(now());
        });
    });
    Ok(id)
}

/// Running tasks, and those that ended in the last minute.
pub fn list() -> Vec<Task> {
    let mut tasks = TASKS.lock().unwrap();
    let cutoff = now().saturating_sub(KEEP_FINISHED_S);
    tasks.retain(|t| t.ended.map_or(true, |e| e >= cutoff));
    tasks.clone()
}

pub async fn cancel(id: u64) -> Result<(), String> {
    let fnos_id = TASKS.lock().unwrap().iter().find(|t| t.id == id).and_then(|t| t.fnos_id.clone());
    let Some(tid) = fnos_id else { return Err("no such running task".into()) };
    crate::fnos::call("file.cancel", json!({ "taskId": tid })).await?;
    update(id, |t| {
        t.state = "cancelled";
        t.ended = Some(now());
    });
    Ok(())
}
