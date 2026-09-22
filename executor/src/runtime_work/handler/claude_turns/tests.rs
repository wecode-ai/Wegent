use super::*;
use tokio::sync::broadcast::error::TryRecvError;

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn cloud_model_selection_materializes_claude_gateway_route() {
    let _lock = crate::test_env::lock();
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "https://wegent.example/api");
    let mut request = ExecutionRequest {
        auth_token: Some("task-token".to_owned()),
        model_config: json!({
            "base_url": "https://local-claude.invalid",
            "api_key": "local-credential",
            "custom_option": "preserved",
            "default_headers": {
                "X-Custom-Header": "preserved",
            },
        }),
        extra: serde_json::Map::from_iter([(
            "modelSelection".to_owned(),
            json!({
                "modelName": "public-review-model",
                "modelType": "public",
                "options": {
                    "weworkCloudModelNamespace": "default",
                    "weworkCloudModelResourceUserId": "0",
                    "weworkCloudModelUpstreamApiFormat": "openai-responses",
                },
            }),
        )]),
        ..ExecutionRequest::default()
    };

    let backend_connection = ConnectionConfig {
        backend_url: "https://wegent.example/api".to_owned(),
        socket_url: "https://wegent.example/api".to_owned(),
        auth_token: "backend-token".to_owned(),
        runtime_auth_token: String::new(),
    };
    let backend_credentials = BackendSessionCredentials::try_from(&backend_connection).unwrap();

    prepare_claude_cloud_model_route(&mut request, Some(&backend_credentials))
        .expect("cloud model selection should materialize");

    assert_eq!(
        request.model_config["base_url"],
        "https://wegent.example/api/runtime-work/llm-responses-proxy"
    );
    assert_eq!(request.model_config["api_key"], "backend-token");
    assert_eq!(request.model_config["model_id"], "public-review-model");
    assert_eq!(
        request.model_config["default_headers"]["X-Wegent-Model-Type"],
        "public"
    );
    assert_eq!(
        request.model_config["default_headers"]["X-Wegent-Upstream-Header-wecode-executor"],
        "claudecode"
    );
    assert_eq!(request.model_config["custom_option"], "preserved");
    assert_eq!(
        request.model_config["default_headers"]["X-Custom-Header"],
        "preserved"
    );
    assert_ne!(
        request.model_config["base_url"],
        "https://local-claude.invalid"
    );
    assert_ne!(request.model_config["api_key"], "local-credential");
}

#[test]
fn cloud_model_selection_fails_closed_without_backend_token() {
    let _lock = crate::test_env::lock();
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "https://wegent.example");
    let mut request = ExecutionRequest {
        extra: serde_json::Map::from_iter([(
            "modelSelection".to_owned(),
            json!({
                "modelName": "public-review-model",
                "modelType": "public",
                "options": {
                    "weworkCloudModelNamespace": "default",
                    "weworkCloudModelResourceUserId": "0",
                },
            }),
        )]),
        ..ExecutionRequest::default()
    };

    let error = prepare_claude_cloud_model_route(&mut request, None)
        .expect_err("cloud model must not fall back to local Claude login");

    assert_eq!(error, "Claude Code cloud model backend token is required");
    assert!(request.model_config.as_object().unwrap().is_empty());
}

#[test]
fn cloud_model_selection_rejects_invalid_resource_user_id() {
    let mut request = ExecutionRequest {
        extra: serde_json::Map::from_iter([(
            "modelSelection".to_owned(),
            json!({
                "modelName": "public-review-model",
                "modelType": "public",
                "options": {
                    "weworkCloudModelNamespace": "default",
                    "weworkCloudModelResourceUserId": "-1",
                },
            }),
        )]),
        ..ExecutionRequest::default()
    };
    let backend_credentials = BackendSessionCredentials {
        backend_url: "https://wegent.example".to_owned(),
        session_token: "backend-token".to_owned(),
    };

    let error =
        prepare_claude_cloud_model_route(&mut request, Some(&backend_credentials)).unwrap_err();

    assert_eq!(
        error,
        "Claude Code cloud model resource user ID must be a non-negative integer"
    );
}

