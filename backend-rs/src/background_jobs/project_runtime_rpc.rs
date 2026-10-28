// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Runtime continuation compiles a fresh transient execution request and waits
//! for acknowledgement through the process-owned Socket.IO subscriber.

use super::store::Node;
use crate::{
    auth::UserRow,
    responses::create::{model_config, resolution, tokens},
    state::AppState,
};
use anyhow::{Context, Result, bail};
use brz_redis::Redis;
use serde_json::{Value, json};

pub(crate) async fn continue_task(
    state: &AppState,
    binding: &Node,
    message: &str,
    selection: Option<&Value>,
) -> Result<()> {
    let identity = crate::device_identity::resolve_runtime_route_identity(
        &state.mysql,
        binding.task_user_id,
        &binding.device_id,
    )
    .await?
    .context("Device not found or access denied")?;
    let user: UserRow = state
        .mysql
        .fetch_one(
            crate::user_reader::USER_BY_ID_QUERY,
            (binding.task_user_id,),
        )
        .await?;
    let execution = direct_execution(
        state,
        &user,
        &binding.task_id,
        &identity.runtime_device_id,
        message,
        selection,
    )
    .await?;
    let mut payload = json!({"deviceId":binding.device_id,"localTaskId":binding.task_id,"message":message,"executionRequest":execution});
    if let Some(selection) = selection {
        payload["modelSelection"] = selection.clone();
    }
    let result = call(
        state,
        binding.task_user_id,
        &identity.runtime_device_id,
        "runtime.tasks.send",
        payload,
        std::time::Duration::from_secs(120),
    )
    .await?;
    if result["success"] == false || result["accepted"] == false {
        bail!(
            "{}",
            result["error"]
                .as_str()
                .unwrap_or("Runtime continuation was rejected")
        )
    }
    Ok(())
}

