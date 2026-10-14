// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn original_task(runtime: &str, workspace: &str) -> (RuntimeTaskLink, ExecutionRequest) {
    let request = ExecutionRequest {
        task_id: "original-task".to_owned(),
        subtask_id: "original-initial".to_owned(),
        model_config: json!({
            "model_id": "original-model",
            "runtime_config": {"codex": {"configured": true, "use_user_config": true}},
            "reasoning": {"effort": "high"},
        }),
        bot: json!([{"shell_type": runtime}]),
        system_prompt: "Original instructions".to_owned(),
        project_workspace_path: Some(workspace.to_owned()),
        runtime_project_key: Some("original-project".to_owned()),
        runtime_workspace_roots: vec![workspace.to_owned()],
        extra: Map::from_iter([
            ("cloudProjectId".to_owned(), json!("project-1")),
            (
                "origin".to_owned(),
                json!({"type": "issue_execution", "dispatchRole": "member"}),
            ),
        ]),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink {
        local_task_id: request.task_id.clone(),
        thread_id: Some("original-thread".to_owned()),
        runtime: runtime.to_owned(),
        workspace_path: workspace.to_owned(),
        title: "Original work".to_owned(),
        runtime_handle: json!({"executorSession": {"session_id": "original-session"}}),
        ..RuntimeTaskLink::default()
    };
    store_runtime_execution_request(&mut link.runtime_handle, &request);
    (link, request)
}

#[test]
fn task_followup_preserves_original_profile_and_refreshes_backend_authentication() {
    let connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: "https://backend.example.com".to_owned(),
        socket_url: String::new(),
        auth_token: "current-session".to_owned(),
        runtime_auth_token: "current-runtime-token".to_owned(),
    })));
    for runtime in ["codex", "claude_code"] {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false")
            .with_backend_connection(connection.clone());
        let (link, original) = original_task(runtime, "C:\\projects\\original");
        let request = handler
            .task_message_execution_request(
                &json!({
                    "message": "Inspect memory next",
                    "clientUserMessageId": "reply-2",
                    "attachments": [{"id": "current-attachment"}],
                    "modelSelection": {"modelName": "unrelated-model"},
                    "workspacePath": "/unrelated/workspace",
                }),
                Some(&link),
            )
            .unwrap();

        assert_eq!(request.task_id, original.task_id);
        assert_eq!(request.subtask_id, "original-task-reply-2");
        assert_eq!(request.prompt, "Inspect memory next");
        assert_eq!(request.model_config, original.model_config);
        assert_eq!(request.bot, original.bot);
        assert_eq!(request.system_prompt, original.system_prompt);
        assert_eq!(
            request.project_workspace_path,
            original.project_workspace_path
        );
        assert_eq!(request.runtime_project_key, original.runtime_project_key);
        assert_eq!(
            request.runtime_workspace_roots,
            original.runtime_workspace_roots
        );
        assert_eq!(request.extra["origin"], original.extra["origin"]);
        assert_eq!(
            request.extra["attachments"],
            json!([{"id": "current-attachment"}])
        );
        assert_eq!(request.extra["client_user_message_id"], "reply-2");
        assert!(request.extra.get("modelSelection").is_none());
        assert_eq!(request.auth_token.as_deref(), Some("current-session"));
        assert_eq!(
            request.runtime_auth_token.as_deref(),
            Some("current-runtime-token")
        );
        assert!(!request.new_session);
    }
}

