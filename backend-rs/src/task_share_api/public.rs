// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/share/public`
//! (`app.api.endpoints.adapter.tasks.get_public_shared_task` ->
//! `SharedTaskService.get_public_shared_task`).
//!
//! The route is unauthenticated: it decodes the share token into
//! `(user_id, task_id)`, resolves the active owned task, then projects the
//! public read-only view — the sharer name, the team display config, the
//! non-deleted subtasks with their public contexts, and the task creation
//! time. A token that does not decode is the route's `400 Invalid share link
//! format`; an absent task is its `404`.

use chrono::NaiveDateTime;
use serde::Deserialize;
use serde_json::Value;

use brz_http_server::StatusCode;
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, MysqlRow};

use crate::attachments::share_token::decode_payload;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::task_detail_api::repository::{ContextRow, list_contexts};
use crate::task_detail_api::views::context_brief;

/// `ContextType.KNOWLEDGE_BASE.value`: the context type the public view omits.
const KNOWLEDGE_BASE: &str = "knowledge_base";

/// `PublicSharedTaskResponse` (`app/schemas/shared_task.py`).
#[derive(Debug, serde::Serialize)]
pub(crate) struct PublicSharedTaskResponse {
    task_title: String,
    sharer_name: String,
    sharer_id: i64,
    display_config: DisplayConfig,
    subtasks: Vec<PublicSubtaskData>,
    created_at: String,
}

/// `TeamDisplayConfig` (`app/schemas/kind.py`): the single field FastAPI
/// serializes from the resolved team display config, present as `null` when the
/// config carries no value.
#[derive(Debug, serde::Serialize)]
struct DisplayConfig {
    show_final_answer_only: Option<bool>,
}

/// `PublicSubtaskData` (`app/schemas/shared_task.py`).
#[derive(Debug, serde::Serialize)]
pub(crate) struct PublicSubtaskData {
    id: i64,
    role: String,
    prompt: String,
    result: Option<OpaqueJson>,
    status: String,
    created_at: String,
    updated_at: String,
    contexts: Vec<PublicContextData>,
    sender_type: Option<String>,
    sender_user_id: Option<i64>,
    sender_user_name: Option<String>,
    reply_to_subtask_id: Option<i64>,
}

/// `PublicContextData` (`app/schemas/shared_task.py`): the public projection of
/// one `subtask_contexts` row with the `build_context_display_fields` additions.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub(crate) struct PublicContextData {
    id: i64,
    context_type: String,
    name: String,
    status: String,
    file_extension: Option<OpaqueJson>,
    file_size: Option<OpaqueJson>,
    mime_type: Option<OpaqueJson>,
    document_count: Option<OpaqueJson>,
    external_provider: Option<OpaqueJson>,
    external_mode: Option<OpaqueJson>,
    external_id: Option<OpaqueJson>,
    external_scope: Option<OpaqueJson>,
    external_target_type: Option<OpaqueJson>,
    external_node_id: Option<OpaqueJson>,
    external_document_id: Option<OpaqueJson>,
    external_parent_id: Option<OpaqueJson>,
    document_id: Option<OpaqueJson>,
    source_config: Option<OpaqueJson>,
    external_media_type: Option<OpaqueJson>,
    text_count: Option<OpaqueJson>,
    video_count: Option<OpaqueJson>,
    image_count: Option<OpaqueJson>,
    comment_count: Option<OpaqueJson>,
    fetched_comment_count: Option<OpaqueJson>,
    site: Option<OpaqueJson>,
    source_url: Option<OpaqueJson>,
    cover_url: Option<OpaqueJson>,
}

/// The `token` query parameter (`Query(...)`, required).
#[derive(Debug, Deserialize)]
pub(crate) struct PublicShareQuery {
    pub token: Option<String>,
}

/// The `users` projection every user read selects, aliased `users_<column>`.
const USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at";

/// `db.query(User).filter(User.id == user_id, User.is_active == True).first()`.
const SHARER_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? AND users.is_active = true \
     LIMIT 1";

/// `db.query(Kind).filter(Kind.user_id == …, Kind.kind == Team, Kind.namespace ==
/// …, Kind.name == …, Kind.is_active == True).first()`.
const TEAM_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.user_id = ? AND kinds.kind = 'Team' \
     AND kinds.namespace = ? AND kinds.name = ? \
     AND kinds.is_active = true \n LIMIT 1";

/// One `users` row: the two columns the sender-name map consumes.
#[derive(Debug, FromMysqlRow)]
struct UserNameRow {
    users_id: i64,
    users_user_name: String,
}

