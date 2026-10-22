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
use crate::responses::auth::ResponsesUser;
use crate::responses::rate_limit::{self, RateLimit};
use crate::state::AppState;
use crate::task_creation::{TaskCrdInput, WorkspaceRepository};

use super::model::parse_model_string;
use super::model_selection;
use super::resolution::{kinds_row, resolve_team_bots};
use super::schema::{ResponseCreateInput, extract_input_text, parse_wegent_tools};
use super::seam::{self, BodyStream, DispatchInput};
use super::session::{SetupChatSessionInput, setup_chat_session};
use crate::task_skills::kinds::KindCacheStore;

/// The create response: a JSON `ResponseObject` or the SSE framing stream.
type CreateResponse = brz_http_server::HttpResponse<BodyStream>;

/// `POST /api/v1/responses`.
#[brz_http_server::post("/api/v1/responses")]
async fn create_response(
    #[inject(state)] state: &AppState,
    #[auth] user: ResponsesUser,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
    #[header("x-request-id")] request_id: Option<&str>,
    #[header("auto_delete_executor")] auto_delete_executor: Option<&str>,
    #[header("auto-delete-executor")] auto_delete_executor_dash: Option<&str>,
    body: serde_json::Value,
) -> Result<CreateResponse, FastApiError> {
    // `@limiter.limit(settings.RATE_LIMIT_CREATE_RESPONSE)`.
    let client_ip = client_ip(x_forwarded_for);
    let limit_key = user
        .rate_limit_key
        .clone()
        .unwrap_or_else(|| format!("ip:{client_ip}"));
    let limit = RateLimit::create_response();
    if !rate_limit::hit(state.redis.as_ref(), limit, &limit_key, "/api/v1/responses").await {
        return Err(FastApiError::json_body(
            StatusCode::TOO_MANY_REQUESTS,
            serde_json::json!({
                "error": format!(
                    "Rate limit exceeded: {} per {} {}",
                    limit.amount, limit.multiples, limit.granularity
                )
            }),
        ));
    }

    let input: ResponseCreateInput = serde_json::from_value(body).map_err(invalid_body)?;
    let auto_delete_executor =
        normalize_auto_delete_executor(auto_delete_executor.or(auto_delete_executor_dash))?;
    create_response_flow(
        state,
        &user,
        input,
        request_id.unwrap_or_default(),
        auto_delete_executor.as_deref(),
    )
    .await
}

/// The `create_response` flow after the body is parsed.
async fn create_response_flow(
    state: &AppState,
    user: &ResponsesUser,
    input: ResponseCreateInput,
    request_id: &str,
    auto_delete_executor: Option<&str>,
) -> Result<CreateResponse, FastApiError> {
    let user_id = i64::from(user.id);
    let model = parse_model_string(&input.model)?;

    // Team resolution reads the `kind:v2` cached documents first and
    // queries SQL on a miss, so the create flow shares the cached store.
    let kinds_cache = KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let team = kinds_cache
        .resolve_team(user_id, &model.namespace, &model.team_name)
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
    let model_type = model_selection::resolve_model_selection(
        &kinds_cache,
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
    let bots = resolve_team_bots(&kinds_cache, team.user_id, &team.json.0)
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
        .get_by_name_and_namespace_row(
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

    // `setup_chat_session`: task + workspace + paired subtasks.
    let tool_settings = parse_wegent_tools(&input.tools);
    let input_text = extract_input_text(&input.input);
    let now = chrono::Local::now().naive_local();
    let row_timestamp = now.format("%Y-%m-%d %H:%M:%S%.6f").to_string();
    let crd_timestamp = now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
    let setup = setup_chat_session(
        state.task_store.as_ref(),
        &SetupChatSessionInput {
            user_id,
            owner_user_id: user.id,
            previous_response_id: input.previous_response_id.as_deref(),
            team_id: team.id,
            bot_ids: &bots.bot_ids,
            input_text: &input_text,
            crd: TaskCrdInput {
                task_id: 0,
                team_name: &team.name,
                team_namespace: &team.namespace,
                team_user_id: team.user_id,
                message: &input_text,
                title: None,
                task_type,
                source: "chat_shell",
                api_key_name: user.api_key_name.as_deref(),
                model_id: model.model_id.as_deref(),
                force_override_bot_model: model.model_id.is_some(),
                is_group_chat: false,
                is_api_call: true,
                auto_delete_executor,
                omit_mcp_binary_output: false,
                device_id: None,
                git_workspace: false,
                created_at: &crd_timestamp,
                updated_at: &crd_timestamp,
            },
            repository: WorkspaceRepository::default(),
            client_origin: "frontend",
            created_at: &row_timestamp,
            updated_at: &row_timestamp,
            completed_at: &row_timestamp,
        },
    )
    .await?;

    // The rewritten Task CRD (override labels + KB refs) the builder reads.
    let task_json = crate::task_creation::build_task_crd(&TaskCrdInput {
        task_id: setup.task_id,
        team_name: &team.name,
        team_namespace: &team.namespace,
        team_user_id: team.user_id,
        message: &input_text,
        title: None,
        task_type,
        source: "chat_shell",
        api_key_name: user.api_key_name.as_deref(),
        model_id: model.model_id.as_deref(),
        force_override_bot_model: model.model_id.is_some(),
        is_group_chat: false,
        is_api_call: true,
        auto_delete_executor,
        omit_mcp_binary_output: false,
        device_id: None,
        git_workspace: false,
        created_at: &crd_timestamp,
        updated_at: &crd_timestamp,
    });
    let task_json = serde_json::to_value(&task_json).unwrap_or(serde_json::Value::Null);

    let (bot_role, team_member_prompt) =
        team_member_context(&team.json.0, &bot.name, &bot.namespace);

    let enable_chat_bot = tool_settings.enable_chat_bot;
    let dispatch = DispatchInput {
        user_id,
        user_name: &user.user_name,
        request_id,
        team: &team,
        bot: &bot,
        bot_role: &bot_role,
        team_member_prompt: team_member_prompt.as_deref(),
        input_text: &input_text,
        task_json: &task_json,
        setup: &setup,
        message_id: setup.assistant_message_id,
        is_group_chat: false,
        stream: input.stream,
        background: input.background,
        previous_response_id: input.previous_response_id.clone(),
        model_string: &input.model,
        enable_tools: enable_chat_bot || !tool_settings.preload_skills.is_empty(),
        enable_chat_bot,
        enable_web_search: enable_chat_bot && seam::web_search_enabled(),
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
