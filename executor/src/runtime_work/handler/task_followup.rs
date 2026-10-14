// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::cloud_model_identity::{cloud_model_gateway_base_url, CloudModelIdentity};
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn task_message_execution_request(
        &self,
        payload: &Value,
        link: Option<&RuntimeTaskLink>,
    ) -> Result<ExecutionRequest, AppIpcError> {
        if payload.get("executionRequest").is_some() || payload.get("execution_request").is_some() {
            return execution_request(payload)
                .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is invalid"));
        }
        let link = link.ok_or_else(|| {
            AppIpcError::new("task_not_found", "The original Runtime task was not found")
        })?;
        let mut request = self.restore_runtime_execution_profile(link)?;
        request.subtask_id = format!(
            "{}-{}",
            link.local_task_id,
            string_field(payload, "clientUserMessageId")
                .or_else(|| string_field(payload, "client_user_message_id"))
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
        );
        request.prompt = Value::String(
            string_field(payload, "message")
                .or_else(|| string_field(payload, "content"))
                .or_else(|| string_field(payload, "prompt"))
                .ok_or_else(|| AppIpcError::new("bad_request", "message is required"))?,
        );
        request.new_session = false;
        apply_runtime_payload_metadata(
            &mut request,
            &json!({
                "attachments": payload.get("attachments"),
                "clientUserMessageId": payload.get("clientUserMessageId")
                    .or_else(|| payload.get("client_user_message_id")),
            }),
        );
        if let Some(execution_id) = payload.get("executionId").filter(|value| {
            value.as_u64().is_some_and(|id| id > 0)
                || value.as_str().is_some_and(|id| !id.trim().is_empty())
        }) {
            if let Some(origin) = request
                .extra
                .get_mut("origin")
                .and_then(Value::as_object_mut)
            {
                origin.remove("execution_id");
                origin.insert("executionId".into(), execution_id.clone());
            }
        }
        Ok(request)
    }

    pub(super) fn restore_runtime_execution_profile(
        &self,
        link: &RuntimeTaskLink,
    ) -> Result<ExecutionRequest, AppIpcError> {
        if !is_codex_runtime(&link.runtime) && !is_claude_runtime(&link.runtime) {
            return Err(AppIpcError::new(
                "unsupported_runtime",
                "The original Runtime task cannot be continued",
            ));
        }
        execution_request(&link.runtime_handle).ok_or_else(|| {
            AppIpcError::new(
                "execution_profile_unavailable",
                "The original Runtime task execution profile is unavailable",
            )
        })?;
        let mut request = runtime_event_request_from_link(link);
        request.model_config = match self.runtime_model_config(&link.local_task_id) {
            Some(config) => config,
            None => recover_saved_model_config(&request)?.ok_or_else(|| AppIpcError::new(
                "execution_profile_unavailable",
                "The original Runtime task model configuration is unavailable; reopen its task to restore the model"))?,
        };
        self.apply_backend_connection(&mut request);
        self.refresh_followup_model_credentials(&mut request, &link.runtime)?;
        Ok(request)
    }

    pub(super) fn refresh_followup_model_credentials(
        &self,
        request: &mut ExecutionRequest,
        runtime: &str,
    ) -> Result<(), AppIpcError> {
        let Some(identity) = CloudModelIdentity::from_request(request)
            .map_err(|error| AppIpcError::new("execution_profile_unavailable", error))?
        else {
            if string_field(&request.model_config, "wework_model_kind").as_deref() == Some("cloud")
            {
                return Err(AppIpcError::new(
                    "execution_profile_unavailable",
                    "The original cloud model identity is unavailable",
                ));
            }
            return Ok(());
        };
        let sidecar_identity = CloudModelIdentity::vision_sidecar_from_request(request)
            .map_err(|error| AppIpcError::new("execution_profile_unavailable", error))?;
        let connection = self.backend_connection_snapshot()?.ok_or_else(|| {
            AppIpcError::new(
                "backend_connection_unavailable",
                "Backend connection is required to continue this cloud model",
            )
        })?;
        if connection.auth_token.trim().is_empty() || connection.backend_url.trim().is_empty() {
            return Err(AppIpcError::new(
                "backend_connection_unavailable",
                "Backend connection and authentication are required to continue this cloud model",
            ));
        }
        restore_cloud_proxy_credentials(
            &mut request.model_config,
            &identity,
            &connection,
            runtime,
            &request.task_id,
            "base_url",
        )?;
        if let Some(sidecar) = request.model_config.get_mut("vision_sidecar") {
            if sidecar.get("enabled").and_then(Value::as_bool) != Some(false)
                && known_cloud_proxy(sidecar, "request_url", true)
            {
                let identity = sidecar_identity.ok_or_else(|| {
                    AppIpcError::new(
                        "execution_profile_unavailable",
                        "The original cloud vision sidecar identity is unavailable",
                    )
                })?;
                restore_cloud_proxy_credentials(
                    sidecar,
                    &identity,
                    &connection,
                    runtime,
                    &request.task_id,
                    "request_url",
                )?;
            }
        }
        Ok(())
    }
}

