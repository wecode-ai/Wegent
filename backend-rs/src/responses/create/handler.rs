// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/responses` create handler
//! (`app/api/endpoints/openapi_responses.py:create_response`).
//!
//! The handler authenticates, applies the `RATE_LIMIT_CREATE_RESPONSE`
//! fixed-window limit, parses the body, resolves the team/bots/model, creates
//! the task/workspace/subtasks ([`setup_chat_session`]), and hands the
//! post-resolution dispatch to the seam ([`super::seam::dispatch_create`]).
use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;
use crate::responses::auth::{CurrentUser, DeferredResponsesUser, ResponsesUser};
use crate::responses::rate_limit::{self, RateLimit};
use crate::state::AppState;
use crate::task_creation::{TaskCrdInput, WorkspaceRepository};
use crate::transaction_outcome::Completion;

use super::kind_reload::reload_team;
use super::memory_context;
use super::model::parse_model_string;
use super::model_selection;
use super::resolution::{kinds_row, resolve_team_bots_on};
use super::schema::{ResponseCreateInput, extract_input_text, parse_wegent_tools};
use super::seam::{self, BodyStream, DispatchInput};
use super::session::{ChatSessionSetup, SetupChatSessionInput, setup_chat_session};
use crate::task_skills::kinds::KindCacheStore;

/// The create response: a JSON `ResponseObject` or the SSE framing stream.
type CreateResponse = brz_http_server::HttpResponse<BodyStream>;

/// `POST /api/v1/responses`.
#[brz_http_server::post("/api/v1/responses")]
async fn create_response(
    #[inject(state)] state: &AppState,
    #[auth] principal: DeferredResponsesUser,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
    #[header("x-request-id")] request_id: Option<&str>,
    #[header("auto_delete_executor")] auto_delete_executor: Option<&str>,
    #[header("auto-delete-executor")] auto_delete_executor_dash: Option<&str>,
    body: serde_json::Value,
) -> Result<CreateResponse, FastApiError> {
    // `@limiter.limit(settings.RATE_LIMIT_CREATE_RESPONSE)`: the key and window
    // are resolved here, but the hit runs on the request transaction because
    // `get_current_user`'s post-commit `api_keys` refresh opens it first (see
    // `create_response_flow`).
    let client_ip = client_ip(x_forwarded_for);
    let limit_key = principal
        .rate_limit_key()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("ip:{client_ip}"));
    let limit = RateLimit::create_response();

    let input: ResponseCreateInput = serde_json::from_value(body).map_err(invalid_body)?;
    create_response_flow(
        state,
        principal,
        input,
        limit,
        &limit_key,
        request_id,
        auto_delete_executor.or(auto_delete_executor_dash),
    )
    .await
}

/// `slowapi`'s `RateLimitExceeded` response body.
fn rate_limit_exceeded(limit: RateLimit) -> FastApiError {
    FastApiError::json_body(
        StatusCode::TOO_MANY_REQUESTS,
        serde_json::json!({
            "error": format!(
                "Rate limit exceeded: {} per {} {}",
                limit.amount, limit.multiples, limit.granularity
            )
        }),
    )
}

/// The endpoint body's opening gate, in Source order (`openapi_responses.py`):
/// the `@limiter.limit` wrapper rejects the request before the endpoint body
/// runs, so an over-limit request is a 429 even when its
/// `auto_delete_executor` header is invalid. Only the requests that pass the
/// limiter reach `_normalize_auto_delete_executor_header`'s 400.
fn endpoint_gate(
    rate_limited: bool,
    limit: RateLimit,
    raw_auto_delete_executor: Option<&str>,
) -> Result<Option<String>, FastApiError> {
    if rate_limited {
        return Err(rate_limit_exceeded(limit));
    }
    normalize_auto_delete_executor(raw_auto_delete_executor)
}

