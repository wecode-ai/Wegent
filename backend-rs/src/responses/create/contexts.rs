// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `subtask_contexts` reads the create flow performs
//! (`app/services/context/context_service.py`) and the executor attachment
//! payload built from them (`chat/trigger/unified.py:55-63`).
//!
//! The create flow issues four of them at distinct source positions:
//! `prepare_execution_request`'s generation-context enrichment
//! (`request_preparation.py:868-880`, the user subtask's attachments and the
//! task's ready attachments), `build_execution_request`'s `current_contexts`
//! (`unified.py:306`) and `_process_contexts`' attachment payload
//! (`unified.py:464`).
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::{Map, Value};

use crate::task_store_listing::subtask_context_columns;
use crate::teams::teams_repository::placeholders;

use super::knowledge_prompt::SelectedKnowledgeRef;

/// One `subtask_contexts` row, decoded from the labeled projection the context
/// reads share. The wide blobs (`binary_data`, `image_base64`,
/// `extracted_text`) are selected by the statement but never decoded here.
#[derive(Debug, Clone, FromMysqlRow)]
pub struct SubtaskContextRow {
    #[mysql(rename = "subtask_contexts_id")]
    pub id: i64,
    #[mysql(rename = "subtask_contexts_subtask_id")]
    pub subtask_id: i64,
    #[mysql(rename = "subtask_contexts_user_id")]
    pub user_id: i64,
    #[mysql(rename = "subtask_contexts_context_type")]
    pub context_type: String,
    #[mysql(rename = "subtask_contexts_name")]
    pub name: String,
    #[mysql(rename = "subtask_contexts_status")]
    pub status: String,
    #[mysql(rename = "subtask_contexts_type_data")]
    pub type_data: Json<Value>,
    #[mysql(rename = "subtask_contexts_created_at")]
    pub created_at: chrono::NaiveDateTime,
}

impl SubtaskContextRow {
    /// `SubtaskContext.type_data` as an object, when it is one.
    pub fn type_data_object(&self) -> Option<&Map<String, Value>> {
        self.type_data.0.as_object()
    }
}

/// `context_service.get_attachments_by_subtask`: one subtask's attachment
/// contexts in creation order.
pub fn attachments_by_subtask_statement() -> String {
    format!(
        "SELECT {columns} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.subtask_id = ? \
         AND subtask_contexts.context_type = 'attachment' \n\
         ORDER BY subtask_contexts.created_at",
        columns = subtask_context_columns()
    )
}

/// `context_service.get_by_subtask`: every context of one subtask in creation
/// order.
pub fn contexts_by_subtask_statement() -> String {
    format!(
        "SELECT {columns} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.subtask_id = ? \n\
         ORDER BY subtask_contexts.created_at",
        columns = subtask_context_columns()
    )
}

/// `context_service.get_attachments_by_task`: the ready attachment contexts of
/// the task's subtasks in creation order.
pub fn attachments_by_task_statement(subtask_count: usize) -> String {
    format!(
        "SELECT {columns} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.subtask_id IN ({ids}) \
         AND subtask_contexts.context_type = 'attachment' \
         AND subtask_contexts.status = 'ready' \n\
         ORDER BY subtask_contexts.created_at",
        columns = subtask_context_columns(),
        ids = placeholders(subtask_count)
    )
}

/// `context_service.get_attachments_by_subtask` (`user_subtask_id`).
pub async fn attachments_by_subtask<M: Mysql>(
    mysql: &M,
    subtask_id: i64,
) -> MysqlResult<Vec<SubtaskContextRow>> {
    mysql
        .fetch_all(attachments_by_subtask_statement(), (subtask_id,))
        .await
}

/// `context_service.get_by_subtask` (`context_subtask_id`).
pub async fn contexts_by_subtask<M: Mysql>(
    mysql: &M,
    subtask_id: i64,
) -> MysqlResult<Vec<SubtaskContextRow>> {
    mysql
        .fetch_all(contexts_by_subtask_statement(), (subtask_id,))
        .await
}

/// `context_service.get_attachments_by_task`: the ready attachments of every
/// subtask in `subtask_ids`.
pub async fn attachments_by_task<M: Mysql>(
    mysql: &M,
    subtask_ids: &[i64],
) -> MysqlResult<Vec<SubtaskContextRow>> {
    if subtask_ids.is_empty() {
        return Ok(Vec::new());
    }
    mysql
        .fetch_all(
            attachments_by_task_statement(subtask_ids.len()),
            subtask_ids.to_vec(),
        )
        .await
}

