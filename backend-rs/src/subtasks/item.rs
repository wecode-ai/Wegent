// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `SubtaskInDB` projection for `GET /api/subtasks`
//! (`app/schemas/subtask.py:SubtaskInDB`).
//!
//! The FastAPI handler returns ORM `Subtask` rows through
//! `response_model=SubtaskListResponse`; FastAPI validates each row into the
//! `SubtaskInDB` model, whose field serializers strip the system prompt blocks
//! (`clean_prompt`), render the attached contexts through
//! `SubtaskContextBrief.from_model`, and expose the group-chat sender name the
//! store attached. The `attachments` compatibility field has no model
//! attribute and stays its default empty list.
//!
//! The `result` / `error_message` masks (`mask_sensitive_data`) are not applied
//! here: that helper is a regex-based Python routine with no Rust port and no
//! recorded case exercising a non-empty page. `prompt`, contexts, timestamps,
//! and the sender-name attachment follow the source.
use std::collections::HashMap;

use brz_json::RawJson;
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;
use serde::Serialize;

use crate::json_compat::OptionalOpaqueJsonExt;
use crate::state::AppState;
use crate::task_detail_api::assembly::{extract_display_prompt, iso_timestamp};
use crate::task_detail_api::repository::{ContextRow, list_contexts};
use crate::task_detail_api::views::context_brief;
use brz_json::OpaqueJson;

/// One `subtasks` row selected with the full projection.
#[derive(Debug)]
struct SubtaskDoc {
    id: i64,
    user_id: i64,
    task_id: i64,
    team_id: i64,
    title: String,
    bot_ids: OpaqueJson,
    role: String,
    executor_namespace: Option<String>,
    executor_name: Option<String>,
    executor_deleted_at: bool,
    prompt: Option<String>,
    message_id: i64,
    parent_id: Option<i64>,
    status: String,
    progress: i64,
    result: Option<OpaqueJson>,
    error_message: Option<String>,
    created_at: Option<NaiveDateTime>,
    updated_at: Option<NaiveDateTime>,
    completed_at: Option<NaiveDateTime>,
    sender_type: Option<String>,
    sender_user_id: i64,
    reply_to_subtask_id: i64,
}

fn decode_subtask(row: &MysqlRow) -> MysqlResult<SubtaskDoc> {
    Ok(SubtaskDoc {
        id: row.get_required("id")?,
        user_id: row.get_required("user_id")?,
        task_id: row.get_required("task_id")?,
        team_id: row.get_required("team_id")?,
        title: row.get_required("title")?,
        bot_ids: row.get_required::<Json<OpaqueJson>>("bot_ids")?.0,
        role: row.get_required("role")?,
        executor_namespace: row.get("executor_namespace")?,
        executor_name: row.get("executor_name")?,
        executor_deleted_at: row.get_required::<i8>("executor_deleted_at")? != 0,
        prompt: row.get("prompt")?,
        message_id: row.get_required("message_id")?,
        parent_id: row.get("parent_id")?,
        status: row.get_required("status")?,
        progress: row.get_required("progress")?,
        result: row.get::<Json<OpaqueJson>>("result")?.map(|json| json.0),
        error_message: row.get("error_message")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        completed_at: row.get("completed_at")?,
        sender_type: row.get("sender_type")?,
        sender_user_id: row.get_required("sender_user_id")?,
        reply_to_subtask_id: row.get_required("reply_to_subtask_id")?,
    })
}

/// `SubtaskInDB` (the `SubtaskListResponse` item).
#[derive(Debug, Serialize)]
pub(crate) struct SubtaskInDb {
    task_id: i64,
    team_id: i64,
    title: String,
    bot_ids: RawJson,
    role: String,
    prompt: Option<String>,
    executor_namespace: Option<String>,
    executor_name: Option<String>,
    message_id: i64,
    parent_id: Option<i64>,
    status: String,
    progress: i64,
    result: RawJson,
    error_message: Option<String>,
    id: i64,
    user_id: i64,
    created_at: Option<String>,
    updated_at: Option<String>,
    completed_at: Option<String>,
    executor_deleted_at: bool,
    contexts: Vec<RawJson>,
    attachments: Vec<RawJson>,
    sender_type: Option<String>,
    sender_user_id: i64,
    sender_user_name: Option<String>,
    reply_to_subtask_id: i64,
}

