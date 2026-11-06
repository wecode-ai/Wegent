// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Atomic automatic pipeline advancement, shared by single-table and sharded stores.
use brz_mysql::{FromMysqlCol, Json, MysqlResult, MysqlRow, MysqlService, MysqlTransaction};
use serde_json::{Value, json};

use crate::internal_callback::completion::task_column;
use crate::json_compat::python_json_value;
use crate::responses::create::resolution::{KIND_COLUMNS, KindRow};
use crate::responses::create::session::{next_message_ids, subtask_rows};
use crate::task_store::SubtaskPairInsert;
use crate::task_store_executor_reference::{
    assistant_row_with_executor, consume_executor_reference, insert_subtask_row,
    inserted_subtask_timestamps_statement, resolve_executor_reference,
    task_for_update_first_statement,
};
use crate::task_store_statements::{subtask_projection, update_task_json_statement};

/// `advance_pipeline_stage_from_auto_completion` loads the request `User` row
/// before `trigger_ai_response_unified`. `user_name` names the request user and
/// `preferences` carries the user-managed provider configuration
/// `_build_skill_data` reads.
pub(crate) const USER_FOR_PIPELINE: &str =
    "SELECT users.user_name, users.preferences FROM users WHERE users.id = ?";

/// Committed next turn; executor dispatch happens after the transaction closes.
pub struct PipelineStageAdvance {
    pub task_id: i64,
    pub user_id: i64,
    pub user_name: String,
    /// The committed turn's `users.preferences`; the source loads the whole
    /// `User` row before `trigger_ai_response_unified` passes it down, and
    /// `_build_skill_data` reads its user-managed provider configuration.
    pub user_preferences: String,
    pub message_id: i64,
    pub message: String,
    pub task_json: Value,
    pub project_id: i64,
    pub pair: SubtaskPairInsert,
    pub previous_bot_id: i64,
    pub(crate) team: KindRow,
    pub(crate) bot: KindRow,
    pub(crate) member: Value,
}

/// The store supplies routed tables and allocated IDs; only the public store
/// uses database-assigned IDs. No transaction is held across dispatch or HTTP.
pub async fn advance_pipeline_stage(
    mysql: &MysqlService,
    tasks_table: &str,
    subtasks_table: &str,
    task_id: i64,
    completed_subtask_id: i64,
    assigned_subtask_ids: Option<(i64, i64)>,
) -> MysqlResult<Option<PipelineStageAdvance>> {
    mysql
        .with_transaction(async |transaction| {
            advance_on(
                transaction,
                tasks_table,
                subtasks_table,
                task_id,
                completed_subtask_id,
                assigned_subtask_ids,
            )
            .await
        })
        .await
}

fn subtask_column<T: FromMysqlCol>(row: &MysqlRow, name: &str) -> Option<T> {
    row.get_at::<Option<T>>(crate::task_store::subtask_column_index(name)?)
        .ok()
        .flatten()
}