/// One `kinds` row: the Team CRD document the display-config read consumes.
/// The named struct is required because `brz_mysql` decodes a non-struct row
/// type positionally (exactly one column, at index 0), which a multi-column
/// `kinds` projection would reject.
#[derive(Debug, FromMysqlRow)]
struct TeamKindRow {
    kinds_json: Json<OpaqueJson>,
}

/// GET /api/tasks/share/public: the source declares no authentication
/// dependency, so the route is public.
#[brz_http_server::get("/api/tasks/share/public", access = public)]
async fn get_public_shared_task(
    #[inject(state)] state: &AppState,
    query: brz_http_server::Query<PublicShareQuery>,
) -> Result<PublicSharedTaskResponse, FastApiError> {
    let Some(token) = query.token.as_deref() else {
        return Err(missing_token());
    };
    run(state, token).await
}

/// The endpoint flow after route dispatch.
async fn run(state: &AppState, token: &str) -> Result<PublicSharedTaskResponse, FastApiError> {
    // `urllib.parse.unquote` + `_aes_decrypt` + the `"{user_id}#{task_id}"`
    // parse. Every failure is the route's `400 Invalid share link format`.
    let Some(info) = decode_payload(token) else {
        return Err(bad_request(INVALID_SHARE_LINK));
    };
    let user_id = info.user_id;
    let task_id = info.task_id;

    // `task_store.get_task_by_states(states=is_active_query(), user_id=user_id)`.
    let task = state
        .task_store
        .get_active_states_task_owned(task_id, user_id as i32)
        .await
        .map_err(internal)?;
    let Some(task) = task else {
        return Err(not_found(TASK_UNAVAILABLE));
    };
    let task_name: Option<String> = task.get("name").map_err(internal)?;
    let task_created_at: NaiveDateTime = task.get_required("created_at").map_err(internal)?;
    let task_json: OpaqueJson = task
        .get_required::<Json<OpaqueJson>>("json")
        .map_err(internal)?
        .0;

    // `user = db.query(User).filter(User.id == user_id, User.is_active == True).first()`.
    let sharer: Option<UserNameRow> = state
        .mysql
        .fetch_optional(SHARER_QUERY, (user_id,))
        .await
        .map_err(internal)?;
    let sharer_name = match sharer {
        Some(row) => row.users_user_name,
        None => format!("User_{user_id}"),
    };

    // `_get_public_task_display_config`.
    let show_final_answer_only = public_display_config(state, &task_json, user_id).await?;

    // `subtask_store.list_by_task_ordered(exclude_deleted=True)` plus the
    // deployment's attached contexts.
    let subtask_rows = state
        .task_store
        .list_non_deleted_subtasks_ordered(task_id)
        .await
        .map_err(internal)?;
    let subtask_ids: Vec<i64> = subtask_rows
        .iter()
        .map(|row| row.get_required::<i64>("id").map_err(internal))
        .collect::<Result<_, _>>()?;
    // `_attach_contexts`: the deployment attaches every context of the rows.
    if !subtask_ids.is_empty() {
        list_contexts(&state.mysql, &subtask_ids)
            .await
            .map_err(internal)?;
    }

    // The sender user names (`_attach_sender_user_names`).
    let mut sender_ids: Vec<i64> = Vec::new();
    for row in &subtask_rows {
        if let Some(id) = row.get::<i64>("sender_user_id").map_err(internal)?
            && id > 0
            && !sender_ids.contains(&id)
        {
            sender_ids.push(id);
        }
    }
    let user_names = sender_user_names(state, &sender_ids).await?;

    // `db.query(SubtaskContext)…context_type != KNOWLEDGE_BASE`.
    let public_contexts = public_contexts_by_subtask(state, &subtask_ids).await?;

    let mut subtasks: Vec<PublicSubtaskData> = Vec::with_capacity(subtask_rows.len());
    for row in &subtask_rows {
        subtasks.push(public_subtask(
            row,
            &user_names,
            &public_contexts,
            show_final_answer_only,
        )?);
    }

    // `refresh_extended_video_result_urls`: the extension refreshes the
    // subtask result payloads in order.
    refresh_result_urls(state, &mut subtasks).await?;

    Ok(PublicSharedTaskResponse {
        task_title: task_name.unwrap_or_else(|| "Untitled Task".to_string()),
        sharer_name,
        sharer_id: user_id,
        display_config: DisplayConfig {
            show_final_answer_only,
        },
        subtasks,
        created_at: format_datetime(&task_created_at),
    })
}

