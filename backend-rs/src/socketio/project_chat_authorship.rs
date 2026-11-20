//! Batch public authorship from the original message, trigger and project robot.

use serde_json::{Value, json};
use std::collections::HashMap;

use super::{MessageRow, ack_error, message_view};
use crate::sql_support::StatementArg;
use crate::state::AppState;

#[derive(brz_mysql::FromMysqlRow)]
struct AuthorshipRow {
    message_id: String,
    actor_user_id: Option<i64>,
    actor_display_name: Option<String>,
    runtime_owner_user_id: Option<i64>,
    project_execution: i64,
}

pub(crate) async fn message_views(
    mysql: &impl brz_mysql::Mysql,
    viewer_user_id: i64,
    rows: &[MessageRow],
) -> Result<Vec<Value>, Value> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; rows.len()].join(",");
    let sql = format!(
        "SELECT m.message_id, u.id AS actor_user_id, u.user_name AS actor_display_name, \
                o.id AS runtime_owner_user_id, \
                CASE WHEN (e.id IS NOT NULL OR (a.id IS NOT NULL AND \
                  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.visibility')),'project')<>'private')) \
                  AND JSON_EXTRACT(i.metadata,'$.assistant_dispatch_role') IS NULL \
                  AND JSON_EXTRACT(m.metadata,'$.stand_in') IS NULL \
                  THEN 1 ELSE 0 END AS project_execution \
         FROM project_chat_messages m \
         LEFT JOIN project_chat_messages t ON t.message_id=m.trigger_message_id \
           AND t.project_id=m.project_id AND t.task_id=m.task_id AND t.sender_type='user' \
         LEFT JOIN loop_items a ON a.id=m.agent_id AND a.cloud_project_id=m.project_id \
           AND a.resource_type='chat_agent' \
         LEFT JOIN loop_items i ON i.id=m.task_id AND i.cloud_project_id=m.project_id AND i.resource_type='task' \
         LEFT JOIN loop_item_executions e ON e.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')) AS UNSIGNED) \
           AND e.cloud_project_id=m.project_id AND e.loop_item_id=m.task_id AND e.agent_id=m.agent_id \
         LEFT JOIN users u ON u.id=CASE \
           WHEN m.sender_type='user' THEN CAST(m.sender_id AS UNSIGNED) \
           WHEN m.sender_type='agent' THEN COALESCE( \
             CASE WHEN JSON_TYPE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id'))='INTEGER' \
               THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id')) AS UNSIGNED) END, \
             CAST(t.sender_id AS UNSIGNED), a.created_by_user_id) END \
         LEFT JOIN users o ON o.id=CASE \
           WHEN m.sender_type='user' THEN CAST(m.sender_id AS UNSIGNED) \
           WHEN m.sender_type='agent' THEN COALESCE( \
             CASE WHEN JSON_TYPE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id'))='INTEGER' \
               THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id')) AS UNSIGNED) END, \
             a.created_by_user_id, CAST(t.sender_id AS UNSIGNED)) END \
         WHERE m.message_id IN ({placeholders})"
    );
    let args: Vec<_> = rows
        .iter()
        .map(|row| StatementArg::Str(row.message_id.clone()))
        .collect();
    let authors: Vec<AuthorshipRow> = mysql.fetch_all(sql, args).await.map_err(|error| {
        tracing::error!(%error, "project message authorship lookup failed");
        ack_error("INVALID_MESSAGE", "database query failed")
    })?;
    let authors: HashMap<_, _> = authors
        .into_iter()
        .map(|row| (row.message_id.clone(), row))
        .collect();
    Ok(rows
        .iter()
        .map(|row| {
            let mut view = message_view(row);
            let author = authors.get(&row.message_id);
            if let Some(author) = author {
                view["actorUserId"] = json!(author.actor_user_id.map(|id| id.to_string()));
                view["actorDisplayName"] = json!(author.actor_display_name);
            }
            apply_private_source_access(
                &mut view,
                row,
                viewer_user_id,
                author.and_then(|value| value.runtime_owner_user_id),
                author.is_some_and(|value| value.project_execution == 1),
            );
            view
        })
        .collect())
}

pub(crate) async fn message_view_with_actor(
    state: &AppState,
    viewer_user_id: i64,
    row: &MessageRow,
) -> Result<Value, Value> {
    let views = message_views(&state.mysql, viewer_user_id, std::slice::from_ref(row)).await?;
    views
        .into_iter()
        .next()
        .ok_or_else(|| ack_error("INVALID_MESSAGE", "message not found"))
}