#[test]
fn task_followup_reuses_cached_cloud_model_route_with_current_credentials() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false").with_backend_connection(
        Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: "https://backend.example.com".to_owned(),
            socket_url: String::new(),
            auth_token: "current-session".to_owned(),
            runtime_auth_token: String::new(),
        }))),
    );
    let (mut link, mut original) = original_task("codex", "/original/workspace");
    original.model_config = json!({
        "model_id": "original-cloud-model",
        "base_url": "https://backend.example.com/api/runtime-work/llm-responses-proxy",
        "api_key": "previous-session",
        "wework_model_kind": "cloud",
        "default_headers": {"X-Wegent-Model-Name": "original-cloud-model"},
    });
    original.extra.insert("modelSelection".to_owned(), json!({
        "modelName": "original-cloud-model", "modelType": "public",
        "options": {"weworkCloudModelNamespace": "original-namespace", "weworkCloudModelResourceUserId": "42"},
    }));
    store_runtime_execution_request(&mut link.runtime_handle, &original);
    handler.retain_runtime_model_config(&link.local_task_id, &original.model_config);
    let request = handler
        .task_message_execution_request(&json!({"message": "Follow up"}), Some(&link))
        .unwrap();

    let mut expected = original.model_config;
    expected["api_key"] = json!("current-session");
    expected["default_headers"] = json!({
        "X-Wegent-Model-Name": "original-cloud-model", "X-Wegent-Model-Type": "public",
        "X-Wegent-Model-Namespace": "original-namespace", "X-Wegent-Model-User-Id": "42",
        "X-Wegent-Upstream-Header-wecode-executor": "codex", "X-Wegent-Upstream-Header-wecode-source": "wegent-local",
        "X-Wegent-Upstream-Header-wecode-session-id": "original-task",
    });
    assert_eq!(request.model_config, expected);
    assert_eq!(
        link.runtime_handle["executionRequest"]["model_config"]["api_key"],
        Value::Null
    );
}

#[test]
fn task_followup_restores_the_exact_cloud_model_after_executor_restart() {
    for runtime in ["codex", "claude_code"] {
        let (mut link, mut original) = original_task(runtime, "C:\\projects\\original");
        original.extra.insert(
            "modelSelection".to_owned(),
            json!({
                "modelName": "original-cloud-model", "modelType": "group",
                "options": {
                    "weworkCloudModelNamespace": "original-namespace",
                    "weworkCloudModelResourceUserId": "42",
                    "weworkCloudModelCodexCatalogModelId": "original-catalog-model",
                    "weworkCloudVisionSidecar": json!({"modelName": "original-vision-model", "modelType": "user",
                        "namespace": "vision-namespace", "resourceUserId": 7, "apiFormat": "anthropic-messages"}).to_string(),
                },
            }),
        );
        original.model_config = json!({
            "model": "openai", "model_id": "original-cloud-model", "wework_model_kind": "cloud",
            "base_url": "https://previous-backend.example/api/runtime-work/llm-responses-proxy",
            "api_key": "previous-session", "codex_catalog_model_id": "original-catalog-model",
            "reasoning": {"effort": "high"}, "native_namespace_tools": true,
            "default_headers": {"X-Wegent-Model-Type": "group"},
            "vision_sidecar": {
                "enabled": true, "request_url": "https://previous-backend.example/api/runtime-work/llm-responses-proxy/responses",
                "api_key": "previous-session", "model_id": "original-vision-model", "api_format": "anthropic-messages",
                "max_descriptions_per_turn": 8, "timeout_ms": 45_000,
                "default_headers": {"X-Wegent-Model-Type": "user"},
            },
        });
        store_runtime_execution_request(&mut link.runtime_handle, &original);
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false").with_backend_connection(
            Arc::new(Mutex::new(Some(ConnectionConfig {
                backend_url: "https://current-backend.example/api".to_owned(),
                socket_url: String::new(),
                auth_token: "current-session".to_owned(),
                runtime_auth_token: String::new(),
            }))),
        );
        assert!(handler.runtime_model_config(&link.local_task_id).is_none());
        assert!(link.runtime_handle["executionRequest"]["model_config"]
            .get("default_headers")
            .is_none());
        let request = handler
            .task_message_execution_request(&json!({"message": "Follow up"}), Some(&link))
            .unwrap();
        let mut expected = original.model_config;
        expected["api_key"] = json!("current-session");
        expected["base_url"] =
            json!("https://current-backend.example/api/runtime-work/llm-responses-proxy");
        let executor = if runtime == "claude_code" {
            "claudecode"
        } else {
            "codex"
        };
        expected["default_headers"] = json!({
            "X-Wegent-Model-Type": "group", "X-Wegent-Model-Namespace": "original-namespace", "X-Wegent-Model-User-Id": "42",
            "X-Wegent-Upstream-Header-wecode-executor": executor, "X-Wegent-Upstream-Header-wecode-source": "wegent-local",
            "X-Wegent-Upstream-Header-wecode-session-id": "original-task",
        });
        expected["vision_sidecar"]["api_key"] = json!("current-session");
        expected["vision_sidecar"]["request_url"] =
            json!("https://current-backend.example/api/runtime-work/llm-responses-proxy/responses");
        expected["vision_sidecar"]["default_headers"] = json!({
            "X-Wegent-Model-Type": "user", "X-Wegent-Model-Namespace": "vision-namespace", "X-Wegent-Model-User-Id": "7",
            "X-Wegent-Upstream-Header-wecode-executor": executor, "X-Wegent-Upstream-Header-wecode-source": "wegent-local",
            "X-Wegent-Upstream-Header-wecode-session-id": "original-task",
        });
        assert_eq!(request.model_config, expected);
        assert_eq!(
            request.extra["modelSelection"],
            original.extra["modelSelection"]
        );
        assert_eq!(
            request.runtime_workspace_roots,
            original.runtime_workspace_roots
        );
        assert_eq!(
            request.project_workspace_path,
            original.project_workspace_path
        );
    }
}