pub(crate) async fn call(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    method: &str,
    payload: Value,
    timeout: std::time::Duration,
) -> Result<Value> {
    let online = crate::device_online_state::read_online_state::<Value>(state, user_id, device_id)
        .await
        .map_err(|error| anyhow::anyhow!("Runtime online lookup failed: {error:?}"))?
        .context("Device is offline")?;
    let socket = online["socket_id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .context("Device is offline")?;
    let rpc = state
        .socketio_rpc
        .as_ref()
        .context("Socket.IO RPC subscriber is unavailable")?;
    let pending = rpc.begin(socket, "/local-executor")?;
    let envelope = json!([{"method":method,"payload":payload}]);
    let message = crate::socketio_emit::emit_message_with_callback(
        "runtime:rpc",
        &crate::internal_callback::py_json::python_dumps(&envelope),
        "/local-executor",
        socket,
        Some((socket, pending.id())),
    );
    state
        .redis
        .as_ref()
        .context("Redis is unavailable")?
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await?;
    let result = pending.wait(timeout).await?;
    Ok(match result {
        Value::Array(mut values) if values.len() == 1 => values.remove(0),
        value => value,
    })
}

async fn direct_execution(
    state: &AppState,
    user: &UserRow,
    task_id: &str,
    device_id: &str,
    message: &str,
    selection: Option<&Value>,
) -> Result<Value> {
    let auth = tokens::create_task_token(state, 0, 0, i64::from(user.id), &user.user_name)
        .map_err(|error| anyhow::anyhow!("Task identity creation failed: {error:?}"))?;
    let now = chrono::Utc::now().timestamp();
    let ttl = crate::config::env_or_dotenv("SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(14_400);
    let skill = sign(
        state,
        &json!({"type":"skill_identity","user_id":user.id,"user_name":user.user_name,"runtime_type":"executor","runtime_name":format!("wework-runtime-{task_id}"),"iat":now,"exp":now+ttl*60}),
    )?;
    let config = runtime_model_config(state, user, selection.unwrap_or(&Value::Null)).await?;
    let generated =
        10_000_000_000_000i64 + (super::store::id().parse::<i64>()? % 8_000_000_000_000);
    let title = message
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(80)
        .collect::<String>();
    let title = if title.is_empty() {
        "Untitled runtime task".into()
    } else {
        title
    };
    Ok(
        json!({"task_id":task_id,"subtask_id":generated+1,"team_id":0,"team_name":"Wework","team_namespace":"default","task_title":title,"subtask_title":format!("{title} - Assistant"),"user":{"id":user.id,"name":user.user_name,"user_name":user.user_name,"email":user.email},"user_id":user.id,"user_name":user.user_name,"bot":[],"bot_name":"","bot_namespace":"wework","model_config":config,"system_prompt":"","prompt":message,"enable_tools":true,"enable_web_search":false,"enable_deep_thinking":false,"new_session":false,"collaboration_model":"single","mode":"code","task_mode":"code","mcp_servers":[],"preload_skills":[],"attachments":[],"auth_token":auth,"skill_identity_token":skill,"runtime_permission_profile":":danger-full-access","device_id":device_id,"execution_target_type":"local","workspace_source":"local_path","project_workspace_path":null,"workspace":{"project":{"project_id":null,"workspace_source":"local_path","execution_target_type":"local","device_id":device_id}},"project_id":null,"runtime_project_key":null,"runtime_project_name":null,"runtime_workspace_roots":[],"project_plugin_ids":[],"origin":null}),
    )
}

fn sign(state: &AppState, claims: &Value) -> Result<String> {
    let algorithm = match state.auth.algorithm.as_str() {
        "HS384" => jsonwebtoken::Algorithm::HS384,
        "HS512" => jsonwebtoken::Algorithm::HS512,
        _ => jsonwebtoken::Algorithm::HS256,
    };
    Ok(jsonwebtoken::encode(
        &jsonwebtoken::Header::new(algorithm),
        claims,
        &jsonwebtoken::EncodingKey::from_secret(state.auth.jwt_key.as_bytes()),
    )?)
}

async fn runtime_model_config(
    state: &AppState,
    user: &UserRow,
    selection: &Value,
) -> Result<Value> {
    let model = selection["modelName"].as_str().unwrap_or("");
    let kind = selection["modelType"].as_str();
    let options = &selection["options"];
    if let Some(provider) = options["runnerModelProvider"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        return Ok(json!({"model_id":model,"model_provider":provider}));
    }
    if model.is_empty() {
        return Ok(json!({}));
    }
    if matches!(kind, Some("public" | "user" | "group")) {
        let namespace = options["weworkCloudModelNamespace"]
            .as_str()
            .filter(|value| !value.is_empty())
            .context("Cloud model identity is incomplete")?;
        let owner = super::authority::integer(&options["weworkCloudModelResourceUserId"])
            .filter(|value| *value >= 0)
            .context("Cloud model identity is incomplete")?;
        let config = crate::llm_proxy::resolve_model_config(
            state,
            user,
            model,
            kind.unwrap(),
            namespace,
            owner,
        )
        .await
        .map_err(|error| anyhow::anyhow!("Cloud model is unavailable: {error:?}"))?;
        let protocol =
            crate::llm_proxy::model_config::resolve_llm_proxy_protocol(model, &config)
                .map_err(|error| anyhow::anyhow!("Cloud model protocol is invalid: {error:?}"))?;
        let format = match protocol {
            crate::llm_proxy::model_config::Protocol::OpenAiResponses => "openai-responses",
            crate::llm_proxy::model_config::Protocol::OpenAiChatCompletions => {
                "openai-chat-completions"
            }
            crate::llm_proxy::model_config::Protocol::AnthropicMessages => "anthropic-messages",
        };
        let base = crate::config::env_or_dotenv("WEGENT_BACKEND_PUBLIC_URL")
            .filter(|value| !value.trim().is_empty())
            .context("Cloud model gateway is not configured")?;
        let access = sign(
            state,
            &json!({"sub":user.user_name,"user_id":user.id,"exp":chrono::Utc::now().timestamp()+30*60}),
        )?;
        let native = format == "openai-responses";
        let mut result = json!({"model":"openai","model_id":model,"api_format":"responses","protocol":"openai-responses","upstream_api_format":format,"codex_catalog_model_id":"wework-gpt-5.6-sol","base_url":format!("{}/api/runtime-work/llm-responses-proxy",base.trim_end_matches('/')),"api_key":access,"default_headers":{"X-Wegent-Model-Type":kind,"X-Wegent-Model-Namespace":namespace,"X-Wegent-Model-User-Id":owner.to_string(),"X-Wegent-Upstream-Header-wecode-executor":"codex","X-Wegent-Upstream-Header-wecode-source":"wegent-agent"},"runtime_config":{"codex":{"use_user_config":false,"configured":true}},"wework_model_kind":"cloud","tool_profile":"custom","codex_responses_compat_proxy":true,"native_tool_search":native,"native_namespace_tools":native});
        apply_model_options(&mut result, options);
        return Ok(result);
    }
    let mut result = json!({"model":"openai","model_id":if model=="codex-gpt-5.5"{"gpt-5.5"}else{model},"api_format":"responses","protocol":"openai-responses"});
    if let Some(resolved) = resolution::resolve_model_for_bot(
        &state.mysql,
        &state.entity_resolvers,
        state.redis.as_ref(),
        i64::from(user.id),
        model,
    )
    .await?
    {
        let config =
            model_config::extract_model_config(&resolved.json.0["spec"]).map_err(|error| {
                anyhow::anyhow!("Runtime model configuration is invalid: {error:?}")
            })?;
        for (key, value) in config {
            result[key] = value;
        }
    }
    for (from, to) in [
        ("codexProviderId", "model_provider"),
        ("codex_model_provider", "model_provider"),
        ("codexProviderName", "provider_name"),
        ("codex_provider_name", "provider_name"),
        ("codexCatalogModelId", "codex_catalog_model_id"),
    ] {
        if let Some(value) = options[from].as_str().filter(|value| !value.is_empty()) {
            result[to] = json!(value)
        }
    }
    apply_model_options(&mut result, options);
    Ok(result)
}

fn apply_model_options(config: &mut Value, options: &Value) {
    for (from, to) in [
        ("weworkCloudModelNativeToolSearch", "native_tool_search"),
        (
            "weworkCloudModelNativeNamespaceTools",
            "native_namespace_tools",
        ),
    ] {
        if let Some(value) = options[from].as_str() {
            match value.trim().to_lowercase().as_str() {
                "true" => config[to] = json!(true),
                "false" => config[to] = json!(false),
                _ => {}
            }
        }
    }
    for (from, to) in [
        ("weworkCloudModelContextWindow", "model_context_window"),
        ("weworkCloudModelMaxOutputTokens", "max_output_tokens"),
    ] {
        if let Some(value) = super::authority::integer(&options[from]).filter(|value| *value > 0) {
            config[to] = json!(value)
        }
    }
    for key in ["reasoning", "reasoning_effort", "temperature"] {
        if !options[key].is_null() {
            config[key] = options[key].clone();
        }
    }
}