/// `SharedTaskService._get_public_task_display_config`: resolve the task team's
/// `spec.displayConfig`, keeping only its non-null `show_final_answer_only`.
async fn public_display_config(
    state: &AppState,
    task_json: &OpaqueJson,
    task_user_id: i64,
) -> Result<Option<bool>, FastApiError> {
    let task: Value = task_json.to_value();
    let team_ref = task
        .get("spec")
        .and_then(|spec| spec.get("teamRef"))
        .filter(|value| value.is_object());
    let Some(team_ref) = team_ref else {
        return Ok(None);
    };
    let Some(team_name) = team_ref.get("name").and_then(Value::as_str) else {
        return Ok(None);
    };
    let team_namespace = team_ref
        .get("namespace")
        .and_then(Value::as_str)
        .unwrap_or("default");

    let team_json = match team_ref.get("user_id").filter(|value| !value.is_null()) {
        Some(owner) => {
            let Some(owner) = owner.as_i64() else {
                return Ok(None);
            };
            let row: Option<TeamKindRow> = state
                .mysql
                .fetch_optional(TEAM_QUERY, (owner, team_namespace, team_name))
                .await
                .map_err(internal)?;
            row.map(|row| row.kinds_json.0)
        }
        None => resolve_team_json(state, task_user_id, team_namespace, team_name).await?,
    };
    let Some(team_json) = team_json else {
        return Ok(None);
    };
    let team: Value = team_json.to_value();
    let display_config = team
        .get("spec")
        .and_then(|spec| spec.get("displayConfig"))
        .filter(|value| value.is_object());
    let Some(display_config) = display_config else {
        return Ok(None);
    };
    // `{key: value for key, value in display_config.items() if value is not None}`
    // then pydantic's `TeamDisplayConfig.show_final_answer_only`.
    Ok(display_config
        .get("show_final_answer_only")
        .filter(|value| !value.is_null())
        .and_then(python_bool))
}

/// `kindReader.get_by_name_and_namespace` Team branch when the task's team ref
/// carries no explicit `user_id`.
async fn resolve_team_json(
    state: &AppState,
    user_id: i64,
    namespace: &str,
    name: &str,
) -> Result<Option<OpaqueJson>, FastApiError> {
    let store = crate::task_skills::kinds::KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let team = store
        .resolve_team(user_id, namespace, name)
        .await
        .map_err(internal)?;
    Ok(team.map(|row| row.kinds_json.0))
}

/// `_attach_sender_user_names`'s batch lookup: `users.id IN (…)`.
async fn sender_user_names(
    state: &AppState,
    sender_ids: &[i64],
) -> Result<Vec<UserNameRow>, FastApiError> {
    if sender_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = sender_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {USER_COLUMNS} \nFROM users \nWHERE users.id IN ({ids})");
    state.mysql.fetch_all(&sql, ()).await.map_err(internal)
}

/// `db.query(SubtaskContext).filter(subtask_id.in_(…), context_type !=
/// KNOWLEDGE_BASE)`: the public contexts keyed by subtask id, ordered by
/// context id.
async fn public_contexts_by_subtask(
    state: &AppState,
    subtask_ids: &[i64],
) -> Result<Vec<(i64, PublicContextData)>, FastApiError> {
    if subtask_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = subtask_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {} \
         FROM subtask_contexts \nWHERE subtask_contexts.subtask_id IN ({ids}) \
         AND subtask_contexts.context_type != '{KNOWLEDGE_BASE}'",
        crate::task_store::subtask_context_columns(),
    );
    let rows: Vec<MysqlRow> = state.mysql.fetch_all(&sql, ()).await.map_err(internal)?;
    let mut contexts = Vec::with_capacity(rows.len());
    for row in rows {
        let context = ContextRow::from_mysql_row(row).map_err(internal)?;
        let subtask_id = context.subtask_contexts_subtask_id;
        contexts.push((subtask_id, public_context(context)));
    }
    Ok(contexts)
}

