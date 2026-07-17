// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::VecDeque,
    future::Future,
    io::{Cursor, Write},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use wegent_executor::{
    config::device::UpdateConfig,
    emitter::EventEnvelope,
    local::{
        backend::{
            CapabilityReportProvider, CapabilitySyncRpcHandler, DeviceExtensionHandler,
            DeviceExtensionRunner, DeviceUpgradeHandler, EventHandler, HttpPackageProvider,
            LocalBackendClient, LocalBackendConfig, LocalBackendRunner, LocalBackendTransport,
            LocalRunningTaskTracker, LocalTaskController, LocalUpgradeService,
            ManagedLocalTaskRunner,
        },
        capabilities::{CapabilityPackageProvider, SkillSyncSpec},
        session::{LocalSessionHandler, PtySpawnRequest, SessionPtyManager, TerminalPty},
    },
    process::{CommandSpec, StreamProcessEngine},
    protocol::{ExecutionRequest, TaskStatus},
    runner::EventSink,
    server::{RunnerResult, TaskRunner},
    services::updater::UpdateResult,
};

const TEST_PROCESS_TIMEOUT_SECONDS: u64 = 3600;

#[tokio::test]
async fn local_backend_registers_all_python_local_device_events() {
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_task_controller(RecordingTaskController::default())
    .with_capability_sync_handler(RecordingCapabilitySync::default())
    .with_session_handler(test_session_handler())
    .with_upgrade_handler(RecordingUpgradeHandler::default());

    runner.register_handlers();

    for event in [
        "task:execute",
        "task:cancel",
        "task:close-session",
        "chat:message",
        "device:execute_command",
        "device:sync_capabilities",
        "device:start_terminal_session",
        "device:start_code_server_session",
        "terminal:attach",
        "terminal:input",
        "terminal:resize",
        "terminal:close",
        "runtime:rpc",
        "device:upgrade",
        "device:run_extension",
    ] {
        assert!(
            transport.handler(event).is_some(),
            "missing handler for {event}"
        );
    }
}

#[tokio::test]
async fn capability_sync_event_returns_ack_and_heartbeat_uses_reporter() {
    let transport = RecordingTransport::with_responses(vec![json!({"success": true})]);
    let sync = RecordingCapabilitySync::default();
    let reporter = StaticCapabilityReporter::new(json!({
        "revision": 7,
        "digest": "sha256:test",
        "full": true,
        "skills": [{"name": "browser", "source": "wegent"}],
        "plugins": [],
        "mcps": [],
        "last_sync_at": "2026-06-26T00:00:00Z"
    }));
    let client = LocalBackendClient::with_capability_reporter(
        local_backend_config(),
        transport.clone(),
        reporter,
    );
    let runner =
        LocalBackendRunner::from_client_and_runner(client.clone(), RecordingTaskRunner::default())
            .with_capability_sync_handler(sync.clone());
    runner.register_handlers();

    let ack = transport.handler("device:sync_capabilities").unwrap()(json!({
        "mode": "replace",
        "skills": [{"name": "browser", "skill_id": 101}],
        "plugins": [],
        "mcps": []
    }))
    .await
    .unwrap();
    assert_eq!(ack["success"], true, "{ack}");
    assert_eq!(
        sync.payloads(),
        vec![json!({
            "mode": "replace",
            "skills": [{"name": "browser", "skill_id": 101}],
            "plugins": [],
            "mcps": []
        })]
    );

    assert!(client.send_heartbeat(Duration::from_secs(1)).await.unwrap());
    let calls = transport.calls();
    assert_eq!(calls[0].event, "device:heartbeat");
    assert_eq!(calls[0].payload["capabilities"]["revision"], 7);
    assert_eq!(
        calls[0].payload["capabilities"]["skills"],
        json!([{"name": "browser", "source": "wegent"}])
    );
}

#[tokio::test]
async fn default_local_backend_runner_wires_capability_sync_and_code_server_session() {
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let capability_ack = transport.handler("device:sync_capabilities").unwrap()(json!({
        "mode": "replace",
        "skills": [],
        "plugins": [],
        "mcps": []
    }))
    .await
    .unwrap();
    assert_eq!(capability_ack["success"], true, "{capability_ack}");

    let session_dir = std::env::temp_dir().join(format!(
        "wegent-default-runner-code-session-{}",
        std::process::id()
    ));
    let session_ack = transport
        .handler("device:start_code_server_session")
        .unwrap()(json!({
        "type": "code_server",
        "session_id": "code-default",
        "project_id": 123,
        "path": session_dir.display().to_string(),
        "access_token": "secret",
        "create_if_missing": true
    }))
    .await
    .unwrap();

    assert_eq!(session_ack["success"], true, "{session_ack}");
    assert_eq!(session_ack["type"], "code_server");
    assert!(session_ack["url"]
        .as_str()
        .unwrap()
        .contains("code-default"));
}

