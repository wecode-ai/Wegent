// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `openapi/chat_session.py:102-170`: the guarded long-term-memory step.
//!
//! After `prepare_execution_session`'s commit and before the endpoint reloads
//! the request user/Team, the source builds the context messages
//! synchronously (`memory/utils.py`) and then schedules a fire-and-forget
//! `MemoryManager.save_user_message_async` (`:137-170`). `memory/utils.py:207-214`
//! touches each expired existing subtask's `status`/`role`, which is the
//! primary-key refresh per row performed here before the messages are built.
use std::time::Duration;

use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow};
use serde_json::{Value, json};

use crate::task_store::TaskStore;

/// `settings.MEMORY_CONTEXT_MESSAGES` (source default `3`).
fn context_limit() -> usize {
    crate::config::env_or_dotenv("MEMORY_CONTEXT_MESSAGES")
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(3)
}

/// `MemoryManager.is_enabled`: the deployment's `MEMORY_ENABLED` flag.
pub(super) fn enabled() -> bool {
    crate::users_features::memory_enabled()
}

/// `task_crd.spec.is_group_chat` from the Task snapshot the setup returned.
pub(super) fn is_group_chat(task_json: &Value) -> bool {
    task_json
        .get("spec")
        .and_then(|spec| spec.get("is_group_chat"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// `f"{workspaceRef.namespace}/{workspaceRef.name}"`, `None` without a ref
/// (`chat_session.py:118-124`).
pub(super) fn workspace_id(task_json: &Value) -> Option<String> {
    let reference = task_json.get("spec")?.get("workspaceRef")?;
    let namespace = reference.get("namespace")?.as_str()?;
    let name = reference.get("name")?.as_str()?;
    Some(format!("{namespace}/{name}"))
}

/// `chat_session.py:157-166`: the memory metadata's `project_id` is the raw
/// Task property rendered as a string when truthy, never the
/// `metadata.labels.projectId` selector fallback.
pub(super) fn metadata_project_id(raw_project_id: Option<i64>) -> Option<String> {
    raw_project_id
        .filter(|project_id| *project_id > 0)
        .map(|project_id| project_id.to_string())
}

/// The fire-and-forget save request (`MemoryManager.save_user_message_async`).
pub(crate) struct SaveRequest {
    pub messages: Vec<Value>,
    pub user_id: String,
    pub team_id: String,
    pub task_id: String,
    pub subtask_id: String,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub is_group_chat: bool,
}

/// One existing subtask read at the memory build's position.
#[derive(Debug)]
struct ContextRow {
    role: String,
    status: String,
    prompt: String,
    result_value: String,
    sender_user_id: i64,
}

/// One message selected for the context, with its group-chat sender name
/// resolved (`memory/utils.py:315-360`).
struct SelectedMessage {
    role: String,
    content: String,
    sender_user_id: i64,
    sender_name: Option<String>,
}

/// Build the memory context messages for the current turn.
///
/// `existing_subtasks` is the fork-history list the setup already resolved
/// (`message_id, created_at, id` ascending); the source re-reads each row
/// through its expired ORM attributes, which is the primary-key refresh this
/// loop performs.
#[allow(clippy::too_many_arguments)]
pub(super) async fn build_context_messages<M: Mysql>(
    mysql: &M,
    task_store: &dyn TaskStore,
    task_id: i64,
    existing_subtasks: &[MysqlRow],
    current_message: &str,
    current_user_id: i64,
    current_user_name: &str,
    is_group_chat: bool,
) -> MysqlResult<Vec<Value>> {
    let mut rows = Vec::with_capacity(existing_subtasks.len());
    for existing in existing_subtasks {
        let Some(id) = existing.get_at::<Option<i64>>(0)? else {
            continue;
        };
        let Some(row) = task_store.refresh_subtask(task_id, id).await? else {
            continue;
        };
        rows.push(context_row(&row)?);
    }
    let mut messages = select_history(&rows, context_limit());
    if is_group_chat {
        resolve_sender_names(mysql, &mut messages).await?;
    }
    Ok(render_messages(
        &messages,
        current_message,
        current_user_id,
        current_user_name,
        is_group_chat,
    ))
}

fn context_row(row: &MysqlRow) -> MysqlResult<ContextRow> {
    let result = row.get::<Json<Value>>("result")?;
    Ok(ContextRow {
        role: row.get::<String>("role")?.unwrap_or_default(),
        status: row.get::<String>("status")?.unwrap_or_default(),
        prompt: row.get::<String>("prompt")?.unwrap_or_default(),
        result_value: result
            .and_then(|result| {
                result
                    .0
                    .get("value")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default(),
        sender_user_id: row.get::<i64>("sender_user_id")?.unwrap_or_default(),
    })
}

/// `memory.utils.build_context_messages`'s selection: only completed
/// USER/ASSISTANT rows, the first `context_limit - 1` of them in list order,
/// with empty content skipped.
fn select_history(rows: &[ContextRow], context_limit: usize) -> Vec<SelectedMessage> {
    let completed: Vec<&ContextRow> = rows
        .iter()
        .filter(|row| row.status == "COMPLETED" && (row.role == "USER" || row.role == "ASSISTANT"))
        .collect();
    let history_count = context_limit.saturating_sub(1).min(completed.len());
    let mut messages = Vec::with_capacity(history_count);
    for row in completed.into_iter().take(history_count) {
        let content = if row.role == "USER" {
            row.prompt.clone()
        } else {
            row.result_value.clone()
        };
        if content.is_empty() {
            continue;
        }
        messages.push(SelectedMessage {
            role: row.role.clone(),
            content,
            sender_user_id: row.sender_user_id,
            sender_name: None,
        });
    }
    messages
}

/// `_format_message_content`'s group-chat sender lookup
/// (`db.query(User).filter(User.id == sender_user_id).first()`): one users read
/// per USER history message; a miss renders `User{id}`.
async fn resolve_sender_names<M: Mysql>(
    mysql: &M,
    messages: &mut [SelectedMessage],
) -> MysqlResult<()> {
    for message in messages.iter_mut().filter(|message| message.role == "USER") {
        let user =
            crate::teams::team_union_lookups::user_by_id(mysql, message.sender_user_id).await?;
        message.sender_name = Some(match user.map(|user| user.users_user_name) {
            Some(name) if !name.is_empty() => name,
            _ => format!("User{}", message.sender_user_id),
        });
    }
    Ok(())
}

/// `build_context_messages`'s message assembly, reversed to chronological
/// order and followed by the current user message.
fn render_messages(
    messages: &[SelectedMessage],
    current_message: &str,
    current_user_id: i64,
    current_user_name: &str,
    is_group_chat: bool,
) -> Vec<Value> {
    let mut rendered: Vec<Value> = messages
        .iter()
        .map(|message| {
            let role = if is_group_chat
                && !(message.role == "USER" && message.sender_user_id == current_user_id)
            {
                "assistant"
            } else if message.role == "USER" {
                "user"
            } else {
                "assistant"
            };
            let content = if is_group_chat {
                format_group_content(message)
            } else {
                message.content.clone()
            };
            json!({"role": role, "content": content})
        })
        .collect();
    rendered.reverse();

    let current_marker = format!("User[{current_user_name}]: ");
    let current = if is_group_chat && !current_message.starts_with(&current_marker) {
        format!("{current_marker}{current_message}")
    } else {
        current_message.to_string()
    };
    rendered.push(json!({"role": "user", "content": current}));
    rendered
}

/// `_format_message_content`: USER messages gain `User[{name}]: ` and
/// ASSISTANT messages `AI: `; an already prefixed text is kept.
fn format_group_content(message: &SelectedMessage) -> String {
    if message.role == "USER" {
        let prefix = format!(
            "User[{}]: ",
            message.sender_name.as_deref().unwrap_or_default()
        );
        if message.content.starts_with(&prefix) {
            message.content.clone()
        } else {
            format!("{prefix}{}", message.content)
        }
    } else if message.content.starts_with("AI: ") {
        message.content.clone()
    } else {
        format!("AI: {}", message.content)
    }
}

/// `MemoryManager.save_user_message_async`: the fire-and-forget mem0 write.
///
/// The source schedules this as a background task and logs every transport or
/// HTTP failure; a failed save never changes the create response. The body is
/// `MemoryCreateRequest.model_dump(exclude_none=True)` with the prefixed user
/// id and `MemoryMetadata.model_dump()` (`task_id`, `subtask_id`, `team_id`,
/// `workspace_id`, `project_id`, `is_group_chat`).
/// `MemoryManager.save_user_message_async`'s transport: the startup-owned
/// responses supervisor runs this fire-and-forget, and every transport or HTTP
/// failure is logged without changing the create response. The body is
/// `MemoryCreateRequest.model_dump(exclude_none=True)` with the prefixed user
/// id and `MemoryMetadata.model_dump()` (`task_id`, `subtask_id`, `team_id`,
/// `workspace_id`, `project_id`, `is_group_chat`).
pub(crate) async fn post_save(http: &brz_http::Client, save: SaveRequest) {
    let api_key = crate::config::env_or_dotenv("MEMORY_API_KEY").unwrap_or_default();
    let prefix = crate::config::env_or_dotenv("MEMORY_USER_ID_PREFIX")
        .unwrap_or_else(|| "wegent_user:".to_string());
    let page = json!({
        "messages": save.messages,
        "user_id": format!("{prefix}{}", save.user_id),
        "metadata": {
            "task_id": save.task_id,
            "subtask_id": save.subtask_id,
            "team_id": save.team_id,
            "workspace_id": save.workspace_id,
            "project_id": save.project_id,
            "is_group_chat": save.is_group_chat,
        },
    });
    let url = format!("{}/memories", memory_base_url());
    let mut request = match http.post(url.as_str()) {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(%error, "failed to store memory (endpoint)");
            return;
        }
    };
    request = request
        .header("Content-Type", "application/json")
        .timeout(write_timeout());
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }
    match request.json(&page).send().await {
        // `client.py`: only HTTP 200 counts as success.
        Ok(response) if response.status().as_u16() == 200 => {
            tracing::info!("stored memory for user {}", save.user_id);
        }
        Ok(response) => {
            tracing::error!(
                status = %response.status(),
                "failed to store memory for user {}",
                save.user_id
            );
        }
        Err(error) => {
            tracing::warn!(%error, "failed to store memory for user {}", save.user_id);
        }
    }
}

/// `settings.MEMORY_BASE_URL` without its trailing slash (source default
/// `http://localhost:8080`, so an enabled deployment still attempts the save).
fn memory_base_url() -> String {
    crate::config::env_or_dotenv("MEMORY_BASE_URL")
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| "http://localhost:8080".to_string())
}

/// `settings.MEMORY_WRITE_TIMEOUT_SECONDS` (default `10`).
fn write_timeout() -> Duration {
    let seconds = crate::config::env_or_dotenv("MEMORY_WRITE_TIMEOUT_SECONDS")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .unwrap_or(10.0);
    Duration::from_secs_f64(seconds.max(0.001))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(role: &str, status: &str, prompt: &str, value: &str, sender: i64) -> ContextRow {
        ContextRow {
            role: role.to_string(),
            status: status.to_string(),
            prompt: prompt.to_string(),
            result_value: value.to_string(),
            sender_user_id: sender,
        }
    }

    fn with_names(messages: &mut [SelectedMessage], names: &[&str]) {
        for (message, name) in messages.iter_mut().zip(names) {
            message.sender_name = Some((*name).to_string());
        }
    }

    #[test]
    fn completed_history_is_taken_from_the_front_then_reversed() {
        let rows = vec![
            row("USER", "COMPLETED", "first", "", 6498),
            row("ASSISTANT", "COMPLETED", "", "second", 0),
            row("USER", "PENDING", "ignored", "", 6498),
        ];
        let messages = select_history(&rows, 3);
        assert_eq!(
            render_messages(&messages, "current", 6498, "示例用户", false),
            vec![
                json!({"role": "assistant", "content": "second"}),
                json!({"role": "user", "content": "first"}),
                json!({"role": "user", "content": "current"}),
            ]
        );
    }

    #[test]
    fn empty_content_is_skipped_and_context_limit_caps_the_history() {
        let rows = vec![
            row("USER", "COMPLETED", "", "", 6498),
            row("USER", "COMPLETED", "one", "", 6498),
            row("ASSISTANT", "COMPLETED", "", "two", 0),
            row("USER", "COMPLETED", "three", "", 6498),
            row("ASSISTANT", "RUNNING", "", "running", 0),
        ];
        // `context_limit = 2` keeps the first completed row only, which has
        // empty content and is skipped, like the source's `continue`.
        let messages = select_history(&rows, 2);
        assert!(messages.is_empty());
        let rendered = render_messages(&messages, "current", 6498, "示例用户", false);
        assert_eq!(
            rendered,
            vec![json!({"role": "user", "content": "current"})]
        );
        // A wider limit takes the next completed rows in list order.
        let messages = select_history(&rows, 4);
        let contents: Vec<&str> = messages.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(contents, ["one", "two"]);
    }

    #[test]
    fn group_chat_prefixes_and_roles_follow_the_sender() {
        let rows = vec![
            row("USER", "COMPLETED", "hello", "", 7),
            row("ASSISTANT", "COMPLETED", "", "answer", 0),
            row("USER", "COMPLETED", "mine", "", 6498),
        ];
        let mut messages = select_history(&rows, 4);
        with_names(&mut messages, &["Alice", "", "示例用户"]);
        let rendered = render_messages(&messages, "current", 6498, "示例用户", true);
        assert_eq!(
            rendered,
            vec![
                json!({"role": "user", "content": "User[示例用户]: mine"}),
                json!({"role": "assistant", "content": "AI: answer"}),
                json!({"role": "assistant", "content": "User[Alice]: hello"}),
                json!({"role": "user", "content": "User[示例用户]: current"}),
            ]
        );
    }

    #[test]
    fn workspace_id_renders_namespace_and_name() {
        let task =
            json!({"spec": {"workspaceRef": {"namespace": "default", "name": "workspace-1"}}});
        assert_eq!(workspace_id(&task), Some("default/workspace-1".to_string()));
        assert_eq!(workspace_id(&json!({"spec": {}})), None);
    }

    #[test]
    fn metadata_project_id_ignores_the_label_selector() {
        // A resumed Task whose physical column is 0/NULL but whose
        // `metadata.labels.projectId` is set: `_merge_project_workspace` uses
        // the label, while the memory metadata sends null.
        assert_eq!(metadata_project_id(None), None);
        assert_eq!(metadata_project_id(Some(0)), None);
        assert_eq!(metadata_project_id(Some(2584)), Some("2584".to_string()));
        let labelled = json!({"metadata": {"labels": {"projectId": "2584"}}});
        assert_eq!(
            crate::responses::create::session::resumed_project_id(Some(0), &labelled),
            2584
        );
    }

    #[test]
    fn group_flag_reads_the_crd() {
        assert!(is_group_chat(&json!({"spec": {"is_group_chat": true}})));
        assert!(!is_group_chat(&json!({"spec": {}})));
    }
}