/// Keep the shared read model free of private execution parameters while
/// allowing the owning user to continue the original Runtime conversation.
fn apply_private_source_access(
    view: &mut Value,
    row: &MessageRow,
    viewer: i64,
    runtime_owner_user_id: Option<i64>,
    project_execution: bool,
) {
    let owner = runtime_owner_user_id == Some(viewer);
    if !owner {
        view["metadata"] = json!(shared_metadata(&row.metadata(), project_execution));
        if private_execution_message(&row.message_type, &row.metadata()) {
            view["content"] = json!("");
            if row.message_type == "text" {
                view["type"] = json!("agent_chunk");
            }
        }
    }
    let (device_id, task_id) = super::runtime_source(row);
    if device_id.is_empty() || task_id.is_empty() {
        return;
    }
    view["traceState"] = json!(if owner || project_execution {
        "available"
    } else {
        "restricted"
    });
    if owner || project_execution {
        view["runtimeAddress"] = json!({
            "deviceId": device_id,
            "taskId": task_id,
        });
    }
}

pub(crate) fn shared_message_payload(view: &Value) -> Value {
    let mut shared = view.clone();
    if let Some(metadata) = view.get("metadata") {
        shared["metadata"] = json!(shared_metadata(metadata, false));
    }
    if private_execution_message(view["type"].as_str().unwrap_or_default(), &view["metadata"]) {
        shared["content"] = json!("");
        if view["type"] == "text" {
            shared["type"] = json!("agent_chunk");
        }
    }
    shared["runtimeAddress"] = Value::Null;
    shared["traceState"] = json!(
        if view.get("traceRef").is_some_and(|value| !value.is_null()) {
            "restricted"
        } else {
            "history-unavailable"
        }
    );
    shared
}

fn private_execution_message(message_type: &str, metadata: &Value) -> bool {
    matches!(message_type, "agent_status" | "agent_chunk") || metadata["kind"] == "task_ai_subagent"
}