/// `_build_executor_attachment_payload`: the five fields the executor uses to
/// download one attachment. `original_filename`, `mime_type` and `file_size`
/// are the model's `type_data` properties (name / "" / 0 fallbacks).
pub fn executor_attachment_payload(context: &SubtaskContextRow) -> Value {
    let type_data = context.type_data_object();
    let field = |key: &str| type_data.and_then(|data| data.get(key));
    Value::Object(Map::from_iter([
        ("id".to_string(), Value::from(context.id)),
        (
            "original_filename".to_string(),
            field("original_filename")
                .and_then(Value::as_str)
                .unwrap_or(context.name.as_str())
                .to_string()
                .into(),
        ),
        (
            "mime_type".to_string(),
            field("mime_type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
                .into(),
        ),
        (
            "file_size".to_string(),
            field("file_size")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .into(),
        ),
        ("subtask_id".to_string(), Value::from(context.subtask_id)),
    ]))
}

/// `_build_current_wegent_refs` (`chat/selected_knowledge.py:488-539`): the
/// ready knowledge-base and selected-document contexts as explicit `wegent`
/// refs, in context order.
///
/// Documented gap: the `scope_restricted` branch's `_load_wegent_resources`
/// (folder/document scope loads) is not modeled, so a restricted context
/// carries no resources.
pub fn ready_wegent_refs(contexts: &[SubtaskContextRow]) -> Vec<SelectedKnowledgeRef> {
    let mut refs = Vec::new();
    for context in contexts.iter().filter(|context| context.status == "ready") {
        let context_type = context.context_type.as_str();
        let (key, is_selected_documents) = match context_type {
            "knowledge_base" => ("knowledge_id", false),
            "selected_documents" => ("knowledge_base_id", true),
            _ => continue,
        };
        let Some(data) = context.type_data_object() else {
            continue;
        };
        let Some(kb_id) = data.get(key).and_then(positive_int) else {
            continue;
        };
        let folder_ids = if is_selected_documents {
            Vec::new()
        } else {
            int_values(data.get("folder_ids"))
        };
        let document_ids = int_values(data.get("document_ids"));
        let scope_restricted = brz_json::adapters::python_truthy(
            &data.get("scope_restricted").cloned().unwrap_or(Value::Null),
        ) || !folder_ids.is_empty()
            || !document_ids.is_empty();
        if scope_restricted && folder_ids.is_empty() && document_ids.is_empty() {
            continue;
        }
        refs.push(SelectedKnowledgeRef {
            provider: "wegent".to_string(),
            knowledge_base_id: kb_id.to_string(),
            knowledge_base_name: if is_selected_documents {
                String::new()
            } else {
                context.name.clone()
            },
            ..Default::default()
        });
    }
    refs
}

/// `_positive_int`: an int-like JSON value when it is positive.
fn positive_int(value: &Value) -> Option<i64> {
    let parsed = match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    };
    parsed.filter(|value| *value > 0)
}

/// `_int_values`: the positive int-like entries of a JSON list.
fn int_values(value: Option<&Value>) -> Vec<i64> {
    value
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(positive_int).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn row(
        id: i64,
        subtask_id: i64,
        user_id: i64,
        context_type: &str,
        type_data: Value,
    ) -> SubtaskContextRow {
        SubtaskContextRow {
            id,
            subtask_id,
            user_id,
            context_type: context_type.to_string(),
            name: format!("ctx-{id}"),
            status: "ready".to_string(),
            type_data: Json(type_data),
            created_at: chrono::NaiveDateTime::default(),
        }
    }

    /// The three reads keep the source's predicates and ordering
    /// (`context_service.get_attachments_by_subtask`, `get_by_subtask`,
    /// `get_attachments_by_task`).
    #[test]
    fn context_reads_match_the_recorded_statements() {
        let by_subtask = normalize(&attachments_by_subtask_statement());
        assert!(by_subtask.contains(
            "WHERE subtask_contexts.subtask_id = ? AND subtask_contexts.context_type = 'attachment'"
        ));
        assert!(by_subtask.ends_with("ORDER BY subtask_contexts.created_at"));

        let all = normalize(&contexts_by_subtask_statement());
        assert!(all.contains("WHERE subtask_contexts.subtask_id = ?"));
        assert!(!all.contains("context_type = 'attachment'"));
        assert!(all.ends_with("ORDER BY subtask_contexts.created_at"));

        let by_task = normalize(&attachments_by_task_statement(2));
        assert!(by_task.contains("WHERE subtask_contexts.subtask_id IN (?, ?)"));
        assert!(by_task.contains("subtask_contexts.context_type = 'attachment'"));
        assert!(by_task.contains("subtask_contexts.status = 'ready'"));
        assert!(by_task.ends_with("ORDER BY subtask_contexts.created_at"));
    }

    /// `_build_executor_attachment_payload`: the five executor fields, with the
    /// model's `type_data` property fallbacks.
    #[test]
    fn the_executor_payload_follows_the_model_properties() {
        let context = row(
            7,
            9,
            6582,
            "attachment",
            json!({"original_filename": "a.pdf", "mime_type": "application/pdf", "file_size": 42}),
        );
        assert_eq!(
            executor_attachment_payload(&context),
            json!({
                "id": 7,
                "original_filename": "a.pdf",
                "mime_type": "application/pdf",
                "file_size": 42,
                "subtask_id": 9,
            })
        );
        // A context without `type_data` falls back to the name and zero size.
        let bare = row(8, 9, 6582, "attachment", json!({}));
        let payload = executor_attachment_payload(&bare);
        assert_eq!(payload["original_filename"], json!("ctx-8"));
        assert_eq!(payload["mime_type"], json!(""));
        assert_eq!(payload["file_size"], json!(0));
    }

    /// `_build_current_wegent_refs`: ready knowledge-base contexts become
    /// explicit `wegent` refs in context order; other types and non-ready rows
    /// do not.
    #[test]
    fn ready_knowledge_contexts_become_explicit_refs() {
        let mut not_ready = row(5, 10, 6582, "knowledge_base", json!({"knowledge_id": 9}));
        not_ready.status = "pending".to_string();
        let rows = vec![
            row(
                1,
                10,
                6582,
                "knowledge_base",
                json!({"knowledge_id": 239607}),
            ),
            not_ready,
            row(2, 10, 6582, "attachment", json!({"knowledge_id": 1})),
            row(
                3,
                10,
                6582,
                "selected_documents",
                json!({"knowledge_base_id": 5}),
            ),
        ];
        let refs = ready_wegent_refs(&rows);
        let ids: Vec<_> = refs.iter().map(|r| r.knowledge_base_id.as_str()).collect();
        assert_eq!(ids, vec!["239607", "5"]);
        assert_eq!(refs[0].knowledge_base_name, "ctx-1");
        assert_eq!(refs[1].knowledge_base_name, "");
    }
}
