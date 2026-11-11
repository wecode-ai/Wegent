//! Group history is readable without joining a Thread and never uses project grants.
use brz_socket_io::{ClientError, Reply};
use serde_json::{Map, Value, json};

use super::{SubscribeRequest, ack_error};
use crate::chat_groups::repository;
use crate::socketio::project_chat_messages::{MESSAGE_COLUMNS, MessageRow, message_view};
use crate::sql_support::StatementArg;
use crate::state::AppState;

const LIVE: &str =
    "(deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))";

/// The marker selects a protocol; actual persisted type and grants authorize it.
pub(super) fn is_group(data: &Value) -> Result<bool, Value> {
    match data
        .get("containerKind")
        .or_else(|| data.get("container_kind"))
    {
        None => Ok(false),
        Some(Value::String(kind)) if kind == "project" => Ok(false),
        Some(Value::String(kind)) if kind == "chat_group" => Ok(true),
        _ => Err(ack_error("INVALID_MESSAGE", "Unknown chat container kind")),
    }
}

pub(super) async fn subscribe(
    state: &AppState,
    user: i64,
    data: &Map<String, Value>,
) -> Result<Reply<Value>, ClientError> {
    let request = match group_request(data) {
        Ok(request) => request,
        Err(error) => return Ok(Reply::payload(ack_error("INVALID_MESSAGE", &error))),
    };
    let Ok(actor) = i32::try_from(user) else {
        return Ok(Reply::payload(ack_error(
            "SCOPE_NOT_FOUND",
            "Chat group not found",
        )));
    };
    if repository::access(&state.mysql, &request.project_id, actor)
        .await
        .is_err()
    {
        return Ok(Reply::payload(ack_error(
            "SCOPE_NOT_FOUND",
            "Chat group not found",
        )));
    }
    if let Some(thread) = request.task_id.as_deref() {
        match repository::thread(&state.mysql, thread, actor).await {
            Ok((row, _)) if row.group_id == request.project_id => {}
            _ => {
                return Ok(Reply::payload(ack_error(
                    "SCOPE_NOT_FOUND",
                    "Thread not found",
                )));
            }
        }
    }
    let result = match history(state, &request, data).await {
        Ok(result) => result,
        Err(error) => return Ok(Reply::payload(error)),
    };
    let mut result = result;
    result["currentUserId"] = json!(user.to_string());
    // Admission already joined the authenticated personal room before any read.
    Ok(Reply::payload(json!({"ok":true,"result":result})))
}

fn group_request(data: &Map<String, Value>) -> Result<SubscribeRequest, String> {
    let mut request = SubscribeRequest::parse(data)?;
    request.task_id = request.task_id.filter(|thread| !thread.is_empty());
    Ok(request)
}

fn scope(request: &SubscribeRequest) -> (String, Vec<StatementArg>) {
    let mut args = vec![StatementArg::Str(request.project_id.clone())];
    let thread = match &request.task_id {
        Some(thread) => {
            args.push(StatementArg::Str(thread.clone()));
            "task_id=?"
        }
        None => "(task_id IS NULL OR task_id='')",
    };
    (format!("project_id=? AND {thread} AND {LIVE}"), args)
}

fn history_cursor(data: &Map<String, Value>) -> Result<(Option<String>, i64, i64), Value> {
    let focus = super::optional_identifier(data, "focus_message_id")
        .map_err(|error| ack_error("INVALID_MESSAGE", &error))?;
    if focus.as_deref() == Some("") {
        return Err(ack_error(
            "INVALID_MESSAGE",
            "A history anchor cannot be empty",
        ));
    }
    let sequence = |key: &str| match data.get(key) {
        None => Ok(0),
        Some(value) => value.as_i64().filter(|value| *value >= 0).ok_or_else(|| {
            ack_error(
                "INVALID_MESSAGE",
                "History cursors must be nonnegative integers",
            )
        }),
    };
    let before = sequence("before_sequence")?;
    let after = sequence("after_sequence")?;
    if usize::from(focus.is_some()) + usize::from(before > 0) + usize::from(after > 0) > 1 {
        return Err(ack_error(
            "INVALID_MESSAGE",
            "Choose a single history cursor",
        ));
    }
    Ok((focus, before, after))
}