#[test]
fn non_cloud_model_selection_leaves_model_configuration_unchanged() {
    let original = json!({
        "base_url": "https://local-claude.example",
        "api_key": "local-token",
        "env": {"HTTPS_PROXY": "http://proxy.example"},
    });
    let mut request = ExecutionRequest {
        model_config: original.clone(),
        extra: serde_json::Map::from_iter([(
            "modelSelection".to_owned(),
            json!({
                "modelName": "local-claude",
                "modelType": "runtime",
                "options": {},
            }),
        )]),
        ..ExecutionRequest::default()
    };

    prepare_claude_cloud_model_route(&mut request, None).unwrap();

    assert_eq!(request.model_config, original);
}

#[test]
fn local_harness_route_overrides_claude_provider_and_login_environment() {
    let mut model_config = serde_json::Map::from_iter([(
        "env".to_owned(),
        json!({
            "HTTPS_PROXY": "http://proxy.example",
            "ANTHROPIC_API_KEY": "stale-token",
        }),
    )]);
    let proxy_url = "http://127.0.0.1:19090/v1/harness-router/token";

    apply_claude_proxy_environment(&mut model_config, proxy_url);

    assert_eq!(model_config["env"]["HTTPS_PROXY"], "http://proxy.example");
    assert_eq!(model_config["env"]["ANTHROPIC_BASE_URL"], proxy_url);
    assert_eq!(
        model_config["env"]["ANTHROPIC_API_KEY"],
        local_model_proxy::API_KEY
    );
    assert_eq!(
        model_config["env"]["ANTHROPIC_AUTH_TOKEN"],
        local_model_proxy::API_KEY
    );
    assert_eq!(model_config["env"]["CLAUDE_CODE_USE_BEDROCK"], "0");
    assert_eq!(model_config["env"]["CLAUDE_CODE_USE_FOUNDRY"], "0");
    assert_eq!(model_config["env"]["CLAUDE_CODE_USE_VERTEX"], "0");

    let request = ExecutionRequest {
        bot: json!([{
            "shell_type": "ClaudeCode",
            "agent_config": {
                "env": {
                    "ANTHROPIC_API_KEY": "local-api-key",
                    "ANTHROPIC_AUTH_TOKEN": "local-auth-token",
                    "ANTHROPIC_BASE_URL": "https://local-claude.invalid",
                    "CLAUDE_CODE_USE_BEDROCK": "1",
                    "CLAUDE_CODE_USE_FOUNDRY": "1",
                    "CLAUDE_CODE_USE_VERTEX": "1",
                },
            },
        }]),
        model_config: Value::Object(model_config),
        ..ExecutionRequest::default()
    };
    let command = crate::agents::build_claude_command(&request, "claude");

    assert_eq!(command.envs()["ANTHROPIC_BASE_URL"], proxy_url);
    assert_eq!(
        command.envs()["ANTHROPIC_API_KEY"],
        local_model_proxy::API_KEY
    );
    assert_eq!(
        command.envs()["ANTHROPIC_AUTH_TOKEN"],
        local_model_proxy::API_KEY
    );
    assert_eq!(command.envs()["CLAUDE_CODE_USE_BEDROCK"], "0");
    assert_eq!(command.envs()["CLAUDE_CODE_USE_FOUNDRY"], "0");
    assert_eq!(command.envs()["CLAUDE_CODE_USE_VERTEX"], "0");
}

fn block_created_event(id: &str) -> EventEnvelope {
    EventEnvelope {
        event_type: "response.block.created".to_owned(),
        task_id: "task-1".to_owned(),
        subtask_id: "turn-1".to_owned(),
        data: json!({
            "block": {
                "id": id,
                "type": "text",
            },
        }),
        message_id: None,
        executor_name: None,
        executor_namespace: None,
        validation_id: None,
    }
}

