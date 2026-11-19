// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework runtime dispatch: the direct ExecutionRequest, the model catalog
//! execution config, `runtime.tasks.get`/`send`, and device readiness
//! (`app/services/wework_api/service.py`, `native.py`,
//! `runtime_work_service.py:1441+`).
use brz_http_server::StatusCode;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::models::ModelSelection;
use super::models::cloud_model_config;
use super::{RUNTIME_EXECUTION_ID_BASE, RUNTIME_EXECUTION_ID_SPAN, WeworkResponseCreate};
use crate::auth::UserRow;
use crate::background_jobs::project::runtime_rpc;
use crate::device_identity::resolve_runtime_route_identity;
use crate::http_compat::FastApiError;
use crate::responses::create::tokens;
use crate::state::AppState;

fn runtime_execution_ids() -> (i64, i64) {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    let value = u64::from_le_bytes(bytes) % RUNTIME_EXECUTION_ID_SPAN;
    let base = RUNTIME_EXECUTION_ID_BASE + value as i64;
    (base, base + 1)
}

/// `_runtime_task_title`: the first line, capped at 80 characters.
pub(super) fn runtime_task_title(body: &WeworkResponseCreate) -> String {
    if let Some(title) = body
        .execution
        .as_ref()
        .and_then(|execution| execution.title.as_deref())
    {
        return title.to_string();
    }
    let title: String = body
        .input_text()
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(80)
        .collect();
    if title.is_empty() {
        "Untitled runtime task".to_string()
    } else {
        title
    }
}