async fn page(
    state: &AppState,
    request: &SubscribeRequest,
    comparison: &str,
    sequence: i64,
    ascending: bool,
    limit: i64,
) -> Result<Vec<MessageRow>, Value> {
    let (scope, mut args) = scope(request);
    args.push(StatementArg::Int(sequence));
    args.push(StatementArg::Int(limit));
    let order = if ascending { "ASC" } else { "DESC" };
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages WHERE {scope} AND id {comparison} ? ORDER BY id {order} LIMIT ?"
    );
    let rows = state.mysql.fetch_all(sql, args).await.map_err(|error| {
        tracing::error!(%error, "group chat history query failed");
        ack_error("INTERNAL_ERROR", "Chat history unavailable")
    })?;
    Ok(rows)
}

async fn history(
    state: &AppState,
    request: &SubscribeRequest,
    data: &Map<String, Value>,
) -> Result<Value, Value> {
    let (focus, before, after) = history_cursor(data)?;
    let mut rows = if let Some(focus) = focus {
        let (scope, mut args) = scope(request);
        args.push(StatementArg::Str(focus));
        let anchor: Option<MessageRow> = state.mysql.fetch_optional(
            format!("SELECT {MESSAGE_COLUMNS} FROM project_chat_messages WHERE {scope} AND message_id=? LIMIT 1"), args,
        ).await.map_err(|error| {
            tracing::error!(%error, "group chat anchor query failed");
            ack_error("INTERNAL_ERROR", "Chat history unavailable")
        })?;
        let anchor = anchor.ok_or_else(|| ack_error("SCOPE_NOT_FOUND", "Message not found"))?;
        let mut rows = page(state, request, "<", anchor.id, false, request.limit / 2).await?;
        rows.reverse();
        let remaining = request.limit - rows.len() as i64;
        rows.extend(page(state, request, ">=", anchor.id, true, remaining).await?);
        rows
    } else if before > 0 {
        let mut rows = page(state, request, "<", before, false, request.limit).await?;
        rows.reverse();
        rows
    } else if after > 0 {
        page(state, request, ">", after, true, request.limit).await?
    } else {
        let mut rows = page(state, request, ">", 0, false, request.limit).await?;
        rows.reverse();
        rows
    };
    rows.sort_by_key(|row| row.id);
    let first = rows
        .first()
        .map_or(if before > 0 { before } else { after }, |row| row.id);
    let last = rows
        .last()
        .map_or(if before > 0 { before } else { after }, |row| row.id);
    let older = !page(state, request, "<", first, false, 1).await?.is_empty();
    let newer = !page(state, request, ">", last, true, 1).await?.is_empty();
    Ok(json!({
        "messages": rows.iter().map(message_view).collect::<Vec<_>>(),
        "latestSequence": last,
        "history": {"firstSequence":first,"lastSequence":last,"hasOlder":older,"hasNewer":newer},
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_protocol_is_explicit_and_rejects_invalid_markers() {
        assert!(!is_group(&json!({})).unwrap());
        assert!(!is_group(&json!({"containerKind":"project"})).unwrap());
        assert!(is_group(&json!({"containerKind":"chat_group"})).unwrap());
        assert!(is_group(&json!({"containerKind":"group"})).is_err());
        assert!(is_group(&json!({"containerKind":null})).is_err());
    }

    #[test]
    fn group_history_cursor_validation_preserves_zero_and_rejects_conflicts() {
        for input in [
            json!({}),
            json!({"before_sequence":0}),
            json!({"after_sequence":0}),
        ] {
            assert_eq!(
                history_cursor(input.as_object().unwrap()).unwrap(),
                (None, 0, 0)
            );
        }
        for input in [
            json!({"before_sequence":-1}),
            json!({"before_sequence":"4"}),
            json!({"after_sequence":1.5}),
            json!({"after_sequence":true}),
            json!({"before_sequence":5,"after_sequence":3}),
            json!({"focus_message_id":"message","after_sequence":3}),
            json!({"focus_message_id":""}),
        ] {
            assert!(
                history_cursor(input.as_object().unwrap()).is_err(),
                "{input}"
            );
        }
    }

    #[test]
    fn empty_thread_uses_the_same_root_scope_as_omission() {
        for input in [
            json!({"project_id":"1101"}),
            json!({"project_id":"1101","task_id":""}),
        ] {
            let request = group_request(input.as_object().unwrap()).unwrap();
            assert!(request.task_id.is_none());
            assert!(scope(&request).0.contains("task_id IS NULL OR task_id=''"));
        }
    }
}