fn recover_saved_model_config(request: &ExecutionRequest) -> Result<Option<Value>, AppIpcError> {
    let config = &request.model_config;
    let Some(object) = config.as_object().filter(|object| !object.is_empty()) else {
        return Ok(None);
    };
    let cloud_identity = CloudModelIdentity::from_request(request)
        .map_err(|error| AppIpcError::new("execution_profile_unavailable", error))?;
    if cloud_identity.is_some() && known_cloud_proxy(config, "base_url", false) {
        if let Some(sidecar) = object.get("vision_sidecar") {
            if sidecar.get("enabled").and_then(Value::as_bool) != Some(false)
                && !known_cloud_proxy(sidecar, "request_url", true)
            {
                return Ok(None);
            }
        }
        return Ok(Some(config.clone()));
    }
    // External routes lose their credentials and headers when persisted. Never
    // reinterpret that redacted profile as a different or unauthenticated model.
    if object
        .get("base_url")
        .or_else(|| object.get("baseUrl"))
        .is_some()
    {
        return Ok(None);
    }
    if object
        .get("vision_sidecar")
        .is_some_and(|sidecar| sidecar.get("enabled").and_then(Value::as_bool) != Some(false))
    {
        return Ok(None);
    }
    let uses_native_credentials = object
        .get("runtime_config")
        .and_then(|config| config.get("codex"))
        .and_then(|config| config.get("use_user_config"))
        .and_then(Value::as_bool)
        == Some(true);
    if !(uses_native_credentials
        || object.get("wework_model_kind").and_then(Value::as_str) == Some("native"))
        || string_field(config, "model_id").is_none()
    {
        return Ok(None);
    }
    Ok(Some(config.clone()))
}

fn known_cloud_proxy(config: &Value, field: &str, response_endpoint: bool) -> bool {
    config
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|base_url| {
            url::Url::parse(base_url).ok().is_some_and(|url| {
                let path = url.path().trim_end_matches('/');
                path.ends_with(if response_endpoint {
                    "/runtime-work/llm-responses-proxy/responses"
                } else {
                    "/runtime-work/llm-responses-proxy"
                })
            })
        })
}

fn restore_cloud_proxy_credentials(
    config: &mut Value,
    identity: &CloudModelIdentity,
    connection: &ConnectionConfig,
    runtime: &str,
    task_id: &str,
    route_field: &str,
) -> Result<(), AppIpcError> {
    let config = config.as_object_mut().ok_or_else(|| {
        AppIpcError::new(
            "execution_profile_unavailable",
            "The original cloud model configuration is invalid",
        )
    })?;
    if config.get("model_id").and_then(Value::as_str) != Some(identity.name.as_str()) {
        return Err(AppIpcError::new(
            "execution_profile_unavailable",
            "The original cloud model configuration does not match its saved identity",
        ));
    }
    let gateway = cloud_model_gateway_base_url(&connection.backend_url);
    let url = if route_field == "request_url" {
        format!("{gateway}/responses")
    } else {
        gateway
    };
    config.insert(route_field.to_owned(), Value::String(url));
    config.insert(
        "api_key".to_owned(),
        Value::String(connection.auth_token.clone()),
    );
    let headers = config
        .entry("default_headers".to_owned())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            AppIpcError::new(
                "execution_profile_unavailable",
                "The original cloud model headers are invalid",
            )
        })?;
    let source = headers
        .get("X-Wegent-Upstream-Header-wecode-source")
        .and_then(Value::as_str)
        .filter(|source| !source.trim().is_empty())
        .unwrap_or("wegent-local")
        .to_owned();
    identity.apply_headers(
        headers,
        if is_claude_runtime(runtime) {
            "claude"
        } else {
            "codex"
        },
        &source,
        task_id,
    );
    Ok(())
}