#[test]
fn task_followup_requires_the_original_task_and_profile() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let payload = json!({"message": "Follow up"});
    let error = handler
        .task_message_execution_request(&payload, None)
        .unwrap_err();
    assert_eq!(error.code, "task_not_found");
    let (mut link, _) = original_task("codex", "/original/workspace");
    for invalid in [
        Value::Null,
        json!({"bot": 3}),
        json!({}),
        json!({"model_config": {"model_id": "ambiguous-model"}}),
    ] {
        link.runtime_handle = json!({"executionRequest": invalid});
        let error = handler
            .task_message_execution_request(&payload, Some(&link))
            .unwrap_err();
        assert_eq!(error.code, "execution_profile_unavailable");
    }
}

#[test]
fn task_followup_rejects_a_redacted_external_model_without_its_original_credentials() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let (mut link, mut original) = original_task("codex", "/original/workspace");
    original.model_config = json!({"model_id": "original-model", "base_url": "https://model.example.com", "api_key": "original-secret"});
    store_runtime_execution_request(&mut link.runtime_handle, &original);
    let error = handler
        .task_message_execution_request(&json!({"message": "Follow up"}), Some(&link))
        .unwrap_err();
    assert_eq!(error.code, "execution_profile_unavailable");
}

#[test]
fn task_followup_keeps_explicit_execution_requests_unchanged() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let (_, original) = original_task("codex", "/original/workspace");
    let restored = handler
        .task_message_execution_request(
            &json!({
                "executionRequest": original,
                "message": "Unrelated message",
            }),
            None,
        )
        .unwrap();
    assert_eq!(restored, original);
}

#[tokio::test]
async fn task_followup_rpc_queues_on_the_same_codex_and_claude_task() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", home.path().to_str().unwrap());
    for runtime in ["codex", "claude_code"] {
        let (handler, root) = isolated_runtime_work_handler(&format!("task-followup-{runtime}"));
        fs::create_dir_all(&root).unwrap();
        let (link, original) = original_task(runtime, root.to_str().unwrap());
        handler.store.upsert_task(link);
        let execution_id = start_test_execution(&handler, &original.task_id);
        let response = handler
            .send_message(json!({
                "taskId": original.task_id,
                "message": "Inspect memory next",
                "clientUserMessageId": "reply-2",
                "threadId": "unrelated-thread",
                "queueIfBusy": true,
                "attachments": [{"id": "current-attachment"}],
            }))
            .await
            .unwrap();
        assert_eq!(response["accepted"], true);
        assert_eq!(response["taskId"], original.task_id);
        assert_eq!(response["runtime"], runtime);
        let scheduler = handler.turn_scheduler.lock().unwrap();
        let queued = scheduler.queued_turns.back().unwrap();
        assert_eq!(queued.local_task_id, original.task_id);
        assert_eq!(queued.request.task_id, original.task_id);
        assert_eq!(queued.request.prompt, "Inspect memory next");
        assert_eq!(queued.request.model_config, original.model_config);
        assert_eq!(
            queued.request.project_workspace_path,
            original.project_workspace_path
        );
        if runtime == "codex" {
            assert_eq!(queued.resume_thread_id.as_deref(), Some("original-thread"));
        } else {
            assert_eq!(
                queued.request.inherited_sessions[0],
                json!({"session_id": "original-session"})
            );
        }
        assert_eq!(handler.store.list_task_summaries(true).len(), 1);
        drop(scheduler);
        assert!(handler.finish_local_task_execution(&original.task_id, execution_id));
        let _ = fs::remove_dir_all(root);
    }
}