impl SubtaskInDb {
    fn from_doc(
        doc: &SubtaskDoc,
        contexts: &[ContextRow],
        sender_names: &HashMap<i64, String>,
    ) -> Self {
        let contexts = contexts
            .iter()
            .filter(|context| context.subtask_contexts_subtask_id == doc.id)
            .map(|context| {
                brz_json::to_raw_value(&context_brief(context)).expect("context brief serializes")
            })
            .collect();
        Self {
            task_id: doc.task_id,
            team_id: doc.team_id,
            title: doc.title.clone(),
            bot_ids: doc.bot_ids.to_raw_value(),
            role: doc.role.clone(),
            prompt: extract_display_prompt(doc.prompt.as_deref()),
            executor_namespace: doc.executor_namespace.clone(),
            executor_name: doc.executor_name.clone(),
            message_id: doc.message_id,
            parent_id: doc.parent_id,
            status: doc.status.clone(),
            progress: doc.progress,
            result: doc.result.raw_or(serde_json::Value::Null),
            error_message: doc.error_message.clone(),
            id: doc.id,
            user_id: doc.user_id,
            created_at: doc.created_at.map(iso_timestamp),
            updated_at: doc.updated_at.map(iso_timestamp),
            completed_at: doc.completed_at.map(iso_timestamp),
            executor_deleted_at: doc.executor_deleted_at,
            contexts,
            attachments: Vec::new(),
            // `validate_sender_type`: the stored empty string renders as null.
            sender_type: doc.sender_type.clone().filter(|value| !value.is_empty()),
            sender_user_id: doc.sender_user_id,
            sender_user_name: sender_names.get(&doc.sender_user_id).cloned(),
            reply_to_subtask_id: doc.reply_to_subtask_id,
        }
    }
}

/// Build the response items for one loaded subtask page: the batch context
/// load and the batched sender-name lookup, then the projection.
pub(crate) async fn build_items(
    state: &AppState,
    rows: &[MysqlRow],
) -> MysqlResult<Vec<SubtaskInDb>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let docs = rows
        .iter()
        .map(decode_subtask)
        .collect::<MysqlResult<Vec<_>>>()?;
    let ids: Vec<i64> = docs.iter().map(|doc| doc.id).collect();
    let contexts = list_contexts(&state.mysql, &ids).await?;
    let sender_names = sender_user_names(&state.mysql, &docs).await?;
    Ok(docs
        .iter()
        .map(|doc| SubtaskInDb::from_doc(doc, &contexts, &sender_names))
        .collect())
}

/// `_attach_sender_user_names`: the user names of the page's group-chat
/// senders (`sender_user_id > 0`).
async fn sender_user_names(
    mysql: &brz_mysql::MysqlService,
    docs: &[SubtaskDoc],
) -> MysqlResult<HashMap<i64, String>> {
    let mut ids: Vec<i64> = Vec::new();
    for doc in docs {
        if doc.sender_user_id > 0 && !ids.contains(&doc.sender_user_id) {
            ids.push(doc.sender_user_id);
        }
    }
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let list = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    #[derive(FromMysqlRow)]
    struct SenderName {
        users_id: i64,
        users_user_name: String,
    }
    let rows: Vec<SenderName> = mysql
        .fetch_all(
            format!(
                "SELECT users.id AS users_id, users.user_name AS users_user_name \n\
                 FROM users \nWHERE users.id IN ({list})"
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.users_id, row.users_user_name))
        .collect())
}