#[tokio::test]
async fn http_capability_provider_encodes_namespace_and_rejects_external_package_urls() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let backend_url = serve_one_http_response(skill_zip_bytes(), Arc::clone(&requests)).await;
    let provider = HttpPackageProvider::new(backend_url, "secret-token");
    let target = std::env::temp_dir().join(format!(
        "wegent-http-capability-skill-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&target);

    provider
        .stage_skill(
            &SkillSyncSpec {
                name: "browser".to_owned(),
                skill_id: 42,
                namespace: "team a&x=y#z".to_owned(),
                is_public: false,
                content_hash: None,
            },
            &target,
        )
        .await
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
        "# Skill"
    );
    let request = requests.lock().unwrap().first().cloned().unwrap();
    assert!(
        request.starts_with(
            "GET /api/v1/kinds/skills/42/download?namespace=team+a%26x%3Dy%23z HTTP/1.1"
        ),
        "{request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-token"),
        "{request}"
    );

    let error = provider
        .download_plugin("https://example.com/not-backend.zip")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("backend origin"));
}

#[tokio::test]
async fn default_session_handler_uses_configured_workspace_root_for_relative_paths() {
    let workspace_root = std::env::temp_dir().join(format!(
        "wegent-configured-session-root-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&workspace_root);
    let transport = RecordingTransport::default();
    let mut config = local_backend_config();
    config.local_workspace_root = workspace_root.clone();
    let runner = LocalBackendRunner::new(config, transport.clone());
    runner.register_handlers();

    let ack = transport
        .handler("device:start_code_server_session")
        .unwrap()(json!({
        "type": "code_server",
        "session_id": "code-config-root",
        "project_id": 123,
        "path": "project-a",
        "access_token": "secret",
        "create_if_missing": true
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true, "{ack}");
    assert_eq!(
        ack["path"],
        workspace_root.join("project-a").display().to_string()
    );
    assert!(workspace_root.join("project-a").is_dir());
}

#[tokio::test]
async fn session_events_start_terminal_and_route_terminal_controls() {
    let transport = RecordingTransport::default();
    let terminal = Arc::new(Mutex::new(RecordingTerminal::default()));
    let session_handler = test_session_handler_with_terminal(Arc::clone(&terminal));
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_session_handler(session_handler);
    runner.register_handlers();

    let ack = transport.handler("device:start_terminal_session").unwrap()(json!({
        "type": "terminal",
        "session_id": "terminal-1",
        "project_id": 123,
        "path": ".",
        "access_token": "secret",
        "rows": 40,
        "cols": 120,
        "create_if_missing": true
    }))
    .await
    .unwrap();
    assert_eq!(ack["success"], true, "{ack}");
    assert_eq!(ack["type"], "terminal");
    assert_eq!(ack["transport"], "socketio");

    let attach = transport.handler("terminal:attach").unwrap()(json!({
        "session_id": "terminal-1"
    }))
    .await
    .unwrap();
    let input = transport.handler("terminal:input").unwrap()(json!({
        "session_id": "terminal-1",
        "data": "pwd\r"
    }))
    .await
    .unwrap();
    let resize = transport.handler("terminal:resize").unwrap()(json!({
        "session_id": "terminal-1",
        "rows": 24,
        "cols": 100
    }))
    .await
    .unwrap();
    let close = transport.handler("terminal:close").unwrap()(json!({"session_id": "terminal-1"}))
        .await
        .unwrap();

    assert_eq!(attach["success"], true);
    assert_eq!(input["success"], true);
    assert_eq!(resize["success"], true);
    assert_eq!(close["success"], true);
    let terminal = terminal.lock().unwrap();
    assert_eq!(terminal.writes, vec![b"pwd\r".to_vec()]);
    assert_eq!(terminal.resizes, vec![(24, 100)]);
    assert!(terminal.terminated);
    assert!(terminal.closed);
}

#[tokio::test]
async fn connected_runner_relays_terminal_output_and_exit_events() {
    let transport = RecordingTransport::default();
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"remote prompt$ ".to_vec()]),
        exit_code: Some(0),
        ..RecordingTerminal::default()
    }));
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_session_handler(test_session_handler_with_terminal(Arc::clone(&terminal)));
    let runner_task = tokio::spawn(runner.run_forever());
    wait_until(|| transport.handler("device:start_terminal_session").is_some()).await;

    let ack = transport.handler("device:start_terminal_session").unwrap()(json!({
        "type": "terminal",
        "session_id": "terminal-relay",
        "project_id": 123,
        "path": ".",
        "access_token": "secret",
        "rows": 24,
        "cols": 80,
        "create_if_missing": true
    }))
    .await
    .unwrap();
    assert_eq!(ack["success"], true, "{ack}");
    tokio::time::sleep(Duration::from_millis(75)).await;
    assert!(
        transport.emits().is_empty(),
        "PTY output must remain buffered until the browser attaches"
    );

    let attach = transport.handler("terminal:attach").unwrap()(json!({
        "session_id": "terminal-relay"
    }))
    .await
    .unwrap();
    assert_eq!(attach["success"], true, "{attach}");

    wait_until(|| transport.emits().len() >= 2).await;
    runner_task.abort();
    let _ = runner_task.await;

    let emits = transport.emits();
    assert_eq!(emits[0].event, "terminal:output");
    assert_eq!(
        emits[0].payload,
        json!({"session_id": "terminal-relay", "data": "remote prompt$ "})
    );
    assert_eq!(emits[1].event, "terminal:exit");
    assert_eq!(
        emits[1].payload,
        json!({"session_id": "terminal-relay", "exit_code": 0})
    );
    assert!(terminal.lock().unwrap().closed);
}

