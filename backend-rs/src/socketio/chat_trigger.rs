// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/chat` `chat:send`'s post-commit trigger.
//!
//! Source: `app/api/ws/chat_namespace.py::on_chat_send` broadcasts the user
//! message (`_broadcast_user_message`, `:1344`) and schedules
//! `asyncio.create_task(_trigger_ai())` (`:1226`), which calls
//! `trigger_ai_response_unified` (`app/services/chat/trigger/unified.py:92`):
//! refresh the ORM rows, build the execution request and hand it to
//! `ExecutionDispatcher.dispatch`, whose default emitter is the
//! `WebSocketResultEmitter` for this namespace.
//!
//! The ACK has already been returned by the time this module runs; both halves
//! are asynchronous with respect to it.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::internal_callback::emitter::CreatedTask;
use crate::internal_callback::publish_emit_in_room_skipping;
use crate::request_sql::{RouteKey, fetch_optional_as};
use crate::responses::create::contexts;
use crate::responses::create::request::{BuildExecutionRequestInput, build_chat_execution_request};
use crate::responses::create::team_member_context;
use crate::responses::create::{resolution, seam, subtask_bot};
use crate::sql_support::StatementArg;
use crate::state::AppState;
use crate::task_detail_api::views::context_brief_fields;

/// `CLIENT_ORIGIN_FRONTEND`.
const CLIENT_ORIGIN_FRONTEND: &str = "frontend";
/// `ContextType.CONVERSATION.value`: conversation references may point at
/// tasks the recipient cannot access, so the broadcast omits them.
const CONVERSATION_CONTEXT: &str = "conversation";