/// `positive_token_limit`: a positive integer, never a boolean.
#[allow(clippy::too_many_arguments)]
pub(super) async fn execution_request(
    state: &AppState,
    user_id: i64,
    task_id: &str,
    device_id: &str,
    message: &str,
    title: &str,
    client_user_message_id: &str,
    selection: &ModelSelection,
) -> Result<Value, FastApiError> {
    // `_build_direct_wework_runtime_execution_request`: the compile reads its
    // own user row (`_get_user(db, user_id)`), independent of the endpoint's
    // earlier principal read.
    let user = user_row(state, user_id).await?;
    let auth_token =
        tokens::create_task_token(state, 0, 0, user_id, &user.user_name).map_err(|error| {
            tracing::error!(?error, "wework task token creation failed");
            FastApiError::internal()
        })?;
    let now = chrono::Utc::now().timestamp();
    let ttl = crate::config::env_or_dotenv("SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(14_400);
    let skill_identity_token = runtime_rpc::sign(
        state,
        &json!({
            "type": "skill_identity",
            "user_id": user.id,
            "user_name": user.user_name,
            "runtime_type": "executor",
            "runtime_name": format!("wework-runtime-{task_id}"),
            "iat": now,
            "exp": now + ttl * 60,
        }),
    )
    .map_err(|error| {
        tracing::error!(?error, "wework skill identity token creation failed");
        FastApiError::internal()
    })?;
    let model_config = cloud_model_config(state, user_id, selection).await?;
    let (generated_task_id, subtask_id) = runtime_execution_ids();
    let task_id_value = if task_id.is_empty() {
        generated_task_id.to_string()
    } else {
        task_id.to_string()
    };
    let reasoning_config = model_config
        .get("reasoning")
        .cloned()
        .unwrap_or(Value::Null);
    // Built field-by-field: a single `json!` literal of this size exceeds the
    // macro recursion limit.
    let mut object = Map::new();
    macro_rules! set {
        ($($key:literal => $value:expr),* $(,)?) => {
            $(object.insert($key.to_string(), $value);)*
        };
    }
    set! {
        "task_id" => json!(task_id_value),
        "subtask_id" => json!(subtask_id),
        "subtask_next_id" => json!(null),
        "team_id" => json!(0),
        "team_name" => json!("Wework"),
        "team_namespace" => json!("default"),
        "team_owner" => json!({}),
        "subtask_title" => json!(format!("{title} - Assistant")),
        "task_title" => json!(title),
        "user" => json!({"id": user.id, "name": user.user_name, "user_name": user.user_name, "email": user.email.clone().unwrap_or_default()}),
        "user_id" => json!(user_id),
        "user_name" => json!(user.user_name),
        "bot" => json!([]),
        "bot_name" => json!(""),
        "bot_namespace" => json!("wework"),
        "model_config" => json!(model_config),
        "prompt" => json!(message),
        "kb_meta_prompt" => json!(""),
        "enable_tools" => json!(true),
        "enable_web_search" => json!(false),
        "enable_clarification" => json!(false),
        "enable_deep_thinking" => json!(false),
        "enable_tool_output_guard" => json!(true),
        "search_engine" => json!(null),
        "skill_names" => json!([]),
        "skill_configs" => json!([]),
        "preload_skills" => json!([]),
        "user_selected_skills" => json!([]),
        "skills" => json!([]),
        "skill_refs" => json!({}),
        "preload_skill_refs" => json!({}),
        "mcp_servers" => json!([]),
        "knowledge_base_ids" => json!(null),
        "document_ids" => json!(null),
        "knowledge_base_scopes" => json!([]),
        "external_knowledge_refs" => json!(null),
        "selected_knowledge_prompt" => json!(""),
        "provider_native_knowledge" => json!(false),
        "is_user_selected_kb" => json!(true),
        "kb_tool_access_mode" => json!("full"),
        "workspace" => json!({"project": {"project_id": null, "workspace_source": "local_path", "execution_target_type": "local", "device_id": device_id}}),
        "project_id" => json!(null),
        "standalone_chat_workspace" => json!(true),
        "workspace_source" => json!("local_path"),
        "project_workspace_path" => json!(null),
        "execution_target_type" => json!("local"),
        "device_id" => json!(device_id),
        "runtime_project_key" => json!(null),
        "runtime_project_name" => json!(null),
        "runtime_workspace_roots" => json!([]),
        "project_plugin_ids" => json!([]),
        "git_domain" => json!(null),
        "git_repo" => json!(null),
        "git_repo_id" => json!(null),
        "branch_name" => json!(null),
        "git_url" => json!(null),
        "git_auth_transport" => json!("none"),
        "message_id" => json!(null),
        "user_message_id" => json!(null),
        "user_subtask_id" => json!(null),
        "is_group_chat" => json!(false),
        "history_limit" => json!(null),
        "stateless" => json!(false),
        "new_session" => json!(true),
        "ephemeral" => json!(false),
        "fork_runtime" => json!(null),
        "inherited_sessions" => json!([]),
        "legacy_session_bindings" => json!([]),
        "collaboration_model" => json!("single"),
        "mode" => json!("code"),
        "request_id" => json!(""),
        "client_user_message_id" => json!(client_user_message_id),
        "contexts" => json!([]),
        "history" => json!([]),
        "interactive_form_answer" => json!(null),
        "auth_token" => json!(auth_token),
        "skill_identity_token" => json!(skill_identity_token),
        "backend_url" => json!(""),
        "attachments" => json!([]),
        "is_subscription" => json!(false),
        "system_mcp_config" => json!(null),
        "task_data" => json!(null),
        "extra_tools" => json!([]),
        "timezone" => json!("Asia/Shanghai"),
        "status" => json!(null),
        "progress" => json!(null),
        "type" => json!(null),
        "task_mode" => json!("code"),
        "executor_name" => json!(null),
        "executor_namespace" => json!(null),
        "executor_image" => json!(null),
        "executor_type" => json!(null),
        "callback_url" => json!(null),
        "validation_params" => json!(null),
        "sandbox_metadata" => json!(null),
        "runtime_permission_profile" => json!(":danger-full-access"),
        "runtime_executable_path" => json!(null),
        "claude_permission_mode" => json!(null),
        "cloud_project_id" => json!(null),
        "origin" => json!(null),
        "reasoning_config" => json!(reasoning_config),
        "skip_git_clone" => json!(false),
        "created_at" => json!(null),
        "updated_at" => json!(null),
        "trace_context" => json!(null),
    }
    Ok(Value::Object(object))
}

/// `_runtime_task_create_payload` for the direct Wework path.
pub(super) async fn create_payload(
    state: &AppState,
    user_id: i64,
    body: &WeworkResponseCreate,
    device_id: &str,
    task_id: &str,
    client_user_message_id: &str,
    selection: &ModelSelection,
) -> Result<Value, FastApiError> {
    let message = body.input_text();
    let title = runtime_task_title(body);
    let execution = execution_request(
        state,
        user_id,
        task_id,
        device_id,
        &message,
        &title,
        client_user_message_id,
        selection,
    )
    .await?;
    Ok(assemble_create_payload(
        execution,
        &message,
        &title,
        task_id,
        client_user_message_id,
        selection,
    ))
}

/// The `_runtime_task_create_payload` wire object, split from the token and
/// catalog work so its shape is directly testable.
pub(super) fn assemble_create_payload(
    execution: Value,
    message: &str,
    title: &str,
    task_id: &str,
    client_user_message_id: &str,
    selection: &ModelSelection,
) -> Value {
    json!({
        "runtime": "codex",
        "message": message,
        "title": title,
        "executionRequest": execution,
        "taskId": task_id,
        "clientUserMessageId": client_user_message_id,
        "standaloneChatWorkspace": true,
        "modelId": selection.model_name,
        "modelType": selection.model_type,
        "modelOptions": Value::Object(selection.options.clone()),
        "modelSelection": selection.to_value(),
    })
}

/// `_decode`: `<prefix>` + base64url(JSON array) of `count` non-empty strings.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeTaskSummary {
    #[serde(alias = "localTaskId", alias = "local_task_id")]
    pub(super) task_id: String,
    #[serde(default)]
    pub(super) workspace_path: String,
    #[serde(default)]
    pub(super) runtime: String,
    #[serde(default)]
    pub(super) running: bool,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    turn_status: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    model_selection: Option<Value>,
    #[serde(default)]
    pub(super) runtime_handle: Option<Value>,
}