#[tokio::test]
async fn session_event_starts_code_server_session_with_gateway_url() {
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_session_handler(test_session_handler());
    runner.register_handlers();

    let ack = transport
        .handler("device:start_code_server_session")
        .unwrap()(json!({
        "type": "code_server",
        "session_id": "code-1",
        "project_id": 123,
        "path": ".",
        "access_token": "secret",
        "create_if_missing": true
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true, "{ack}");
    assert_eq!(ack["type"], "code_server");
    assert!(ack["url"]
        .as_str()
        .unwrap()
        .starts_with("http://localhost:17888/s/code-1/?"));
    assert!(ack["url"].as_str().unwrap().contains("token=secret"));
}

#[tokio::test]
async fn close_session_and_cancel_events_call_task_controller_and_refresh_heartbeat() {
    let transport = RecordingTransport::with_responses(vec![
        json!({"success": true}),
        json!({"success": true}),
    ]);
    let controller = RecordingTaskController::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_task_controller(controller.clone());
    runner.register_handlers();

    transport.handler("task:cancel").unwrap()(json!({"task_id": 10, "subtask_id": 20})).await;
    transport.handler("task:close-session").unwrap()(json!({"task_id": 10})).await;

    assert_eq!(
        controller.cancelled(),
        vec![("10".to_owned(), Some("20".to_owned()))]
    );
    assert_eq!(controller.closed(), vec!["10".to_owned()]);
    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].event, "device:heartbeat");
    assert_eq!(calls[0].payload["running_task_ids"], json!([]));
}