fn shared_metadata(metadata: &Value, include_runtime: bool) -> serde_json::Map<String, Value> {
    const SHARED_KEYS: &[&str] = &[
        "mentions",
        "stand_in_reply_to",
        "collaboration_public_reply",
        "collaboration_turn_start",
        "collaboration_guidance",
        "collaboration_execution_activity_id",
        "execution_dispatch",
        "activity_type",
        "dispatch_role",
        "manager_display_name",
        "run_status",
        "summary",
        "evidence_refs",
        "next_action",
        "publish_policy",
        "imported_from",
        "history_import",
        "member_assistant_result",
        "runtime_event_sequence",
    ];
    const RUNTIME_KEYS: &[&str] = &[
        "run_id",
        "execution_id",
        "executor_type",
        "backend_task_id",
        "execution_url",
        "model",
        "runtime_event_sequence",
        "contentMode",
        "runtime_turn_id",
        "workflow_task_title",
    ];
    SHARED_KEYS
        .iter()
        .chain(if include_runtime {
            RUNTIME_KEYS.iter()
        } else {
            [].iter()
        })
        .filter_map(|key| {
            metadata
                .get(*key)
                .map(|value| ((*key).into(), value.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;

    #[test]
    fn shared_streams_strip_private_process_text_and_parameters() {
        for (kind, metadata) in [
            ("agent_chunk", json!({"private_prompt":"secret"})),
            ("agent_status", json!({"private_prompt":"secret"})),
            (
                "text",
                json!({"kind":"task_ai_subagent","private_prompt":"secret"}),
            ),
        ] {
            let original = json!({"type":kind,"content":"private tool output","metadata":metadata,
                "runtimeAddress":{"deviceId":"owner-device","taskId":"private-task"},"traceRef":"opaque"});
            let shared = shared_message_payload(&original);
            assert_eq!(shared["content"], "");
            assert!(shared["runtimeAddress"].is_null());
            assert_eq!(shared["traceState"], "restricted");
            assert!(shared["metadata"].get("private_prompt").is_none());
            assert_eq!(original["content"], "private tool output");
        }
        let published = shared_message_payload(
            &json!({"type":"text","content":"Public conclusion",
            "metadata":{"execution_dispatch":"comment_only","assistant_publication":{"verified":true}}}),
        );
        assert_eq!(published["content"], "Public conclusion");
    }

    fn row() -> MessageRow {
        MessageRow {
            id: 1,
            message_id: "message".into(),
            client_message_id: String::new(),
            project_id: "project".into(),
            task_id: "ISSUE-1".into(),
            sender_type: "agent".into(),
            sender_id: "assistant".into(),
            sender_name: "Assistant".into(),
            message_type: "text".into(),
            content: "Public summary".into(),
            metadata: Some(brz_mysql::Json(json!({
                "private_prompt":"secret",
                "summary":"Public summary",
                "mentions":[]
            }))),
            trigger_message_id: String::new(),
            reply_to_message_id: String::new(),
            thread_root_message_id: String::new(),
            agent_id: String::new(),
            runtime_device_id: "device".into(),
            runtime_task_id: "task".into(),
            status: "completed".into(),
            created_at: DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
            updated_at: DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
        }
    }

    #[test]
    fn another_member_receives_an_opaque_trace_without_runtime_parameters() {
        let mut view = message_view(&row());
        view["actorUserId"] = json!("7");
        apply_private_source_access(&mut view, &row(), 8, Some(7), false);
        assert_eq!(view["runtimeAddress"], Value::Null);
        assert_eq!(view["traceState"], "restricted");
        assert!(
            view["traceRef"]
                .as_str()
                .is_some_and(|value| value.len() == 64)
        );
        assert!(view["metadata"].get("private_prompt").is_none());
        assert_eq!(view["metadata"]["summary"], "Public summary");
    }

    #[test]
    fn tool_generated_sources_do_not_acquire_human_confirmation() {
        let mut source = row();
        source.sender_type = "user".into();
        source.runtime_device_id.clear();
        source.runtime_task_id.clear();
        source.metadata = Some(brz_mysql::Json(json!({"assistant_publication":{
            "verified":false,"source_verified":true,"published_by":"ai",
            "binding_id":"binding","device_id":"bound-device","task_id":"bound-task"
        }})));
        let mut owner = message_view(&source);
        apply_private_source_access(&mut owner, &source, 7, Some(7), false);
        assert_eq!(owner["generationSource"], "ai");
        assert_eq!(owner["publicationSource"], "ai");
        assert_eq!(owner["confirmationState"], "pending");
        assert_eq!(
            owner["runtimeAddress"],
            json!({"deviceId":"bound-device","taskId":"bound-task"})
        );
        let mut observer = message_view(&source);
        apply_private_source_access(&mut observer, &source, 8, Some(7), false);
        assert!(observer["runtimeAddress"].is_null());
        assert!(observer["metadata"].get("assistant_publication").is_none());
        assert_eq!(observer["confirmationState"], "pending");
    }

    #[test]
    fn stand_in_sources_are_owner_only_without_granting_publication() {
        let mut source = row();
        source.runtime_device_id.clear();
        source.runtime_task_id.clear();
        source.metadata = Some(brz_mysql::Json(json!({"stand_in": {
            "binding_id":"binding", "user_id":7, "device_id":"bound-device", "task_id":"bound-task"
        }})));
        let mut owner = message_view(&source);
        apply_private_source_access(&mut owner, &source, 7, Some(7), false);
        assert_eq!(
            owner["runtimeAddress"],
            json!({"deviceId":"bound-device","taskId":"bound-task"})
        );
        assert_eq!(owner["generationSource"], "ai");
        assert_eq!(owner["confirmationState"], "pending");
        let mut observer = message_view(&source);
        apply_private_source_access(&mut observer, &source, 8, Some(7), false);
        assert!(observer["runtimeAddress"].is_null());
        assert_eq!(observer["traceRef"], owner["traceRef"]);
        assert_eq!(observer["traceState"], "restricted");
        assert!(observer["metadata"].get("stand_in").is_none());
        source.metadata.as_mut().unwrap().0["stand_in"]["task_id"] = json!("");
        assert!(message_view(&source)["traceRef"].is_null());
    }

    #[test]
    fn verified_publications_resolve_complete_sources_without_mixing_pairs() {
        let mut published = row();
        published.sender_type = "user".into();
        published.runtime_device_id = "incomplete-column-device".into();
        published.runtime_task_id.clear();
        published.metadata = Some(brz_mysql::Json(json!({"assistant_publication": {
            "verified": true, "published_by": "human", "device_id": "bound-device", "task_id": "bound-task"
        }})));
        let mut view = message_view(&published);
        apply_private_source_access(&mut view, &published, 7, Some(7), false);
        assert_eq!(
            view["runtimeAddress"],
            json!({"deviceId":"bound-device","taskId":"bound-task"})
        );
        assert_eq!(view["confirmationState"], "authorized");
        assert!(view["traceRef"].is_string());
        let room = shared_message_payload(&view);
        assert!(room["runtimeAddress"].is_null());
        assert_eq!(room["traceState"], "restricted");
        published.metadata = Some(brz_mysql::Json(json!({"assistant_publication": {
            "verified": false, "published_by": "ai", "device_id": "forged-device", "task_id": "forged-task"
        }})));
        let forged = message_view(&published);
        assert!(forged["traceRef"].is_null());
        assert_eq!(forged["generationSource"], "human");
        assert_eq!(forged["publicationSource"], "human");
    }

    #[test]
    fn canonical_project_execution_retains_its_scoped_shared_source() {
        let mut view = message_view(&row());
        apply_private_source_access(&mut view, &row(), 8, Some(7), true);
        assert_eq!(view["runtimeAddress"]["taskId"], "task");
        assert_eq!(view["traceState"], "available");
        assert!(view["metadata"].get("private_prompt").is_none());
    }

    #[test]
    fn the_owner_can_resume_the_exact_runtime_task() {
        let mut view = message_view(&row());
        view["actorUserId"] = json!("7");
        apply_private_source_access(&mut view, &row(), 7, Some(7), false);
        assert_eq!(view["runtimeAddress"]["deviceId"], "device");
        assert_eq!(view["runtimeAddress"]["taskId"], "task");
        assert_eq!(view["traceState"], "available");
    }

    #[test]
    fn process_output_is_removed_from_another_members_shared_view() {
        let mut process = row();
        process.message_type = "agent_chunk".into();
        process.content = "private tool output".into();
        let mut view = message_view(&process);
        view["actorUserId"] = json!("7");
        apply_private_source_access(&mut view, &process, 8, Some(7), false);
        assert_eq!(view["content"], "");
    }

    #[test]
    fn runtime_address_follows_the_agent_owner_not_the_trigger_author() {
        let mut view = message_view(&row());
        view["actorUserId"] = json!("8");
        apply_private_source_access(&mut view, &row(), 8, Some(7), false);
        assert_eq!(view["runtimeAddress"], Value::Null);

        let mut owner_view = message_view(&row());
        owner_view["actorUserId"] = json!("8");
        apply_private_source_access(&mut owner_view, &row(), 7, Some(7), false);
        assert_eq!(owner_view["runtimeAddress"]["deviceId"], "device");
    }

    #[test]
    fn room_payload_never_reuses_the_requesters_private_view() {
        let mut owner_view = message_view(&row());
        owner_view["actorUserId"] = json!("7");
        owner_view["runtimeAddress"] = json!({"deviceId":"device","taskId":"task"});
        owner_view["traceRef"] = json!("trace");
        owner_view["traceState"] = json!("available");
        let shared = shared_message_payload(&owner_view);
        assert_eq!(shared["runtimeAddress"], Value::Null);
        assert_eq!(shared["traceState"], "restricted");
        assert!(shared["metadata"].get("private_prompt").is_none());
    }

    #[test]
    fn historical_import_uses_human_publication_with_unknown_audit_state() {
        let mut historical = row();
        historical.metadata = Some(brz_mysql::Json(json!({
            "history_import":true,
            "imported_from":"legacy"
        })));
        let view = message_view(&historical);
        assert_eq!(view["generationSource"], "human");
        assert_eq!(view["publicationSource"], "human");
        assert_eq!(view["confirmationState"], "unknown");
    }

    #[test]
    fn verified_private_source_marks_ai_generated_human_publication() {
        let mut published = row();
        published.sender_type = "user".into();
        published.sender_id = "7".into();
        published.metadata = Some(brz_mysql::Json(json!({
            "assistant_publication":{"verified":true,"binding_id":"binding"}
        })));
        let view = message_view(&published);
        assert_eq!(view["generationSource"], "ai");
        assert_eq!(view["publicationSource"], "human");
        assert_eq!(view["confirmationState"], "authorized");
    }

    #[test]
    fn verified_automatic_policy_marks_ai_generated_ai_publication() {
        let mut published = row();
        published.metadata = Some(brz_mysql::Json(json!({
            "assistant_publication":{"verified":true,"published_by":"ai"}
        })));
        let view = message_view(&published);
        assert_eq!(view["generationSource"], "ai");
        assert_eq!(view["publicationSource"], "ai");
        assert_eq!(view["confirmationState"], "not_required");
    }
}