/// The `ctx_dict` + `build_context_display_fields` projection of one context.
fn public_context(context: ContextRow) -> PublicContextData {
    let brief = context_brief(&context);
    PublicContextData {
        id: context.subtask_contexts_id,
        context_type: context.subtask_contexts_context_type.clone(),
        name: context.subtask_contexts_name.clone().unwrap_or_default(),
        status: context.subtask_contexts_status.clone().unwrap_or_default(),
        file_extension: opt_field(&brief.file_extension),
        file_size: opt_field(&brief.file_size),
        mime_type: opt_field(&brief.mime_type),
        document_count: opt_field(&brief.document_count),
        external_provider: opt_field(&brief.external_provider),
        external_mode: opt_field(&brief.external_mode),
        external_id: opt_field(&brief.external_id),
        external_scope: opt_field(&brief.external_scope),
        external_target_type: opt_field(&brief.external_target_type),
        external_node_id: opt_field(&brief.external_node_id),
        external_document_id: opt_field(&brief.external_document_id),
        external_parent_id: opt_field(&brief.external_parent_id),
        ..PublicContextData::default()
    }
}

/// A non-null `RawJson` display field as an opaque value (`null` stays absent).
fn opt_field(value: &brz_json::RawJson) -> Option<OpaqueJson> {
    if value.is_null() {
        None
    } else {
        OpaqueJson::from_json_text(value.get())
    }
}

/// One `PublicSubtaskData` from its row, the sender names, and the public
/// contexts.
fn public_subtask(
    row: &MysqlRow,
    user_names: &[UserNameRow],
    contexts: &[(i64, PublicContextData)],
    show_final_answer_only: Option<bool>,
) -> Result<PublicSubtaskData, FastApiError> {
    let id: i64 = row.get_required("id").map_err(internal)?;
    let role: String = row.get_required("role").map_err(internal)?;
    let status: String = row.get_required("status").map_err(internal)?;
    let created_at: NaiveDateTime = row.get_required("created_at").map_err(internal)?;
    let updated_at: NaiveDateTime = row.get_required("updated_at").map_err(internal)?;
    let prompt: Option<String> = row.get("prompt").map_err(internal)?;
    let result: Option<OpaqueJson> = row
        .get::<Json<OpaqueJson>>("result")
        .map_err(internal)?
        .map(|json| json.0);
    let sender_user_id: Option<i64> = row.get("sender_user_id").map_err(internal)?;
    let sender_type: Option<String> = row.get("sender_type").map_err(internal)?;
    let reply_to_subtask_id: Option<i64> = row.get("reply_to_subtask_id").map_err(internal)?;

    let clean_prompt = crate::attachment_block::parse_prompt_blocks(&prompt.unwrap_or_default()).0;

    let result = if show_final_answer_only == Some(true) && role != "USER" {
        result.map(|json| OpaqueJson::from(redact_final_answer_only(json.to_value())))
    } else {
        result
    };

    let sender_user_name = sender_user_id.filter(|id| *id > 0).and_then(|id| {
        user_names
            .iter()
            .find(|row| row.users_id == id)
            .map(|row| row.users_user_name.clone())
    });

    let subtask_contexts = contexts
        .iter()
        .filter(|(subtask_id, _)| *subtask_id == id)
        .map(|(_, context)| context.clone())
        .collect();

    Ok(PublicSubtaskData {
        id,
        role,
        prompt: clean_prompt,
        result,
        status,
        created_at: format_datetime(&created_at),
        updated_at: format_datetime(&updated_at),
        contexts: subtask_contexts,
        sender_type,
        sender_user_id,
        sender_user_name,
        reply_to_subtask_id,
    })
}

/// `refresh_extended_video_result_urls`: hand the subtask result payloads to
/// the registered extension in order and write the refreshed payloads back.
async fn refresh_result_urls(
    state: &AppState,
    subtasks: &mut [PublicSubtaskData],
) -> Result<(), FastApiError> {
    let mut payloads: Vec<brz_json::RawJson> = subtasks
        .iter()
        .map(|subtask| match &subtask.result {
            Some(result) => result.to_raw_value(),
            None => brz_json::raw_null(),
        })
        .collect();
    {
        let mut refs: Vec<&mut brz_json::RawJson> = payloads.iter_mut().collect();
        state
            .video_result_urls
            .refresh_result_urls(&state.attachment_http, &mut refs)
            .await
            .map_err(|error| {
                tracing::error!(%error, "[task_share] video result refresh failed");
                FastApiError::unhandled()
            })?;
    }
    for (subtask, payload) in subtasks.iter_mut().zip(payloads) {
        subtask.result = OpaqueJson::from_json_text(payload.get());
    }
    Ok(())
}