#[tokio::test]
async fn upgrade_event_calls_upgrade_handler_and_emits_backend_status() {
    let transport = RecordingTransport::default();
    let upgrade = RecordingUpgradeHandler::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_upgrade_handler(upgrade.clone());
    runner.register_handlers();

    let ack = transport.handler("device:upgrade").unwrap()(json!({
        "force": true,
        "auto_confirm": true,
        "verbose": true
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true);
    assert_eq!(
        upgrade.payloads(),
        vec![json!({
            "force": true,
            "auto_confirm": true,
            "verbose": true
        })]
    );
}

#[tokio::test]
async fn default_upgrade_event_reports_busy_when_tasks_are_running_without_force_stop() {
    let transport = RecordingTransport::default();
    let controller = RecordingTaskController::with_running_tasks([10, 11]);
    let upgrade = RecordingUpgradeService::latest();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_task_controller(controller.clone())
    .with_upgrade_service(upgrade.clone());
    runner.register_handlers();

    let ack = transport.handler("device:upgrade").unwrap()(json!({"auto_confirm": true}))
        .await
        .unwrap();

    assert_eq!(ack["success"], false, "{ack}");
    assert_eq!(ack["status"], "busy");
    assert_eq!(ack["running_task_ids"], json!(["10", "11"]));
    assert!(upgrade.calls().is_empty());
    assert_eq!(
        controller.cancelled(),
        Vec::<(String, Option<String>)>::new()
    );
    let emits = transport.emits();
    assert_eq!(emits.len(), 1);
    assert_eq!(emits[0].event, "device:upgrade_status");
    assert_eq!(emits[0].payload["status"], "busy");
    assert_eq!(emits[0].payload["device_id"], "device-1");
}

#[tokio::test]
async fn default_upgrade_event_force_stops_tasks_and_runs_updater() {
    let transport = RecordingTransport::with_responses(vec![json!({"success": true})]);
    let controller = RecordingTaskController::with_running_tasks([10, 11]);
    let upgrade = RecordingUpgradeService::updated();
    let mut config = local_backend_config();
    config.update = UpdateConfig {
        registry: "https://default-registry.example".to_owned(),
        registry_token: "default-token".to_owned(),
    };
    let runner = LocalBackendRunner::with_task_runner(
        config,
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_task_controller(controller.clone())
    .with_upgrade_service(upgrade.clone());
    runner.register_handlers();

    let ack = transport.handler("device:upgrade").unwrap()(json!({
        "force_stop_tasks": true,
        "auto_confirm": false,
        "verbose": true,
        "registry": "https://override-registry.example",
        "registry_token": "override-token"
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true, "{ack}");
    assert_eq!(ack["old_version"], "1.0.0");
    assert_eq!(ack["new_version"], "1.6.6");
    assert_eq!(
        controller.cancelled(),
        vec![("10".to_owned(), None), ("11".to_owned(), None)]
    );
    assert_eq!(
        upgrade.calls(),
        vec![UpgradeCall {
            update_config: UpdateConfig {
                registry: "https://override-registry.example".to_owned(),
                registry_token: "override-token".to_owned(),
            },
            auto_confirm: false,
            verbose: true,
        }]
    );
    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].event, "device:heartbeat");
    let statuses: Vec<_> = transport
        .emits()
        .into_iter()
        .map(|call| call.payload["status"].clone())
        .collect();
    assert_eq!(
        statuses,
        vec![json!("checking"), json!("success"), json!("restarting")]
    );
}

#[tokio::test]
async fn upgrade_service_uses_task_controller_even_when_builder_order_is_reversed() {
    let transport = RecordingTransport::with_responses(vec![json!({"success": true})]);
    let controller = RecordingTaskController::with_running_tasks([21]);
    let upgrade = RecordingUpgradeService::latest();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_upgrade_service(upgrade.clone())
    .with_task_controller(controller.clone());
    runner.register_handlers();

    let ack = transport.handler("device:upgrade").unwrap()(json!({
        "force_stop_tasks": true,
        "auto_confirm": true
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true, "{ack}");
    assert_eq!(controller.cancelled(), vec![("21".to_owned(), None)]);
    assert_eq!(upgrade.calls().len(), 1);
}

#[tokio::test]
async fn upgrade_force_stop_aborts_when_task_cancellation_fails() {
    let transport = RecordingTransport::default();
    let controller = FailingCancelTaskController::with_running_tasks([31]);
    let upgrade = RecordingUpgradeService::latest();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        RecordingTaskRunner::default(),
    )
    .with_task_controller(controller.clone())
    .with_upgrade_service(upgrade.clone());
    runner.register_handlers();

    let ack = transport.handler("device:upgrade").unwrap()(json!({
        "force_stop_tasks": true,
        "auto_confirm": true
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], false, "{ack}");
    assert_eq!(ack["status"], "error");
    assert_eq!(controller.cancelled(), vec![("31".to_owned(), None)]);
    assert!(upgrade.calls().is_empty());
    let statuses: Vec<_> = transport
        .emits()
        .into_iter()
        .map(|call| call.payload["status"].clone())
        .collect();
    assert_eq!(statuses, vec![json!("error")]);
}

#[cfg(unix)]
#[tokio::test]
async fn default_extension_event_runs_skill_script_with_payload_environment() {
    let workspace_root =
        std::env::temp_dir().join(format!("wegent-extension-workspace-{}", std::process::id()));
    let script_dir = workspace_root
        .join("123")
        .join(".claude")
        .join("skills")
        .join("sample-extension");
    std::fs::create_dir_all(script_dir.join("bin")).unwrap();
    let script = script_dir.join("bin/run.sh");
    std::fs::write(
        &script,
        r#"#!/bin/sh
printf '{"success":true,"action":"%s","name":"%s","foo":"%s"}' "$WEGENT_EXTENSION_ACTION" "$WEGENT_EXTENSION_NAME" "$WEGENT_EXT_FOO_BAR"
"#,
    )
    .unwrap();
    make_executable(&script);

    let transport = RecordingTransport::default();
    let mut config = local_backend_config();
    config.local_workspace_root = workspace_root;
    let runner = LocalBackendRunner::new(config, transport.clone());
    runner.register_handlers();

    let ack = transport.handler("device:run_extension").unwrap()(json!({
        "extension_name": "sample-extension",
        "action": "render",
        "task_id": 123,
        "script_path": "bin/run.sh",
        "payload": {"foo-bar": "baz"}
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true, "{ack}");
    assert_eq!(ack["action"], "render");
    assert_eq!(ack["name"], "sample-extension");
    assert_eq!(ack["foo"], "baz");
}

#[cfg(unix)]
#[tokio::test]
async fn device_extension_runner_runs_global_skill_script() {
    let temp_root =
        std::env::temp_dir().join(format!("wegent-global-extension-{}", std::process::id()));
    let workspace_root = temp_root.join("workspace");
    let global_skills_root = temp_root.join("home").join(".claude").join("skills");
    let script_dir = global_skills_root.join("sample-extension");
    let _ = std::fs::remove_dir_all(&temp_root);
    std::fs::create_dir_all(script_dir.join("bin")).unwrap();
    let script = script_dir.join("bin/run.sh");
    std::fs::write(
        &script,
        r#"#!/bin/sh
printf '{"success":true,"scope":"global"}'
"#,
    )
    .unwrap();
    make_executable(&script);

    let runner = DeviceExtensionRunner::with_global_skills_root(workspace_root, global_skills_root);
    let ack = runner
        .handle_run_extension(json!({
            "extension_name": "sample-extension",
            "extension_scope": "global",
            "action": "render",
            "task_id": 123,
            "script_path": "bin/run.sh",
            "payload": {}
        }))
        .await;

    assert_eq!(ack["success"], true, "{ack}");
    assert_eq!(ack["scope"], "global");
}

#[cfg(unix)]
#[tokio::test]
async fn default_extension_event_rejects_script_path_escape() {
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let ack = transport.handler("device:run_extension").unwrap()(json!({
        "extension_name": "sample-extension",
        "action": "render",
        "task_id": 123,
        "script_path": "../run.sh",
        "payload": {}
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], false, "{ack}");
    assert!(ack["message"]
        .as_str()
        .unwrap()
        .contains("Invalid script_path"));
}

#[tokio::test]
async fn default_extension_event_rejects_path_meta_extension_names() {
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    for extension_name in [".", ".."] {
        let ack = transport.handler("device:run_extension").unwrap()(json!({
            "extension_name": extension_name,
            "action": "render",
            "task_id": 123,
            "script_path": "run.sh",
            "payload": {}
        }))
        .await
        .unwrap();

        assert_eq!(ack["success"], false, "{ack}");
        assert!(ack["message"]
            .as_str()
            .unwrap()
            .contains("Invalid extension_name"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn managed_local_task_runner_tracks_running_tasks_and_cancel_aborts_child_process() {
    let temp = std::env::temp_dir().join(format!(
        "wegent-managed-runner-cancel-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).unwrap();
    let pid_file = temp.join("child.pid");
    let script = temp.join("long-running.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s' $$ > '{}'\nwhile true; do sleep 1; done\n",
            pid_file.display()
        ),
    )
    .unwrap();
    make_executable(&script);

    let tracker = LocalRunningTaskTracker::default();
    let sink = RecordingEventSink::default();
    let heartbeat_transport = RecordingTransport::with_responses(vec![
        json!({"success": true}),
        json!({"success": true}),
    ]);
    let heartbeat_client = LocalBackendClient::with_capability_reporter_and_tracker(
        local_backend_config(),
        heartbeat_transport.clone(),
        StaticCapabilityReporter::new(json!({
            "revision": 0,
            "digest": "sha256:test",
            "full": true,
            "skills": [],
            "plugins": [],
            "mcps": [],
            "last_sync_at": null
        })),
        tracker.clone(),
    );
    let runner = ManagedLocalTaskRunner::new(
        StreamProcessEngine::new(
            CommandSpec::new(script.display().to_string()),
            TEST_PROCESS_TIMEOUT_SECONDS,
        ),
        sink.clone(),
        tracker.clone(),
    );
    let request = ExecutionRequest {
        task_id: "501".to_owned(),
        subtask_id: "502".to_owned(),
        ..ExecutionRequest::default()
    };

    let result = runner.submit(request).await;

    assert_eq!(result.status, TaskStatus::Running);
    wait_until(|| pid_file.exists()).await;
    assert_eq!(tracker.running_task_ids(), vec!["501".to_owned()]);
    assert!(heartbeat_client
        .send_heartbeat(Duration::from_secs(1))
        .await
        .unwrap());
    assert_eq!(
        heartbeat_transport.calls()[0].payload["running_task_ids"],
        json!(["501"])
    );

    assert!(
        runner
            .cancel_task("501".to_owned(), Some("502".to_owned()))
            .await
    );
    let pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    wait_until(|| !process_is_alive(pid)).await;
    assert!(tracker.running_task_ids().is_empty());
    assert!(heartbeat_client
        .send_heartbeat(Duration::from_secs(1))
        .await
        .unwrap());
    assert_eq!(
        heartbeat_transport.calls()[1].payload["running_task_ids"],
        json!([])
    );
    assert!(sink.events().iter().any(|event| event.event_type == "error"
        && event.data["code"] == "cancelled"
        && event.task_id == "501"));
}

#[derive(Clone, Debug)]
struct RecordedCall {
    event: String,
    payload: Value,
}

#[derive(Clone, Default)]
struct RecordingTransport {
    calls: Arc<Mutex<Vec<RecordedCall>>>,
    emits: Arc<Mutex<Vec<RecordedCall>>>,
    responses: Arc<Mutex<VecDeque<Value>>>,
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
}

impl RecordingTransport {
    fn with_responses(responses: Vec<Value>) -> Self {
        Self {
            responses: Arc::new(Mutex::new(responses.into())),
            ..Self::default()
        }
    }

    fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }

    fn emits(&self) -> Vec<RecordedCall> {
        self.emits.lock().unwrap().clone()
    }

    fn handler(&self, event: &str) -> Option<EventHandler> {
        self.handlers
            .lock()
            .unwrap()
            .iter()
            .find(|(name, _)| name == event)
            .map(|(_, handler)| Arc::clone(handler))
    }
}

impl LocalBackendTransport for RecordingTransport {
    fn connect<'a>(
        &'a self,
        _config: &'a LocalBackendConfig,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn disconnect<'a>(&'a self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn call<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
        _timeout: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(RecordedCall {
                event: event.to_owned(),
                payload,
            });
            Ok(self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| json!({"success": true})))
        })
    }

    fn emit<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            self.emits.lock().unwrap().push(RecordedCall {
                event: event.to_owned(),
                payload,
            });
            Ok(())
        })
    }

    fn on(&self, event: &str, handler: EventHandler) {
        self.handlers
            .lock()
            .unwrap()
            .push((event.to_owned(), handler));
    }
}

#[derive(Clone, Default)]
struct RecordingTaskRunner {
    submitted: Arc<Mutex<Vec<ExecutionRequest>>>,
}

#[derive(Clone, Default)]
struct RecordingEventSink {
    events: Arc<Mutex<Vec<EventEnvelope>>>,
}

impl RecordingEventSink {
    fn events(&self) -> Vec<EventEnvelope> {
        self.events.lock().unwrap().clone()
    }
}

impl EventSink for RecordingEventSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        self.events.lock().unwrap().push(event);
        Box::pin(async { Ok(()) })
    }
}

impl TaskRunner for RecordingTaskRunner {
    type SubmitFuture = Pin<Box<dyn Future<Output = RunnerResult> + Send>>;

    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture {
        self.submitted.lock().unwrap().push(request);
        Box::pin(async { RunnerResult::accepted(TaskStatus::Running) })
    }
}

type CancelRecords = Arc<Mutex<Vec<(String, Option<String>)>>>;
type TaskIds = Arc<Mutex<Vec<String>>>;

#[derive(Clone, Default)]
struct RecordingTaskController {
    cancelled: CancelRecords,
    closed: TaskIds,
    running: TaskIds,
}

impl RecordingTaskController {
    fn with_running_tasks<I>(task_ids: I) -> Self
    where
        I: IntoIterator<Item = i64>,
    {
        Self {
            running: Arc::new(Mutex::new(
                task_ids
                    .into_iter()
                    .map(|task_id| task_id.to_string())
                    .collect(),
            )),
            ..Self::default()
        }
    }

    fn cancelled(&self) -> Vec<(String, Option<String>)> {
        self.cancelled.lock().unwrap().clone()
    }

    fn closed(&self) -> Vec<String> {
        self.closed.lock().unwrap().clone()
    }
}

impl LocalTaskController for RecordingTaskController {
    fn cancel_task<'a>(
        &'a self,
        task_id: String,
        subtask_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            self.cancelled
                .lock()
                .unwrap()
                .push((task_id.clone(), subtask_id));
            self.running
                .lock()
                .unwrap()
                .retain(|running_task_id| running_task_id != &task_id);
            true
        })
    }

    fn close_task_session<'a>(
        &'a self,
        task_id: String,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            self.closed.lock().unwrap().push(task_id);
            true
        })
    }

    fn running_task_ids(&self) -> Vec<String> {
        self.running.lock().unwrap().clone()
    }
}