fn isolated_handler() -> (tempfile::TempDir, RuntimeWorkRpcHandler) {
    let directory = tempfile::tempdir().expect("temporary runtime work directory");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(directory.path().join("index.json"));
    (directory, handler)
}

#[test]
fn claude_transcript_merges_streamed_block_updates() {
    let mut transcript = ClaudeTurnTranscript::default();
    transcript.record(&EventEnvelope {
        event_type: "response.block.created".to_owned(),
        task_id: "task-1".to_owned(),
        subtask_id: "turn-1".to_owned(),
        data: json!({
            "block": {
                "id": "block-1",
                "type": "tool",
                "status": "running",
            },
        }),
        message_id: None,
        executor_name: None,
        executor_namespace: None,
        validation_id: None,
    });
    transcript.record(&EventEnvelope {
        event_type: "response.block.updated".to_owned(),
        task_id: "task-1".to_owned(),
        subtask_id: "turn-1".to_owned(),
        data: json!({
            "block_id": "block-1",
            "updates": {
                "status": "completed",
                "output": "done",
            },
        }),
        message_id: None,
        executor_name: None,
        executor_namespace: None,
        validation_id: None,
    });

    assert_eq!(
        transcript.blocks(),
        vec![json!({
            "id": "block-1",
            "type": "tool",
            "status": "completed",
            "output": "done",
        })]
    );
}

#[tokio::test]
async fn claude_runtime_events_include_monotonic_event_sequence() {
    let (event_tx, mut event_rx) = tokio::sync::broadcast::channel(4);
    let handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    let request = ExecutionRequest {
        task_id: "task-1".to_owned(),
        subtask_id: "turn-1".to_owned(),
        ..ExecutionRequest::default()
    };

    handler.emit_claude_runtime_event("task-1", &request, "response.created", json!({}));
    handler.emit_claude_runtime_event("task-1", &request, "error", json!({"message": "failed"}));

    let first = event_rx.recv().await.expect("first Claude runtime event");
    let second = event_rx.recv().await.expect("second Claude runtime event");
    let first_sequence = first["payload"]["eventSeq"]
        .as_u64()
        .expect("first event sequence");
    let second_sequence = second["payload"]["eventSeq"]
        .as_u64()
        .expect("second event sequence");

    assert!(first_sequence > 0);
    assert!(second_sequence > first_sequence);
    assert_eq!(first["payload"]["runtime"], "claude_code");
    assert_eq!(second["payload"]["runtime"], "claude_code");
}

#[tokio::test]
async fn claude_event_sink_drops_events_after_cancellation_starts() {
    let directory = tempfile::tempdir().expect("temporary runtime work directory");
    let (event_tx, mut event_rx) = tokio::sync::broadcast::channel(4);
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(directory.path().join("index.json"));
    let (cancel_tx, _cancel_rx) = oneshot::channel();
    let (_stopped_tx, stopped_rx) = oneshot::channel();
    let execution_id =
        handler.start_local_task_execution("task-1".to_owned(), cancel_tx, stopped_rx);
    let transcript = Arc::new(Mutex::new(ClaudeTurnTranscript::default()));
    let sink = ClaudeRuntimeEventSink {
        handler: handler.clone(),
        local_task_id: "task-1".to_owned(),
        execution_id,
        request: ExecutionRequest {
            task_id: "task-1".to_owned(),
            subtask_id: "turn-1".to_owned(),
            ..ExecutionRequest::default()
        },
        transcript: Arc::clone(&transcript),
    };

    sink.send(block_created_event("before-cancel"))
        .await
        .expect("active event should be accepted");
    event_rx
        .recv()
        .await
        .expect("active event should be emitted");

    {
        let mut active = handler
            .active_local_executions
            .lock()
            .expect("active local execution map lock");
        let control = active.get_mut("task-1").expect("active Claude turn");
        control.stop_requested = true;
    }
    sink.send(block_created_event("after-cancel"))
        .await
        .expect("late event should be ignored without failing the runtime");

    assert!(matches!(event_rx.try_recv(), Err(TryRecvError::Empty)));
    assert_eq!(
        transcript
            .lock()
            .expect("Claude transcript lock")
            .blocks()
            .iter()
            .map(|block| block["id"].as_str())
            .collect::<Vec<_>>(),
        vec![Some("before-cancel")]
    );
}

