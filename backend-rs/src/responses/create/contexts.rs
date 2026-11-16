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
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlTransaction};
use serde_json::{Map, Value};

use crate::task_store_listing::subtask_context_columns;
use crate::teams::teams_repository::placeholders;

use super::knowledge_prompt::SelectedKnowledgeRef;

/// One `subtask_contexts` row, decoded from the labeled projection the context
/// reads share. Raw binary content stays out of the decoded row.
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
    #[mysql(rename = "subtask_contexts_image_base64")]
    pub image_base64: Option<String>,
    #[mysql(rename = "subtask_contexts_extracted_text")]
    pub extracted_text: Option<String>,
    #[mysql(rename = "subtask_contexts_created_at")]
    pub created_at: chrono::NaiveDateTime,
}

impl SubtaskContextRow {
    /// `SubtaskContext.type_data` as an object, when it is one.
    pub fn type_data_object(&self) -> Option<&Map<String, Value>> {
        self.type_data.0.as_object()
    }
}

/// Normalize external knowledge selections before creating the turn.
pub(crate) fn chat_external_refs(items: &[Value]) -> Result<Vec<Value>, &'static str> {
    const FIELDS: &[&str] = &[
        "provider",
        "mode",
        "id",
        "name",
        "scope",
        "target_type",
        "node_id",
        "document_id",
        "parent_id",
        "target_name",
        "resource_url",
    ];
    items
        .iter()
        .filter(|item| item["type"] == "external_knowledge")
        .map(|item| {
            let mut reference = Map::new();
            for &key in FIELDS {
                match item["data"].get(key) {
                    None | Some(Value::Null) => {}
                    Some(Value::String(value)) => {
                        reference.insert(key.to_string(), Value::String(value.clone()));
                    }
                    _ => return Err("Invalid external knowledge reference"),
                }
            }
            let value = Value::Object(reference);
            if value["mode"] != "explicit"
                || super::task_default_knowledge_bases::external_refs_from_values(
                    std::slice::from_ref(&value),
                )
                .is_empty()
            {
                return Err("Invalid external knowledge reference");
            }
            Ok(value)
        })
        .collect()
}

fn same_external_scope(left: &Value, right: &Value) -> bool {
    ["provider", "mode", "id"]
        .into_iter()
        .all(|key| left[key] == right[key])
}

fn whole_external_scope(reference: &Value) -> bool {
    reference["target_type"]
        .as_str()
        .is_none_or(|value| value == "knowledge_base")
}

fn merge_chat_external_refs(current: &mut Vec<Value>, incoming: &[Value]) {
    for reference in incoming {
        let whole = whole_external_scope(reference);
        if !whole
            && incoming
                .iter()
                .any(|other| whole_external_scope(other) && same_external_scope(reference, other))
        {
            continue;
        }
        current.retain(|other| {
            !same_external_scope(reference, other)
                || (!whole
                    && !whole_external_scope(other)
                    && ["target_type", "node_id", "document_id"]
                        .into_iter()
                        .any(|key| reference[key] != other[key]))
        });
        current.push(reference.clone());
    }
}