#[derive(Clone)]
struct FailingCancelTaskController {
    cancelled: CancelRecords,
    running: TaskIds,
}

impl FailingCancelTaskController {
    fn with_running_tasks<I>(task_ids: I) -> Self
    where
        I: IntoIterator<Item = i64>,
    {
        Self {
            cancelled: Arc::new(Mutex::new(Vec::new())),
            running: Arc::new(Mutex::new(
                task_ids
                    .into_iter()
                    .map(|task_id| task_id.to_string())
                    .collect(),
            )),
        }
    }

    fn cancelled(&self) -> Vec<(String, Option<String>)> {
        self.cancelled.lock().unwrap().clone()
    }
}

impl LocalTaskController for FailingCancelTaskController {
    fn cancel_task<'a>(
        &'a self,
        task_id: String,
        subtask_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            self.cancelled.lock().unwrap().push((task_id, subtask_id));
            false
        })
    }

    fn close_task_session<'a>(
        &'a self,
        _task_id: String,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async { true })
    }

    fn running_task_ids(&self) -> Vec<String> {
        self.running.lock().unwrap().clone()
    }
}

#[derive(Clone, Default)]
struct RecordingCapabilitySync {
    payloads: Arc<Mutex<Vec<Value>>>,
}

impl RecordingCapabilitySync {
    fn payloads(&self) -> Vec<Value> {
        self.payloads.lock().unwrap().clone()
    }
}