/// The deferred `api_keys` refresh outcome for one create request.
///
/// `None` for the key id means JWT / task-token authentication, which has no
/// row to refresh and proceeds with no `api_key_name`. An id whose row is gone
/// is Source's `ObjectDeletedError`: FastAPI's generic handler renders it as
/// `500 {"error_code": 500, "detail": "Internal server error"}`
/// (`app/core/exceptions.py:113-121`).
fn deferred_api_key_name(
    api_key_id: Option<i64>,
    reloaded: Option<crate::responses::auth::ApiKeyReloadRow>,
) -> Result<Option<String>, FastApiError> {
    match (api_key_id, reloaded) {
        (None, _) => Ok(None),
        (Some(_), Some(row)) => Ok(Some(row.name)),
        (Some(api_key_id), None) => {
            // The row is gone for a key that just authenticated. The status and
            // body stay Source's generic 500, but the cause is invisible on the
            // wire, so the id has to reach the log.
            tracing::error!(
                api_key_id,
                "deferred api_keys reload found no row for the authenticated key"
            );
            Err(FastApiError::unhandled())
        }
    }
}

/// The handler's deferred-refresh step: reload only when an API key
/// authenticated the request, then apply [`deferred_api_key_name`]. This is the
/// exact code path `create_response_flow` runs, so a test that calls it covers
/// the handler's decision rather than the pure helper alone.
async fn deferred_api_key_name_for(
    sql: &mut dyn crate::request_sql::RequestSql,
    api_key_id: Option<i64>,
) -> brz_mysql::MysqlResult<Result<Option<String>, FastApiError>> {
    let reloaded = match api_key_id {
        Some(id) => crate::responses::auth::reload_api_key_on(sql, id).await?,
        None => None,
    };
    Ok(deferred_api_key_name(api_key_id, reloaded))
}

/// The handler's authentication step on the request transaction.
///
/// The recorded session reads `api_keys` (the post-commit refresh) and then the
/// authenticating user's `users` row before any business statement, so an
/// API-key principal resolves both here instead of on a pooled connection. A
/// rejection ends the transaction before anything writes.
async fn resolve_principal_on(
    user_reader: &dyn crate::user_reader::UserByIdReader,
    sql: &mut dyn crate::request_sql::RequestSql,
    principal: DeferredResponsesUser,
) -> Result<(ResponsesUser, Option<String>), FastApiError> {
    match principal {
        DeferredResponsesUser::Resolved(user) => {
            let api_key_name = deferred_api_key_name_for(sql, user.api_key_id)
                .await
                .map_err(dependency)??;
            Ok((user, api_key_name))
        }
        DeferredResponsesUser::Deferred {
            key,
            rate_limit_key,
        } => {
            let api_key_id = key.api_key_id;
            let api_key_name = deferred_api_key_name_for(sql, Some(api_key_id))
                .await
                .map_err(dependency)??;
            let user = crate::responses::auth::resolve_authenticated_key_on(user_reader, sql, key)
                .await
                .map_err(crate::responses::auth::deferred_auth_error)?;
            Ok((
                ResponsesUser {
                    api_key_id: Some(api_key_id),
                    user,
                    rate_limit_key,
                },
                api_key_name,
            ))
        }
    }
}

/// The team/model/source-group/session state one create request resolves on its
/// single request transaction.
struct PreparedCreate {
    user: ResponsesUser,
    team: crate::responses::create::resolution::KindRow,
    bot: crate::responses::create::resolution::KindRow,
    bot_ids: Vec<i64>,
    model_type: Option<String>,
    project_id: i64,
    setup: ChatSessionSetup,
}