async fn advance_on<T: MysqlTransaction>(
    transaction: &mut T,
    tasks: &str,
    subtasks: &str,
    task_id: i64,
    completed_id: i64,
    assigned_ids: Option<(i64, i64)>,
) -> MysqlResult<Option<PipelineStageAdvance>> {
    let task: Option<MysqlRow> = transaction
        .fetch_optional(task_for_update_first_statement(tasks), (task_id,))
        .await?;
    let Some(task) = task else { return Ok(None) };
    if task_column::<i64>(&task, "is_active") != Some(1)
        || task_column::<String>(&task, "kind").as_deref() != Some("Task")
        || task_column::<String>(&task, "namespace").as_deref() == Some("system")
    {
        return Ok(None);
    }
    let Some(Json(mut task_json)) = task_column::<Json<Value>>(&task, "json") else {
        return Ok(None);
    };
    let user_id = task_column::<i64>(&task, "user_id").unwrap_or_default();
    let user: Option<MysqlRow> = transaction
        .fetch_optional(USER_FOR_PIPELINE, (user_id,))
        .await?;
    let Some(user) = user else {
        return Ok(None);
    };
    let Some(user_name) = user.get_at::<Option<String>>(0).ok().flatten() else {
        return Ok(None);
    };
    let user_preferences = user
        .get_at::<Option<String>>(1)
        .ok()
        .flatten()
        .unwrap_or_default();
    let completed: Option<MysqlRow> = transaction
        .fetch_optional(
            format!(
                "SELECT {} FROM {subtasks} WHERE {subtasks}.id = ? AND {subtasks}.task_id = ?",
                subtask_projection(subtasks)
            ),
            (completed_id, task_id),
        )
        .await?;
    let Some(completed) = completed else {
        return Ok(None);
    };
    if subtask_column::<String>(&completed, "status").as_deref() != Some("COMPLETED")
        || subtask_column::<String>(&completed, "role").as_deref() != Some("ASSISTANT")
    {
        return Ok(None);
    }
    // The Task row lock serializes pair insertion. A replayed completion must
    // never advance again once a newer assistant has been appended, even when
    // adjacent stages reference the same Bot.
    let latest: Option<i64> = transaction.fetch_optional(
        format!("SELECT {subtasks}.id FROM {subtasks} WHERE {subtasks}.task_id = ? AND {subtasks}.`role` = 'ASSISTANT' ORDER BY {subtasks}.message_id DESC, {subtasks}.id DESC LIMIT 1"),
        (task_id,)).await?;
    if !is_current_completion(completed_id, latest) {
        return Ok(None);
    }
    let Some(previous_bot_id) = subtask_column::<Json<Value>>(&completed, "bot_ids")
        .and_then(|ids| ids.0.as_array()?.first()?.as_i64())
    else {
        return Ok(None);
    };
    let Some(team) = load_team(transaction, &task_json).await? else {
        return Ok(None);
    };
    let previous_bot: Option<KindRow> = transaction.fetch_optional(
        format!("SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.id = ? AND kinds.kind = 'Bot' AND kinds.is_active = true LIMIT 1"),
        (previous_bot_id,)).await?;
    let Some(previous_bot) = previous_bot else {
        return Ok(None);
    };
    let Some(stage) = automatic_next_stage(
        &task_json,
        &team.json.0,
        &previous_bot.name,
        &previous_bot.namespace,
    ) else {
        return Ok(None);
    };
    let members = team
        .json
        .0
        .pointer("/spec/members")
        .and_then(Value::as_array)
        .expect("validated members");
    let member = members[stage].clone();
    let Some(bot) = load_member_bot(transaction, team.user_id, &member).await? else {
        return Ok(None);
    };
    let before = subtask_column::<i64>(&completed, "message_id").unwrap_or_default();
    let first_prompt: Option<String> = transaction.fetch_optional(
        format!("SELECT {subtasks}.prompt FROM {subtasks} WHERE {subtasks}.task_id = ? AND {subtasks}.`role` = 'USER' AND {subtasks}.message_id < ? ORDER BY {subtasks}.message_id ASC, {subtasks}.id ASC LIMIT 1"),
        (task_id, before)).await?;
    let result = subtask_column::<Json<Value>>(&completed, "result")
        .map(|json| json.0)
        .unwrap_or(Value::Null);
    let context_mode = members[stage - 1]
        .get("contextPassing")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let original =
        crate::task_detail_api::assembly::extract_display_prompt(first_prompt.as_deref())
            .unwrap_or_default();
    let message = handoff_message(context_mode, &original, &result);
    let executor = resolve_executor_reference(transaction, tasks, subtasks, task_id).await?;
    if let Some(stripped) = consume_executor_reference(&task_json).stripped_json {
        task_json = stripped;
    }
    let now = chrono::Local::now().naive_local();
    task_json["spec"]["currentStage"] = json!(stage);
    task_json["status"]["status"] = json!("PENDING");
    task_json["status"]["progress"] = json!(0);
    task_json["status"]["updatedAt"] = json!(now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string());
    task_json["status"]["completedAt"] = Value::Null;
    transaction
        .execute(
            update_task_json_statement(tasks),
            (
                python_json_value(&task_json),
                now.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
                task_id,
            ),
        )
        .await?;
    let maximum: Option<i64> = transaction.fetch_optional(
        format!("SELECT COALESCE(MAX({subtasks}.message_id), 0) FROM {subtasks} WHERE {subtasks}.task_id = ?"), (task_id,)).await?;
    let ids = next_message_ids(maximum);
    let bot_ids = python_json_value(&json!([bot.id]));
    let completed_at = now.format("%Y-%m-%d %H:%M:%S%.6f").to_string();
    let (mut user, mut assistant) = subtask_rows(
        user_id,
        task_id,
        team.id,
        &bot_ids,
        &message,
        &completed_at,
        ids,
    );
    if let Some((user_id, assistant_id)) = assigned_ids {
        user.id = user_id;
        assistant.id = assistant_id;
    }
    let assistant = assistant_row_with_executor(&assistant, &executor);
    let user_subtask_id =
        insert_subtask_row(transaction, subtasks, assigned_ids.is_some(), &user).await?;
    let assistant_subtask_id =
        insert_subtask_row(transaction, subtasks, assigned_ids.is_some(), &assistant).await?;
    let timestamps: Option<MysqlRow> = transaction
        .fetch_optional(
            inserted_subtask_timestamps_statement(subtasks),
            (assistant_subtask_id,),
        )
        .await?;
    let assistant_created_at = timestamps.and_then(|row| {
        row.get_at::<Option<chrono::NaiveDateTime>>(0)
            .ok()
            .flatten()
    });
    Ok(Some(PipelineStageAdvance {
        task_id,
        user_id,
        user_name,
        user_preferences,
        message_id: ids.next_message_id,
        message,
        task_json,
        project_id: task_column::<i64>(&task, "project_id").unwrap_or_default(),
        pair: SubtaskPairInsert {
            user_subtask_id,
            assistant_subtask_id,
            executor,
            assistant_created_at,
        },
        previous_bot_id,
        team,
        bot,
        member,
    }))
}

