//! fnOS file manager endpoints: listings (personal/team/trash/favorites/recent),
//! folder size, mkdir/rename/favorite, trash + restore, copy/move (task API)
//! and finder search. All require sign-in; method names and param shapes are
//! catalogued in refs/fnos-api-catalog.md and refs/fnos-file-write-api.md.

use axum::{extract::Query, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub(super) struct FilesQ {
    // Omitted (not empty-string) makes `file.ls`/`file.team.lsDir` return the
    // caller's own home dir / team-folder root — see refs/fnos-api-catalog.md.
    path: Option<String>,
}

fn ls_params(path: &Option<String>) -> serde_json::Value {
    match path {
        Some(p) => serde_json::json!({ "path": p }),
        None => serde_json::json!({}),
    }
}

/// Read-only directory listing via the fnOS file API (`file.ls`). Requires sign-in.
/// No `path` = the caller's personal home dir (Personal Folder).
pub(super) async fn get_fnos_files(Query(q): Query<FilesQ>) -> Response {
    match crate::fnos::call("file.ls", ls_params(&q.path)).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Team Folder listing. The team *root* is NOT `file.team.lsDir` with no path
/// (that returns empty) — the fnOS web client gets it from
/// `appcgi.filestor.getTeamDirList`. Sub-paths list normally via `file.ls`.
/// Result normalized to the browser's `{files:[{name,dir,...}]}` shape.
pub(super) async fn get_fnos_team_files(Query(q): Query<FilesQ>) -> Response {
    match &q.path {
        Some(p) => match crate::fnos::call("file.ls", serde_json::json!({ "path": p })).await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
        },
        None => match crate::fnos::call("appcgi.filestor.getTeamDirList", serde_json::json!({})).await {
            Ok(v) => {
                // getTeamDirList returns team share dirs; normalize whichever
                // array key it uses into {files:[{name,path,dir:1}]}.
                let arr = v.get("teamDirList")
                    .or_else(|| v.get("list"))
                    .or_else(|| v.get("dirs"))
                    .or_else(|| v.get("teamDir"))
                    .and_then(|a| a.as_array())
                    .cloned()
                    .unwrap_or_default();
                let files: Vec<serde_json::Value> = arr.into_iter().map(|mut it| {
                    let path = it.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
                    let name = it.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
                        .unwrap_or_else(|| path.rsplit('/').next().unwrap_or("").to_string());
                    if let Some(o) = it.as_object_mut() {
                        o.insert("name".into(), serde_json::json!(name));
                        o.insert("dir".into(), serde_json::json!(1));
                    }
                    it
                }).collect();
                Json(serde_json::json!({ "files": files })).into_response()
            }
            Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
        },
    }
}

/// Personal trash (`file.trash.list`) — flat, includes deletion metadata
/// (`rmTime`/`rmUid`). Read-only: no restore/empty actions exposed yet.
pub(super) async fn get_fnos_trash() -> Response {
    match crate::fnos::call("file.trash.list", serde_json::json!({})).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Starred items (`file.fav.list`) — flat, full absolute paths (not scoped to
/// one folder). Normalized to the same `{files:[{name,path,dir,...}]}` shape
/// the file browser already renders, since fnOS returns it as `{fav:[...]}`
/// with no `name` field.
pub(super) async fn get_fnos_favorites() -> Response {
    match crate::fnos::call("file.fav.list", serde_json::json!({})).await {
        Ok(v) => {
            let items = v.get("fav").and_then(|f| f.as_array()).cloned().unwrap_or_default();
            let files: Vec<serde_json::Value> = items
                .into_iter()
                .map(|mut it| {
                    let name = it
                        .get("path")
                        .and_then(|p| p.as_str())
                        .and_then(|p| p.rsplit('/').next())
                        .unwrap_or("")
                        .to_string();
                    if let Some(obj) = it.as_object_mut() {
                        obj.insert("name".into(), serde_json::json!(name));
                    }
                    it
                })
                .collect();
            Json(serde_json::json!({ "files": files })).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Recently-opened items (`file.recent.list`) — server-side, shared with the
/// fnOS web client. Shape: `{recent:[{path,dir,...}]}`.
pub(super) async fn get_fnos_recent() -> Response {
    match crate::fnos::call("file.recent.list", serde_json::json!({})).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Recursive size of a folder (or files) via `file.calc({files:[path]})`.
pub(super) async fn get_fnos_folder_size(Query(q): Query<FilesQ>) -> Response {
    let path = match &q.path {
        Some(p) => p.clone(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "path required" }))).into_response(),
    };
    match crate::fnos::call("file.calc", serde_json::json!({ "files": [path] })).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct MkdirBody { path: String, name: String }
/// Create a folder: `file.mkdir({path})`.
pub(super) async fn post_fnos_mkdir(Json(b): Json<MkdirBody>) -> Response {
    let full = format!("{}/{}", b.path.trim_end_matches('/'), b.name);
    match crate::fnos::call("file.mkdir", serde_json::json!({ "path": full })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true, "path": full })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct RenameBody { path: String, #[serde(rename = "newName")] new_name: String }
/// Rename in place: `file.rename({path, newName})`.
pub(super) async fn post_fnos_rename(Json(b): Json<RenameBody>) -> Response {
    match crate::fnos::call("file.rename", serde_json::json!({ "path": b.path, "newName": b.new_name })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct FavBody { path: String, on: bool }
/// Toggle a favorite: `file.fav.add` / `file.fav.del` ({path}).
pub(super) async fn post_fnos_fav(Json(b): Json<FavBody>) -> Response {
    let method = if b.on { "file.fav.add" } else { "file.fav.del" };
    match crate::fnos::call(method, serde_json::json!({ "path": b.path })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/* ---------- External drives & remote mounts (fnOS stor.* / appcgi.mountmgr.*) ---------- */

#[derive(Deserialize)]
pub(super) struct PathsBody { paths: Vec<String> }
/// Move items to Trash (reversible): `file.rm({files, moveToTrashbin:true})`.
/// Permanent delete (moveToTrashbin:false) is intentionally NOT exposed.
pub(super) async fn post_fnos_trash(Json(b): Json<PathsBody>) -> Response {
    if b.paths.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "no paths" }))).into_response();
    }
    match crate::fnos::call("file.rm", serde_json::json!({ "files": b.paths, "moveToTrashbin": true })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Restore items from Trash: `file.trash.restore({files})`.
pub(super) async fn post_fnos_trash_restore(Json(b): Json<PathsBody>) -> Response {
    if b.paths.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "no paths" }))).into_response();
    }
    match crate::fnos::call("file.trash.restore", serde_json::json!({ "files": b.paths })).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct TransferBody {
    /// Absolute source paths.
    paths: Vec<String>,
    /// Absolute destination directory.
    to: String,
    /// fnOS conflict strategy (numeric enum): 0 = Skip (server default —
    /// silently skips conflicts yet reports "succ"!), 1 = Replace, 2 = Rename
    /// (keep both). The UI pre-checks name collisions and asks the user.
    #[serde(default)]
    overwrite: Option<i64>,
    /// Debug: include the raw task frames.
    #[serde(default)]
    debug: Option<u8>,
}

/// Copy or move via fnOS's own task API (`file.cp` / `file.mv`). These are
/// long-running tasks: the server streams progress frames (`result:"doing"`)
/// and a terminal `succ`/`fail` under the request's reqid, so we collect them
/// with `call_stream` (like finder search) to report real completion + errors.
/// Params mirror the web client: `{files, pathTo, overwrite, details:{name,dir,count}}`.
pub(super) async fn file_transfer(method: &str, b: &TransferBody) -> Response {
    if b.paths.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "no paths" }))).into_response();
    }
    let first = b.paths[0].rsplit('/').next().unwrap_or("").to_string();
    let mut params = serde_json::json!({
        "files": b.paths,
        "pathTo": b.to,
        "details": { "name": first, "count": b.paths.len() },
    });
    if let Some(ow) = b.overwrite {
        params["overwrite"] = serde_json::json!(ow);
    }
    let budget = std::time::Duration::from_secs(90);
    let frames = match crate::fnos::call_stream(method, params, budget).await {
        Ok(f) => f,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    };
    // Interpret: terminal frame = result present && != "doing".
    let mut task_id = serde_json::Value::Null;
    let mut terminal: Option<&serde_json::Value> = None;
    for fr in &frames {
        if task_id.is_null() { if let Some(t) = fr.get("taskId") { task_id = t.clone(); } }
        if fr.get("result").and_then(|r| r.as_str()).map_or(false, |r| r != "doing") { terminal = Some(fr); }
    }
    let mut out = serde_json::json!({ "taskId": task_id, "frames": frames.len() });
    match terminal {
        Some(t) => {
            let res = t.get("result").and_then(|r| r.as_str()).unwrap_or("");
            out["finished"] = serde_json::json!(true);
            out["ok"] = serde_json::json!(res == "succ");
            out["result"] = serde_json::json!(res);
            if let Some(e) = t.get("errno") { out["errno"] = e.clone(); }
            if let Some(m) = t.get("errmsg").or_else(|| t.get("msg")) { out["errmsg"] = m.clone(); }
            // conflict/detail payloads the web client uses for its dialog
            for k in ["failedFiles", "failedFilesCount", "conflict", "conflictFiles"] {
                if let Some(v) = t.get(k) { out[k] = v.clone(); }
            }
        }
        None => {
            // budget elapsed before a terminal frame — task may still be running
            out["finished"] = serde_json::json!(false);
            out["ok"] = serde_json::json!(false);
            out["pending"] = serde_json::json!(true);
        }
    }
    if b.debug.is_some() { out["raw"] = serde_json::json!(frames); }
    Json(out).into_response()
}
pub(super) async fn post_fnos_copy(Json(b): Json<TransferBody>) -> Response { file_transfer("file.cp", &b).await }
pub(super) async fn post_fnos_move(Json(b): Json<TransferBody>) -> Response { file_transfer("file.mv", &b).await }