impl CapabilitySyncRpcHandler for RecordingCapabilitySync {
    fn handle_sync_capabilities<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>> {
        Box::pin(async move {
            self.payloads.lock().unwrap().push(payload);
            json!({"success": true})
        })
    }
}

#[derive(Clone)]
struct StaticCapabilityReporter {
    report: Value,
}

impl StaticCapabilityReporter {
    fn new(report: Value) -> Self {
        Self { report }
    }
}

impl CapabilityReportProvider for StaticCapabilityReporter {
    fn build_report(&self) -> Value {
        self.report.clone()
    }
}

#[derive(Clone, Default)]
struct RecordingUpgradeHandler {
    payloads: Arc<Mutex<Vec<Value>>>,
}

impl RecordingUpgradeHandler {
    fn payloads(&self) -> Vec<Value> {
        self.payloads.lock().unwrap().clone()
    }
}

impl DeviceUpgradeHandler for RecordingUpgradeHandler {
    fn handle_upgrade<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>> {
        Box::pin(async move {
            self.payloads.lock().unwrap().push(payload);
            json!({"success": true})
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UpgradeCall {
    update_config: UpdateConfig,
    auto_confirm: bool,
    verbose: bool,
}

#[derive(Clone)]
struct RecordingUpgradeService {
    result: UpdateResult,
    calls: Arc<Mutex<Vec<UpgradeCall>>>,
}

impl RecordingUpgradeService {
    fn latest() -> Self {
        Self::new(UpdateResult {
            success: true,
            already_latest: true,
            old_version: Some("1.6.6".to_owned()),
            ..UpdateResult::default()
        })
    }

    fn updated() -> Self {
        Self::new(UpdateResult {
            success: true,
            old_version: Some("1.0.0".to_owned()),
            new_version: Some("1.6.6".to_owned()),
            ..UpdateResult::default()
        })
    }

    fn new(result: UpdateResult) -> Self {
        Self {
            result,
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn calls(&self) -> Vec<UpgradeCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl LocalUpgradeService for RecordingUpgradeService {
    fn check_and_update<'a>(
        &'a self,
        update_config: UpdateConfig,
        auto_confirm: bool,
        verbose: bool,
    ) -> Pin<Box<dyn Future<Output = UpdateResult> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(UpgradeCall {
                update_config,
                auto_confirm,
                verbose,
            });
            self.result.clone()
        })
    }
}

fn local_backend_config() -> LocalBackendConfig {
    LocalBackendConfig {
        backend_url: "http://localhost:8000".to_owned(),
        auth_token: "wg-token".to_owned(),
        device_id: "device-1".to_owned(),
        runtime_instance_id: "runtime-1".to_owned(),
        device_name: "Device One".to_owned(),
        device_type: "local".to_owned(),
        app_device_id: String::new(),
        bind_shell: "claudecode".to_owned(),
        executor_version: "test-version".to_owned(),
        client_ip: "192.0.2.10".to_owned(),
        runtime_transfer_host: "192.0.2.10".to_owned(),
        heartbeat_interval: Duration::from_secs(30),
        heartbeat_timeout: Duration::from_secs(10),
        registration_timeout: Duration::from_secs(10),
        reconnect_delay: Duration::from_secs(1),
        reconnect_delay_max: Duration::from_secs(30),
        configured_capabilities: Vec::new(),
        runtime_auth_home: std::env::temp_dir().join("wegent-device-migration-auth"),
        local_workspace_root: std::env::temp_dir().join("wegent-device-migration-workspace"),
        update: UpdateConfig::default(),
    }
}

fn test_session_handler() -> LocalSessionHandler {
    test_session_handler_with_terminal(Arc::new(Mutex::new(RecordingTerminal::default())))
}

fn test_session_handler_with_terminal(
    terminal: Arc<Mutex<RecordingTerminal>>,
) -> LocalSessionHandler {
    let workspace_root = std::env::temp_dir().join(format!(
        "wegent-device-migration-session-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&workspace_root).unwrap();
    LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        workspace_root,
        Arc::new(RecordingPtyManager::new(terminal)),
    )
}

async fn serve_one_http_response(body: Vec<u8>, requests: Arc<Mutex<Vec<String>>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0; 8192];
        let read = stream.read(&mut buffer).await.unwrap();
        requests
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(&buffer[..read]).to_string());
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
    });
    format!("http://{address}")
}

