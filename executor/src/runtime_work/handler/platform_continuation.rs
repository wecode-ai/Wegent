// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::response::ExecutionBackend;
use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Continuation {
    team_id: i64,
    model_id: Option<String>,
    model_type: Option<String>,
    model_options: Option<Value>,
    #[serde(default)]
    messages: Vec<Value>,
    task_id: i64,
    user_id: i64,
    device_id: String,
    thread_id: String,
    shell_type: String,
    title: String,
    #[serde(default)]
    workspace_path: String,
}

impl Continuation {
    fn runtime(&self) -> Result<&'static str, AppIpcError> {
        match self.shell_type.as_str() {
            "Codex" => Ok("codex"),
            "ClaudeCode" => Ok("claude_code"),
            _ => Err(AppIpcError::new(
                "unsupported_runtime",
                "Unsupported platform task runtime",
            )),
        }
    }

    fn matches_link(&self, link: &RuntimeTaskLink) -> Result<bool, AppIpcError> {
        Ok(link.thread_id.as_deref() == Some(self.thread_id.as_str())
            && link.runtime == self.runtime()?)
    }
}

pub(super) fn continuation_id(origin: &str, owner: i64, device: &str, task: &str) -> String {
    let digest = Sha256::digest(
        json!([origin.trim_end_matches('/'), owner, device, task])
            .to_string()
            .as_bytes(),
    );
    format!("platform-task-{digest:x}")
}

fn unavailable() -> AppIpcError {
    AppIpcError::new("cloud_unavailable", "Could not reach the platform task")
}

fn denied() -> AppIpcError {
    AppIpcError::new(
        "permission_denied",
        "The platform task does not belong to this execution identity",
    )
}

