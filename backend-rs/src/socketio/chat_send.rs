// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/chat` `chat:send`.
//!
//! Source: `app/api/ws/chat_namespace.py::on_chat_send` (token guard, session
//! user, task/bound-team resolution, the interactive-form, artifact-scope,
//! group-chat, conversation-reference and RAG guards) and
//! `app/services/chat/storage/task_manager.py::create_task_and_subtasks` ->
//! `app/services/chat/trigger/lifecycle.py::prepare_execution_session` for the
//! persisted turn.
//!
//! The persisted half reuses
//! [`crate::responses::create::session::setup_chat_session`]'s
//! `previous_response_id` continuation branch: the Source's
//! `prepare_execution_session(task_id=...)` is the same function that branch
//! ports, so the recorded statement shape (task CRD rewrite, savepoint, the
//! paired user/assistant subtask inserts, created_at read, release, commit)
//! comes from one implementation.
//!
//! Step (a) scope: the handler, validation, resolution, guards, the persisted
//! turn and the ACK. The AI trigger and the socket forwarding are step (b);
//! this module never publishes `chat:*` frames.

use std::sync::Arc;

use brz_mysql::{Json, MysqlTransactionService};
use brz_socket_io::{ClientError, Reply};
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;
use crate::internal_callback::completion::task_column;
use crate::request_sql::{RequestSql, RouteKey, fetch_optional_as};
use crate::responses::create::continuation::Continuation;
use crate::responses::create::resolution::{self, KindRow};
use crate::responses::create::session::{self, SetupChatSessionInput};
use crate::socketio::chat_session::ChatSession;
use crate::socketio::chat_trigger::{self, ChatTurn};
use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::runtime::{CHAT_NAMESPACE, SocketRuntime};
use crate::sql_support::StatementArg;
use crate::state::AppState;
use crate::task_creation::{TaskCrdInput, WorkspaceRepository};
use crate::task_store_statements::active_task_projection_statement;
use crate::transaction_outcome::{self, Completion};

/// `CLIENT_ORIGIN_FRONTEND`.
const CLIENT_ORIGIN_FRONTEND: &str = "frontend";
/// `CLIENT_ORIGIN_WEWORK`.
const CLIENT_ORIGIN_WEWORK: &str = "wework";
/// `SUPPORTED_CLIENT_ORIGINS` (`app/api/ws/events.py`).
const SUPPORTED_CLIENT_ORIGINS: [&str; 2] = [CLIENT_ORIGIN_FRONTEND, CLIENT_ORIGIN_WEWORK];
/// `PROJECT_TASK_TASK_TYPE`.
const TASK_TYPE_CHAT: &str = "chat";
/// `TaskCreationParams.source`'s default (`task_manager.py:100`). The WebSocket
/// `chat:send` path builds its params without an explicit source, and
/// `create_chat_task`'s own `source="web"` argument is not forwarded to
/// `prepare_execution_session`, so the persisted task label is `chat_shell`.
const CHAT_SHELL_SOURCE: &str = "chat_shell";
/// `is_deep_research_protocol`'s protocol marker.
const DEEP_RESEARCH_PROTOCOL: &str = "gemini-deep-research";

/// `ChatSendPayload` (`app/api/ws/events.py:211-297`).
///
/// The Source validates it with pydantic; fields carry the Source's defaults
/// and unknown extras are ignored like `BaseModel`'s default.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ChatSendPayload {
    #[serde(default)]
    pub task_id: Option<i64>,
    pub team_id: i64,
    pub message: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub attachment_id: Option<i64>,
    #[serde(default)]
    pub attachment_ids: Option<Vec<i64>>,
    #[serde(default = "default_true")]
    pub enable_deep_thinking: bool,
    #[serde(default)]
    pub enable_web_search: bool,
    #[serde(default)]
    pub search_engine: Option<String>,
    #[serde(default)]
    pub enable_clarification: bool,
    #[serde(default)]
    pub force_override_bot_model: Option<String>,
    #[serde(default)]
    pub force_override_bot_model_type: Option<String>,
    #[serde(default)]
    pub model_options: Option<Value>,
    #[serde(default)]
    pub is_group_chat: bool,
    #[serde(default)]
    pub contexts: Option<Value>,
    #[serde(default)]
    pub git_url: Option<String>,
    #[serde(default)]
    pub git_repo: Option<String>,
    #[serde(default)]
    pub git_repo_id: Option<i64>,
    #[serde(default)]
    pub git_domain: Option<String>,
    #[serde(default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub task_type: Option<String>,
    #[serde(default)]
    pub knowledge_base_id: Option<i64>,
    #[serde(default)]
    pub artifact_context: Option<Value>,
    #[serde(default)]
    pub additional_skills: Option<Value>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default = "default_client_origin")]
    pub client_origin: String,
    #[serde(default)]
    pub generate_params: Option<Value>,
    #[serde(default)]
    pub interactive_form_answer: Option<Value>,
    #[serde(default)]
    pub execution: Option<Value>,
}

fn default_true() -> bool {
    true
}

fn default_client_origin() -> String {
    CLIENT_ORIGIN_FRONTEND.to_string()
}

impl ChatSendPayload {
    /// `ChatSendPayload.model_validate` for one decoded event payload.
    ///
    /// The Source validates the mapping with pydantic; a malformed payload is
    /// rendered by the namespace decorator as an error ACK, so the text stays
    /// descriptive rather than reproducing pydantic's message list.
    pub fn parse(data: &Value) -> Result<Self, String> {
        let object = data
            .as_object()
            .ok_or_else(|| "value is not a valid dict".to_string())?;
        if object.get("team_id").and_then(Value::as_i64).is_none() {
            return Err("team_id: Input should be a valid integer".to_string());
        }
        if !matches!(object.get("message"), Some(Value::String(_))) {
            return Err("message: Input should be a valid string".to_string());
        }
        let payload: Self =
            serde_json::from_value(data.clone()).map_err(|error| error.to_string())?;
        if !SUPPORTED_CLIENT_ORIGINS.contains(&payload.client_origin.as_str()) {
            return Err(format!(
                "client_origin: Input should match the supported origins ({})",
                SUPPORTED_CLIENT_ORIGINS.join(", ")
            ));
        }
        Ok(payload)
    }

    /// `payload.task_type` or the Source's `TaskCreationParams` default.
    #[must_use]
    pub fn effective_task_type(&self) -> &str {
        self.task_type.as_deref().unwrap_or(TASK_TYPE_CHAT)
    }

    fn generation_options(&self) -> Option<Value> {
        let options = self.generate_params.as_ref()?.as_object()?;
        let mut generation = Map::new();
        for key in [
            "resolution",
            "ratio",
            "duration",
            "model",
            "model_display_name",
            "generation_mode_id",
            "size",
        ] {
            if let Some(value) = options.get(key).filter(|value| {
                if key == "duration" {
                    value.is_i64()
                } else {
                    value.is_string()
                }
            }) {
                generation.insert(key.to_owned(), value.clone());
            }
        }
        Some(Value::Object(generation))
    }

    /// Match the user subtask's image_config written by Python chat.
    fn image_result(&self, generation: Option<&Value>) -> Option<Value> {
        if self.effective_task_type() != "image" {
            return None;
        }
        let generation = generation?;
        let size = generation.get("size")?.as_str()?;
        let model = self
            .force_override_bot_model
            .as_deref()
            .or_else(|| generation.get("model").and_then(Value::as_str));
        Some(json!({ "image_config": { "model": model, "size": size } }))
    }

    /// `payload.interactive_form_answer` as the Source's mapping.
    #[must_use]
    pub fn interactive_form_answer_map(&self) -> Option<&Map<String, Value>> {
        self.interactive_form_answer
            .as_ref()
            .and_then(Value::as_object)
    }

    /// `payload.contexts` as the Source's `ContextItem` list.
    #[must_use]
    pub fn context_items(&self) -> &[Value] {
        self.contexts
            .as_ref()
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    }
}

/// `_handle_token_expired`'s emitted payload (`app/api/ws/events.py`).
#[derive(serde::Serialize)]
struct AuthError<'a> {
    error: &'a str,
    code: &'a str,
}

fn error_ack(message: &str) -> Value {
    json!({ "error": message })
}

/// The two-key rejection `on_chat_send` returns for interactive-form state
/// (`{"error": <code>, "message": <text>}`).
fn error_ack_with_message(error: &str, message: &str) -> Value {
    json!({ "error": error, "message": message })
}

/// `_handle_token_expired`: emit `auth_error` to the socket and answer the
/// event.
async fn handle_token_expired(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    socket_id: &str,
) -> Value {
    let payload = serde_json::to_value(AuthError {
        error: "Token expired",
        code: "TOKEN_EXPIRED",
    })
    .expect("auth error serializes");
    if let Err(error) = runtime
        .emitters()
        .chat_auth_error(socket_id, &payload)
        .await
    {
        tracing::warn!(%error, "auth_error local delivery failed");
    }
    publish_room_event(state, "auth_error", &payload, CHAT_NAMESPACE, socket_id).await;
    error_ack("Token expired")
}

/// The recorded `_resolve_task_bound_team` query: the Team a task's `teamRef`
/// names, matched by name, namespace and owner (qs151's filter order).
fn bound_team_statement() -> String {
    format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.kind = 'Team' \
         AND kinds.name = ? AND kinds.namespace = ? AND kinds.user_id = ? \
         AND kinds.is_active IS true \n LIMIT 1",
        resolution::KIND_COLUMNS
    )
}

/// The task/team pair `on_chat_send` continues (or the new-task team).
struct ResolvedScope {
    team: KindRow,
    task_json: Value,
    task_owner_user_id: i64,
}

