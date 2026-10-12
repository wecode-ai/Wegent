// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed row structs and repositories for the internal chat history API.
//!
//! Mirrors the SQLAlchemy ORM queries behind `task_store.get_by_id`,
//! `ShardedSubtaskStore.list_by_task_ordered` (owner guard + `_attach_contexts`)
//! and the per-user-subtask context load in
//! `app/api/endpoints/internal/chat_storage.py:_build_user_message_content`.
//!
//! The task and subtask reads come from the injected `TaskStore`, which owns
//! the physical table choice: a new-format id carries its own shard, a legacy
//! id resolves its owner through the base `tasks` index before the read is
//! routed, and the store runs the guard and context load the source attaches
//! on that path. The `subtask_contexts` reads below carry no table choice and
//! stay on this module's handle.
//!
//! The source SQLAlchemy session renders every one of these reads as one text
//! `COM_QUERY` with the full mapped-column projection labeled
//! `{table}_{column}` and scalar filters inlined as literals; the target
//! reproduces those exact renderings so the recorded dependency stream matches.
use brz_mysql::{Json, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;
use serde::Deserialize;
use serde_json::Value;

/// `tasks_{:04}` row (`TaskResource`); the history flow consumes the owner and
/// the JSON payload.
#[derive(Debug)]
pub struct TaskRow {
    pub id: i64,
    pub user_id: i32,
    pub json: Option<Json<Value>>,
}

/// `subtasks_{:04}` row (`Subtask`); `role`/`status` are stored as strings
/// because MySQL ENUM decoding through JSON-recorded values is textual.
#[derive(Debug, Clone)]
pub struct SubtaskRow {
    pub id: i64,
    #[allow(dead_code)]
    pub user_id: i32,
    pub task_id: i64,
    pub role: String,
    pub prompt: Option<String>,
    pub message_id: i32,
    pub status: String,
    pub result: Option<Json<Value>>,
    pub created_at: Option<NaiveDateTime>,
    #[allow(dead_code)]
    pub sender_user_id: i32,
}

/// `subtask_contexts` row (`SubtaskContext`).
#[derive(Debug, Clone)]
pub struct SubtaskContextRow {
    pub id: i32,
    #[allow(dead_code)]
    pub subtask_id: i64,
    #[allow(dead_code)]
    pub user_id: i32,
    pub context_type: String,
    pub name: String,
    #[allow(dead_code)]
    pub status: String,
    pub image_base64: Option<String>,
    pub extracted_text: Option<String>,
    pub type_data: Option<Json<Value>>,
    #[allow(dead_code)]
    pub created_at: Option<NaiveDateTime>,
}

impl SubtaskContextRow {
    /// `type_data` as a JSON object (source columns default to `dict`).
    fn type_data_map(&self) -> &serde_json::Map<String, Value> {
        static EMPTY: std::sync::LazyLock<serde_json::Map<String, Value>> =
            std::sync::LazyLock::new(serde_json::Map::new);
        self.type_data
            .as_ref()
            .and_then(|json| json.0.as_object())
            .unwrap_or(&EMPTY)
    }

    /// `original_filename` property: `type_data.original_filename` else `name`.
    pub fn original_filename(&self) -> String {
        self.type_data_map()
            .get("original_filename")
            .and_then(Value::as_str)
            .unwrap_or(&self.name)
            .to_string()
    }

    /// `file_extension` property.
    pub fn file_extension(&self) -> String {
        self.type_data_map()
            .get("file_extension")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    /// `file_size` property.
    pub fn file_size(&self) -> i64 {
        self.type_data_map()
            .get("file_size")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    }

    /// `mime_type` property.
    pub fn mime_type(&self) -> String {
        self.type_data_map()
            .get("mime_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    /// `is_truncated` property: whether `extracted_text` was truncated during
    /// parsing (recorded from the parser's truncation result at parse time).
    pub fn is_truncated(&self) -> bool {
        let Some(type_data) = self.type_data.as_ref() else {
            return false;
        };
        type_data
            .0
            .get("is_truncated")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    }

    /// `knowledge_id` property.
    pub fn knowledge_id(&self) -> String {
        self.type_data_map()
            .get("knowledge_id")
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "unknown".to_string())
    }

    /// Whether the KB context should be suppressed for restricted mode
    /// (`_is_restricted_kb_context`).
    pub fn is_restricted_kb_context(&self) -> bool {
        let type_data = self.type_data_map();
        let restricted = |map: &serde_json::Map<String, Value>| {
            map.get("restricted_mode")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        let rag_restricted = type_data
            .get("rag_result")
            .and_then(Value::as_object)
            .is_some_and(restricted);
        rag_restricted || restricted(type_data)
    }
}

impl SubtaskContextRow {
    /// `name` rendered as `context.name or ""` (an empty string stays empty).
    pub fn name_or_empty(&self) -> &str {
        &self.name
    }
}

fn decode_task_row(row: &MysqlRow) -> MysqlResult<TaskRow> {
    Ok(TaskRow {
        id: row.get_required("id")?,
        user_id: row.get_required("user_id")?,
        json: row.get("json")?,
    })
}

fn decode_subtask_row(row: &MysqlRow) -> MysqlResult<SubtaskRow> {
    Ok(SubtaskRow {
        id: row.get_required("id")?,
        user_id: row.get_required("user_id")?,
        task_id: row.get_required("task_id")?,
        role: row.get_required("role")?,
        prompt: row.get("prompt")?,
        message_id: row.get_required("message_id")?,
        status: row.get_required("status")?,
        result: row.get("result")?,
        created_at: row.get("created_at")?,
        sender_user_id: row.get_required("sender_user_id")?,
    })
}

/// Decode one `subtask_contexts` row (`SubtaskContextRow`) from the labeled
/// projection; public for the attachment-text endpoint's ready-attachment
/// lookup, which shares the projection.
pub fn decode_context_row_pub(row: &MysqlRow) -> MysqlResult<SubtaskContextRow> {
    decode_context_row(row)
}

fn decode_context_row(row: &MysqlRow) -> MysqlResult<SubtaskContextRow> {
    Ok(SubtaskContextRow {
        id: row.get_required("subtask_contexts_id")?,
        subtask_id: row.get_required("subtask_contexts_subtask_id")?,
        user_id: row.get_required("subtask_contexts_user_id")?,
        context_type: row.get_required("subtask_contexts_context_type")?,
        name: row.get_required("subtask_contexts_name")?,
        status: row.get_required("subtask_contexts_status")?,
        image_base64: row.get("subtask_contexts_image_base64")?,
        extracted_text: row.get("subtask_contexts_extracted_text")?,
        type_data: row.get("subtask_contexts_type_data")?,
        created_at: row.get("subtask_contexts_created_at")?,
    })
}

/// Task-sharded MySQL readers for the chat history read path.
///
/// The task and subtask rows come from the injected `TaskStore`, which owns the
/// table choice for every one of them; the `subtask_contexts` reads carry no
/// table choice and stay on this handle.
pub struct ChatHistoryRepository<'a> {
    mysql: &'a brz_mysql::MysqlService,
    task_store: &'a dyn crate::task_store::TaskStore,
}

impl<'a> ChatHistoryRepository<'a> {
    pub fn new(
        mysql: &'a brz_mysql::MysqlService,
        task_store: &'a dyn crate::task_store::TaskStore,
    ) -> Self {
        Self { mysql, task_store }
    }

    /// The underlying MySQL handle (shared with this API's readers).
    pub fn mysql_ref(&self) -> &'a brz_mysql::MysqlService {
        self.mysql
    }

    /// `task_store.get_by_id(db, task_id=task_id)` without an owner filter.
    pub async fn get_task_by_id(&self, task_id: i64) -> MysqlResult<Option<TaskRow>> {
        let row = self.task_store.get_task(task_id).await?;
        row.as_ref().map(decode_task_row).transpose()
    }

    /// `task_store.get_by_id(db, task_id=task_id, owner_user_id=owner_user_id)`
    /// (`TaskForkHistoryResolver._lineage_task` at depth 0).
    pub async fn get_task_by_id_with_owner(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<Option<TaskRow>> {
        let row = self
            .task_store
            .get_task_owned(task_id, owner_user_id)
            .await?;
        row.as_ref().map(decode_task_row).transpose()
    }

    /// `subtask_store.list_ids_by_task`: the task's subtask ids.
    pub async fn list_subtask_ids_by_task(&self, task_id: i64) -> MysqlResult<Vec<i64>> {
        let rows = self.task_store.list_subtask_ids_by_task(task_id).await?;
        rows.iter().map(|row| row.get_required("id")).collect()
    }

    /// `subtask_store.list_by_task_ordered` for a lineage task node: the task's
    /// subtasks ordered `message_id ASC, created_at ASC`. The store also runs
    /// the new-format owner guard and the batched context load the source
    /// attaches on the path that reads a table the deployment resolved itself.
    /// The history endpoint re-queries ready contexts per user subtask, so the
    /// loaded rows only need to preserve the recorded call topology.
    pub async fn list_subtasks_by_task(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<Vec<SubtaskRow>> {
        // The listing's contexts are the store's load; this path discards them.
        let listing = self
            .task_store
            .list_subtasks_by_task_ordered(task_id, owner_user_id)
            .await?;
        listing.rows.iter().map(decode_subtask_row).collect()
    }

    // Note (replay/20261001-6): recording 20260928050001 contains a single wide
    // batched `subtask_contexts` read (16,508 ids, ~206 KB of SQL, ~33 K tokens).
    // Replay's optional-session classifier only proves a statement read-only
    // within a bounded token budget, so that budget was raised in the traffic-e2e
    // harness to keep the recorded read classifiable. Target behavior here is
    // unchanged; this note records why the round re-verifies.
    pub async fn list_ready_contexts(
        &self,
        subtask_id: i64,
    ) -> MysqlResult<Vec<SubtaskContextRow>> {
        let sql = format!(
            "SELECT {columns} \nFROM subtask_contexts \n\
             WHERE subtask_contexts.subtask_id = {subtask_id} \
             AND subtask_contexts.status = 'ready' \
             AND subtask_contexts.context_type IN \
             ('attachment', 'external_web_content', 'knowledge_base') \
             ORDER BY subtask_contexts.created_at",
            columns = crate::task_store::subtask_context_columns()
        );
        let rows: Vec<MysqlRow> = self.mysql.fetch_all(sql.as_str(), ()).await?;
        rows.iter().map(decode_context_row).collect()
    }
}

/// Fork specification parsed from a task `json` column (`TaskForkSpec`).
#[derive(Debug, Deserialize)]
pub struct TaskForkSpec {
    #[serde(rename = "sourceTaskId")]
    pub source_task_id: i64,
    #[serde(rename = "afterMessageId")]
    pub after_message_id: i64,
}

impl TaskForkSpec {
    /// Extract the fork spec from a task json value (`_fork_spec`).
    pub fn from_task_json(task_json: &Value) -> Option<Self> {
        let spec = task_json.get("spec")?;
        let fork = spec.get("fork")?;
        if fork.is_null() {
            return None;
        }
        serde_json::from_value(fork.clone()).ok()
    }
}

#[cfg(test)]
mod tests {
    use crate::task_store::{
        SUBTASKS_TABLE, TASKS_TABLE, subtasks_by_message_ordered_statement, task_by_id_statement,
    };

    /// The projections this module decodes must keep every column the
    /// decoders read.
    #[test]
    fn task_projection_lists_every_mapped_column() {
        let columns = task_by_id_statement(TASKS_TABLE);
        assert!(columns.starts_with("SELECT id, user_id, kind, name, namespace, json"));
        assert!(columns.contains("is_group_chat"));
    }

    #[test]
    fn subtask_projection_includes_the_role_column() {
        let columns = subtasks_by_message_ordered_statement(SUBTASKS_TABLE);
        assert!(columns.contains("`role`"));
        assert!(columns.contains("result"));
        assert!(columns.contains("sender_user_id"));
    }

    #[test]
    fn context_projection_covers_the_recorded_column_order() {
        let columns = crate::task_store::subtask_context_columns();
        assert!(columns.starts_with(
            "subtask_contexts.id AS subtask_contexts_id, \
             subtask_contexts.subtask_id AS subtask_contexts_subtask_id"
        ));
        assert!(columns.ends_with("subtask_contexts.updated_at AS subtask_contexts_updated_at"));
    }
}