/// Persist both the message-level context and the task's inherited binding.
pub(crate) async fn link_chat_external_refs(
    sql: &mut dyn crate::request_sql::RequestSql,
    store: &dyn crate::task_store::TaskStore,
    setup: &mut super::session::ChatSessionSetup,
    user_id: i64,
    owner_user_id: i64,
    updated_at: &str,
    refs: &[Value],
) -> MysqlResult<()> {
    use crate::request_sql::RouteKey;
    use crate::sql_support::StatementArg::{Int, Str};

    let table = store.table_templates().tasks;
    let row = sql
        .fetch_optional_row(
            RouteKey::Task(setup.task_id as u64),
            &format!("SELECT json FROM {table} WHERE id = ? FOR UPDATE"),
            vec![Int(setup.task_id)],
        )
        .await?
        .ok_or_else(|| brz_mysql::MysqlError::InvalidQuery {
            reason: "Chat task disappeared".into(),
        })?;
    let mut task_json = row.get_required::<Json<Value>>("json")?.0;
    let mut merged = super::knowledge_resolution::task_external_knowledge_refs(&task_json)
        .as_array()
        .cloned()
        .unwrap_or_default();
    merge_chat_external_refs(&mut merged, refs);
    let Some(spec) = task_json.get_mut("spec").and_then(Value::as_object_mut) else {
        return Err(brz_mysql::MysqlError::InvalidQuery {
            reason: "Chat task has no spec".into(),
        });
    };
    spec.insert("externalKnowledgeRefs".into(), Value::Array(merged));
    store
        .update_task_json_on(
            sql,
            setup.task_id,
            owner_user_id,
            &crate::json_compat::python_json_value(&task_json),
            updated_at,
        )
        .await?;
    setup.task_json = task_json;

    for reference in refs {
        let name = reference["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .or_else(|| reference["id"].as_str())
            .unwrap_or_default();
        sql.execute_statement(
            RouteKey::None,
            "INSERT INTO subtask_contexts (subtask_id, user_id, context_type, name, status, \
             error_message, binary_data, image_base64, extracted_text, text_length, type_data, created_at, updated_at) \
             VALUES (?, ?, 'external_knowledge', ?, 'ready', '', X'', '', '', 0, ?, NOW(), NOW())",
            vec![Int(setup.user_subtask_id), Int(user_id), Str(name.to_string()),
                Str(crate::json_compat::python_json_value(reference))],
        ).await?;
    }
    Ok(())
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

/// Current-turn contexts must be visible immediately after the writer commits.
pub(super) async fn current_contexts_by_subtask<M: Mysql>(
    mysql: &M,
    subtask_id: i64,
) -> MysqlResult<Vec<SubtaskContextRow>> {
    mysql
        .with_transaction(async |tx| {
            tx.fetch_all(contexts_by_subtask_statement(), (subtask_id,))
                .await
        })
        .await
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

/// Validate and move ready attachments while holding their row locks.
pub(crate) async fn link_chat_attachments(
    sql: &mut dyn crate::request_sql::RequestSql,
    user_id: i64,
    subtask_id: i64,
    mut ids: Vec<i64>,
    existing_subtasks: &[brz_mysql::MysqlRow],
) -> MysqlResult<Vec<i64>> {
    use crate::request_sql::RouteKey;
    use crate::sql_support::StatementArg::Int;

    ids.sort_unstable();
    ids.dedup();
    let owner_column = crate::task_store_statements::subtask_column_index("user_id")
        .expect("subtask projection has an owner");
    let id_column = crate::task_store_statements::subtask_column_index("id")
        .expect("subtask projection has an id");
    let mut owned_subtasks = std::collections::HashSet::new();
    for row in existing_subtasks {
        if row.get_at::<Option<i64>>(owner_column)? == Some(user_id) {
            owned_subtasks.extend(row.get_at::<Option<i64>>(id_column)?);
        }
    }
    let mut invalid = Vec::new();
    for &id in &ids {
        let row = sql
            .fetch_optional_row(
                RouteKey::None,
                "SELECT subtask_id FROM subtask_contexts WHERE id = ? AND user_id = ? \
             AND context_type = 'attachment' AND status = 'ready' FOR UPDATE",
                vec![Int(id), Int(user_id)],
            )
            .await?;
        let linked = row
            .map(|row| row.get_required::<i64>("subtask_id"))
            .transpose()?;
        if !linked.is_some_and(|subtask| subtask == 0 || owned_subtasks.contains(&subtask)) {
            invalid.push(id);
        }
    }
    if invalid.is_empty() {
        for id in ids {
            sql.execute_statement(
                RouteKey::None,
                "UPDATE subtask_contexts SET subtask_id = ? WHERE id = ? AND user_id = ?",
                vec![Int(subtask_id), Int(id), Int(user_id)],
            )
            .await?;
        }
    }
    Ok(invalid)
}

/// `context_service.get_attachments_by_subtask` (`user_subtask_id`).
pub async fn attachments_by_subtask<M: Mysql>(
    mysql: &M,
    subtask_id: i64,
) -> MysqlResult<Vec<SubtaskContextRow>> {
    mysql
        .with_transaction(async |tx| {
            tx.fetch_all(attachments_by_subtask_statement(), (subtask_id,))
                .await
        })
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

/// `SubtaskContextBrief.from_model` for one `get_by_subtask` row: the display
/// brief `websocket.py:_load_context_briefs` attaches to `chat:done`. The
/// display fields come from `build_context_display_fields` (the shared
/// `context_brief_fields` renderer the broadcast path uses); the row already
/// carries exactly the columns `get_briefs_by_subtask` selects, in
/// `created_at` order, so no extra read or re-sort is needed.
pub fn context_brief_payload(row: &SubtaskContextRow) -> Value {
    let context = crate::task_detail_api::repository::ContextRow {
        subtask_contexts_id: row.id,
        subtask_contexts_subtask_id: row.subtask_id,
        subtask_contexts_context_type: row.context_type.clone(),
        subtask_contexts_name: Some(row.name.clone()),
        subtask_contexts_status: Some(row.status.clone()),
        subtask_contexts_type_data: Some(Json(brz_json::OpaqueJson::from_serializable(
            &row.type_data.0,
        ))),
    };
    serde_json::to_value(crate::task_detail_api::views::context_brief_fields(
        &context,
    ))
    .unwrap_or(Value::Null)
}

/// `context_service.get_briefs_by_subtask`: the committed context briefs of
/// one subtask, in the Source's `created_at` order, ready for the `chat:done`
/// payload's `contexts` field.
pub async fn context_briefs<M: Mysql>(mysql: &M, subtask_id: i64) -> MysqlResult<Value> {
    let rows = contexts_by_subtask(mysql, subtask_id).await?;
    Ok(Value::Array(
        rows.iter().map(context_brief_payload).collect(),
    ))
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
        .with_transaction(async |tx| {
            tx.fetch_all(
                attachments_by_task_statement(subtask_ids.len()),
                subtask_ids.to_vec(),
            )
            .await
        })
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

/// Prepare attachment metadata and inline content for the current user turn.
pub(super) fn attachment_prompt(
    rows: &[SubtaskContextRow],
    message: &str,
    task_id: i64,
    shell_type: &str,
    model_config: &Map<String, Value>,
    inject_max_chars: usize,
) -> Value {
    let model_type = model_config
        .get("modelType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let inline = !model_type.eq_ignore_ascii_case("video")
        && !matches!(shell_type, "ClaudeCode" | "Agno" | "CodeX" | "Codex");
    let supports_image = model_supports_image(model_type, model_config);
    let mut metadata = String::new();
    let mut image_headers = String::new();
    let mut images = Vec::new();
    for (index, row) in rows.iter().filter(|row| row.status == "ready").enumerate() {
        let content = attachment_content(row, task_id, inline, supports_image, inject_max_chars);
        match content {
            AttachmentContent::Image { header, url } => {
                image_headers.push_str(&header);
                images.push(serde_json::json!({"type": "input_image", "image_url": url}));
            }
            AttachmentContent::Text(text) => {
                metadata.push_str(&format!("[Attachment {}]\n{text}", index + 1));
            }
            AttachmentContent::Empty => {}
        }
    }
    metadata.push_str(&image_headers);
    if metadata.is_empty() {
        return Value::String(message.to_string());
    }
    let mut blocks = vec![serde_json::json!({
        "type": "input_text", "text": format!("<attachment>{metadata}</attachment>"),
    })];
    blocks.extend(images);
    blocks.push(serde_json::json!({"type": "input_text", "text": message}));
    Value::Array(blocks)
}

fn model_supports_image(model_type: &str, model_config: &Map<String, Value>) -> bool {
    if model_type == "image" {
        let config = model_config.get("imageConfig").unwrap_or(&Value::Null);
        let capabilities = &config["capabilities"];
        let max_images = capabilities["max_reference_images"]
            .as_i64()
            .or_else(|| config["max_reference_images"].as_i64());
        return capabilities["supports_image_input"].as_bool() != Some(false)
            && max_images != Some(0);
    }
    model_config
        .get("modelCapabilities")
        .and_then(|capabilities| capabilities["supportsImage"].as_bool())
        == Some(true)
}

enum AttachmentContent {
    Text(String),
    Image { header: String, url: String },
    Empty,
}

fn attachment_content(
    row: &SubtaskContextRow,
    task_id: i64,
    inline: bool,
    supports_image: bool,
    inject_max_chars: usize,
) -> AttachmentContent {
    use crate::attachment_block as blocks;

    let data = &row.type_data.0;
    let filename = data["original_filename"].as_str().unwrap_or(&row.name);
    let mime_type = data["mime_type"].as_str().filter(|mime| !mime.is_empty());
    let extension = data["file_extension"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_image = matches!(
        extension.trim_start_matches('.'),
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp"
    );
    let sandbox_path =
        blocks::build_sandbox_path(Some(task_id), Some(row.subtask_id), Some(filename));
    let header = |image| {
        blocks::build_attachment_header(
            row.id,
            Some(filename),
            mime_type,
            data["file_size"].as_i64().unwrap_or(0),
            sandbox_path.as_deref(),
            image,
        )
    };
    if !inline {
        return AttachmentContent::Text(format!("{}\n\n", header(is_image)));
    }
    if let Some(image) = row
        .image_base64
        .as_deref()
        .filter(|image| is_image && !image.is_empty())
    {
        let header = header(true);
        return if supports_image {
            AttachmentContent::Image {
                header,
                url: format!("data:{};base64,{image}", mime_type.unwrap_or("image/jpeg")),
            }
        } else {
            AttachmentContent::Text(header)
        };
    }
    let Some(text) = row
        .extracted_text
        .as_deref()
        .filter(|text| !text.is_empty())
    else {
        return AttachmentContent::Empty;
    };
    let (preview, truncated) = blocks::truncate_for_injection(text, inject_max_chars);
    let note =
        blocks::build_truncation_note(data["is_truncated"].as_bool() == Some(true) && !truncated);
    AttachmentContent::Text(format!("{}\n{note}{preview}\n\n", header(false)))
}

/// `_build_current_wegent_refs` (`chat/selected_knowledge.py:488-539`): the
/// ready knowledge-base and selected-document contexts as explicit `wegent`
/// refs, in context order.
///
pub async fn ready_wegent_refs<M: Mysql>(
    mysql: &M,
    contexts: &[SubtaskContextRow],
) -> MysqlResult<Vec<SelectedKnowledgeRef>> {
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
        let document_ids = int_values(
            data.get("explicit_document_ids")
                .or_else(|| data.get("document_ids")),
        );
        let scope_restricted = brz_json::adapters::python_truthy(
            &data.get("scope_restricted").cloned().unwrap_or(Value::Null),
        ) || !folder_ids.is_empty()
            || !document_ids.is_empty();
        if scope_restricted && folder_ids.is_empty() && document_ids.is_empty() {
            continue;
        }
        let resources = super::selected_knowledge::load_wegent_resources(
            mysql,
            kb_id,
            &folder_ids,
            &document_ids,
        )
        .await?;
        refs.push(SelectedKnowledgeRef {
            provider: "wegent".to_string(),
            knowledge_base_id: kb_id.to_string(),
            knowledge_base_name: if is_selected_documents {
                String::new()
            } else {
                context.name.clone()
            },
            resources,
            ..Default::default()
        });
    }
    Ok(refs)
}

/// `_prepare_kb_tools_from_contexts`' priority-1 input
/// (`contexts.py:1871-1877`): the current subtask's ready `knowledge_base`
/// contexts in creation order. A non-empty list means the caller selected the
/// knowledge bases for this message, so the task-level fallback must not run.
pub fn subtask_knowledge_base_contexts(contexts: &[SubtaskContextRow]) -> Vec<&SubtaskContextRow> {
    contexts
        .iter()
        .filter(|context| context.context_type == "knowledge_base" && context.status == "ready")
        .collect()
}

/// `SubtaskContext.knowledge_id`: `type_data["knowledge_id"]` as a positive id.
pub fn knowledge_id(context: &SubtaskContextRow) -> Option<i64> {
    context
        .type_data_object()
        .and_then(|data| data.get("knowledge_id"))
        .and_then(positive_int)
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

    #[test]
    fn external_selection_requires_a_supported_and_identifiable_target() {
        let good = serde_json::json!({"type": "external_knowledge", "data": {
            "provider": "dingtalk", "mode": "explicit", "id": "space",
            "target_type": "document", "node_id": "document",
        }});
        assert_eq!(
            chat_external_refs(std::slice::from_ref(&good)).unwrap(),
            vec![good["data"].clone()]
        );
        let mut invalid = good;
        invalid["data"]["node_id"] = Value::Null;
        assert!(chat_external_refs(&[invalid]).is_err());
    }

    #[test]
    fn a_whole_external_selection_replaces_children_in_the_same_scope() {
        let document = serde_json::json!({"provider": "dingtalk", "mode": "explicit", "id": "space",
            "target_type": "document", "document_id": "document"});
        let other = serde_json::json!({"provider": "dingtalk", "mode": "explicit", "id": "other"});
        let whole = serde_json::json!({"provider": "dingtalk", "mode": "explicit", "id": "space"});
        let mut refs = vec![document.clone(), other.clone()];
        merge_chat_external_refs(&mut refs, &[whole.clone(), document.clone()]);
        assert_eq!(refs, vec![other.clone(), whole]);
        merge_chat_external_refs(&mut refs, std::slice::from_ref(&document));
        assert_eq!(refs, vec![other, document]);
    }

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
            image_base64: None,
            extracted_text: None,
            created_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn attachment_prompt_inlines_ready_images_for_vision_models() {
        let mut image = row(
            3,
            9,
            7,
            "attachment",
            json!({
                "file_extension": ".png", "mime_type": "image/png", "original_filename": "photo.png",
            }),
        );
        image.image_base64 = Some("aW1hZ2U=".into());
        let rows = [image];
        let config = json!({"modelCapabilities": {"supportsImage": true}});
        let prompt = attachment_prompt(
            &rows,
            "Describe this",
            5,
            "Chat",
            config.as_object().unwrap(),
            100,
        );
        assert!(prompt[0]["text"].as_str().unwrap().contains("photo.png"));
        assert_eq!(
            prompt[1],
            json!({"type": "input_image", "image_url": "data:image/png;base64,aW1hZ2U="})
        );
        assert_eq!(
            prompt[2],
            json!({"type": "input_text", "text": "Describe this"})
        );

        for (shell_type, config) in [
            ("Codex", config),
            (
                "Chat",
                json!({"modelType": "video", "modelCapabilities": {"supportsImage": true}}),
            ),
            (
                "Chat",
                json!({"modelCapabilities": {"supportsImage": false}}),
            ),
        ] {
            let prompt = attachment_prompt(
                &rows,
                "Describe this",
                5,
                shell_type,
                config.as_object().unwrap(),
                100,
            );
            assert_eq!(prompt.as_array().unwrap().len(), 2);
            assert_eq!(prompt[1]["text"], "Describe this");
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

    /// `_prepare_kb_tools_from_contexts`' priority-1 input: only ready
    /// `knowledge_base` contexts count, in creation order; `selected_documents`,
    /// attachments and non-ready rows do not select the priority-1 branch.
    #[test]
    fn ready_knowledge_contexts_select_the_subtask_knowledge_bases() {
        let mut not_ready = row(5, 10, 6582, "knowledge_base", json!({"knowledge_id": 9}));
        not_ready.status = "pending".to_string();
        let rows = vec![
            row(
                1,
                10,
                6582,
                "knowledge_base",
                json!({"knowledge_id": 157464}),
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
            row(
                4,
                10,
                6582,
                "knowledge_base",
                json!({"knowledge_id": "161644"}),
            ),
            // A ready knowledge-base context without an id is skipped, not an
            // empty selection.
            row(6, 10, 6582, "knowledge_base", json!({})),
        ];
        let selected = subtask_knowledge_base_contexts(&rows);
        let ids: Vec<_> = selected
            .iter()
            .filter_map(|context| knowledge_id(context))
            .collect();
        assert_eq!(ids, vec![157464, 161644]);
        assert_eq!(
            subtask_knowledge_base_contexts(&[]).len(),
            0,
            "no contexts leave the task-level fallback in charge"
        );
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
    #[tokio::test]
    async fn ready_knowledge_contexts_become_explicit_refs() {
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
                json!({"knowledge_base_id": 5, "document_ids": [11]}),
            ),
        ];
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let refs = ready_wegent_refs(&mysql, &rows).await.unwrap();
        let ids: Vec<_> = refs.iter().map(|r| r.knowledge_base_id.as_str()).collect();
        assert_eq!(ids, vec!["239607", "5"]);
        assert_eq!(refs[0].knowledge_base_name, "ctx-1");
        assert_eq!(refs[1].knowledge_base_name, "");
        assert_eq!(refs[1].resources[0].resource_id.as_deref(), Some("11"));
        assert_eq!(mysql.queries().len(), 1);
    }
}