/// Resolve the create scope on the caller's request transaction: the cached
/// team keepers, the Model read (qs17), the cached team-bot reads, the
/// source-group lock (qs18) and `setup_chat_session` (qs19-22/30-34).
#[allow(clippy::too_many_arguments)]
async fn resolve_create_scope(
    state: &AppState,
    user: ResponsesUser,
    input: &ResponseCreateInput,
    model: &crate::responses::create::model::ModelString,
    sql: &mut dyn crate::request_sql::RequestSql,
    api_key_name: Option<&str>,
    input_text: &str,
    row_timestamp: &str,
    crd_timestamp: &str,
    auto_delete_executor: Option<&str>,
) -> Result<PreparedCreate, FastApiError> {
    let user_id = i64::from(user.id);
    // `openapi_responses.py:522-547`: a `previous_response_id` follow-up
    // resolves the recorded Task on the request session before the team and
    // model reads (`:565`), so the lookup precedes `resolve_team_on`.
    let continuation = match input.previous_response_id.as_deref() {
        Some(previous) => {
            super::continuation::resolve(
                state.task_store.as_ref(),
                sql,
                previous,
                user.id,
                crd_timestamp,
            )
            .await?
        }
        None => None,
    };
    let kinds_cache = KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let team = kinds_cache
        .resolve_team_on(sql, user_id, &model.namespace, &model.team_name)
        .await
        .map_err(dependency)?;
    let Some(team) = team.map(kinds_row) else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            format!(
                "Team '{}#{}' not found or not accessible",
                model.namespace, model.team_name
            ),
        ));
    };

    // `create_response`'s model selection (`openapi_responses.py:594-672`)
    // runs before the task is created: an explicit `model_id` resolves that
    // Model, and without one every team member's Bot is read and validated.
    let model_type = model_selection::resolve_model_selection_on(
        &kinds_cache,
        sql,
        user_id,
        &model.namespace,
        &model.team_name,
        team.user_id,
        &team.json.0,
        model.model_id.as_deref(),
    )
    .await?;
    let task_type = model_selection::model_task_type(model_type.as_deref());

    // `get_bot_ids_from_team`: one `kindReader` read per member.
    let bots = resolve_team_bots_on(sql, &kinds_cache, team.user_id, &team.json.0)
        .await
        .map_err(dependency)?;
    if bots.bot_ids.is_empty() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "No valid bots found in team",
        ));
    }

    // The first team-member bot row (`_get_first_bot`): the same cached
    // `kindReader` read.
    let bot = kinds_cache
        .get_by_name_and_namespace_row_on(
            sql,
            team.user_id,
            "Bot",
            &bots.first_bot_namespace,
            &bots.first_bot_name,
        )
        .await
        .map_err(dependency)?;
    let Some(bot) = bot.map(kinds_row) else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "No valid bots found in team",
        ));
    };

    // `create_new_task`'s API source group (`params.is_api_call`): the group
    // id is written to the placeholder Task row. A `previous_response_id`
    // reuse skips task creation, so the source resolves no group.
    let project_id = if input.previous_response_id.is_none() {
        crate::task_source_group::get_or_create_task_source_group_on(
            sql,
            state.redis.as_ref(),
            user_id,
            "frontend",
            "api",
        )
        .await
        .map_err(source_group_error)?
    } else {
        0
    };

    // The source runs `prepare_execution_session` on the request's one SQLAlchemy
    // session: the task/workspace/subtask savepoints and inserts belong to the
    // request transaction, which is committed once when setup returns.
    let setup = setup_chat_session(
        state.task_store.as_ref(),
        sql,
        &SetupChatSessionInput {
            user_id,
            owner_user_id: user.id,
            continuation,
            team_id: team.id,
            bot_ids: &bots.bot_ids,
            input_text,
            crd: TaskCrdInput {
                task_id: 0,
                team_name: &team.name,
                team_namespace: &team.namespace,
                team_user_id: team.user_id,
                message: input_text,
                title: None,
                task_type,
                source: "chat_shell",
                project_id,
                api_key_name,
                model_id: model.model_id.as_deref(),
                force_override_bot_model: model.model_id.is_some(),
                is_group_chat: false,
                is_api_call: true,
                auto_delete_executor,
                omit_mcp_binary_output: false,
                device_id: None,
                git_workspace: false,
                created_at: crd_timestamp,
                updated_at: crd_timestamp,
            },
            repository: WorkspaceRepository::default(),
            client_origin: "frontend",
            project_id,
            created_at: row_timestamp,
            updated_at: row_timestamp,
            completed_at: row_timestamp,
        },
    )
    .await?;

    Ok(PreparedCreate {
        user,
        team,
        bot,
        bot_ids: bots.bot_ids,
        model_type,
        project_id,
        setup,
    })
}