fn skill_zip_bytes() -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::FileOptions::default();
    writer.start_file("browser/SKILL.md", options).unwrap();
    writer.write_all(b"# Skill").unwrap();
    writer.finish().unwrap().into_inner()
}

struct RecordingPtyManager {
    terminal: Arc<Mutex<RecordingTerminal>>,
}

impl RecordingPtyManager {
    fn new(terminal: Arc<Mutex<RecordingTerminal>>) -> Self {
        Self { terminal }
    }
}

impl SessionPtyManager for RecordingPtyManager {
    fn is_available(&self) -> bool {
        true
    }

    fn spawn(&self, _request: PtySpawnRequest) -> Result<Box<dyn TerminalPty>, String> {
        Ok(Box::new(SharedTerminal(Arc::clone(&self.terminal))))
    }
}

#[derive(Default)]
struct RecordingTerminal {
    output: VecDeque<Vec<u8>>,
    exit_code: Option<u32>,
    writes: Vec<Vec<u8>>,
    resizes: Vec<(u16, u16)>,
    terminated: bool,
    closed: bool,
}

struct SharedTerminal(Arc<Mutex<RecordingTerminal>>);

impl TerminalPty for SharedTerminal {
    fn pid(&self) -> u32 {
        1234
    }

    fn fd(&self) -> Option<i32> {
        None
    }

    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().writes.push(data.to_vec());
        Ok(data.len())
    }

    fn read_available(&mut self, _timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        Ok(self.0.lock().unwrap().output.pop_front())
    }

    fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        self.0.lock().unwrap().resizes.push((rows, cols));
        Ok(())
    }

    fn poll(&mut self) -> std::io::Result<Option<u32>> {
        Ok(self.0.lock().unwrap().exit_code)
    }

    fn terminate(&mut self, _force: bool) {
        self.0.lock().unwrap().terminated = true;
    }

    fn close(&mut self) {
        self.0.lock().unwrap().closed = true;
    }
}

#[cfg(unix)]
fn make_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions).unwrap();
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

async fn wait_until(condition: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(condition());
}