/// The persisted turn the trigger consumes, captured inside the `chat:send`
/// transaction (`prepare_execution_session`'s result).
#[derive(Debug, Clone)]
pub(crate) struct ChatTurn {
    pub task_id: i64,
    pub user_subtask_id: i64,
    pub assistant_subtask_id: i64,
    pub user_message_id: i64,
    pub assistant_message_id: i64,
    pub team_id: i64,
    pub bot_ids: Vec<i64>,
    pub new_session: bool,
    pub message: String,
    pub interactive_form_answer: Option<Value>,
    pub additional_skills: Vec<Value>,
    pub options: ChatTurnOptions,
    pub is_group_chat: bool,
    pub project_id: i64,
    pub client_origin: String,
    /// The validated device target (`resolve_chat_task_device_id`); routing
    /// selects the device WebSocket dispatch whenever it is present.
    pub device_id: Option<String>,
    pub task_json: Value,
    /// Repository written with a newly created Git task. The trigger runs only
    /// after that transaction commits, when the replica can still lag.
    pub created_git_repository: Option<Value>,
    pub executor_name: String,
    pub executor_namespace: String,
    /// The inserted assistant subtask's `created_at` captured inside the
    /// setup savepoint (`TaskRunMetricHooks._after_flush_postexec`).
    pub assistant_created_at: Option<chrono::NaiveDateTime>,
    /// The user subtask's persisted `created_at` (`isoformat()` shape), read by
    /// the post-commit refresh on the handler's admitted path and reused by
    /// `_broadcast_user_message` instead of a second read.
    pub user_created_at: String,
    /// `create_task_and_subtasks`' `existing_subtasks`: the task's rows from
    /// before this turn, used to rebuild an empty `chat:history` cache.
    pub existing_history: Vec<(i64, String, String, String, Value)>,
    /// The same rows' primary keys in the same (message) order. The memory
    /// block reloads each row by `subtask.id` (`f084b6fc` qs173-175), never by
    /// the `message_id` carried in `existing_history`.
    pub existing_subtask_ids: Vec<i64>,
    pub has_conversation_references: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ChatTurnOptions {
    pub enable_deep_thinking: bool,
    pub enable_web_search: bool,
    pub enable_clarification: bool,
    pub model_options: Option<Value>,
    pub generation: Option<Value>,
}

impl Default for ChatTurnOptions {
    fn default() -> Self {
        Self {
            enable_deep_thinking: true,
            enable_web_search: false,
            enable_clarification: false,
            model_options: None,
            generation: None,
        }
    }
}

/// Run `_broadcast_user_message` and then the asynchronous `_trigger_ai`.
///
/// The broadcast is awaited like the Source's `self.emit` (its failure ends
/// the handler with the Source's error dict), while the trigger runs in its
/// own task so the ACK is never delayed by the request build or the stream.
pub(crate) async fn after_commit(
    state: &Arc<AppState>,
    turn: &ChatTurn,
    user_id: i64,
    user_name: &str,
    socket_id: &str,
) -> Result<(), FastApiError> {
    broadcast_user_message(state, turn, user_id, user_name, socket_id).await?;
    if turn.assistant_subtask_id == 0 {
        return Ok(());
    }
    let state = Arc::clone(state);
    let turn = turn.clone();
    tokio::spawn(async move {
        if let Err(error) = trigger_ai(&state, &turn, user_id).await {
            tracing::error!(
                ?error,
                task_id = turn.task_id,
                subtask_id = turn.assistant_subtask_id,
                "chat:send AI trigger failed"
            );
            finalize_trigger_failure(&state, &turn, user_id, &error).await;
        }
    });
    Ok(())
}

async fn finalize_trigger_failure(
    state: &AppState,
    turn: &ChatTurn,
    user_id: i64,
    error: &FastApiError,
) {
    use crate::internal_callback::{
        completion, emitter,
        event::{EventType, ExecutionEvent},
    };

    let Some(redis) = state.redis.as_ref() else {
        tracing::error!(
            task_id = turn.task_id,
            "chat:send failure cannot be finalized without Redis"
        );
        return;
    };
    let message = if error.status().is_server_error() {
        "Internal server error"
    } else {
        error
            .detail_message()
            .unwrap_or("Execution could not start")
    };
    let code = if error.status().is_server_error() {
        "INTERNAL_ERROR"
    } else {
        "VALIDATION_ERROR"
    };
    let ctx = completion::Completion {
        app: Some(state),
        mysql: &state.mysql,
        redis,
        tables: crate::internal_callback::tables(state),
        executor_manager: &state.executor_manager,
    };
    let result = completion::complete_terminal_event(
        &ctx,
        turn.task_id,
        turn.assistant_subtask_id,
        "FAILED",
        None,
        Some(message),
        Some(code),
        None,
        None,
    )
    .await;
    let mut event = ExecutionEvent::new(EventType::Error, turn.task_id, turn.assistant_subtask_id);
    event.message_id = Some(turn.assistant_message_id);
    event.error = Some(message.to_owned());
    event.error_code = Some(code.to_owned());
    if let Err(error) = emitter::emit_terminal_frames(
        redis,
        &event,
        Some(user_id),
        result.as_ref().unwrap_or(&Value::Null),
        None,
    )
    .await
    {
        tracing::warn!(%error, task_id = turn.task_id, "chat:send failure notification failed");
    }
}

/// `_broadcast_user_message` (`chat_namespace.py:1344-1430`): publish the
/// user subtask's `chat:message` into the task room, excluding the sender.
async fn broadcast_user_message(
    state: &AppState,
    turn: &ChatTurn,
    user_id: i64,
    user_name: &str,
    socket_id: &str,
) -> Result<(), FastApiError> {
    let Some(redis) = state.redis.as_ref() else {
        return Ok(());
    };
    // `link_contexts_to_subtask` (`preprocessing/contexts.py:697-838`) reads
    // its arguments from the session the setup commit expired: the user
    // Subtask before its own transaction commits (`chat_namespace.py:1174`),
    // then — after that commit — the Task and the user Subtask again for the
    // broadcast stage (`chat_namespace.py:1344`, between the Task and the
    // contexts read). Both Subtask reads render the same labeled projection
    // and row, so replay consumes them in this order.
    let link_tables = state
        .task_store
        .message_edit_tables(turn.task_id)
        .await
        .map_err(dependency)?;
    let mut handle = &state.mysql;
    // `#180`: `link_contexts_to_subtask`'s `subtask_id=user_subtask.id`.
    fetch_optional_as::<brz_mysql::MysqlRow>(
        &mut handle,
        RouteKey::None,
        &crate::task_store_statements::subtask_by_id_labeled_refresh_statement(
            &link_tables.subtasks,
        ),
        vec![StatementArg::Int(turn.user_subtask_id)],
    )
    .await
    .map_err(dependency)?;
    // `#184`: the broadcast stage's Task reload.
    fetch_optional_as::<brz_mysql::MysqlRow>(
        &mut handle,
        RouteKey::None,
        &crate::task_store_statements::task_by_id_labeled_refresh_statement(&link_tables.tasks),
        vec![StatementArg::Int(turn.task_id)],
    )
    .await
    .map_err(dependency)?;
    // `#185`: the broadcast stage's user Subtask reload
    // (`user_subtask.result` / `created_at` after the commit expired them).
    fetch_optional_as::<brz_mysql::MysqlRow>(
        &mut handle,
        RouteKey::None,
        &crate::task_store_statements::subtask_by_id_labeled_refresh_statement(
            &link_tables.subtasks,
        ),
        vec![StatementArg::Int(turn.user_subtask_id)],
    )
    .await
    .map_err(dependency)?;
    // `user_subtask.created_at` is the persisted DATETIME column, decoded by
    // the subtask mapper position (`created_at` is not in the task mapper
    // order). The post-commit refresh on the handler's admitted path already
    // read it, so the broadcast reuses that value instead of a second read.
    let created_at = turn.user_created_at.clone();
    // `context_service.get_briefs_by_subtask`: every context in creation
    // order, minus conversation references.
    let rows = contexts::contexts_by_subtask(&state.mysql, turn.user_subtask_id)
        .await
        .map_err(dependency)?;
    let context_rows = rows
        .into_iter()
        .filter(|row| row.context_type != CONVERSATION_CONTEXT)
        .map(|row| crate::task_detail_api::repository::ContextRow {
            subtask_contexts_id: row.id,
            subtask_contexts_subtask_id: row.subtask_id,
            subtask_contexts_context_type: row.context_type,
            subtask_contexts_name: Some(row.name),
            subtask_contexts_status: Some(row.status),
            subtask_contexts_type_data: Some(brz_mysql::Json(
                brz_json::OpaqueJson::from_serializable(&row.type_data.0),
            )),
        })
        .collect::<Vec<_>>();
    let contexts_list = context_rows
        .iter()
        .map(|row| serde_json::to_value(context_brief_fields(row)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            tracing::error!(%error, "chat:message context serialization failed");
            FastApiError::internal()
        })?;
    let payload = json!({
        "subtask_id": turn.user_subtask_id,
        "task_id": turn.task_id,
        "message_id": turn.user_message_id,
        "role": "user",
        "content": turn.message,
        "sender": {
            "user_id": user_id,
            "user_name": user_name,
        },
        "created_at": created_at,
        "attachment": Value::Null,
        "attachments": [],
        "contexts": contexts_list,
        "source": Value::Null,
    });
    if let Err(error) = publish_emit_in_room_skipping(
        redis,
        "chat:message",
        &format!("task:{}", turn.task_id),
        payload,
        Some(socket_id),
    )
    .await
    {
        tracing::error!(%error, task_id = turn.task_id, "chat:message broadcast failed");
        return Err(FastApiError::internal());
    }
    Ok(())
}

/// The `chat:retry` trigger: the Source awaits `trigger_ai_response_unified` on
/// the already reset subtask, so the same request build and dispatch run
/// without the send path's user-message broadcast.
pub(crate) async fn trigger_existing(
    state: &Arc<AppState>,
    turn: &ChatTurn,
    user_id: i64,
) -> Result<(), FastApiError> {
    trigger_ai(state, turn, user_id).await
}

/// `_trigger_ai` + `trigger_ai_response_unified`: build the execution request
/// and dispatch it with the socket emitter.
///
/// `_trigger_ai`'s leading `db.refresh(task)` / `db.refresh(assistant_subtask)`
/// do not run here: `create_task_and_subtasks` refreshes that pair on the
/// handler's admitted path before the ACK (`chat_send::handle`), so the
/// spawned task must not repeat them.
async fn trigger_ai(state: &AppState, turn: &ChatTurn, user_id: i64) -> Result<(), FastApiError> {
    // `chat_namespace.py:1237-1240`: `_trigger_ai` refreshes the Task and the
    // Team before the assistant/user reloads; both are custom-mapped
    // resources, so the refresh emits the flat projection
    // (`e06fe28f` qs115/qs116).
    super::chat_send::refresh_task_from_writer(state, turn.task_id, user_id)
        .await
        .map_err(dependency)?;
    let mut handle = &state.mysql;
    // `db.refresh(team)` reads the row once (`make_transient` afterwards only
    // detaches it), so the flat projection's row is decoded and reused instead
    // of re-selecting the same Team.
    let team: Option<crate::responses::create::kind_reload::KindEntityRow> = fetch_optional_as(
        &mut handle,
        RouteKey::None,
        &crate::task_store_statements::kind_by_id_flat_statement(),
        vec![StatementArg::Int(turn.team_id)],
    )
    .await
    .map_err(dependency)?;
    let Some(team) = team else {
        tracing::error!(
            team_id = turn.team_id,
            "chat:send trigger team row is missing"
        );
        return Err(FastApiError::internal());
    };
    let team: resolution::KindRow = team.into();
    // `_trigger_ai`'s `db.refresh(user)` (`chat_namespace.py:1237-1240`); the
    // Task and assistant subtask refreshes already ran in the handler. The
    // recording renders this refresh with the bare entity projection
    // (`SELECT users.id, users.user_name, ...`, no LIMIT), distinct from the
    // labeled `Session.get` read the memory-preference step issues.
    let Some(user) = crate::user_reader::user_entity_by_id(&state.mysql, user_id)
        .await
        .map_err(dependency)?
    else {
        tracing::error!(user_id, "chat:send trigger user row is missing");
        return Err(FastApiError::internal());
    };
    // `_get_bot_for_subtask`: the subtask's first bot id, else the team's first
    // member. The builder re-reads the same bot; this row feeds its fallback.
    let bot = match subtask_bot::bot_by_id(&state.mysql, turn.bot_ids.first().copied())
        .await
        .map_err(dependency)?
    {
        Some(bot) => bot,
        None => {
            tracing::error!(
                task_id = turn.task_id,
                "chat:send trigger bot row is missing"
            );
            return Err(FastApiError::internal());
        }
    };
    let (bot_role, team_member_prompt) =
        team_member_context(&team.json.0, &bot.name, &bot.namespace);
    let request_id = request_id();
    let persisted_options = turn
        .task_json
        .pointer("/metadata/labels/modelOptions")
        .and_then(Value::as_str)
        .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok());
    let model_options = turn
        .options
        .model_options
        .as_ref()
        .or(persisted_options.as_ref());
    let mut request = build_chat_execution_request(
        state,
        &BuildExecutionRequestInput {
            user_id,
            user_name: &user.user_name,
            user_git_info: &user.git_info,
            user_preferences: Some(&user.preferences),
            task_id: turn.task_id,
            assistant_subtask_id: turn.assistant_subtask_id,
            user_subtask_id: turn.user_subtask_id,
            team: &team,
            bot: &bot,
            bot_role: &bot_role,
            team_member_prompt: team_member_prompt.as_deref(),
            bot_ids: &turn.bot_ids,
            message: &turn.message,
            reasoning: None,
            enable_tools: true,
            enable_web_search: turn.options.enable_web_search,
            enable_deep_thinking: turn.options.enable_deep_thinking,
            task_json: &turn.task_json,
            request_id: &request_id,
            message_id: turn.assistant_message_id,
            is_group_chat: turn.is_group_chat,
            task_project_id: turn.project_id,
            executor_name: &turn.executor_name,
            executor_namespace: &turn.executor_namespace,
            executor_deleted: false,
            new_session: turn.new_session,
            knowledge_base_refs: &[],
            knowledge_base_names: &[],
            // `request_preparation.py:751-755`: the frontend client origin
            // injects the web runtime guidance.
            web_runtime_guidance: turn.client_origin == CLIENT_ORIGIN_FRONTEND,
            subtask_bot_resolved: true,
        },
        &turn.additional_skills,
        turn.options.generation.as_ref(),
        model_options,
        turn.created_git_repository.as_ref(),
    )
    .await?;
    request.enable_clarification = turn.options.enable_clarification;
    if let Some(options) = model_options.and_then(Value::as_object) {
        use crate::responses::create::wework::reasoning_from_model_options;

        if let Some(selected) = reasoning_from_model_options(options) {
            let mut reasoning = request.model_config["reasoning"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            reasoning.extend(selected);
            request.model_config["reasoning"] = Value::Object(reasoning);
        }
        let speed = options.get("speed").or_else(|| options.get("service_tier"));
        let speed = speed.and_then(|value| {
            value.as_str().or_else(|| {
                ["value", "speed", "service_tier"]
                    .into_iter()
                    .find_map(|key| value[key].as_str())
            })
        });
        let service_tier = match speed.map(|value| value.trim().to_lowercase()).as_deref() {
            Some("fast" | "priority" | "快速" | "运行快速") => Some("priority"),
            Some("standard" | "default" | "普通" | "标准" | "运行标准") => Some("default"),
            _ => None,
        };
        if let Some(service_tier) = service_tier {
            request.model_config["service_tier"] = json!(service_tier);
        }
    }
    request
        .interactive_form_answer
        .clone_from(&turn.interactive_form_answer);
    if turn.has_conversation_references {
        super::chat_references::prepend_prompt(
            state,
            user_id,
            turn.user_subtask_id,
            &mut request.prompt,
        )
        .await
        .map_err(dependency)?;
    }
    let request_title = request.task_title.clone().unwrap_or_default();
    let created_task = created_task(turn, &request, &request_title);
    seam::dispatch_chat_turn(
        state,
        &mut request,
        &request_id,
        created_task,
        turn.device_id.as_deref(),
    )
    .await
}

/// `WebSocketResultEmitter`'s constructor identity for the START branch's
/// `task:created` frame: it emits only when every value is set.
fn created_task(
    turn: &ChatTurn,
    request: &crate::responses::create::dispatch::ExecutionRequest,
    title: &str,
) -> Option<CreatedTask> {
    if request.user_id == 0
        || request.team_id == 0
        || request.team_name.is_empty()
        || title.is_empty()
    {
        return None;
    }
    Some(CreatedTask {
        user_id: request.user_id,
        team_id: request.team_id,
        team_name: request.team_name.clone(),
        title: title.to_string(),
        is_group_chat: turn.is_group_chat,
        project_id: turn.project_id,
    })
}

/// `get_request_id()`'s 8-character request context (`uuid4().hex[:8]`).
fn request_id() -> String {
    let mut bytes = [0u8; 4];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `datetime.isoformat()`: microseconds only when the value has them.
pub(crate) fn iso_datetime(value: chrono::NaiveDateTime) -> String {
    use chrono::Timelike as _;
    if value.nanosecond() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// Decode `created_at` from `refresh_subtask`'s subtask projection by the
/// subtask mapper position. The completion helper's `task_column` maps the
/// *task* mapper order, where position 7 is `created_at` but in the subtask
/// projection it is `executor_deleted_at`; using it here broke the broadcast's
/// timestamp and silently fell back to the process clock.
pub(crate) fn subtask_created_at(row: &brz_mysql::MysqlRow) -> Option<chrono::NaiveDateTime> {
    let index = crate::task_store::subtask_column_index("created_at")?;
    row.get_at::<Option<chrono::NaiveDateTime>>(index)
        .ok()
        .flatten()
}

fn dependency(error: impl std::fmt::Debug) -> FastApiError {
    tracing::error!(?error, "chat:send trigger dependency failure");
    FastApiError::internal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_id_is_eight_lowercase_hex_characters() {
        let id = request_id();
        assert_eq!(id.len(), 8);
        assert!(
            id.chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
        );
    }

    #[test]
    fn a_second_precision_datetime_renders_without_a_fraction() {
        let value = chrono::NaiveDate::from_ymd_opt(2026, 11, 5)
            .unwrap()
            .and_hms_opt(17, 1, 57)
            .unwrap();
        assert_eq!(iso_datetime(value), "2026-11-05T17:01:57");
        use chrono::Timelike as _;
        let value = value.with_nanosecond(644_305_000).unwrap();
        assert_eq!(iso_datetime(value), "2026-11-05T17:01:57.644305");
    }

    #[test]
    fn created_at_decodes_by_the_subtask_mapper_position() {
        // `refresh_subtask` selects `SUBTASK_COLUMNS`, where `created_at` is
        // position 17. The completion helper's task mapper shares the name at
        // position 7, which is `executor_deleted_at` here — decoding there
        // failed and the broadcast fell back to the process clock.
        assert_eq!(
            crate::task_store::subtask_column_index("created_at"),
            Some(17)
        );
        assert_eq!(
            crate::task_store::subtask_column_index("executor_deleted_at"),
            Some(9)
        );
        assert_eq!(crate::task_store::task_column_index("created_at"), Some(7));
    }

    /// `db.refresh(team)` is the single Team read of the trigger
    /// (`chat_namespace.py:1237-1240`): the row it returns becomes the
    /// transient instance handed to the request builder, so the statement must
    /// stay the unaliased primary-key projection with no kind/active predicate
    /// and no `LIMIT`.
    #[test]
    fn the_team_refresh_is_the_single_recorded_projection() {
        let sql = crate::task_store_statements::kind_by_id_flat_statement();
        let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(
            normalized,
            "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, \
             kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \
             FROM kinds WHERE kinds.id = ?"
        );
    }

    /// `chat:send` reads the same user Subtask row twice: `#180` as
    /// `link_contexts_to_subtask`'s argument before its commit
    /// (`chat_namespace.py:1174`) and `#185` in the broadcast stage
    /// (`:1344`), between the Task read (`#184`) and the contexts read
    /// (`#186`). Both reads share the labeled projection, so they are consumed
    /// by order and must both stay.
    #[test]
    fn the_broadcast_reloads_the_subtask_at_both_recorded_stages() {
        let source = include_str!("chat_trigger.rs");
        let link_subtask = source.find("// `#180`").expect("link argument read");
        let task = source.find("// `#184`").expect("broadcast task read");
        let broadcast_subtask = source.find("// `#185`").expect("broadcast subtask read");
        let contexts = source
            .find("contexts::contexts_by_subtask(")
            .expect("contexts read");
        assert!(
            link_subtask < task && task < broadcast_subtask && broadcast_subtask < contexts,
            "the recorded read order is subtask, task, subtask, contexts"
        );
    }

    #[test]
    fn task_created_requires_the_source_gate() {
        let turn = ChatTurn {
            task_id: 1,
            user_subtask_id: 2,
            assistant_subtask_id: 3,
            user_message_id: 4,
            assistant_message_id: 5,
            team_id: 6,
            bot_ids: vec![7],
            new_session: false,
            message: "hi".into(),
            interactive_form_answer: None,
            additional_skills: Vec::new(),
            options: ChatTurnOptions::default(),
            is_group_chat: false,
            project_id: 0,
            client_origin: "frontend".into(),
            device_id: None,
            task_json: json!({}),
            created_git_repository: None,
            executor_name: String::new(),
            executor_namespace: String::new(),
            assistant_created_at: None,
            user_created_at: "2026-11-05T17:03:32".into(),
            existing_history: Vec::new(),
            existing_subtask_ids: Vec::new(),
            has_conversation_references: false,
        };
        let mut request = crate::responses::create::dispatch::ExecutionRequest {
            user_id: 6501,
            team_id: 110_467,
            team_name: "wegent-chat".into(),
            ..Default::default()
        };
        assert!(created_task(&turn, &request, "title").is_some());
        assert!(created_task(&turn, &request, "").is_none());
        request.team_name = String::new();
        assert!(created_task(&turn, &request, "title").is_none());
    }
}