/// `native.find_conversation`: one owned task read on the device runtime.
pub(super) async fn find_conversation(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    task_id: &str,
) -> Result<RuntimeTaskSummary, FastApiError> {
    let result = runtime_rpc::call(
        state,
        user_id,
        device_id,
        "runtime.tasks.get",
        json!({"taskId": task_id}),
        std::time::Duration::from_secs(120),
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "wework runtime task lookup failed");
        FastApiError::detail(StatusCode::BAD_GATEWAY, error.to_string())
    })?;
    if result.get("success") != Some(&Value::Bool(true)) {
        let code = result
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("runtime_task_lookup_failed");
        let status = if code == "task_not_found" {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_GATEWAY
        };
        return Err(FastApiError::detail(
            status,
            result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Task lookup failed")
                .to_string(),
        ));
    }
    let task: RuntimeTaskSummary = serde_json::from_value(
        result.get("task").cloned().unwrap_or(Value::Null),
    )
    .map_err(|_| {
        FastApiError::detail(
            StatusCode::BAD_GATEWAY,
            "Runtime returned invalid task metadata",
        )
    })?;
    if task.task_id != task_id {
        return Err(FastApiError::detail(
            StatusCode::BAD_GATEWAY,
            "Runtime returned a different task identity",
        ));
    }
    Ok(task)
}

/// `_merge_selection_options`: the previous turn's options under the new ones.
pub(super) fn merged_selection(
    previous: Option<&Value>,
    selection: &ModelSelection,
) -> ModelSelection {
    let mut options = previous
        .and_then(|selection| selection.get("options"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, value) in &selection.options {
        options.insert(key.clone(), value.clone());
    }
    ModelSelection {
        model_name: selection.model_name.clone(),
        model_type: selection.model_type.clone(),
        options,
        from_persisted: selection.from_persisted,
    }
}

/// `service._dispatch` for an existing conversation: `runtime.tasks.send`.
#[allow(clippy::too_many_arguments)]
pub(super) async fn send_message(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    task_id: &str,
    workspace_path: &str,
    message: &str,
    client_user_message_id: &str,
    title: &str,
    selection: &ModelSelection,
) -> Result<(), FastApiError> {
    // `send_runtime_message` checks the owned device and refreshes the
    // DeviceWorkspace mapping before compiling the execution request.
    ensure_owned_device(state, user_id, device_id).await?;
    touch_workspace_mapping(state, user_id, device_id, workspace_path).await?;
    let mut execution = execution_request(
        state,
        user_id,
        task_id,
        device_id,
        message,
        title,
        client_user_message_id,
        selection,
    )
    .await?;
    if let Some(object) = execution.as_object_mut() {
        object.insert("new_session".to_string(), json!(false));
        object.insert("standalone_chat_workspace".to_string(), json!(false));
        object.insert("client_user_message_id".to_string(), Value::Null);
        object.insert("system_prompt".to_string(), json!(""));
        object.insert("project_workspace_path".to_string(), json!(workspace_path));
        object.insert(
            "workspace".to_string(),
            json!({"project": {
                "project_id": null,
                "workspace_source": "local_path",
                "execution_target_type": "local",
                "device_id": device_id,
                "project_workspace_path": workspace_path,
                "local_path": workspace_path,
            }}),
        );
    }
    let payload = json!({
        "deviceId": device_id,
        "workspacePath": workspace_path,
        "taskId": task_id,
        "message": message,
        "clientUserMessageId": client_user_message_id,
        "createdAt": chrono::Utc::now().timestamp_millis(),
        "executionRequest": execution,
        "modelSelection": selection.to_value(),
    });
    let result = runtime_rpc::call(
        state,
        user_id,
        device_id,
        "runtime.tasks.send",
        payload,
        std::time::Duration::from_secs(120),
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "wework runtime send failed");
        FastApiError::detail(StatusCode::BAD_GATEWAY, error.to_string())
    })?;
    if result.get("success") == Some(&Value::Bool(false))
        || result.get("accepted") == Some(&Value::Bool(false))
    {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Runtime rejected the task")
                .to_string(),
        ));
    }
    Ok(())
}

