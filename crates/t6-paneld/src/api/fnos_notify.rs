//! fnOS health alerts and the notification center. Requires sign-in.

use axum::{extract::Query, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;

/// fnOS-side health for the home banner: the resource monitor's active alert
/// ("beep") reasons — what fnOS itself would sound the buzzer for (disk
/// failure, degraded storage, overheat, UPS…). `succ` with no payload = no
/// active alerts. The non-empty shape isn't documented, so any list/strings in
/// the payload are surfaced generically as `alerts:[..]`. Cheap; the UI polls
/// it on the 30 s notification cadence.
pub(super) async fn get_fnos_health() -> Response {
    match crate::fnos::call("appcgi.resmon.alert.getBeepReasons", serde_json::json!({})).await {
        Ok(v) => {
            let mut alerts: Vec<String> = Vec::new();
            fn collect(v: &serde_json::Value, out: &mut Vec<String>) {
                match v {
                    serde_json::Value::String(s) => { if !s.is_empty() { out.push(s.clone()); } }
                    serde_json::Value::Array(a) => { for x in a { collect(x, out); } }
                    serde_json::Value::Object(o) => {
                        for (k, x) in o {
                            if ["req", "reqid", "result", "rev", "errno"].contains(&k.as_str()) { continue; }
                            collect(x, out);
                        }
                    }
                    _ => {}
                }
            }
            collect(&v, &mut alerts);
            Json(serde_json::json!({ "alerts": alerts, "raw": v })).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct NotifQ {
    #[serde(default = "default_notif_limit")]
    limit: i64,
}
fn default_notif_limit() -> i64 {
    30
}

/// fnOS notification center: recent system notifications (`notify.list`) plus
/// the unread badge count (`notify.unreadTotal`). Normalized to
/// `{unread, total, items:[{id,title,content,datetime,level,read,from}]}`.
pub(super) async fn get_fnos_notifications(Query(q): Query<NotifQ>) -> Response {
    let list = match crate::fnos::call(
        "notify.list",
        serde_json::json!({ "start": 0, "limit": q.limit }),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response()
        }
    };
    // unreadTotal is authoritative for the badge; fall back to counting the
    // page's unread rows if that call fails (e.g. method quirk), never fatal.
    let unread = match crate::fnos::call("notify.unreadTotal", serde_json::json!({})).await {
        Ok(v) => v.get("unreadTotal").and_then(|x| x.as_i64()).unwrap_or(0),
        Err(_) => list
            .get("notifyList")
            .and_then(|l| l.as_array())
            .map(|a| a.iter().filter(|n| n.get("read").and_then(|r| r.as_i64()) == Some(0)).count() as i64)
            .unwrap_or(0),
    };
    let items: Vec<serde_json::Value> = list
        .get("notifyList")
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|n| {
            serde_json::json!({
                "id": n.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "title": n.get("title").cloned().unwrap_or(serde_json::Value::Null),
                "content": n.get("content").cloned().unwrap_or(serde_json::Value::Null),
                "datetime": n.get("datetime").cloned().unwrap_or(serde_json::Value::Null),
                "level": n.get("level").cloned().unwrap_or(serde_json::json!(0)),
                "read": n.get("read").cloned().unwrap_or(serde_json::json!(1)),
                "from": n.get("from").cloned().unwrap_or(serde_json::Value::Null),
            })
        })
        .collect();
    Json(serde_json::json!({
        "unread": unread,
        "total": list.get("total").cloned().unwrap_or(serde_json::json!(items.len())),
        "items": items,
    }))
    .into_response()
}

/// Mark every notification read (`notify.setReadAll`). User-initiated only.
pub(super) async fn post_fnos_notifications_read_all() -> Response {
    match crate::fnos::call("notify.setReadAll", serde_json::json!({})).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}