impl RuntimeWorkRpcHandler {
    async fn verified_continuation(
        &self,
        connection: &ConnectionConfig,
        task: i64,
        expected_owner: i64,
        include_history: bool,
    ) -> Result<Continuation, AppIpcError> {
        let url = crate::agents::runtime_capabilities::api_url(
            &connection.backend_url,
            &format!("/api/tasks/{task}/wework-continuation"),
        )
        .map_err(|_| denied())?;
        let response = crate::agents::backend_url::backend_http_client()
            .map_err(|_| denied())?
            .get(url)
            .query(&[("include_history", include_history)])
            .bearer_auth(&connection.auth_token)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| {
                AppIpcError::new("cloud_unavailable", "Could not reach the platform task")
            })?
            .error_for_status()
            .map_err(|_| denied())?;
        let context: Continuation = response.json().await.map_err(|_| {
            AppIpcError::new("invalid_response", "Invalid platform task continuation")
        })?;
        if self.backend_connection_snapshot()?.as_ref() != Some(connection)
            || context.task_id != task
            || context.team_id <= 0
            || context.user_id <= 0
            || context.user_id != expected_owner
            || connection
                .authenticated_user_id
                .is_some_and(|owner| owner != context.user_id)
            || context.device_id != self.cloud_device_id()?
            || context.thread_id.trim().is_empty()
        {
            return Err(denied());
        }
        Ok(context)
    }

    pub(super) async fn send_platform_message(
        &self,
        link: &RuntimeTaskLink,
        binding: &ExecutionBackend,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let connection = self
            .backend_connection_snapshot()?
            .filter(|config| {
                config.backend_url.trim_end_matches('/') == binding.url
                    && !config.auth_token.is_empty()
            })
            .ok_or_else(denied)?;
        if self.cloud_device_id()? != binding.device {
            return Err(denied());
        }
        let task = binding
            .task_id
            .as_deref()
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|id| *id > 0)
            .ok_or_else(denied)?;
        let message = payload["message"]
            .as_str()
            .or_else(|| payload["content"].as_str())
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| {
                AppIpcError::new("bad_request", "The platform message has no content")
            })?;
        let client = crate::agents::backend_url::backend_http_client().map_err(|_| denied())?;
        let api = |path: &str| {
            crate::agents::runtime_capabilities::api_url(&connection.backend_url, path)
                .map_err(|_| denied())
        };
        let context = self
            .verified_continuation(&connection, task, binding.owner, false)
            .await?;
        if !context.matches_link(link)? {
            return Err(denied());
        }
        let mut submission = json!({"taskId":task, "teamId":context.team_id, "deviceId":binding.device, "message":message,
            "modelId":context.model_id, "modelType":context.model_type, "modelOptions":context.model_options});
        for field in [
            "attachmentIds",
            "contexts",
            "additionalSkills",
            "enableDeepThinking",
            "enableWebSearch",
            "searchEngine",
        ] {
            if let Some(value) = payload.get(field) {
                submission[field] = value.clone();
            }
        }
        let result: Value = client
            .post(api("/api/device-chat/tasks")?)
            .bearer_auth(&connection.auth_token)
            .json(&submission)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| unavailable())?
            .error_for_status()
            .map_err(|_| {
                AppIpcError::new("platform_rejected", "The platform rejected this message")
            })?
            .json()
            .await
            .map_err(|_| unavailable())?;
        if result["taskId"] != task {
            return Err(denied());
        }
        Ok(
            json!({"success":true, "accepted":true,"taskId":link.local_task_id, "runtimeHandle":runtime_handle_json(link),"turnId":result["assistantSubtaskId"].to_string()}),
        )
    }

    pub(super) async fn open_platform_task(&self, payload: Value) -> Result<Value, AppIpcError> {
        let task = id_field(&payload, "platformTaskId")
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|id| *id > 0)
            .ok_or_else(|| {
                AppIpcError::new("bad_request", "A positive platformTaskId is required")
            })?;
        let connection = self
            .backend_connection_snapshot()?
            .filter(|config| !config.auth_token.is_empty())
            .ok_or_else(denied)?;
        let device = self.cloud_device_id()?;
        let expected = payload["expectedApiBaseUrl"].as_str().ok_or_else(denied)?;
        let api_base = |base: &str| {
            crate::agents::runtime_capabilities::api_url(base, "/api").map_err(|_| denied())
        };
        let owner = payload["expectedUserId"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or_else(denied)?;
        if api_base(expected)? != api_base(&connection.backend_url)? {
            return Err(denied());
        }
        let context = self
            .verified_continuation(&connection, task, owner, true)
            .await?;
        let runtime = context.runtime()?;
        let origin = connection.backend_url.trim_end_matches('/');
        let local_id = continuation_id(origin, context.user_id, &device, &task.to_string());
        let gate = self.task_send_gate(&context.thread_id);
        let _guard = gate.lock().await;
        if self.backend_connection_snapshot()?.as_ref() != Some(&connection) {
            return Err(denied());
        }
        if let Some(existing) = self.local_task_link(&local_id) {
            if !context.matches_link(&existing)?
                || !existing.execution_backend.as_ref().is_some_and(|binding| {
                    binding.task_id.as_deref() == Some(task.to_string().as_str())
                        && binding.owner == context.user_id
                        && binding.url == origin
                        && binding.device == device
                })
            {
                return Err(denied());
            }
            if !context.messages.is_empty()
                && existing.runtime_handle["messages"]
                    .as_array()
                    .map_or(true, Vec::is_empty)
            {
                self.store.update_task_without_snapshot(&local_id, |link| {
                    if link.runtime_handle["messages"]
                        .as_array()
                        .map_or(true, Vec::is_empty)
                    {
                        set_runtime_handle_messages(&mut link.runtime_handle, context.messages);
                    }
                });
            }
            return Ok(json!({"taskId":local_id}));
        }
        let mut link = RuntimeTaskLink::new_pending_with_runtime(
            local_id.clone(),
            context.workspace_path,
            context.title,
            runtime,
        );
        set_runtime_handle_messages(&mut link.runtime_handle, context.messages);
        link.thread_id = Some(context.thread_id);
        link.status = "completed".into();
        link.runtime_handle["executionRequest"] = json!({"user_id":context.user_id});
        link.execution_backend = Some(ExecutionBackend {
            url: origin.into(),
            owner: context.user_id,
            device,
            task_id: Some(task.to_string()),
        });
        self.store
            .try_upsert_task(link)
            .map_err(|e| AppIpcError::new("storage_error", e.to_string()))?;
        Ok(json!({"taskId":local_id}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn open_and_send_require_the_current_authenticated_native_binding() {
        crate::test_env::run_with_executor_home(verify_platform_continuation());
    }

    async fn verify_platform_continuation() {
        use axum::{
            extract::State,
            http::HeaderMap,
            routing::{get, post},
            Json, Router,
        };
        let evidence = Arc::new(Mutex::new(
            json!({"task_id":42,"team_id":6,"user_id":7,"device_id":"here",
            "thread_id":"native","shell_type":"ClaudeCode","title":"Task","messages":[{"id":"m","role":"assistant","content":"original"}]}),
        ));
        let app = Router::new()
            .route(
                "/api/tasks/42/wework-continuation",
                get(
                    |State(evidence): State<Arc<Mutex<Value>>>, headers: HeaderMap| async move {
                        assert_eq!(headers["authorization"], "Bearer wg-test");
                        Json(evidence.lock().unwrap().clone())
                    },
                ),
            )
            .route(
                "/api/device-chat/tasks",
                post(|Json(body): Json<Value>| async move {
                    assert_eq!(body["teamId"], 6);
                    assert_eq!(body["taskId"], 42);
                    assert_eq!(body["message"], "follow-up");
                    Json(json!({"taskId":42,"assistantSubtaskId":9}))
                }),
            )
            .with_state(evidence.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let handler = RuntimeWorkRpcHandler::new("here", "unused");
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
            backend_url: backend.clone(),
            auth_token: "wg-test".into(),
            ..Default::default()
        });
        let payload = json!({"platformTaskId":42,"expectedApiBaseUrl":format!("{backend}/api"),"expectedUserId":7, "threadId":"spoofed"});
        let opened = handler.open_platform_task(payload.clone()).await.unwrap();
        let local = opened["taskId"].as_str().unwrap();
        let restored = handler.local_task_link(local).unwrap();
        assert_eq!(restored.thread_id.as_deref(), Some("native"));
        assert_eq!(
            restored.runtime_handle["messages"][0]["content"],
            "original"
        );
        assert_eq!(
            handler.open_platform_task(payload.clone()).await.unwrap()["taskId"],
            local
        );
        let message = json!({"taskId":local,"message":"follow-up","teamId":99});
        assert_eq!(
            handler
                .send_message_from_owner(message.clone(), true)
                .await
                .unwrap()["turnId"],
            "9"
        );
        for (field, replacement, previous) in [
            ("thread_id", "different", "native"),
            ("shell_type", "Codex", "ClaudeCode"),
        ] {
            evidence.lock().unwrap()[field] = json!(replacement);
            assert_eq!(
                handler
                    .open_platform_task(payload.clone())
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
            assert_eq!(
                handler
                    .send_message_from_owner(message.clone(), true)
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
            evidence.lock().unwrap()[field] = json!(previous);
        }
        server.abort();
    }
}