/// The `create_response` flow after the body is parsed.
#[allow(clippy::too_many_arguments)]
async fn create_response_flow(
    state: &AppState,
    principal: DeferredResponsesUser,
    input: ResponseCreateInput,
    limit: RateLimit,
    limit_key: &str,
    request_id: Option<&str>,
    // The raw `auto_delete_executor` / `auto-delete-executor` header; the
    // endpoint body normalizes it after the rate-limit check.
    raw_auto_delete_executor: Option<&str>,
) -> Result<CreateResponse, FastApiError> {
    // `setup_chat_session`: task + workspace + paired subtasks.
    let input_text = extract_input_text(&input.input);
    let now = chrono::Local::now().naive_local();
    let row_timestamp = now.format("%Y-%m-%d %H:%M:%S%.6f").to_string();
    let crd_timestamp = now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string();

    // The source runs `get_current_user`, the rate-limit wrapper, team/model
    // resolution, the source-group lock and `prepare_execution_session` on the
    // request's one SQLAlchemy session (`openapi_responses.py` ->
    // `chat_session.py` -> `lifecycle.py:209`). `core/security.py:650` commits
    // the `last_used_at` update, then the endpoint's first access to the
    // expired `api_key_record` re-selects it; that refresh is the transaction's
    // first statement. The `@limiter.limit` wrapper, the endpoint body's
    // `auto_delete_executor` normalization and the Model read follow it in that
    // recorded order. Every rejection ends that session with `db.rollback()`,
    // so it must leave the closure as an error rather than as an `Ok` value
    // that `with_transaction` would commit.
    let prepared = crate::transaction_outcome::run(
        &state.mysql,
        async |transaction| {
            let mut sql: &mut brz_mysql::MysqlTransactionService = transaction;
            // The api_keys refresh and the authenticating user's `users` read
            // both belong to this transaction (`get_current_user` ran on the
            // request session), so they precede every business statement.
            let (user, api_key_name) =
                resolve_principal_on(state.user_reader.as_ref(), &mut sql, principal).await?;
            let rate_limited =
                !rate_limit::hit(state.redis.as_ref(), limit, limit_key, "/api/v1/responses").await;
            let auto_delete_executor =
                endpoint_gate(rate_limited, limit, raw_auto_delete_executor)?;
            let model = parse_model_string(&input.model)?;
            // `openapi_responses.py:513`: `parse_wegent_tools` runs after the
            // limiter (`:440`), the header normalization (`:504`) and the model
            // parse (`:511`), so a malformed `knowledge_base` tool must not
            // outrank their rejections.
            let tool_settings = parse_wegent_tools(&input.tools)?;
            match resolve_create_scope(
                state,
                user,
                &input,
                &model,
                &mut sql,
                api_key_name.as_deref(),
                &input_text,
                &row_timestamp,
                &crd_timestamp,
                auto_delete_executor.as_deref(),
            )
            .await
            {
                Ok(prepared) => Ok(Completion::Commit((
                    prepared,
                    model,
                    auto_delete_executor,
                    tool_settings,
                ))),
                Err(error) => Err(error),
            }
        },
        // `run` logs the transaction failure itself; the source renders a
        // failed commit or rollback as the generic 500 handler.
        FastApiError::internal,
    )
    .await?;
    let (
        PreparedCreate {
            user,
            team,
            bot,
            bot_ids,
            setup,
            ..
        },
        _model,
        _auto_delete_executor,
        tool_settings,
    ) = prepared;
    // `chat_session.py:104`: the memory-context guard's `enable_chat_bot`
    // (`openapi_responses.py` passes `enable_deep_thinking = enable_chat_bot`).
    let enable_chat_bot = tool_settings.enable_chat_bot;

    // `lifecycle.py:421-429`: `prepare_execution_session` commits inside the
    // call (`commit=True`; `chat_session.py:91` passes no override) and only
    // then runs `db.refresh(task)` / `db.refresh(user_subtask)`. The Source
    // COMMIT therefore precedes these reads, so they are a post-commit read
    // phase rather than members of the setup transaction.
    // Source's `db.refresh(task)` is a plain primary-key re-read on the
    // already-bound row. `refresh_task` resolves its table through
    // `project_task_handle` -> `task_table_for_lookup`, which probes the owner
    // on the pool after commit; the create path therefore refreshes on its own
    // read-phase transaction with the route the committed row already proved.
    match state
        .mysql
        .with_transaction(async |transaction| {
            let mut sql: &mut brz_mysql::MysqlTransactionService = transaction;
            state
                .task_store
                .refresh_task_on(&mut sql, setup.task_id, i64::from(user.id))
                .await?;
            Ok::<(), brz_mysql::MysqlError>(())
        })
        .await
    {
        Ok(()) => {}
        Err(error) => return Err(dependency(error)),
    }
    let _ = state
        .task_store
        .refresh_subtask(setup.task_id, setup.user_subtask_id)
        .await
        .map_err(dependency)?;

    // `TaskRunMetricHooks`: the source's `after_flush_postexec` listener
    // captured the new assistant subtask's `created_at` (read inside the
    // insert's savepoint) and `after_commit` records it in the run totals. The
    // insert is committed by the store, so publish immediately after setup.
    publish_inserted_assistant_subtask_metrics(
        state,
        setup.task_id,
        setup.assistant_subtask_id,
        setup.assistant_created_at,
    )
    .await;

    // `openapi/chat_session.py:102-135`: after `prepare_execution_session`'s
    // commit/refreshes and before the caller reloads the user/Team, the guarded
    // long-term-memory context build touches each existing subtask
    // (`memory/utils.py:207-214`), i.e. one primary-key refresh per row.
    if enable_chat_bot && memory_context::enabled() {
        let is_group_chat = memory_context::is_group_chat(&setup.task_json);
        let messages = memory_context::build_context_messages(
            &state.mysql,
            state.task_store.as_ref(),
            setup.task_id,
            &setup.existing_subtasks,
            &input_text,
            i64::from(user.id),
            &user.user_name,
            is_group_chat,
        )
        .await
        .map_err(dependency)?;
        // `chat_session.py:137-170`: the prepared context goes to the
        // fire-and-forget mem0 save with the task/team/workspace metadata; its
        // failures are logged in the background and never change the response.
        let save = memory_context::SaveRequest {
            messages,
            user_id: user.id.to_string(),
            team_id: team.id.to_string(),
            task_id: setup.task_id.to_string(),
            subtask_id: setup.user_subtask_id.to_string(),
            workspace_id: memory_context::workspace_id(&setup.task_json),
            project_id: memory_context::metadata_project_id(setup.raw_project_id),
            is_group_chat,
        };
        // `chat_session.py:137-170`: the startup-owned responses supervisor
        // runs the fire-and-forget save; a full queue is logged, never silent.
        state
            .responses_dispatch
            .submit(crate::responses::dispatch::DispatchJob::MemorySave(save));
    }

    // `openapi_responses.py:755` / `:1122-1123`: `created_at` is captured right
    // after the setup refreshes and metric publication, before the request
    // user/team reloads and `build_execution_request`, and that one value is
    // reused by every response branch.
    let created_at = chrono::Utc::now().timestamp();

    // `_create_non_streaming_response_unified`'s first access to the request
    // user after `setup_chat_session` (`openapi_responses.py:761`,
    // `user_id = user.id`), which the commit above expired: the ORM re-selects
    // the `users` row by primary key before its values are used again.
    let user = reload_request_user(state, &user).await?;
    // The same expiry covers the Team Kind: `build_execution_request` receives
    // the expired instance (`openapi_responses.py:795-799`) and its first
    // `team.` access reloads the row by primary key.
    let team = reload_team(state, &team).await?;
    let user_id = i64::from(user.id);

    // `setup.task` is the Task CRD this request built or reused: a resumed
    // Task keeps its stored workspace refs, project id, and labels, while a new
    // Task carries the rewrite. The builder reads this snapshot directly.
    let task_json = setup.task_json.clone();
    let task_project_id = setup.workspace_project_id;

    // `_get_current_knowledge_base_refs` / `_get_inherited_knowledge_base_refs`
    // (`openapi_responses.py:237-254`): this request's normalized KB refs, else
    // the task's persisted API scopes. The inherited refs only feed
    // `enable_tools`; they are not passed to `build_execution_request`.
    let current_kb_refs = tool_settings.knowledge_base_refs.clone();
    let has_inherited_kb_refs = current_kb_refs.is_empty()
        && task_json
            .get("spec")
            .and_then(|spec| spec.get("knowledgeBaseScopes"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|refs| !refs.is_empty());

    let (bot_role, team_member_prompt) =
        team_member_context(&team.json.0, &bot.name, &bot.namespace);

    // `request_preparation.py:966-970`: the middleware request id, or the
    // deterministic `req_{assistant_subtask.id}` fallback when the request
    // context carries none.
    let request_id = request_id
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("req_{}", setup.assistant_subtask_id));

    let dispatch = DispatchInput {
        created_at,
        user_id,
        user_name: &user.user_name,
        user_git_info: &user.git_info,
        user_preferences: Some(&user.preferences),
        request_id: &request_id,
        team: &team,
        bot: &bot,
        bot_role: &bot_role,
        team_member_prompt: team_member_prompt.as_deref(),
        bot_ids: &bot_ids,
        input_text: &input_text,
        task_json: &task_json,
        setup: &setup,
        message_id: setup.assistant_message_id,
        is_group_chat: false,
        stream: input.stream,
        background: input.background,
        previous_response_id: input.previous_response_id.clone(),
        model_string: &input.model,
        task_project_id,
        executor_name: &setup.assistant_executor_name,
        executor_namespace: &setup.assistant_executor_namespace,
        // `enable_tools`: `enable_chat_bot or current/inherited KB refs`
        // (`openapi_responses.py:762-770`).
        enable_tools: enable_chat_bot
            || !tool_settings.preload_skills.is_empty()
            || !current_kb_refs.is_empty()
            || has_inherited_kb_refs,
        knowledge_base_refs: &current_kb_refs,
        knowledge_base_names: &tool_settings.knowledge_base_names,
        enable_chat_bot,
        enable_web_search: enable_chat_bot && seam::web_search_enabled(),
        reasoning: input.reasoning.as_ref(),
    };
    seam::dispatch_create(state, &dispatch).await
}