/// `SharedTaskService._redact_public_final_answer_only_result`: remove the
/// tool/answer metadata a final-answer-only team hides.
fn redact_final_answer_only(value: Value) -> Value {
    const HIDDEN: [&str; 3] = ["annotations", "retrieval_summary", "sources"];
    match redact_tool_details(value) {
        Value::Array(items) => {
            Value::Array(items.into_iter().map(redact_final_answer_only).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .filter(|(key, _)| !HIDDEN.contains(&key.as_str()))
                .map(|(key, item)| (key, redact_final_answer_only(item)))
                .collect(),
        ),
        other => other,
    }
}

/// `SharedTaskService._redact_public_tool_details` + `_redact_tool_call_text`.
fn redact_tool_details(value: Value) -> Value {
    const TOOL_BLOCK_PUBLIC_KEYS: [&str; 8] = [
        "id",
        "type",
        "status",
        "timestamp",
        "tool_use_id",
        "tool_name",
        "display_name",
        "argument_status",
    ];
    const TOOL_DETAIL_PUBLIC_KEYS: [&str; 13] = [
        "type",
        "subtype",
        "id",
        "name",
        "tool_name",
        "status",
        "tool_use_id",
        "is_error",
        "error",
        "error_message",
        "execution_type",
        "timestamp",
        "created_at",
    ];
    match value {
        Value::String(text) => Value::String(redact_tool_call_text(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_tool_details).collect()),
        Value::Object(fields) => {
            let allowed: Option<&[&str]> = match fields.get("type").and_then(Value::as_str) {
                Some("tool") => Some(&TOOL_BLOCK_PUBLIC_KEYS),
                Some("tool_use") | Some("tool_result") => Some(&TOOL_DETAIL_PUBLIC_KEYS),
                _ => None,
            };
            let mut out = serde_json::Map::new();
            for (key, item) in fields {
                if let Some(allowed) = allowed
                    && !allowed.contains(&key.as_str())
                {
                    continue;
                }
                if key == "content" && item.is_array() {
                    out.insert(key, redact_message_content(item));
                } else {
                    out.insert(key, redact_tool_details(item));
                }
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// `SharedTaskService._redact_public_message_content`: redact the tool entries
/// inside an assistant/user message content array.
fn redact_message_content(content: Value) -> Value {
    let Value::Array(items) = content else {
        return redact_tool_details(content);
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Value::Object(fields) = &item else {
            out.push(redact_tool_details(item));
            continue;
        };
        match fields.get("type").and_then(Value::as_str) {
            Some("tool_use") => out.push(drop_keys(item, &["input", "content", "details"])),
            Some("tool_result") => out.push(drop_keys(item, &["content", "output", "details"])),
            Some("text") if fields.get("text").is_some_and(Value::is_string) => {
                let mut redacted = fields.clone();
                let text = redacted
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                redacted.insert(
                    "text".to_string(),
                    Value::String(redact_tool_call_text(text)),
                );
                out.push(Value::Object(redacted));
            }
            _ => out.push(redact_tool_details(item)),
        }
    }
    Value::Array(out)
}

/// `{key: _redact_public_tool_details(value) for key, value in item.items() if
/// key not in hidden}` over an object value.
fn drop_keys(value: Value, hidden: &[&str]) -> Value {
    let Value::Object(fields) = value else {
        return redact_tool_details(value);
    };
    let mut out = serde_json::Map::new();
    for (key, item) in fields {
        if hidden.contains(&key.as_str()) {
            continue;
        }
        out.insert(key, redact_tool_details(item));
    }
    Value::Object(out)
}

/// `_redact_tool_call_text`: replace every `<tool_call>…</tool_call>` body with
/// the redaction marker, keeping only the tool name.
fn redact_tool_call_text(text: &str) -> String {
    const OPEN: &str = "<tool_call>";
    const CLOSE: &str = "</tool_call>";
    if !text.contains(OPEN) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + OPEN.len()..];
        let Some(end) = after_open.find(CLOSE) else {
            out.push_str(rest);
            return out;
        };
        let content = &after_open[..end];
        let tool_name = content
            .trim_start()
            .split(|c: char| c.is_whitespace() || c == '<')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("unknown");
        out.push_str("<tool_call>");
        out.push_str(tool_name);
        out.push_str(
            " <arg_key>redacted</arg_key><arg_value>[tool details hidden]</arg_value></tool_call>",
        );
        rest = &after_open[end + CLOSE.len()..];
    }
    out.push_str(rest);
    out
}

/// pydantic's `bool` coercion for a non-null JSON value.
fn python_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" | "y" | "t" => Some(true),
            "false" | "0" | "no" | "off" | "n" | "f" => Some(false),
            _ => None,
        },
        Value::Number(number) => number.as_i64().map(|value| value != 0),
        _ => None,
    }
}