/// `on_chat_send`'s task/team resolution on the caller's transaction.
///
/// Source order (qs148-151): the user read opens the transaction, then the
/// client-selected Team by id, the Task by id, and the task's bound Team. The
/// Source runs all of them on one SQLAlchemy session, so they must be members
/// of the same transaction as the session setup.
async fn resolve_scope_on(
    sql: &mut dyn RequestSql,
    viewer_user_id: i64,
    team_id: i64,
    task_id: Option<i64>,
    // The deployment's physical `tasks` table template (`tasks` for the base
    // store, `{{tasks}}` for a sharded one). The routing layer expands it to
    // the task id's shard (`tasks_0357`), and the projection aliases follow.
    tasks_table: &str,
) -> Result<Result<ResolvedScope, Value>, anyhow::Error> {
    // qs148: `db.query(User).filter(User.id == user_id).first()`. The Source
    // reads the ORM row directly, so the deployment `userReader` cache (its
    // `user:v2:data:{id}` GETs) must not run here; only the lookup at the two
    // recorded task:join points uses it.
    let Some(_user) = crate::user_reader::get_by_id_direct_on(sql, viewer_user_id).await? else {
        return Ok(Err(error_ack("User not found")));
    };
    // qs149: `_get_active_team_by_id`.
    let client_team: Option<KindRow> = fetch_optional_as(
        sql,
        RouteKey::None,
        &resolution::team_by_id_statement(),
        vec![StatementArg::Int(team_id)],
    )
    .await?;
    let Some(task_id) = task_id else {
        let Some(team) = client_team else {
            return Ok(Err(error_ack("Team not found")));
        };
        return Ok(Ok(ResolvedScope {
            team,
            task_json: Value::Object(Map::new()),
            task_owner_user_id: viewer_user_id,
        }));
    };
    // qs150: `get_task_by_states(TaskResource.is_active_query())`. The source
    // runs `db.query(TaskResource).filter(id == task_id, kind == 'Task',
    // is_active.in_((1, 2))).first()`, so the read carries the ORM's labeled
    // projection (`tasks_0357.id AS tasks_0357_id, ...`) and no JSON-delete
    // predicate. The physical table and every alias come from the deployment's
    // template, which the routing layer expands to the task id's shard.
    let task = sql
        .fetch_optional_row(
            RouteKey::Task(task_id as u64),
            &active_task_projection_statement(tasks_table),
            vec![StatementArg::Int(task_id)],
        )
        .await?;
    let Some(task) = task else {
        return Ok(Err(error_ack("Task not found")));
    };
    if task_column::<String>(&task, "namespace").as_deref() == Some("system") {
        return Ok(Err(error_ack("Task not found")));
    }
    let task_json = task_column::<Json<Value>>(&task, "json").map_or(Value::Null, |json| json.0);
    let task_owner_user_id = task_column::<i64>(&task, "user_id").unwrap_or(0);
    let team = match bound_team_on(
        sql,
        task_id,
        &task_json,
        task_owner_user_id,
        client_team,
        team_id,
    )
    .await?
    {
        Ok(team) => team,
        Err(ack) => return Ok(Err(ack)),
    };
    Ok(Ok(ResolvedScope {
        team,
        task_json,
        task_owner_user_id,
    }))
}

/// `_resolve_task_bound_team` on the caller's transaction (qs151).
async fn bound_team_on(
    sql: &mut dyn RequestSql,
    task_id: i64,
    task_json: &Value,
    task_owner_user_id: i64,
    client_team: Option<KindRow>,
    client_team_id: i64,
) -> Result<Result<KindRow, Value>, anyhow::Error> {
    let team_ref = task_json
        .get("spec")
        .and_then(|spec| spec.get("teamRef"))
        .and_then(Value::as_object);
    let name = team_ref.and_then(|team_ref| team_ref.get("name"));
    let Some(name) = name.and_then(Value::as_str) else {
        return Ok(match client_team {
            Some(team) => Ok(team),
            None => Err(error_ack(&format!(
                "Team not found for id={client_team_id}"
            ))),
        });
    };
    let namespace = team_ref
        .and_then(|team_ref| team_ref.get("namespace"))
        .and_then(Value::as_str)
        .unwrap_or("default");
    let recorded_owner = team_ref
        .and_then(|team_ref| team_ref.get("user_id"))
        .and_then(Value::as_i64);
    let bound: Option<KindRow> = match recorded_owner {
        Some(owner) => fetch_bound_team(sql, name, namespace, owner).await?,
        None => {
            // Legacy ref without an owner: the permission-aware reader tries
            // the task owner's personal row, then the public (`user_id = 0`)
            // row, exactly like `KindReader.get_by_name_and_namespace`.
            match fetch_bound_team(sql, name, namespace, task_owner_user_id).await? {
                Some(team) => Some(team),
                None => fetch_bound_team(sql, name, namespace, 0).await?,
            }
        }
    };
    Ok(match bound {
        Some(team) => Ok(team),
        None => Err(error_ack(&format!(
            "Task {task_id} belongs to agent '{name}' which no longer exists"
        ))),
    })
}

async fn fetch_bound_team(
    sql: &mut dyn RequestSql,
    name: &str,
    namespace: &str,
    owner_user_id: i64,
) -> Result<Option<KindRow>, anyhow::Error> {
    Ok(fetch_optional_as(
        sql,
        RouteKey::None,
        &bound_team_statement(),
        vec![
            StatementArg::Str(name.to_string()),
            StatementArg::Str(namespace.to_string()),
            StatementArg::Int(owner_user_id),
        ],
    )
    .await?)
}

/// `is_deep_research_protocol`: the team's first member bot model protocol.
async fn is_deep_research_protocol(
    state: &AppState,
    team: &KindRow,
) -> Result<bool, brz_mysql::MysqlError> {
    let Some(member) = team
        .json
        .0
        .get("spec")
        .and_then(|spec| spec.get("members"))
        .and_then(Value::as_array)
        .and_then(|members| members.first())
    else {
        return Ok(false);
    };
    let Some(bot_ref) = member.get("botRef") else {
        return Ok(false);
    };
    let (Some(name), namespace) = (
        bot_ref.get("name").and_then(Value::as_str),
        bot_ref
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("default"),
    ) else {
        return Ok(false);
    };
    let cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let Some(bot) = cache
        .get_by_name_and_namespace_row(team.user_id, "Bot", namespace, name)
        .await?
    else {
        return Ok(false);
    };
    let bot_json = bot.kinds_json.0.to_value();
    let Some(model_ref) = bot_json.get("spec").and_then(|spec| spec.get("modelRef")) else {
        return Ok(false);
    };
    let (Some(model_name), model_namespace) = (
        model_ref.get("name").and_then(Value::as_str),
        model_ref
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("default"),
    ) else {
        return Ok(false);
    };
    let Some(model) = cache
        .get_by_name_and_namespace_row(team.user_id, "Model", model_namespace, model_name)
        .await?
    else {
        return Ok(false);
    };
    Ok(model
        .kinds_json
        .0
        .to_value()
        .get("spec")
        .and_then(|spec| spec.get("protocol"))
        .and_then(Value::as_str)
        == Some(DEEP_RESEARCH_PROTOCOL))
}

/// `prepare_execution_session`'s independently resolved first available Bot
/// (`app/services/chat/trigger/lifecycle.py:256-277`).
///
/// With a `bot_ids_override` the Source skips the id collection but still
/// walks `team_crd.spec.members` in member order and resolves each member Bot
/// through the cached reader (`kindReader.get_by_name_and_namespace`, so the
/// `kind:v2:idx` -> `kind:v2:data` reads), keeping the first that resolves.
/// The pair becomes the execution session's `bot_name`/`bot_namespace`; no
/// later consumer reads it on the `chat:send` path, so the observable
/// behavior is this member-order resolution and the Source's
/// `400 "No valid bots found in team"` when no member resolves.
async fn resolve_first_available_bot<M: brz_mysql::Mysql, R: brz_redis::Redis>(
    cache: &crate::task_skills::kinds::KindCacheStore<'_, M, R>,
    team_owner_user_id: i64,
    team_json: &Value,
) -> Result<Option<resolution::BotRef>, brz_mysql::MysqlError> {
    for reference in resolution::bot_refs(team_json) {
        if cache
            .get_by_name_and_namespace_row(
                team_owner_user_id,
                "Bot",
                &reference.namespace,
                &reference.name,
            )
            .await?
            .is_some()
        {
            return Ok(Some(reference));
        }
    }
    Ok(None)
}

async fn pipeline_handoff(
    state: &AppState,
    sql: &mut dyn RequestSql,
    task_id: i64,
    user_id: i64,
    mode: &str,
) -> brz_mysql::MysqlResult<String> {
    fn column<T: brz_mysql::FromMysqlCol>(row: &brz_mysql::MysqlRow, name: &str) -> Option<T> {
        row.get_at(crate::task_store_statements::subtask_column_index(name)?)
            .ok()
            .flatten()
    }
    let listing = state
        .task_store
        .list_subtasks_by_task_ordered_on(sql, task_id, user_id)
        .await?;
    let Some(completed) = listing.rows.iter().rev().find(|row| {
        column::<String>(row, "role").as_deref() == Some("ASSISTANT")
            && column::<String>(row, "status").as_deref() == Some("COMPLETED")
    }) else {
        return Ok(String::new());
    };
    let before = column::<i64>(completed, "message_id").unwrap_or_default();
    let prompt = listing
        .rows
        .iter()
        .find(|row| {
            column::<String>(row, "role").as_deref() == Some("USER")
                && column::<i64>(row, "message_id").is_some_and(|id| id < before)
        })
        .and_then(|row| column::<String>(row, "prompt"));
    let original =
        wegent_task_store::prompt::extract_display_prompt(prompt.as_deref()).unwrap_or_default();
    let result = column::<Json<Value>>(completed, "result").map_or(Value::Null, |value| value.0);
    Ok(crate::task_store::handoff_message(mode, &original, &result))
}