#[derive(Deserialize)]
pub(super) struct SearchQ {
    /// Search keyword (name substring).
    q: String,
    /// fnOS finder scope: `my-files` (all the user's files, every volume),
    /// `all-files`, `team-files`, … Defaults to `my-files`.
    #[serde(default)]
    scope: Option<String>,
    /// Optional absolute path to restrict the search to one subtree.
    #[serde(default)]
    path: Option<String>,
}

/// Indexed name search via fnOS's finder (`appcgi.finder.fileSearch`). Unlike a
/// `file.ls` walk this is server-side, indexed, and spans all volumes. It
/// *streams*: the server sends many frames under one reqid (intermediate ones
/// `result:"doing"` carrying `matchedFiles`, a terminal `result:"succ"`), which
/// `call_stream` collects. We aggregate + de-dup `matchedFiles`, cap the count,
/// and give each hit a `loc` (containing folder) for the results UI. Read-only.
pub(super) async fn get_fnos_search(Query(q): Query<SearchQ>) -> Response {
    const MAX_RESULTS: usize = 200;
    let budget = std::time::Duration::from_millis(6000);

    let needle = q.q.trim();
    if needle.is_empty() {
        return Json(serde_json::json!({ "files": [], "capped": false })).into_response();
    }
    // fnOS finder params: `{key: <keyword>, path: [<dir>,…]}`. `path` is an
    // ARRAY of search roots (omit to search everything the user can access,
    // across all volumes). There is no `scope` field.
    let mut obj = serde_json::Map::new();
    obj.insert("key".into(), serde_json::json!(needle));
    if let Some(p) = &q.path {
        obj.insert("path".into(), serde_json::json!([p]));
    }
    let params = Value::Object(obj);
    let _ = &q.scope; // scope kept in the query for the UI; not an RPC field

    let frames = match crate::fnos::call_stream("appcgi.finder.fileSearch", params, budget).await {
        Ok(f) => f,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    };

    // Each frame's `data` is an incremental batch of hits. An item's `path` is
    // its CONTAINING folder, volume-relative and WITHOUT a leading slash
    // (e.g. "vol1/1000/Workspace"); `name` is the entry. Normalize to an
    // absolute full path (`/vol1/1000/Workspace/<name>`) and a `loc` (parent)
    // so the results UI can navigate/preview and show a location line.
    let mut files: Vec<serde_json::Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut finished = false;
    for fr in &frames {
        if fr.get("result").and_then(|r| r.as_str()).map_or(false, |r| r != "doing") {
            finished = true;
        }
        let batch = fr.get("data").and_then(|m| m.as_array());
        if let Some(arr) = batch {
            for it in arr {
                if files.len() >= MAX_RESULTS { break; }
                let name = it.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name.is_empty() { continue; }
                let parent = it.get("path").and_then(|p| p.as_str()).unwrap_or("").trim_start_matches('/');
                let full = if parent.is_empty() { format!("/{name}") } else { format!("/{parent}/{name}") };
                if !seen.insert(full.clone()) { continue; }
                let loc = if parent.is_empty() { "/".to_string() } else { format!("/{parent}") };
                let mut e = it.clone();
                if let Some(obj) = e.as_object_mut() {
                    obj.insert("path".into(), serde_json::json!(full));
                    obj.insert("loc".into(), serde_json::json!(loc));
                }
                files.push(e);
            }
        }
    }
    let capped = !finished || files.len() >= MAX_RESULTS;
    Json(serde_json::json!({ "files": files, "capped": capped })).into_response()
}