/// The message.body validation failure: FastAPI's `422` for a malformed body.
fn invalid_body(error: serde_json::Error) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, error.to_string())
}

/// `_normalize_auto_delete_executor_header` (`openapi_responses.py:161-175`):
/// the `auto_delete_executor` / `auto-delete-executor` request header carried
/// into the Task CRD's `autoDeleteExecutor` label. An unrecognized value is the
/// source's `400 Invalid auto_delete_executor header value.`.
fn normalize_auto_delete_executor(value: Option<&str>) -> Result<Option<String>, FastApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(Some("true".to_string())),
        "false" | "0" | "no" | "off" | "" => Ok(Some("false".to_string())),
        _ => Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Invalid auto_delete_executor header value. Expected true or false.",
        )),
    }
}

/// A dependency (MySQL) failure: the source propagates it, FastAPI renders 500.
pub(super) fn dependency(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "responses create dependency failure");
    FastApiError::internal()
}

/// `get_or_create_task_source_group` errors: a missing owner is the source's
/// `404 {"detail": "User not found"}`; a database failure stays a 500.
fn source_group_error(error: crate::task_source_group::SourceGroupError) -> FastApiError {
    match error {
        crate::task_source_group::SourceGroupError::UserNotFound => {
            FastApiError::detail(StatusCode::NOT_FOUND, "User not found")
        }
        crate::task_source_group::SourceGroupError::Mysql(error) => dependency(error),
    }
}