/// `should_trigger_ai_response` (`app/services/chat/trigger/group_chat.py:23`).
#[must_use]
pub fn should_trigger_ai_response(
    task_json: &Value,
    prompt: &str,
    team_name: &str,
    request_is_group_chat: bool,
) -> bool {
    let mut is_group_chat = task_json
        .get("spec")
        .and_then(|spec| spec.get("is_group_chat"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !is_group_chat && request_is_group_chat {
        is_group_chat = true;
    }
    if !is_group_chat {
        return true;
    }
    prompt.contains(&format!("@{team_name}"))
}

/// `INTERACTIVE_FORM_TOOL_MARKER` (`app/services/chat/interactive_forms.py`).
const INTERACTIVE_FORM_TOOL_MARKER: &str = "interactive_form_question";

/// The pending form `get_pending_interactive_form` finds, if any.
struct PendingInteractiveForm {
    tool_use_id: String,
}

/// `_extract_interactive_form_from_result`'s `reversed(blocks)` scan.
fn pending_form_in_result(result: &Value) -> Option<PendingInteractiveForm> {
    let blocks = result.get("blocks")?.as_array()?;
    for block in blocks.iter().rev() {
        let Some(block) = block.as_object() else {
            continue;
        };
        let tool_name = block.get("tool_name").and_then(Value::as_str).unwrap_or("");
        if !tool_name.contains(INTERACTIVE_FORM_TOOL_MARKER) {
            continue;
        }
        let tool_use_id = match block.get("tool_use_id").or_else(|| block.get("id")) {
            Some(Value::String(text)) => text.trim().to_string(),
            Some(other) => other.to_string().trim().to_string(),
            None => String::new(),
        };
        if tool_use_id.is_empty() {
            continue;
        }
        let Some(render_payload) = block.get("render_payload").and_then(Value::as_object) else {
            continue;
        };
        if render_payload.get("type").and_then(Value::as_str) != Some(INTERACTIVE_FORM_TOOL_MARKER)
        {
            continue;
        }
        if render_payload
            .get("questions")
            .and_then(Value::as_array)
            .is_some_and(|questions| !questions.is_empty())
        {
            return Some(PendingInteractiveForm { tool_use_id });
        }
    }
    None
}

/// `_get_answer_value(answer, key)` for the request's answer mapping.
fn answer_field<'a>(answer: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    answer.get(key)
}

fn answer_text(answer: &Map<String, Value>, key: &str) -> String {
    match answer_field(answer, key) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// `validate_interactive_form_answer` (`app/services/chat/interactive_forms.py`)
/// on the caller's transaction.
///
/// `get_pending_interactive_form` reads the task's subtasks through
/// `subtask_store.list_by_task_desc`: the ORM's labeled projection ordered
/// `message_id DESC, id DESC` (recorded qs152). The scan stops at the first
/// user row, and the latest assistant row whose result still carries an
/// answered-form tool block is the pending form.
async fn validate_interactive_form_answer_on(
    sql: &mut dyn RequestSql,
    subtasks_table: &str,
    task_id: i64,
    answer: Option<&Map<String, Value>>,
) -> Result<Result<(), Value>, anyhow::Error> {
    let rows = sql
        .fetch_all_rows(
            RouteKey::Task(task_id as u64),
            &crate::task_store_statements::subtasks_by_task_desc_statement(subtasks_table),
            vec![StatementArg::Int(task_id)],
        )
        .await?;
    let column = |name: &str| {
        crate::task_store_statements::subtask_column_index(name)
            .expect("the subtask projection contains every mapped column")
    };
    let (role_index, result_index) = (column("role"), column("result"));
    let mut pending = None;
    for row in &rows {
        let role: String = row
            .get_at::<Option<String>>(role_index)?
            .unwrap_or_default();
        if role == "USER" {
            break;
        }
        if role != "ASSISTANT" {
            continue;
        }
        let result = row
            .get_at::<Option<brz_mysql::Json<Value>>>(result_index)?
            .map(|json| json.0)
            .unwrap_or(Value::Null);
        if let Some(form) = pending_form_in_result(&result) {
            pending = Some(form);
            break;
        }
    }

    let Some(pending) = pending else {
        if answer.is_some_and(|answer| !answer.is_empty()) {
            return Ok(Err(error_ack_with_message(
                "interactive_form_not_pending",
                "No pending interactive form is waiting for an answer.",
            )));
        }
        return Ok(Ok(()));
    };
    let Some(answer) = answer.filter(|answer| !answer.is_empty()) else {
        return Ok(Err(error_ack_with_message(
            "pending_interactive_form",
            "A pending interactive form must be submitted or cancelled first.",
        )));
    };
    if answer_field(answer, "type").and_then(Value::as_str) != Some(INTERACTIVE_FORM_TOOL_MARKER) {
        return Ok(Err(error_ack_with_message(
            "invalid_interactive_form_answer",
            "Invalid interactive form answer payload.",
        )));
    }
    let tool_use_id = answer_text(answer, "tool_use_id");
    let tool_use_id = tool_use_id.trim();
    if tool_use_id.is_empty() {
        return Ok(Err(error_ack_with_message(
            "interactive_form_tool_required",
            "Interactive form answers must include tool_use_id.",
        )));
    }
    if tool_use_id != pending.tool_use_id {
        return Ok(Err(error_ack_with_message(
            "interactive_form_tool_mismatch",
            "Interactive form answer does not match the pending tool call.",
        )));
    }
    Ok(Ok(()))
}

/// `_apply_artifact_node_scope`: the artifact-node source scope.
///
/// Replace the client sources with the authorized artifact's documents before
/// any attachment or context resolution.
async fn apply_artifact_node_scope(
    state: &AppState,
    user_id: i64,
    payload: &mut ChatSendPayload,
) -> Result<(), Value> {
    let Some(context) = payload.artifact_context.as_ref() else {
        return Ok(());
    };
    let Some(knowledge_base_id) = payload
        .knowledge_base_id
        .filter(|_| payload.effective_task_type() == "knowledge")
    else {
        return Err(error_ack(
            "Artifact node questions require a knowledge base task",
        ));
    };
    let artifact_id = context["artifact_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| error_ack("Artifact ID is required"))?;
    let node_id = context["node_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| error_ack("Mind map node ID is required"))?;
    let (name, document_ids) = crate::knowledge_artifacts::resolve_node_scope(
        state,
        user_id,
        knowledge_base_id,
        artifact_id,
        node_id,
    )
    .await
    .map_err(|error| error_ack(error.detail_message().unwrap_or("Artifact is unavailable")))?;
    payload.attachment_id = None;
    payload.attachment_ids = None;
    payload.contexts = Some(json!([{
        "type": "knowledge_base",
        "data": {"knowledge_id": knowledge_base_id, "name": name, "document_ids": document_ids, "scope_restricted": true}
    }]));
    Ok(())
}

/// `process_context_and_rag`: returns the RAG-enhanced prompt.
///
/// With no contexts the Source builds no retrieval prompt and returns the
/// message unchanged; the retrieval service is step (c).
async fn process_context_and_rag(
    state: &AppState,
    payload: &ChatSendPayload,
    should_trigger_ai: bool,
    user_id: i64,
    message: &str,
) -> Result<String, Value> {
    let _ = (state, should_trigger_ai, user_id);
    if payload.context_items().is_empty() {
        return Ok(message.to_string());
    }
    Ok(message.to_string())
}

/// The tasks table's row timestamps (`"%Y-%m-%d %H:%M:%S%.6f"`).
fn row_timestamp(now: chrono::NaiveDateTime) -> String {
    now.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// `create_task_and_subtasks`' post-commit memory block reloads the user
/// subtask first and then the pre-existing rows `build_context_messages`
/// touches, each by primary key (`f084b6fc` qs173-175:
/// `WHERE subtasks_0357.id = ?`). The pre-existing ids come from the
/// `existing_subtasks` rows' `id` column in message order; the `message_id`
/// carried by `existing_history` is not a primary key.
fn memory_reload_ids(user_subtask_id: i64, existing_subtask_ids: &[i64]) -> Vec<i64> {
    std::iter::once(user_subtask_id)
        .chain(existing_subtask_ids.iter().copied())
        .collect()
}

/// `_normalize_to_bool` (`app/services/memory/__init__.py:41-58`): booleans
/// pass through, strings match the truthy spellings, numbers are true when
/// non-zero, and anything else keeps the default.
fn normalize_memory_flag(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::String(value) => {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "true" | "1" | "yes" | "on"
            )
        }
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        _ => true,
    }
}

/// `is_memory_enabled_for_user` (`app/services/memory/__init__.py:62-108`):
/// the deployment flag gates everything, a user without preferences keeps the
/// service default, and only an explicitly parsed `memory_enabled` overrides
/// it. Parse failures default to enabled, exactly like the source.
fn is_memory_enabled_for_user(preferences: &str) -> bool {
    crate::users_features::memory_enabled() && memory_preference_enabled(preferences)
}

/// The preference half of `is_memory_enabled_for_user`: the user's
/// `memory_enabled` preference with the source's default and parse-failure
/// behavior, independent of the deployment flag.
fn memory_preference_enabled(preferences: &str) -> bool {
    if preferences.is_empty() {
        return true;
    }
    match serde_json::from_str::<Value>(preferences) {
        Ok(Value::Object(preferences)) => preferences
            .get("memory_enabled")
            .is_none_or(normalize_memory_flag),
        Ok(_) => true,
        Err(_) => true,
    }
}

/// `memory.utils.build_context_messages`'s candidate set
/// (`app/services/memory/utils.py:207-217`): only `COMPLETED` `USER` /
/// `ASSISTANT` rows, and only the newest `context_limit - 1` of them
/// (`history_count`). The rows arrive in message order, so the newest are the
/// tail; the block reads them oldest to newest, which is the order the
/// recorded reloads appear in (`f084b6fc` qs174-175: 581 then 582).
fn memory_history_ids(rows: &[(i64, String, String)], context_limit: usize) -> Vec<i64> {
    let completed = rows
        .iter()
        .filter(|(_, status, role)| {
            status == "COMPLETED" && (role == "USER" || role == "ASSISTANT")
        })
        .collect::<Vec<_>>();
    let history_count = context_limit.saturating_sub(1).min(completed.len());
    completed[completed.len() - history_count..]
        .iter()
        .map(|(id, ..)| *id)
        .collect()
}

/// The CRD timestamps (`datetime.now().isoformat()` shape).
fn crd_timestamp(now: chrono::NaiveDateTime) -> String {
    now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}

/// The task room the sender joins (`task:{task_id}`).
#[must_use]
pub fn task_room(task_id: i64, wework: bool) -> String {
    if wework {
        format!("wework:task:{task_id}")
    } else {
        format!("task:{task_id}")
    }
}

/// `on_chat_send`'s success ACK.
#[must_use]
pub fn success_ack(task_id: i64, subtask_id: i64, message_id: i64) -> Value {
    json!({
        "task_id": task_id,
        "subtask_id": subtask_id,
        "message_id": message_id,
    })
}

/// The send has just committed, so the replica may not yet have its rows.
pub(super) async fn refresh_task_from_writer(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> brz_mysql::MysqlResult<Option<brz_mysql::MysqlRow>> {
    state
        .mysql
        .with_transaction(async |tx| state.task_store.refresh_task_on(tx, task_id, user_id).await)
        .await
}

async fn refresh_subtask_from_writer(
    state: &AppState,
    task_id: i64,
    subtask_id: i64,
) -> brz_mysql::MysqlResult<Option<brz_mysql::MysqlRow>> {
    state
        .mysql
        .with_transaction(async |tx| {
            state
                .task_store
                .refresh_subtask_on(tx, task_id, subtask_id)
                .await
        })
        .await
}

/// Handle one `chat:send` event.
pub async fn handle(
    state: &Arc<AppState>,
    runtime: &Arc<SocketRuntime>,
    session: &ChatSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let mut payload = match ChatSendPayload::parse(&data) {
        Ok(payload) => payload,
        Err(error) => {
            return Ok(Reply::payload(error_ack(&format!(
                "Invalid payload: {error}"
            ))));
        }
    };
    // `_check_token_expiry` precedes every payload branch.
    if session.token_expired(chrono::Utc::now().timestamp()) {
        return Ok(Reply::payload(
            handle_token_expired(state, runtime, socket_id).await,
        ));
    }
    let user_id = session.user_id();
    if user_id == 0 {
        return Ok(Reply::payload(error_ack("Not authenticated")));
    }
    if let Err(ack) = apply_artifact_node_scope(state, user_id, &mut payload).await {
        return Ok(Reply::payload(ack));
    }

    let references = match super::chat_references::validate(
        state,
        user_id,
        payload.task_id,
        payload.context_items(),
    )
    .await
    {
        Ok(references) => references,
        Err(message) => return Ok(Reply::payload(error_ack(message))),
    };
    let external_refs =
        match crate::responses::create::contexts::chat_external_refs(payload.context_items()) {
            Ok(refs) => refs,
            Err(message) => return Ok(Reply::payload(error_ack(message))),
        };
    let knowledge_contexts =
        match crate::responses::create::kb_context_creation::resolve_chat_contexts(
            state,
            user_id,
            payload.context_items(),
        )
        .await
        {
            Ok(contexts) => contexts,
            Err(error) => {
                tracing::warn!(?error, user_id, "chat:send invalid knowledge context");
                return Ok(Reply::payload(error_ack(
                    error.detail_message().unwrap_or("Internal server error"),
                )));
            }
        };
    let additional_skills = payload
        .additional_skills
        .as_ref()
        .map_or_else(Vec::new, |skills| {
            let normalized = crate::resource_refs::parse_requested_skill_refs(
                &skills.to_string(),
                crate::resource_refs::EmptyNamespace::UseDefault,
            );
            normalized
                .into_iter()
                .map(|reference| {
                    serde_json::to_value(reference).expect("skill references serialize")
                })
                .collect()
        });
    let now = chrono::Local::now().naive_local();
    let row_ts = row_timestamp(now);
    let crd_ts = crd_timestamp(now);
    let wework = session.is_wework();

    // The Source runs `on_chat_send`'s reads, guards and
    // `prepare_execution_session` on one SQLAlchemy session, so every
    // statement below is a member of one transaction whose first statement is
    // the users-by-id read (qs148).
    let outcome = transaction_outcome::run(
        &state.mysql,
        async |transaction| {
            let sql: &mut MysqlTransactionService = transaction;
            let mut payload = payload.clone();
            let mut scope = match resolve_scope_on(
                &mut *sql,
                user_id,
                payload.team_id,
                payload.task_id,
                state.task_store.table_templates().tasks,
            )
            .await
            {
                Ok(Ok(scope)) => scope,
                Ok(Err(ack)) => return Ok(Completion::Rollback(Err(ack))),
                Err(error) => {
                    tracing::error!(%error, user_id, "chat:send scope read failed");
                    return Ok(Completion::Rollback(Err(error_ack(
                        "Internal server error",
                    ))));
                }
            };
            let confirming_pipeline = payload.action.as_deref() == Some("pipeline:confirm");
            if confirming_pipeline {
                let Some(task_id) = payload.task_id.filter(|_| scope.task_owner_user_id == user_id)
                else {
                    return Ok(Completion::Rollback(Err(error_ack("Task not found"))));
                };
                let row = sql.fetch_optional_row(
                    RouteKey::Task(task_id as u64),
                    &crate::task_store::task_for_update_first_statement(state.task_store.table_templates().tasks),
                    vec![StatementArg::Int(task_id)],
                ).await.map_err(|error| {
                    tracing::error!(%error, task_id, "pipeline confirmation task lock failed");
                    FastApiError::internal()
                })?;
                let Some(task_json) = row.as_ref()
                    .filter(|row| task_column::<i64>(row, "user_id") == Some(user_id))
                    .and_then(|row| task_column::<Json<Value>>(row, "json"))
                else {
                    return Ok(Completion::Rollback(Err(error_ack("Task not found"))));
                };
                scope.task_json = task_json.0;
                if scope.task_json["status"]["status"] != "PENDING_CONFIRMATION" {
                    return Ok(Completion::Rollback(Err(error_ack("Task is not awaiting confirmation"))));
                }
            }
            let team = scope.team;
            let stage = scope.task_json["spec"]["currentStage"].as_u64().unwrap_or(0) as usize;
            let pipeline = team.json.0["spec"]["collaborationModel"] == "pipeline";
            let mut new_session = false;
            let mut stage_team = None;
            if pipeline {
                let next = stage.saturating_add(usize::from(confirming_pipeline));
                let members = &team.json.0["spec"]["members"];
                let Some(member) = members.get(next) else {
                    return Ok(Completion::Rollback(Err(error_ack("Pipeline stage is unavailable"))));
                };
                let mut selected = team.json.0.clone();
                selected["spec"]["members"] = json!([member]);
                stage_team = Some(selected);
                if confirming_pipeline {
                    new_session = member["botRef"] != members[stage]["botRef"];
                    payload.message = payload.message.trim().to_owned();
                    let task_id = payload.task_id.unwrap_or_default();
                    let context_mode = members[stage]["contextPassing"].as_str().unwrap_or("none");
                    if payload.message.is_empty() && context_mode != "none" {
                        payload.message = pipeline_handoff(
                            state, sql, task_id, user_id, context_mode,
                        ).await.map_err(|error| {
                            tracing::error!(%error, task_id, "pipeline confirmation handoff read failed");
                            FastApiError::internal()
                        })?;
                    }
                    scope.task_json["spec"]["currentStage"] = json!(next);
                    state.task_store.update_task_json_on(
                        &mut *sql, task_id, user_id,
                        &crate::json_compat::python_json_value(&scope.task_json), &row_ts,
                    ).await.map_err(|error| {
                        tracing::error!(%error, "pipeline confirmation stage update failed");
                        FastApiError::internal()
                    })?;
                }
            } else if confirming_pipeline {
                return Ok(Completion::Rollback(Err(error_ack("Stage confirmation is only available for pipeline teams"))));
            }
            let bot_team = stage_team.as_ref().unwrap_or(&team.json.0);

            // Follow-ups on a deep-research task are rejected before any
            // lookup of the interactive-form state.
            if payload.task_id.is_some() {
                match is_deep_research_protocol(state, &team).await {
                    Ok(true) => {
                        return Ok(Completion::Rollback(Err(error_ack(
                            "Deep Research does not support follow-up questions. \
                             Please start a new conversation.",
                        ))));
                    }
                    Ok(false) => {}
                    Err(error) => {
                        tracing::error!(%error, team_id = team.id, "chat:send protocol read failed");
                        return Ok(Completion::Rollback(Err(error_ack(
                            "Internal server error",
                        ))));
                    }
                }
                if let Some(task_id) = payload.task_id {
                    match validate_interactive_form_answer_on(
                        &mut *sql,
                        state.task_store.table_templates().subtasks,
                        task_id,
                        payload.interactive_form_answer_map(),
                    )
                    .await
                    {
                        Ok(Ok(())) => {}
                        Ok(Err(ack)) => return Ok(Completion::Rollback(Err(ack))),
                        Err(error) => {
                            tracing::error!(%error, task_id, "chat:send form state read failed");
                            return Ok(Completion::Rollback(Err(error_ack(
                                "Internal server error",
                            ))));
                        }
                    }
                }
            }

            // `should_trigger_ai_response`: group chats only run on an @team
            // mention.
            let should_trigger_ai = confirming_pipeline || should_trigger_ai_response(
                &scope.task_json,
                &payload.message,
                &team.name,
                payload.is_group_chat,
            );

            let rag_prompt = match process_context_and_rag(
                state,
                &payload,
                should_trigger_ai,
                user_id,
                &payload.message,
            )
            .await
            {
                Ok(prompt) => prompt,
                Err(ack) => return Ok(Completion::Rollback(Err(ack))),
            };

            // `resolve_chat_task_device_id` (`chat_namespace.py:1105`): the
            // persisted Task carries the validated runtime route, not the raw
            // client payload. Both Device-kind reads run on this transaction,
            // before `create_chat_task`'s savepoint, like the Source session.
            let existing_task = payload.task_id.is_some().then_some(&scope.task_json);
            let mut device_query = &mut *sql;
            let resolved_device_id = match crate::socketio::chat_device_resolution::
                resolve_chat_task_device_id(
                    &mut device_query,
                    user_id,
                    payload.device_id.as_deref(),
                    existing_task,
                    payload.project_id.unwrap_or(0),
                    &payload.client_origin,
                )
                .await
            {
                Ok(device_id) => device_id,
                Err(crate::socketio::chat_device_resolution::DeviceResolutionError::Ambiguous) => {
                    return Ok(Completion::Rollback(Err(error_ack(&format!(
                        "409: {}",
                        crate::socketio::chat_device_resolution::AMBIGUOUS_DEVICE_MESSAGE
                    )))));
                }
                Err(crate::socketio::chat_device_resolution::DeviceResolutionError::Mysql(error)) => {
                    tracing::error!(%error, user_id, "chat:send device resolution failed");
                    return Ok(Completion::Rollback(Err(error_ack(
                        "Internal server error",
                    ))));
                }
            };

            // `get_bot_ids_from_team`: one cached reader lookup per team
            // member.
            let cache = crate::task_skills::kinds::KindCacheStore {
                mysql: &state.mysql,
                redis: state.redis.as_ref(),
                erp: Some(state.erp.as_ref()),
                resolvers: Some(&state.entity_resolvers),
            };
            let bots = match resolution::resolve_team_bots(&cache, team.user_id, bot_team).await
            {
                Ok(bots) => bots,
                Err(error) => {
                    tracing::error!(%error, team_id = team.id, "chat:send bot resolution failed");
                    return Ok(Completion::Rollback(Err(error_ack(
                        "Internal server error",
                    ))));
                }
            };
            if bots.bot_ids.is_empty() {
                return Ok(Completion::Rollback(Err(error_ack(
                    "No valid bots found in team",
                ))));
            }

            // `prepare_execution_session` (`lifecycle.py:256-277`): with a
            // `bot_ids_override` the Source still resolves the first
            // available member Bot independently, after the id collection and
            // before the task reads. The resolved pair is carried as the
            // session's `bot_name`/`bot_namespace`; nothing on this path reads
            // it afterwards.
            let first_bot = match resolve_first_available_bot(&cache, team.user_id, bot_team)
                .await
            {
                Ok(bot) => bot,
                Err(error) => {
                    tracing::error!(
                        %error,
                        team_id = team.id,
                        "chat:send first available bot resolution failed"
                    );
                    return Ok(Completion::Rollback(Err(error_ack(
                        "Internal server error",
                    ))));
                }
            };
            let Some(first_bot) = first_bot else {
                return Ok(Completion::Rollback(Err(error_ack(
                    "No valid bots found in team",
                ))));
            };
            tracing::debug!(
                bot_name = %first_bot.name,
                bot_namespace = %first_bot.namespace,
                "chat:send first available member bot resolved"
            );

            let repository = WorkspaceRepository {
                git_url: payload.git_url.as_deref().unwrap_or(""),
                git_repo: payload.git_repo.as_deref().unwrap_or(""),
                git_repo_id: payload.git_repo_id.unwrap_or(0),
                git_domain: payload.git_domain.as_deref().unwrap_or(""),
                branch_name: payload.branch_name.as_deref().unwrap_or(""),
            };
            // A supplied whitespace-only URL still selects a Git workspace so
            // the execution request can report the missing URL.
            let git_workspace = !repository.git_url.is_empty()
                || !repository.git_repo.trim().is_empty()
                || repository.git_repo_id > 0;
            let task_id = payload.task_id.unwrap_or(0);
            let continuation = payload.task_id.map(|task_id| Continuation {
                task_id,
                task_json: scope.task_json.clone(),
            });
            let generation = payload.generation_options();
            let user_result = payload.image_result(generation.as_ref());
            let input = SetupChatSessionInput {
                user_id,
                // `owner_user_id` is the authenticated principal the Source
                // binds on the task lookups.
                owner_user_id: user_id as i32,
                continuation,
                team_id: team.id,
                bot_ids: &bots.bot_ids,
                create_assistant: should_trigger_ai,
                model_override_type: payload.force_override_bot_model_type.as_deref(),
                model_options: payload.model_options.as_ref(),
                input_text: &payload.message,
                user_result: user_result.as_ref(),
                additional_skills: &additional_skills,
                crd: TaskCrdInput {
                    task_id,
                    team_name: &team.name,
                    team_namespace: &team.namespace,
                    team_user_id: team.user_id,
                    message: &payload.message,
                    title: payload.title.as_deref(),
                    task_type: Some(payload.effective_task_type()),
                    source: CHAT_SHELL_SOURCE,
                    project_id: payload.project_id.unwrap_or(0),
                    api_key_name: None,
                    model_id: payload.force_override_bot_model.as_deref(),
                    force_override_bot_model: payload.force_override_bot_model.is_some(),
                    is_group_chat: payload.is_group_chat,
                    is_api_call: false,
                    auto_delete_executor: None,
                    omit_mcp_binary_output: false,
                    device_id: resolved_device_id.as_deref(),
                    git_workspace,
                    created_at: &crd_ts,
                    updated_at: &crd_ts,
                },
                repository,
                client_origin: &payload.client_origin,
                project_id: payload.project_id.unwrap_or(0),
                // The `tasks.updated_at` column binds SQLAlchemy's
                // `datetime.now()` (space-separated), while the CRD's
                // `status.updatedAt` keeps the `isoformat()` "T" shape
                // (`input.crd.updated_at`). The OpenAPI create path passes
                // the row shape here for the same reason.
                created_at: &row_ts,
                updated_at: &row_ts,
                completed_at: &row_ts,
            };
            let _ = rag_prompt;
            let mut setup =
                match session::setup_chat_session(state.task_store.as_ref(), &mut *sql, &input)
                    .await
                {
                    Ok(setup) => setup,
                    Err(error) => {
                        tracing::error!(
                            ?error,
                            user_id,
                            task_id,
                            "chat:send session setup failed"
                        );
                        return Ok(Completion::Rollback(Err(error_ack(&format!(
                            "{error:?}"
                        )))));
                    }
                };

            let attachment_ids = payload
                .attachment_ids
                .as_ref()
                .filter(|ids| !ids.is_empty())
                .cloned()
                .unwrap_or_else(|| payload.attachment_id.into_iter().collect());
            if !attachment_ids.is_empty() {
                let invalid = crate::responses::create::contexts::link_chat_attachments(
                    &mut *sql,
                    user_id,
                    setup.user_subtask_id,
                    attachment_ids,
                    &setup.existing_subtasks,
                )
                 .await
                .map_err(|error| {
                    tracing::error!(%error, user_id, "chat:send attachment link failed");
                    FastApiError::internal()
                })?;
                if !invalid.is_empty() {
                    return Ok(Completion::Rollback(Err(error_ack(&format!(
                        "Invalid or unauthorized attachment IDs: {invalid:?}"
                    )))));
                }
            }

            if !knowledge_contexts.is_empty() {
                crate::responses::create::kb_context_creation::link_chat_contexts(
                    &mut *sql, state.task_store.as_ref(), &mut setup,
                    (user_id, session.user_name()), scope.task_owner_user_id, &row_ts,
                    &knowledge_contexts,
                ).await.map_err(|error| {
                    tracing::error!(%error, user_id, "chat:send knowledge context link failed");
                    FastApiError::internal()
                })?;
            }

            if !external_refs.is_empty() {
                crate::responses::create::contexts::link_chat_external_refs(
                    &mut *sql,
                    state.task_store.as_ref(),
                    &mut setup,
                    user_id,
                    scope.task_owner_user_id,
                    &row_ts,
                    &external_refs,
                )
                .await
                .map_err(|error| {
                    tracing::error!(%error, user_id, "chat:send external context link failed");
                    FastApiError::internal()
                })?;
            }

            super::chat_references::link(&mut *sql, user_id, setup.user_subtask_id, &references)
                .await
                .map_err(|error| {
                    tracing::error!(%error, user_id, "chat:send conversation link failed");
                    FastApiError::internal()
                })?;

            // `initialize_redis_chat_history` inputs: the task's pre-existing
            // subtasks (`create_task_and_subtasks` reads them before the
            // session). The cache check/write runs after the commit.
            fn existing_column<T: brz_mysql::FromMysqlCol>(
                row: &brz_mysql::MysqlRow,
                name: &str,
            ) -> Option<T> {
                row.get_at(crate::task_store_statements::subtask_column_index(name)?)
                    .ok()
                    .flatten()
            }
            let existing_history = setup
                .existing_subtasks
                .iter()
                .filter_map(|row| {
                    Some((
                        existing_column::<i64>(row, "message_id")?,
                        existing_column::<String>(row, "status")?,
                        existing_column::<String>(row, "role")?,
                        existing_column::<String>(row, "prompt").unwrap_or_default(),
                        existing_column::<brz_mysql::Json<Value>>(row, "result")
                            .map(|json| json.0)
                            .unwrap_or(Value::Null),
                    ))
                })
                .collect::<Vec<_>>();
            // The same rows' primary keys for `build_context_messages`'
            // candidate set (`memory.utils:207-217`: `COMPLETED` `USER` /
            // `ASSISTANT`, newest `context_limit - 1`), in message order: the
            // post-commit memory block reloads each row by `subtask.id`
            // (`f084b6fc` qs173-175), never by the `message_id` above.
            let memory_rows = setup
                .existing_subtasks
                .iter()
                .filter_map(|row| {
                    Some((
                        existing_column::<i64>(row, "id")?,
                        existing_column::<String>(row, "status")?,
                        existing_column::<String>(row, "role")?,
                    ))
                })
                .collect::<Vec<_>>();
            let existing_subtask_ids = memory_history_ids(
                &memory_rows,
                crate::responses::create::memory_context::context_limit(),
            );

            // The ACK is returned before `chat:start`; the broadcast and the
            // AI trigger run after the commit on the persisted turn.
            let created_git_repository =
                (setup.workspace_id != 0 && git_workspace).then(|| input.repository.to_json());
            let turn = ChatTurn {
                task_id: setup.task_id,
                user_subtask_id: setup.user_subtask_id,
                assistant_subtask_id: setup.assistant_subtask_id,
                user_message_id: setup.user_message_id,
                assistant_message_id: setup.assistant_message_id,
                team_id: team.id,
                bot_ids: bots.bot_ids.clone(),
                new_session,
                message: payload.message.clone(),
                interactive_form_answer: payload.interactive_form_answer.clone(),
                additional_skills: additional_skills.clone(),
                options: chat_trigger::ChatTurnOptions {
                    enable_deep_thinking: payload.enable_deep_thinking,
                    enable_web_search: payload.enable_web_search,
                    enable_clarification: payload.enable_clarification,
                    model_options: payload.model_options.clone(),
                    generation,
                },
                is_group_chat: setup
                    .task_json
                    .pointer("/spec/is_group_chat")
                    .and_then(Value::as_bool)
                    .unwrap_or(payload.is_group_chat),
                project_id: setup.raw_project_id.unwrap_or(0),
                client_origin: payload.client_origin.clone(),
                device_id: resolved_device_id.clone(),
                task_json: setup.task_json.clone(),
                created_git_repository,
                executor_name: setup.assistant_executor_name.clone(),
                executor_namespace: setup.assistant_executor_namespace.clone(),
                assistant_created_at: setup.assistant_created_at,
                existing_history,
                existing_subtask_ids,
                has_conversation_references: !references.is_empty(),
                // Filled by the post-commit refresh pair before the ACK.
                user_created_at: String::new(),
            };
            Ok(Completion::Commit(Ok(turn)))
        },
        FastApiError::internal,
    )
    .await;

    match outcome {
        Ok(Ok(turn)) => {
            // Source's two post-commit refresh pairs, each at its own commit
            // point and in its own order:
            //  * `lifecycle.py:421-429` (`prepare_execution_session`):
            //    refresh(task) [e06 106], refresh(user_subtask) [107],
            //    refresh(assistant_subtask) [108];
            //  * `task_manager.py:849-855` (`create_task_and_subtasks`):
            //    refresh(task) [f084 170], refresh(assistant_subtask) [171].
            // All of them run on the handler's admitted path before the ACK: a
            // spawned trigger has no admitted slot, so a read moved there
            // hangs and gates the START behind the whole trigger build. One
            // refresh can only claim one recorded occurrence, so the pairs are
            // not merged.
            match refresh_task_from_writer(state, turn.task_id, user_id).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    tracing::error!(
                        task_id = turn.task_id,
                        "chat:send task refresh lost the row"
                    );
                    return Ok(Reply::payload(error_ack("Internal server error")));
                }
                Err(error) => {
                    tracing::error!(%error, task_id = turn.task_id, "chat:send task refresh failed");
                    return Ok(Reply::payload(error_ack("Internal server error")));
                }
            }
            let user_row = match refresh_subtask_from_writer(
                state,
                turn.task_id,
                turn.user_subtask_id,
            )
            .await
            {
                Ok(Some(row)) => row,
                Ok(None) => {
                    tracing::error!(
                        task_id = turn.task_id,
                        subtask_id = turn.user_subtask_id,
                        "chat:send user subtask refresh lost the row"
                    );
                    return Ok(Reply::payload(error_ack("Internal server error")));
                }
                Err(error) => {
                    tracing::error!(
                        %error,
                        task_id = turn.task_id,
                        subtask_id = turn.user_subtask_id,
                        "chat:send user subtask refresh failed"
                    );
                    return Ok(Reply::payload(error_ack("Internal server error")));
                }
            };
            // `user_subtask.created_at` feeds `_broadcast_user_message`; the
            // Source never substitutes the process clock for a persisted row.
            let Some(user_created_at) =
                chat_trigger::subtask_created_at(&user_row).map(chat_trigger::iso_datetime)
            else {
                tracing::error!(
                    task_id = turn.task_id,
                    subtask_id = turn.user_subtask_id,
                    "chat:send could not decode the user subtask created_at"
                );
                return Ok(Reply::payload(error_ack("Internal server error")));
            };
            if turn.assistant_subtask_id != 0 {
                match refresh_subtask_from_writer(state, turn.task_id, turn.assistant_subtask_id)
                    .await
                {
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        tracing::error!(
                            task_id = turn.task_id,
                            subtask_id = turn.assistant_subtask_id,
                            "chat:send assistant refresh lost the row"
                        );
                        return Ok(Reply::payload(error_ack("Internal server error")));
                    }
                    Err(error) => {
                        tracing::error!(
                            %error,
                            task_id = turn.task_id,
                            subtask_id = turn.assistant_subtask_id,
                            "chat:send assistant refresh failed"
                        );
                        return Ok(Reply::payload(error_ack("Internal server error")));
                    }
                }
            }
            // `create_task_and_subtasks`' second commit point.
            match refresh_task_from_writer(state, turn.task_id, user_id).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    tracing::error!(
                        task_id = turn.task_id,
                        "chat:send second task refresh lost the row"
                    );
                    return Ok(Reply::payload(error_ack("Internal server error")));
                }
                Err(error) => {
                    tracing::error!(
                        %error,
                        task_id = turn.task_id,
                        "chat:send second task refresh failed"
                    );
                    return Ok(Reply::payload(error_ack("Internal server error")));
                }
            }
            if turn.assistant_subtask_id != 0 {
                match refresh_subtask_from_writer(state, turn.task_id, turn.assistant_subtask_id)
                    .await
                {
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        tracing::error!(
                            task_id = turn.task_id,
                            subtask_id = turn.assistant_subtask_id,
                            "chat:send second assistant refresh lost the row"
                        );
                        return Ok(Reply::payload(error_ack("Internal server error")));
                    }
                    Err(error) => {
                        tracing::error!(
                            %error,
                            task_id = turn.task_id,
                            subtask_id = turn.assistant_subtask_id,
                            "chat:send second assistant refresh failed"
                        );
                        return Ok(Reply::payload(error_ack("Internal server error")));
                    }
                }
            }
            // `task_manager.py:857-905`: `is_memory_enabled_for_user(user)` is
            // the first access to the commit-expired `user.preferences`, so
            // SQLAlchemy reloads the user through the labeled ORM projection
            // (`f084b6fc` qs172, no `LIMIT`). The fresh row's preferences — not
            // the pre-commit instance — drive the memory decision.
            let memory_user =
                match crate::user_reader::get_by_id_refresh(&state.mysql, user_id).await {
                    Ok(Some(user)) => user,
                    Ok(None) => {
                        tracing::error!(user_id, "chat:send memory user refresh lost the row");
                        return Ok(Reply::payload(error_ack("Internal server error")));
                    }
                    Err(error) => {
                        tracing::error!(%error, user_id, "chat:send memory user refresh failed");
                        return Ok(Reply::payload(error_ack("Internal server error")));
                    }
                };
            let memory_enabled = is_memory_enabled_for_user(&memory_user.preferences);
            if memory_enabled {
                // `create_task_and_subtasks`' post-commit memory block
                // (`task_manager.py:857-905`): `build_context_messages` reads
                // `user_subtask.prompt` and every pre-existing subtask's fields
                // after the commit expired those instances, so SQLAlchemy reloads
                // each row through the ORM projection (`f084b6fc` qs173-175:
                // user subtask, then the existing rows in message order).
                let memory_tables = match state.task_store.message_edit_tables(turn.task_id).await {
                    Ok(tables) => tables,
                    Err(error) => {
                        tracing::error!(%error, task_id = turn.task_id, "chat:send memory table lookup failed");
                        return Ok(Reply::payload(error_ack("Internal server error")));
                    }
                };
                let memory_statement =
                    crate::task_store_statements::subtask_by_id_labeled_refresh_statement(
                        &memory_tables.subtasks,
                    );
                let memory_ids =
                    memory_reload_ids(turn.user_subtask_id, &turn.existing_subtask_ids);
                for subtask_id in memory_ids {
                    match state
                        .mysql
                        .with_transaction(async |tx| {
                            fetch_optional_as::<brz_mysql::MysqlRow>(
                                tx,
                                RouteKey::None,
                                &memory_statement,
                                vec![StatementArg::Int(subtask_id)],
                            )
                            .await
                        })
                        .await
                    {
                        Ok(Some(_)) => {}
                        Ok(None) => {
                            tracing::error!(
                                task_id = turn.task_id,
                                subtask_id,
                                "chat:send memory subtask reload lost the row"
                            );
                            return Ok(Reply::payload(error_ack("Internal server error")));
                        }
                        Err(error) => {
                            tracing::error!(
                                %error,
                                task_id = turn.task_id,
                                subtask_id,
                                "chat:send memory subtask reload failed"
                            );
                            return Ok(Reply::payload(error_ack("Internal server error")));
                        }
                    }
                }
            }
            let turn = ChatTurn {
                user_created_at,
                ..turn
            };
            // `TaskRunMetricHooks._after_commit` for the paired insert: the
            // run totals are recorded after the setup transaction commits and
            // before the turn is broadcast or triggered.
            if turn.assistant_subtask_id != 0 {
                crate::responses::create::publish_inserted_assistant_subtask_metrics(
                    state,
                    turn.task_id,
                    turn.assistant_subtask_id,
                    turn.assistant_created_at,
                )
                .await;
            }
            // `initialize_redis_chat_history`: a reused Task with history but an
            // empty cache rebuilds it before the turn is broadcast/triggered.
            if let Some(redis) = state.redis.as_ref()
                && let Err(error) = crate::chat_history::initialize_from_subtasks(
                    redis,
                    turn.task_id,
                    turn.existing_history.clone(),
                )
                .await
            {
                tracing::warn!(%error, task_id = turn.task_id, "chat history init failed");
            }
            if let Err(error) =
                chat_trigger::after_commit(state, &turn, user_id, session.user_name(), socket_id)
                    .await
            {
                tracing::error!(
                    ?error,
                    task_id = turn.task_id,
                    "chat:send post-commit trigger failed"
                );
                return Ok(Reply::payload(error_ack("Internal server error")));
            }
            let ack = success_ack(turn.task_id, turn.user_subtask_id, turn.user_message_id);
            Ok(Reply::payload(ack).join(task_room(turn.task_id, wework)))
        }
        Ok(Err(ack)) => Ok(Reply::payload(ack)),
        Err(error) => {
            tracing::error!(?error, user_id, "chat:send transaction failed");
            Ok(Reply::payload(error_ack("Internal server error")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_defaults_match_the_source_model() {
        let payload =
            ChatSendPayload::parse(&json!({"team_id": 110467, "message": "hi"})).expect("valid");
        assert_eq!(payload.team_id, 110_467);
        assert!(payload.enable_deep_thinking);
        assert!(!payload.enable_web_search);
        assert!(!payload.enable_clarification);
        assert!(!payload.is_group_chat);
        assert_eq!(payload.client_origin, CLIENT_ORIGIN_FRONTEND);
        assert_eq!(payload.effective_task_type(), TASK_TYPE_CHAT);
    }

    #[test]
    fn image_turn_stores_the_selected_generation_size() {
        let payload = ChatSendPayload::parse(&json!({
            "team_id": 1,
            "message": "Draw a circle",
            "task_type": "image",
            "force_override_bot_model": "gpt-image-e2e",
            "generate_params": {"size": "1536x1024"}
        }))
        .unwrap();
        assert_eq!(
            payload.image_result(payload.generation_options().as_ref()),
            Some(json!({
                "image_config": {"model": "gpt-image-e2e", "size": "1536x1024"}
            }))
        );
    }

    #[test]
    fn payload_requires_the_source_required_fields() {
        let missing_team = ChatSendPayload::parse(&json!({"message": "x"})).unwrap_err();
        assert!(missing_team.contains("team_id"), "{missing_team}");
        let missing_message = ChatSendPayload::parse(&json!({"team_id": 1})).unwrap_err();
        assert!(missing_message.contains("message"), "{missing_message}");
        let unsupported_origin = ChatSendPayload::parse(
            &json!({"team_id": 1, "message": "x", "client_origin": "bogus"}),
        )
        .unwrap_err();
        assert!(
            unsupported_origin.contains("client_origin"),
            "{unsupported_origin}"
        );
    }

    #[test]
    fn a_direct_chat_always_triggers_the_ai() {
        assert!(should_trigger_ai_response(
            &json!({"spec": {"is_group_chat": false}}),
            "hello",
            "wegent-chat",
            false,
        ));
        assert!(should_trigger_ai_response(
            &json!({}),
            "hello",
            "wegent-chat",
            false,
        ));
    }

    #[test]
    fn a_group_chat_requires_the_team_mention() {
        let group = json!({"spec": {"is_group_chat": true}});
        assert!(!should_trigger_ai_response(
            &group,
            "hello everyone",
            "wegent-chat",
            false,
        ));
        assert!(should_trigger_ai_response(
            &group,
            "hello @wegent-chat",
            "wegent-chat",
            false,
        ));
        // A new task's request flag marks the group mode when the CRD is empty.
        assert!(!should_trigger_ai_response(
            &json!({}),
            "hello everyone",
            "wegent-chat",
            true,
        ));
    }

    #[test]
    fn the_ack_matches_the_recorded_shape() {
        assert_eq!(
            success_ack(893_490_636_671_579, 893_490_636_671_583, 3),
            json!({
                "task_id": 893_490_636_671_579_i64,
                "subtask_id": 893_490_636_671_583_i64,
                "message_id": 3,
            })
        );
    }

    #[test]
    fn the_room_follows_the_client_origin() {
        assert_eq!(
            task_room(893_490_636_671_579, false),
            "task:893490636671579"
        );
        assert_eq!(
            task_room(893_490_636_671_579, true),
            "wework:task:893490636671579"
        );
    }

    #[test]
    fn the_task_rewrite_carries_the_recorded_labels_and_pending_status() {
        // The recorded chat:send Task rewrite (qs161) keeps the existing
        // labels, stamps the request's model override and flips the status to
        // PENDING while preserving the previous result.
        let mut task = json!({
            "metadata": {
                "labels": {
                    "type": "online",
                    "source": "chat_shell",
                    "modelId": "old-model",
                    "taskType": "chat",
                    "autoDeleteExecutor": "false",
                }
            },
            "status": {
                "state": "Available",
                "status": "COMPLETED",
                "progress": 100,
                "result": {"value": "previous answer"},
            }
        });
        crate::responses::create::continuation::apply_request_labels(
            &mut task,
            Some("huoshan-deepseek-flash(公网)"),
            true,
            None,
        );
        crate::responses::create::continuation::mark_pending(
            &mut task,
            "2026-11-05T17:03:32.858709",
        );
        assert_eq!(
            task["metadata"]["labels"]["modelId"],
            "huoshan-deepseek-flash(公网)"
        );
        assert_eq!(task["metadata"]["labels"]["forceOverrideBotModel"], "true");
        assert_eq!(task["metadata"]["labels"]["source"], "chat_shell");
        assert_eq!(task["metadata"]["labels"]["autoDeleteExecutor"], "false");
        assert_eq!(task["status"]["status"], "PENDING");
        assert_eq!(task["status"]["progress"], 0);
        assert_eq!(task["status"]["result"]["value"], "previous answer");
    }

    /// The recorded pair: user `message_id` 3 / assistant 4, both numbered by
    /// `next_message_ids` from the task's previous max (2). The ACK uses the
    /// user subtask's own number (`ChatSessionSetup::user_message_id`).
    #[test]
    fn the_ack_message_id_is_the_user_subtask_number() {
        let ids = wegent_task_store::message_pair::next_message_ids(Some(2));
        assert_eq!(ids.next_message_id, 3);
        assert_eq!(ids.parent_id, 2);
        assert_eq!(success_ack(1, 2, ids.next_message_id)["message_id"], 3);
    }

    #[test]
    fn error_acks_are_source_dicts_without_the_reply_envelope() {
        let ack = error_ack("Task not found");
        assert_eq!(ack, json!({"error": "Task not found"}));
        assert!(ack.get("ok").is_none());
    }

    /// Source binds two timestamp shapes from the same `datetime.now()`: the
    /// `tasks.updated_at` column is SQLAlchemy's `datetime` (space-separated),
    /// while the flushed CRD's `status.updatedAt` keeps `isoformat()`'s "T".
    /// The session input therefore takes the row shape for the column and the
    /// CRD shape for `mark_pending`; recorded qs161 binds
    /// `updated_at='2026-11-05 17:03:32.804418'`.
    #[test]
    fn the_task_update_binds_the_row_timestamp_shape() {
        let now = chrono::NaiveDateTime::parse_from_str(
            "2026-11-05 17:03:32.804418",
            "%Y-%m-%d %H:%M:%S%.6f",
        )
        .expect("parse");
        let row = row_timestamp(now);
        let crd = crd_timestamp(now);
        assert_eq!(row, "2026-11-05 17:03:32.804418");
        assert!(!row.contains('T'), "{row}");
        assert_eq!(crd, "2026-11-05T17:03:32.804418");
        let mut task = json!({"status": {"status": "COMPLETED"}});
        crate::responses::create::continuation::mark_pending(&mut task, &crd);
        assert_eq!(task["status"]["updatedAt"], json!(crd));
    }

    /// The handler renders qs150 through the deployment's `tasks` table
    /// template, so a sharded store's routing expands every alias to the
    /// task id's physical shard (`tasks_0357`) instead of the base `tasks`.
    #[test]
    fn the_task_read_renders_the_deployment_shard_template() {
        let sql = active_task_projection_statement("{{tasks}}");
        assert!(
            sql.starts_with("SELECT {{tasks}}.id AS {{tasks}}_id, "),
            "{sql}"
        );
        assert!(sql.contains("\nFROM {{tasks}} \n"), "{sql}");
        assert!(
            sql.contains("WHERE {{tasks}}.id = ? AND {{tasks}}.kind = 'Task' AND {{tasks}}.is_active IN (1, 2)"),
            "{sql}"
        );
        assert!(
            !sql.contains("tasks_0357") && !sql.contains("FROM tasks "),
            "{sql}"
        );
    }

    #[test]
    fn the_task_read_uses_the_recorded_active_shape() {
        let sql = active_task_projection_statement("tasks_0357");
        // The recorded qs150 keeps SQLAlchemy's labeled projection.
        assert!(
            sql.starts_with("SELECT tasks_0357.id AS tasks_0357_id, "),
            "{sql}"
        );
        assert!(sql.contains("is_active IN (1, 2)"), "{sql}");
        assert!(!sql.contains("JSON_EXTRACT"), "{sql}");
        // The plain sharded-store projection must not be used here: it is what
        // the engine rejected as an unmatched prepared statement.
        assert!(!sql.contains("SELECT id, user_id, kind"), "{sql}");
    }

    /// The recorded qs152: the interactive-form pending scan keeps the ORM's
    /// labeled projection, the shard table as alias, and the descending order.
    #[test]
    fn the_form_scan_uses_the_recorded_desc_statement() {
        let sql = crate::task_store_statements::subtasks_by_task_desc_statement("subtasks_0357");
        assert!(
            sql.starts_with("SELECT subtasks_0357.id AS subtasks_0357_id, "),
            "{sql}"
        );
        assert!(sql.contains("\nFROM subtasks_0357 \n"), "{sql}");
        assert!(
            sql.contains(
                "WHERE subtasks_0357.task_id = ? ORDER BY subtasks_0357.message_id DESC, \
                 subtasks_0357.id DESC"
            ),
            "{sql}"
        );
        // No flat column list and no unqualified predicate.
        assert!(!sql.contains("SELECT id, user_id"), "{sql}");
        assert!(!sql.contains("WHERE task_id = ?"), "{sql}");
    }

    /// The recorded qs155: the session's existing-subtask read keeps the ORM
    /// labels plus the `message_id, created_at` ordering in SQL.
    #[test]
    fn the_session_subtask_read_keeps_the_recorded_ordering_offsets() {
        let sql = crate::task_store_statements::subtasks_by_task_message_ordered_labeled_statement(
            "subtasks_0357",
        );
        assert!(
            sql.starts_with("SELECT subtasks_0357.id AS subtasks_0357_id, "),
            "{sql}"
        );
        assert!(
            sql.contains(
                "WHERE subtasks_0357.task_id = ? ORDER BY subtasks_0357.message_id ASC, \
                 subtasks_0357.created_at ASC"
            ),
            "{sql}"
        );
        assert!(!sql.contains("SELECT id, user_id"), "{sql}");
    }

    /// The recorded qs153/qz154/qs157 task reads carry the shard table as the
    /// alias prefix and a table-qualified predicate.
    #[test]
    fn the_owned_task_reads_use_the_recorded_labeled_shape() {
        let owned = crate::task_store_statements::active_task_owned_labeled_statement("tasks_0357");
        assert!(
            owned.starts_with("SELECT tasks_0357.id AS tasks_0357_id, "),
            "{owned}"
        );
        assert!(
            owned.contains(
                "WHERE tasks_0357.id = ? AND tasks_0357.kind = 'Task' AND \
                 tasks_0357.is_active IN (1) AND tasks_0357.user_id = ? \n LIMIT 1"
            ),
            "{owned}"
        );
        let guard =
            crate::task_store_statements::owner_matches_task_id_labeled_statement("tasks_0357");
        assert_eq!(
            guard,
            "SELECT tasks_0357.id AS tasks_0357_id \nFROM tasks_0357 \n\
             WHERE tasks_0357.id = ? AND tasks_0357.user_id = ? \n LIMIT 1"
        );
    }

    /// `get_pending_interactive_form`'s block scan: the last answered-form
    /// tool block is the pending form; a result without one is not.
    #[test]
    fn the_pending_form_scan_reads_the_rendered_question_block() {
        let result = json!({
            "blocks": [
                {"tool_name": "bash", "tool_use_id": "call_1"},
                {
                    "tool_name": "interactive_form_question",
                    "tool_use_id": "call_form",
                    "render_payload": {
                        "type": "interactive_form_question",
                        "questions": [{"id": "q1", "label": "name"}]
                    }
                }
            ]
        });
        let form = pending_form_in_result(&result).expect("pending form");
        assert_eq!(form.tool_use_id, "call_form");
        assert!(pending_form_in_result(&json!({"blocks": []})).is_none());
        assert!(
            pending_form_in_result(&json!({
                "blocks": [{
                    "tool_name": "interactive_form_question",
                    "tool_use_id": "call_form",
                    "render_payload": {"type": "interactive_form_question", "questions": []}
                }]
            }))
            .is_none(),
            "an empty question list is not a pending form"
        );
    }

    /// The recorded qs148/qs149 read order.
    struct RecordingSql {
        calls: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl Default for RecordingSql {
        fn default() -> Self {
            Self {
                calls: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }
    }

    #[async_trait::async_trait]
    impl crate::request_sql::RequestSql for RecordingSql {
        async fn execute_statement(
            &mut self,
            _route: crate::request_sql::RouteKey,
            _sql: &str,
            _arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution> {
            panic!("the resolution reads at most")
        }

        async fn fetch_optional_row(
            &mut self,
            _route: crate::request_sql::RouteKey,
            sql: &str,
            _arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<Option<brz_mysql::MysqlRow>> {
            self.calls.lock().unwrap().push(sql.to_string());
            Ok(None)
        }

        async fn fetch_all_rows(
            &mut self,
            _route: crate::request_sql::RouteKey,
            _sql: &str,
            _arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<Vec<brz_mysql::MysqlRow>> {
            panic!("the resolution reads at most one row")
        }
    }

    /// `qs148` opens the transaction: the users-by-id read precedes the
    /// client-team read, both on the caller's handle. The read is the Source's
    /// direct `db.query(User)` statement, not the deployment `userReader`, so
    /// no `user:v2:data:{id}` cache GET is issued here.
    #[tokio::test]
    async fn the_transaction_reads_users_before_the_team() {
        let mut sql = RecordingSql::default();
        let outcome = resolve_scope_on(&mut sql, 6501, 110_467, None, "tasks")
            .await
            .expect("no database failure");
        assert!(outcome.is_err(), "the recording has no user");
        let calls = sql.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].contains("FROM users"), "{}", calls[0]);
        assert!(calls[0].contains("WHERE users.id = ?"), "{}", calls[0]);
        assert_eq!(calls[0], crate::user_reader::USER_BY_ID_QUERY);
    }

    /// `prepare_execution_session` walks `spec.members` in order and resolves
    /// each member Bot through the cached reader, keeping the first that
    /// resolves (`lifecycle.py:256-277`). The capture fake never resolves a
    /// Bot, so every member is read once, in member order, and the result is
    /// the Source's `No valid bots found in team` case.
    #[tokio::test]
    async fn the_first_available_bot_reads_members_in_order() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let cache: crate::task_skills::kinds::KindCacheStore<'_, _> =
            crate::task_skills::kinds::KindCacheStore {
                mysql: &mysql,
                redis: None,
                erp: None,
                resolvers: None,
            };
        let team = json!({
            "spec": {"members": [
                {"botRef": {"name": "first", "namespace": "ns-b"}},
                {"botRef": {"name": "second", "namespace": "ns-b"}},
            ]}
        });
        let resolved = resolve_first_available_bot(&cache, 6501, &team)
            .await
            .expect("the capture fake fails no read");
        assert!(resolved.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2, "one cached read per member");
        assert!(queries[0].sql.contains("kinds.name"));
        assert_eq!(queries[0].args, 3);
    }

    /// A team without members resolves no Bot and issues no read, which the
    /// caller rejects with the Source's `No valid bots found in team`.
    #[tokio::test]
    async fn a_team_without_members_resolves_no_bot() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let cache: crate::task_skills::kinds::KindCacheStore<'_, _> =
            crate::task_skills::kinds::KindCacheStore {
                mysql: &mysql,
                redis: None,
                erp: None,
                resolvers: None,
            };
        let resolved = resolve_first_available_bot(&cache, 6501, &json!({"spec": {"members": []}}))
            .await
            .expect("no member means no read");
        assert!(resolved.is_none());
        assert!(mysql.queries().is_empty());
    }

    /// `_trigger_ai`'s leading `db.refresh(task)` runs on the handler's
    /// admitted path before the ACK; its statement is the Source's primary-key
    /// task projection (`f084b6fc` qs170), not the active-task shape.
    #[test]
    fn the_post_commit_refresh_reads_the_task_by_primary_key() {
        let sql = crate::task_store_project::task_by_id_refresh_statement("tasks_0357");
        assert_eq!(
            sql,
            "SELECT id, user_id, kind, name, namespace, json, is_active, \
             created_at, updated_at, project_id, client_origin, is_group_chat \
             \nFROM tasks_0357 \nWHERE tasks_0357.id = ?"
        );
        assert!(!sql.contains("is_active IN"));
        assert!(!sql.to_uppercase().contains("LIMIT"));
    }

    /// `create_task_and_subtasks` refreshes the assistant subtask right after
    /// the task (`task_manager.py:849-855`), by primary key (`f084b6fc` qs171).
    #[test]
    fn the_post_commit_refresh_reads_the_assistant_by_primary_key() {
        let sql = crate::task_store_statements::subtask_by_id_refresh_statement("subtasks_0357");
        assert!(sql.starts_with("SELECT id, user_id, task_id, team_id, title"));
        assert!(sql.contains("FROM `subtasks_0357`"), "{sql}");
        assert!(sql.ends_with("WHERE subtasks_0357.id = ?"), "{sql}");
        assert!(!sql.to_uppercase().contains("LIMIT"));
    }

    /// The spawned trigger must not repeat the handler's refreshes: its own
    /// body performs no task/assistant read (comments naming the helper are
    /// fine; only real calls count).
    #[test]
    fn the_spawned_trigger_does_not_refresh_the_task_again() {
        let source = include_str!("chat_trigger.rs");
        let production = source.split("#[cfg(test)]").next().expect("production");
        assert!(!production.contains("refresh_task("));
        let trigger = production
            .split("async fn trigger_ai(")
            .nth(1)
            .expect("trigger_ai production body");
        assert!(!trigger.contains(".refresh_subtask("));
    }

    /// Source refreshes at two commit points, one occurrence per call: task,
    /// user, assistant (`lifecycle.py:421-429`) and task, assistant
    /// (`task_manager.py:849-855`). The handler must issue all five.
    #[test]
    fn the_post_commit_refresh_pairs_follow_the_source_commit_points() {
        let source = include_str!("chat_send.rs");
        let production = source.split("#[cfg(test)]").next().expect("production");
        let post_commit = production
            .split("Ok(Ok(turn)) => {")
            .nth(1)
            .expect("post-commit branch");
        assert_eq!(post_commit.matches("refresh_task_from_writer(").count(), 2);
        assert_eq!(
            post_commit.matches("refresh_subtask_from_writer(").count(),
            3
        );
        let first_task = post_commit
            .find("refresh_task_from_writer(")
            .expect("first task read");
        let user = post_commit
            .find("refresh_subtask_from_writer(")
            .expect("user read");
        let second_task = post_commit[first_task + 1..]
            .find("refresh_task_from_writer(")
            .map(|offset| first_task + 1 + offset)
            .expect("second task read");
        assert!(first_task < user && user < second_task);
    }

    /// The memory block reloads by primary key: the user subtask first, then
    /// `build_context_messages`' candidate set — `COMPLETED` `USER`/`ASSISTANT`
    /// rows only, the newest `context_limit - 1` of them, in message order
    /// (`f084b6fc` qs173-175). Their `message_id` values must never be bound.
    #[test]
    fn the_memory_reload_binds_subtask_ids_not_message_ids() {
        // Recorded rows in message order: 580 (msg 0, not completed), 581
        // (msg 1, USER), 582 (msg 2, ASSISTANT). `MEMORY_CONTEXT_MESSAGES`
        // defaults to 3, so `history_count` is 2 and the newest two are
        // reloaded oldest-to-newest: 581 then 582.
        let rows = vec![
            (
                893_490_636_671_580,
                "RUNNING".to_string(),
                "USER".to_string(),
            ),
            (
                893_490_636_671_581,
                "COMPLETED".to_string(),
                "USER".to_string(),
            ),
            (
                893_490_636_671_582,
                "COMPLETED".to_string(),
                "ASSISTANT".to_string(),
            ),
        ];
        let history = memory_history_ids(&rows, 3);
        assert_eq!(history, vec![893_490_636_671_581, 893_490_636_671_582]);
        let ids = memory_reload_ids(893_490_636_671_583, &history);
        assert_eq!(
            ids,
            vec![
                893_490_636_671_583,
                893_490_636_671_581,
                893_490_636_671_582
            ]
        );
        assert!(!ids.contains(&3));
        assert!(!ids.contains(&2));
        // `context_limit` caps the history at its first `limit - 1` slots; a
        // completed row outside that window is not reloaded.
        assert_eq!(memory_history_ids(&rows, 2), vec![893_490_636_671_582]);
        // An empty history (new task) reloads only the user subtask.
        assert_eq!(memory_reload_ids(42, &[]), vec![42]);
    }

    /// `is_memory_enabled_for_user`'s preference half
    /// (`app/services/memory/__init__.py:41-108`): an absent preference keeps
    /// the service default, an explicit value overrides it with the source's
    /// normalization, and malformed preferences default to enabled.
    #[test]
    fn the_memory_decision_reads_the_fresh_preferences() {
        assert!(memory_preference_enabled(""));
        assert!(memory_preference_enabled("{}"));
        assert!(!memory_preference_enabled(r#"{"memory_enabled": false}"#));
        assert!(memory_preference_enabled(r#"{"memory_enabled": true}"#));
        assert!(!memory_preference_enabled(r#"{"memory_enabled": "false"}"#));
        assert!(memory_preference_enabled(r#"{"memory_enabled": "on"}"#));
        assert!(!memory_preference_enabled(r#"{"memory_enabled": 0}"#));
        assert!(memory_preference_enabled(r#"{"memory_enabled": 1}"#));
        // An unrelated preference does not disable memory.
        assert!(memory_preference_enabled(r#"{"theme": "dark"}"#));
        // Malformed JSON and non-object roots fall back to the default.
        assert!(memory_preference_enabled("not-json"));
        assert!(memory_preference_enabled("[1, 2]"));
        // The deployment flag gates the decision before any preference value.
        if !crate::users_features::memory_enabled() {
            assert!(!is_memory_enabled_for_user(r#"{"memory_enabled": true}"#));
        }
    }

    /// The two user refreshes the chat turn issues after the setup commit keep
    /// their recorded projections: the memory-preference step uses the labeled
    /// `Session.get` projection (`f084b6fc` qs172) while `_trigger_ai`'s
    /// `db.refresh(user)` uses the bare entity projection (`e06fe28f` qs118).
    /// Both carry no `LIMIT`; neither substitutes for the other.
    #[test]
    fn the_two_user_refreshes_keep_their_recorded_projections() {
        use crate::user_reader::{USER_BY_ID_REFRESH_QUERY, USER_ENTITY_BY_ID_QUERY};
        assert!(USER_BY_ID_REFRESH_QUERY.contains("AS users_id"));
        assert!(!USER_BY_ID_REFRESH_QUERY.to_uppercase().contains("LIMIT"));
        assert!(!USER_ENTITY_BY_ID_QUERY.contains("AS users_id"));
        assert!(!USER_ENTITY_BY_ID_QUERY.to_uppercase().contains("LIMIT"));
        let trigger = include_str!("chat_trigger.rs");
        let trigger_production = trigger.split("#[cfg(test)]").next().expect("production");
        assert!(trigger_production.contains("user_entity_by_id"));
        assert!(!trigger_production.contains("get_by_id_refresh"));
        let send = include_str!("chat_send.rs");
        let send_production = send.split("#[cfg(test)]").next().expect("production");
        assert!(send_production.contains("get_by_id_refresh"));
    }
}