#[test]
fn claude_goal_uses_native_print_mode_command_and_persists_state() {
    let (_directory, handler) = isolated_handler();
    let link = RuntimeTaskLink::new_pending_with_runtime(
        "claude-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Goal task".to_owned(),
        "claude_code",
    );
    handler.upsert_local_task(link);
    let mut request = ExecutionRequest {
        prompt: Value::String("original visible message".to_owned()),
        ..ExecutionRequest::default()
    };

    handler.prepare_claude_goal(
        "claude-task-1",
        &mut request,
        &json!({
            "initialGoal": {
                "objective": "all focused tests pass",
                "status": "active",
            },
        }),
    );

    assert_eq!(request.prompt, json!("/goal all focused tests pass"));
    assert!(is_claude_goal_invocation(&request));
    let stored = handler
        .local_task_link("claude-task-1")
        .expect("stored Claude task");
    assert_eq!(stored.goal_status.as_deref(), Some("active"));
    assert_eq!(
        stored.runtime_handle["goal"]["objective"],
        "all focused tests pass"
    );
}

#[test]
fn claude_goal_status_update_preserves_objective() {
    let (_directory, handler) = isolated_handler();
    let mut link = RuntimeTaskLink::new_pending_with_runtime(
        "claude-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Goal task".to_owned(),
        "claude_code",
    );
    link.runtime_handle["goal"] = claude_goal_value(
        "claude-task-1",
        &json!({"status": "active"}),
        Some("finish the migration".to_owned()),
    );
    handler.upsert_local_task(link.clone());

    let updated = handler.set_claude_goal(&link, &json!({"status": "paused"}));

    assert_eq!(updated["objective"], "finish the migration");
    assert_eq!(updated["status"], "paused");
    let stored = handler
        .local_task_link("claude-task-1")
        .expect("stored Claude task");
    assert_eq!(stored.goal_status.as_deref(), Some("paused"));
}

#[tokio::test]
async fn claude_completed_and_follow_up_turns_survive_store_restart() {
    let (directory, mut handler) = isolated_handler();
    handler.upsert_local_task(RuntimeTaskLink::new_pending_with_runtime(
        "claude-1".into(),
        "/tmp/project".into(),
        "Task".into(),
        "claude_code",
    ));
    for (turn, status) in [("first", "done"), ("second", "cancelled")] {
        let request = ExecutionRequest {
            task_id: "claude-1".into(),
            subtask_id: turn.into(),
            ..Default::default()
        };
        handler.prepare_claude_send("claude-1", "/tmp/project", &request,
            &json!({"message": format!("request {turn}"), "clientUserMessageId": format!("user-{turn}")}));
        handler.persist_claude_assistant_message("claude-1", &request, &format!("answer {turn}"),
            vec![json!({"id": format!("tool-{turn}"), "type":"tool", "tool_name":"pwd", "tool_output":"/tmp/project", "status":"done"})], status, None);
    }
    handler.store = RuntimeWorkStore::new(directory.path().join("index.json"));
    let response = handler
        .transcript(json!({"taskId":"claude-1"}))
        .await
        .unwrap();
    assert_eq!(response["running"], false);
    assert_eq!(response["historyUnavailable"], false);
    assert_eq!(response["messages"].as_array().unwrap().len(), 4);
    let turns = response["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["id"], "first");
    assert_eq!(turns[0]["status"], "done");
    assert_eq!(turns[1]["id"], "second");
    assert_eq!(turns[1]["status"], "cancelled");
    assert_eq!(
        handler.local_task_link("claude-1").unwrap().status,
        "cancelled"
    );
    assert!(response["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["blocks"][0]["tool_output"] == "/tmp/project"));
}