async fn load_team<T: MysqlTransaction>(
    transaction: &mut T,
    task: &Value,
) -> MysqlResult<Option<KindRow>> {
    let Some(reference) = task.pointer("/spec/teamRef") else {
        return Ok(None);
    };
    let (Some(owner), Some(name)) = (
        reference.get("user_id").and_then(Value::as_i64),
        reference.get("name").and_then(Value::as_str),
    ) else {
        return Ok(None);
    };
    let namespace = reference
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    transaction
        .fetch_optional(
            crate::responses::create::resolution::team_by_owner_statement(),
            (owner, namespace, name),
        )
        .await
}

async fn load_member_bot<T: MysqlTransaction>(
    transaction: &mut T,
    owner: i64,
    member: &Value,
) -> MysqlResult<Option<KindRow>> {
    let name = member
        .pointer("/botRef/name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let namespace = member
        .pointer("/botRef/namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");
    transaction.fetch_optional(format!("SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.namespace = ? AND kinds.name = ? AND kinds.kind = 'Bot' AND kinds.is_active = true LIMIT 1"), (owner, namespace, name)).await
}

fn automatic_next_stage(
    task: &Value,
    team: &Value,
    bot_name: &str,
    namespace: &str,
) -> Option<usize> {
    if team
        .pointer("/spec/collaborationModel")
        .and_then(Value::as_str)
        != Some("pipeline")
    {
        return None;
    }
    let stage = match task.pointer("/spec/currentStage") {
        None | Some(Value::Null) => 0,
        Some(value) => usize::try_from(value.as_u64()?).ok()?,
    };
    let members = team.pointer("/spec/members")?.as_array()?;
    let current = members.get(stage)?;
    let bot_stage = members.iter().position(|member| {
        member.pointer("/botRef/name").and_then(Value::as_str) == Some(bot_name)
            && member
                .pointer("/botRef/namespace")
                .and_then(Value::as_str)
                .unwrap_or("default")
                == namespace
    })?;
    if bot_stage != stage
        || current
            .get("requireConfirmation")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || stage + 1 >= members.len()
    {
        return None;
    }
    Some(stage + 1)
}

fn handoff_message(mode: &str, original: &str, result: &Value) -> String {
    let mut parts = Vec::new();
    if matches!(mode, "original_user" | "original_and_previous") && !original.trim().is_empty() {
        parts.push(format!("Original user request:\n{}", original.trim()));
    }
    if matches!(mode, "previous_bot" | "original_and_previous") {
        let previous = previous_output(result);
        if !previous.is_empty() {
            parts.push(format!("Previous stage output:\n{previous}"));
        }
    }
    parts.join("\n\n")
}

fn previous_output(result: &Value) -> String {
    if let Some(value) = result
        .get("value")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return value.trim().to_owned();
    }
    result
        .get("messages_chain")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .find_map(|message| {
            let content = message.get("content")?;
            let text = match content {
                Value::String(text) => text.trim().to_owned(),
                Value::Array(blocks) => blocks
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            (!text.is_empty()).then_some(text)
        })
        .unwrap_or_default()
}

fn is_current_completion(completed_id: i64, latest_assistant_id: Option<i64>) -> bool {
    latest_assistant_id == Some(completed_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::mysql_pool_server;

    /// `advance_pipeline_stage_from_auto_completion` loads the same `User` row
    /// before dispatching the next turn; `_build_skill_data` reads
    /// `user.preferences` for its user-managed provider branch, so the
    /// pipeline request must not lose the stored document.
    #[test]
    fn pipeline_user_read_carries_the_preferences_document() {
        assert_eq!(
            USER_FOR_PIPELINE,
            "SELECT users.user_name, users.preferences FROM users WHERE users.id = ?"
        );
    }

    #[tokio::test]
    async fn pipeline_advance_starts_with_the_writer_transaction_task_lock() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mysql = crate::connect_mysql(&format!(
                "mysql://test:test@{}/test?ssl-mode=disabled",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(mysql_pool_server::capture_queries_until(listener, stopped));
            let result = advance_pipeline_stage(&mysql, "tasks", "subtasks", 25, 42, None).await;
            assert!(result.is_err());
            stop.send(()).unwrap();
            let queries = server.await.unwrap();
            assert_eq!(queries.len(), 1);
            assert_eq!(queries[0], task_for_update_first_statement("tasks"));
            mysql.close().await;
        })
        .await
        .expect("writer task lock should be the first prepared statement");
    }

    fn team() -> Value {
        json!({"spec":{"collaborationModel":"pipeline","members":[
            {"botRef":{"name":"first","namespace":"default"},"requireConfirmation":false},
            {"botRef":{"name":"second","namespace":"default"},"requireConfirmation":false}
        ]}})
    }

    #[test]
    fn automatic_stage_requires_current_nonfinal_bot_without_confirmation() {
        let task = json!({"spec":{"currentStage":0}});
        assert_eq!(
            automatic_next_stage(&task, &team(), "first", "default"),
            Some(1)
        );
        assert_eq!(
            automatic_next_stage(&task, &team(), "second", "default"),
            None
        );
        assert_eq!(automatic_next_stage(&task, &team(), "first", "other"), None);
        assert_eq!(
            automatic_next_stage(
                &json!({"spec":{"currentStage":1}}),
                &team(),
                "second",
                "default"
            ),
            None
        );
        let mut manual = team();
        manual["spec"]["members"][0]["requireConfirmation"] = json!(true);
        assert_eq!(
            automatic_next_stage(&task, &manual, "first", "default"),
            None
        );
    }

    #[test]
    fn duplicate_completion_cannot_advance_adjacent_stages_with_the_same_bot() {
        let mut repeated = team();
        repeated["spec"]["members"][1]["botRef"]["name"] = json!("first");
        assert!(is_current_completion(42, Some(42)));
        assert!(!is_current_completion(42, Some(44)));
        assert!(!is_current_completion(42, None));
        assert_eq!(
            automatic_next_stage(
                &json!({"spec":{"currentStage":1}}),
                &repeated,
                "first",
                "default"
            ),
            None
        );
    }

    #[test]
    fn handoff_keeps_configured_original_request_and_previous_output() {
        let result = json!({"value":" first output "});
        assert_eq!(
            handoff_message("original_and_previous", " original request ", &result),
            "Original user request:\noriginal request\n\nPrevious stage output:\nfirst output"
        );
        assert_eq!(
            handoff_message("previous_bot", "ignored", &result),
            "Previous stage output:\nfirst output"
        );
        assert_eq!(
            handoff_message("original_user", "request", &result),
            "Original user request:\nrequest"
        );
        assert_eq!(handoff_message("none", "request", &result), "");
        assert_eq!(handoff_message("unknown", "request", &result), "");
    }

    #[test]
    fn missing_output_uses_latest_assistant_text_chain() {
        let result = json!({"value":" ","messages_chain":[
            {"role":"assistant","content":"old"},
            {"role":"user","content":"ignore"},
            {"role":"assistant","content":[{"type":"text","text":" final "},{"type":"text","text":"answer"}]}
        ]});
        assert_eq!(previous_output(&result), "final\nanswer");
    }
}