/// pydantic's naive-datetime serialization: `isoformat()` without an offset and
/// with microseconds omitted when they are zero.
fn format_datetime(value: &NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    let micros = value.and_utc().timestamp_subsec_micros();
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

const INVALID_SHARE_LINK: &str = "Invalid share link format";
const TASK_UNAVAILABLE: &str =
    "This shared task is no longer available. It may have been deleted by the owner.";

fn missing_token() -> FastApiError {
    FastApiError::validation(serde_json::json!([
        {
            "type": "missing",
            "loc": ["query", "token"],
            "msg": "Field required",
            "input": serde_json::Value::Null,
        }
    ]))
}

fn bad_request(detail: &'static str) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, detail)
}

fn not_found(detail: &'static str) -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, detail)
}

fn internal(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "[task_share] database error");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `is_active_query()` is `[STATE_ACTIVE, STATE_SUBSCRIPTION]`, so the
    /// public-share task read filters `IN (1, 2)` — unlike the single-state
    /// `get_active_task_owned` read.
    #[test]
    fn task_read_keeps_both_active_states() {
        let sql = crate::task_store::active_states_task_owned_statement("tasks_0737");
        assert!(
            sql.contains("FROM `tasks_0737`")
                && sql.contains("is_active IN (1, 2)")
                && sql.contains("AND user_id = ?"),
            "{sql}"
        );
    }

    /// The public subtask listing adds the delete predicate before the
    /// `message_id`/`created_at` ordering.
    #[test]
    fn subtask_read_excludes_deleted_rows() {
        let sql = crate::task_store::non_deleted_subtasks_by_message_ordered_statement("subtasks");
        assert!(
            sql.contains("WHERE task_id = ? AND status != 'DELETE'")
                && sql.contains("ORDER BY message_id ASC, created_at ASC"),
            "{sql}"
        );
    }

    #[test]
    fn formats_naive_datetimes_like_pydantic() {
        let whole = NaiveDateTime::parse_from_str("2026-10-16T10:31:33", "%Y-%m-%dT%H:%M:%S")
            .expect("datetime");
        assert_eq!(format_datetime(&whole), "2026-10-16T10:31:33");
        let fractional = whole + chrono::Duration::microseconds(123_456);
        assert_eq!(format_datetime(&fractional), "2026-10-16T10:31:33.123456");
    }

    #[test]
    fn coerces_pydantic_booleans() {
        assert_eq!(python_bool(&Value::Bool(true)), Some(true));
        assert_eq!(python_bool(&Value::Bool(false)), Some(false));
        assert_eq!(python_bool(&Value::String("true".into())), Some(true));
        assert_eq!(python_bool(&Value::String("0".into())), Some(false));
        assert_eq!(python_bool(&Value::String("maybe".into())), None);
        assert_eq!(python_bool(&Value::Number(1.into())), Some(true));
    }

    /// `_redact_tool_call_text` keeps the tool name and hides the arguments.
    #[test]
    fn redacts_inline_tool_calls() {
        assert_eq!(redact_tool_call_text("plain text"), "plain text");
        assert_eq!(
            redact_tool_call_text(
                "<tool_call>search <arg_key>q</arg_key><arg_value>x</arg_value></tool_call>"
            ),
            "<tool_call>search <arg_key>redacted</arg_key><arg_value>[tool details hidden]</arg_value></tool_call>"
        );
    }

    /// A `tool_use` block keeps only its public keys and a final-answer-only
    /// result drops the retrieval metadata.
    #[test]
    fn redacts_final_answer_only_results() {
        let value = serde_json::json!({
            "type": "tool_use",
            "name": "search",
            "input": {"q": "secret"},
            "sources": [{"url": "https://example.invalid"}],
            "text": "drop me",
        });
        assert_eq!(
            redact_final_answer_only(value),
            serde_json::json!({"type": "tool_use", "name": "search"})
        );
    }

    /// Inside a message `content` array a tool entry keeps every key except the
    /// hidden ones, unlike the top-level tool public-key allowlist.
    #[test]
    fn redacts_message_content_tool_entries() {
        let value = serde_json::json!({
            "content": [
                {"type": "tool_use", "name": "search", "input": {"q": "x"}, "extra": 1},
            ],
        });
        assert_eq!(
            redact_tool_details(value),
            serde_json::json!({"content": [{"type": "tool_use", "name": "search", "extra": 1}]})
        );
    }
}