/// The matching team member's `role` and `prompt` for the resolved bot.
fn team_member_context(
    team_json: &serde_json::Value,
    bot_name: &str,
    bot_namespace: &str,
) -> (String, Option<String>) {
    let members = team_json
        .get("spec")
        .and_then(|spec| spec.get("members"))
        .and_then(serde_json::Value::as_array);
    let Some(member) = members.and_then(|members| {
        members.iter().find(|member| {
            member.get("botRef").is_some_and(|reference| {
                reference.get("name").and_then(serde_json::Value::as_str) == Some(bot_name)
                    && reference
                        .get("namespace")
                        .and_then(serde_json::Value::as_str)
                        == Some(bot_namespace)
            })
        })
    }) else {
        return (String::new(), None);
    };
    let role = member
        .get("role")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let prompt = member
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    (role, prompt)
}

/// `request.client.host` / the leftmost `x-forwarded-for` entry.
fn client_ip(x_forwarded_for: Option<&str>) -> String {
    x_forwarded_for
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

/// `Session._load_expired` for the request user: the first attribute access
/// after the setup commit re-selects the expired `User` row by primary key with
/// the unaliased projection and no `LIMIT` (`openapi_responses.py:761`,
/// `SQLAlchemy` `loading.load_on_pk_identity`). The reloaded row replaces the
/// in-memory values for the rest of the request; the authenticating
/// `api_key_name` is not a `users` column and is carried over.
async fn reload_request_user(
    state: &AppState,
    user: &ResponsesUser,
) -> Result<CurrentUser, FastApiError> {
    let record = state
        .user_reader
        .get_entity_by_id(i64::from(user.id))
        .await
        .map_err(|error| {
            tracing::error!(%error, "responses request user reload failed");
            FastApiError::internal()
        })?;
    let Some(record) = record else {
        // The source's expired-instance access raises `ObjectDeletedError`
        // when the row is gone, which FastAPI renders as an internal error.
        tracing::error!("responses request user reload found no row");
        return Err(FastApiError::internal());
    };
    Ok(CurrentUser {
        id: i32::try_from(record.id).unwrap_or(user.id),
        user_name: record.user_name,
        api_key_name: user.api_key_name.clone(),
        api_key_id: user.api_key_id,
        git_info: record.git_info,
        preferences: record.preferences,
    })
}

/// `TaskRunMetricHooks._after_flush_postexec`/`_after_commit` for the paired
/// subtask insert: the hook captured the inserted assistant subtask's
/// `created_at` during the setup flush (`created_at` here), and
/// `prepare_execution_session` refreshes the assistant subtask after the commit
/// (`db.refresh(assistant_subtask)`), which the source issues unconditionally.
/// The new row is then recorded in the `task-run-monitor:v2` run totals. The
/// source hook logs and swallows a store failure, so neither step can change
/// the committed setup.
async fn publish_inserted_assistant_subtask_metrics(
    state: &AppState,
    task_id: i64,
    subtask_id: i64,
    created_at: Option<chrono::NaiveDateTime>,
) {
    if !matches!(
        state.task_store.refresh_subtask(task_id, subtask_id).await,
        Ok(Some(_))
    ) {
        return;
    }
    // `if not subtask.id or not subtask.created_at: continue`: a missing
    // captured timestamp skips the event.
    let Some(created_at) = created_at else {
        return;
    };
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    if let Err(error) =
        crate::task_run_metrics::record_inserted_assistant_subtask(redis, subtask_id, created_at)
            .await
    {
        tracing::warn!(%error, "task run metrics publish failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `None` for the key id means JWT / task-token authentication: the create
    /// path proceeds with no `api_key_name` and issues no refresh.
    #[test]
    fn no_api_key_proceeds_without_a_name() {
        assert_eq!(deferred_api_key_name(None, None).unwrap(), None);
    }

    /// An API-key request takes the name from the refreshed row.
    #[test]
    fn refreshed_row_supplies_the_api_key_name() {
        let row = crate::responses::auth::ApiKeyReloadRow {
            name: "service-key".to_string(),
            key_type: "service".to_string(),
        };
        assert_eq!(
            deferred_api_key_name(Some(6539), Some(row)).unwrap(),
            Some("service-key".to_string())
        );
    }

    /// `@limiter.limit` runs before the endpoint body normalizes the header
    /// (`openapi_responses.py:440` vs `:504-506`): an over-limit request is a
    /// 429 even though its `auto_delete_executor` value is invalid, and the
    /// rejection does not fall through to the endpoint's 400.
    #[test]
    fn the_rate_limit_precedes_auto_delete_executor_validation() {
        let limit = RateLimit::per_minute(60);
        let invalid = Some("sometimes");

        let over_limit = endpoint_gate(true, limit, invalid).expect_err("over the limit");
        assert_eq!(over_limit.status(), StatusCode::TOO_MANY_REQUESTS);

        // The same value is the endpoint's own 400 once the limiter admits it.
        let under_limit = endpoint_gate(false, limit, invalid).expect_err("invalid header");
        assert_eq!(under_limit.status(), StatusCode::BAD_REQUEST);

        assert_eq!(
            endpoint_gate(false, limit, Some("true")).expect("valid header"),
            Some("true".to_string())
        );
    }

    /// Records the statements issued through the handle.
    #[derive(Default)]
    struct NoRowRequestSql {
        calls: std::sync::Mutex<Vec<(crate::request_sql::RouteKey, String, usize)>>,
    }

    #[async_trait::async_trait]
    impl crate::request_sql::RequestSql for NoRowRequestSql {
        async fn execute_statement(
            &mut self,
            route: crate::request_sql::RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(brz_mysql::MysqlExecution {
                rows_affected: 1,
                last_insert_id: 0,
            })
        }

        async fn fetch_optional_row(
            &mut self,
            route: crate::request_sql::RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<Option<brz_mysql::MysqlRow>> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(None)
        }

        async fn fetch_all_rows(
            &mut self,
            route: crate::request_sql::RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<Vec<brz_mysql::MysqlRow>> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(Vec::new())
        }
    }

    /// The handler's own step, not the helper: a JWT/task-token request issues
    /// no refresh and continues with no name.
    #[tokio::test]
    async fn handler_step_skips_the_refresh_without_an_api_key() {
        let mut sql = NoRowRequestSql::default();
        let name = deferred_api_key_name_for(&mut sql, None)
            .await
            .expect("no mysql error")
            .expect("no auth error");
        assert_eq!(name, None);
        assert!(sql.calls.lock().unwrap().is_empty(), "no statement may run");
    }

    /// The handler's own step fails an API-key request whose row is gone.
    #[tokio::test]
    async fn handler_step_fails_when_the_api_key_row_is_gone() {
        let mut sql = NoRowRequestSql::default();
        let error = deferred_api_key_name_for(&mut sql, Some(6539))
            .await
            .expect("no mysql error")
            .expect_err("must fail");
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(sql.calls.lock().unwrap().len(), 1, "one refresh read");
    }

    /// Only an API-key request whose row vanished maps to Source's
    /// `ObjectDeletedError` rendering.
    #[test]
    fn missing_row_for_an_api_key_request_is_the_internal_error() {
        let error = deferred_api_key_name(Some(6539), None).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