/// Read the response owner for the runtime execution request.
pub(super) async fn user_row(state: &AppState, user_id: i64) -> Result<UserRow, FastApiError> {
    state
        .mysql
        .fetch_one(crate::user_reader::USER_BY_ID_QUERY, (user_id,))
        .await
        .map_err(|error| {
            tracing::error!(?error, "wework user read failed");
            FastApiError::internal()
        })
}

/// `runtime_work_service._touch_workspace_mapping` →
/// `touch_device_workspace_kind`: on send, refresh the existing
/// `DeviceWorkspace` Kind's `status.lastSeenAt`. A missing mapping is a plain
/// SELECT with no write.
pub(super) async fn touch_workspace_mapping(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    workspace_path: &str,
) -> Result<(), FastApiError> {
    let trimmed = workspace_path.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let normalized = if trimmed == "/" {
        "/"
    } else {
        let stripped = trimmed.trim_end_matches('/');
        if stripped.is_empty() { "/" } else { stripped }
    };
    let path_hash = hex_sha256(normalized.as_bytes());
    let name = format!(
        "device-workspace-{}",
        &hex_sha256(format!("{}:{}", device_id.trim(), path_hash).as_bytes())[..32]
    );
    let row: Option<brz_mysql::MysqlRow> = state
        .mysql
        .fetch_optional(
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
             WHERE kinds.user_id = ? AND kinds.kind = 'DeviceWorkspace' \
             AND kinds.namespace = 'runtime-work' AND kinds.name = ? \
             AND kinds.is_active = 1 \n LIMIT 1",
            (user_id, name.as_str()),
        )
        .await
        .map_err(|error| {
            tracing::error!(?error, "wework workspace mapping read failed");
            FastApiError::internal()
        })?;
    let Some(row) = row else {
        return Ok(());
    };
    let id: i64 = row.get_required("kinds_id").map_err(|error| {
        tracing::error!(?error, "wework workspace mapping id decode failed");
        FastApiError::internal()
    })?;
    let mut document: Value = row
        .get_required::<brz_mysql::Json<Value>>("kinds_json")
        .map(|json| json.0)
        .unwrap_or_else(|_| json!({}));
    if !document.is_object() {
        document = json!({});
    }
    let status = document
        .get_mut("status")
        .and_then(Value::as_object_mut)
        .cloned()
        .unwrap_or_default();
    let mut status = status;
    status.insert(
        "lastSeenAt".to_string(),
        json!(
            chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S+00:00")
                .to_string()
        ),
    );
    document["status"] = Value::Object(status);
    let updated_at = chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    state
        .mysql
        .execute(
            "UPDATE kinds SET json=?, updated_at=? WHERE kinds.id = ?",
            (
                crate::internal_callback::py_json::python_dumps(&document),
                updated_at,
                id,
            ),
        )
        .await
        .map_err(|error| {
            tracing::error!(?error, "wework workspace mapping update failed");
            FastApiError::internal()
        })?;
    Ok(())
}

/// Lowercase hex SHA-256.
fn hex_sha256(value: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    let digest = Sha256::digest(value);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `runtime_work_service._ensure_owned_device`: the pure-DB owned-device check
/// the compile/dispatch paths run before building an execution request
/// (`device_service.get_device_by_device_id` → `resolve_owned_device_alias`,
/// then the runtime route identity as the source's fallback). It deliberately
/// does not consult the online state, unlike `ensure_device_online`.
pub(super) async fn ensure_owned_device(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<(), FastApiError> {
    let owned =
        crate::device_identity::resolve_owned_device_alias(&state.mysql, user_id, device_id)
            .await
            .map_err(|error| {
                tracing::error!(?error, "wework owned device read failed");
                FastApiError::internal()
            })?;
    if owned.is_some() {
        return Ok(());
    }
    let routed = resolve_runtime_route_identity(&state.mysql, user_id, device_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "wework device route read failed");
            FastApiError::internal()
        })?;
    if routed.is_some() {
        return Ok(());
    }
    Err(FastApiError::detail(
        StatusCode::NOT_FOUND,
        "Device not found or access denied",
    ))
}

/// `native.ensure_device_online`: the owned device route plus its online entry.
pub(super) async fn ensure_device_online(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<String, FastApiError> {
    let identity = resolve_runtime_route_identity(&state.mysql, user_id, device_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, "wework device route read failed");
            FastApiError::internal()
        })?
        .ok_or_else(|| {
            FastApiError::json_body(
                StatusCode::NOT_FOUND,
                json!({"detail": {"code": "device_not_found", "message": "Device not found or access denied"}}),
            )
        })?;
    if crate::device_online_state::read_online_state::<Value>(
        state,
        user_id,
        &identity.runtime_device_id,
    )
    .await?
    .is_none()
    {
        return Err(FastApiError::json_body(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"detail": {"code": "device_offline", "message": "Device is offline"}}),
        ));
    }
    Ok(identity.runtime_device_id)
}
