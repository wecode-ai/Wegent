// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use tokio::{
    sync::oneshot,
    time::{timeout, Duration},
};
use wegent_executor::{
    agents::{
        run_codex_app_server_turn_with_cancel, CodexAppServerClient, CodexAppServerTurnOptions,
    },
    protocol::ExecutionRequest,
    services::capability_activation,
};

#[tokio::test]
async fn running_codex_turn_releases_capability_lease_after_startup() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let _codex_home = EnvGuard::set("CODEX_HOME", root.path().join("codex").to_str().unwrap());
    let _wegent_codex_home = EnvGuard::set(
        "WEGENT_CODEX_HOME",
        root.path().join("codex").to_str().unwrap(),
    );
    let _workbench_home = EnvGuard::set(
        "WEGENT_WORKBENCH_HOME",
        root.path().join("workbench").to_str().unwrap(),
    );
    let _capabilities_home = EnvGuard::set(
        "WEGENT_CAPABILITIES_HOME",
        root.path().join("capabilities").to_str().unwrap(),
    );
    let _sqlite_home = EnvGuard::set(
        "CODEX_SQLITE_HOME",
        root.path().join("sqlite").to_str().unwrap(),
    );
    for dedicated in [false, true] {
        let log_path = root.path().join(format!("turn-{dedicated}.jsonl"));
        let binary = write_fake_codex_interruptible_turn(&log_path);
        let client = CodexAppServerClient::new(binary.display().to_string());
        let request: ExecutionRequest = serde_json::from_value(codex_execution_request(
            "Keep running until cancelled",
            "/tmp/project",
            "gpt-5.5",
        ))
        .unwrap();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let options = CodexAppServerTurnOptions {
            cancellation: Some(cancel_rx),
            ..Default::default()
        };
        let running_client = client.clone();
        let task = tokio::spawn(async move {
            if dedicated {
                run_codex_app_server_turn_with_cancel(binary.to_str().unwrap(), request, options)
                    .await
            } else {
                running_client.run_turn_with_cancel(request, options).await
            }
        });
        wait_for_method_count(&log_path, "turn/start", 1).await;
        assert!(
            !task.is_finished(),
            "the fixture must keep model work running"
        );
        let writer = timeout(Duration::from_secs(2), capability_activation::activate())
            .await
            .expect("capability publication must not wait for model work");
        capability_activation::mark_changed();
        drop(writer);
        let next_startup = timeout(
            Duration::from_secs(2),
            capability_activation::begin_execution(),
        )
        .await
        .expect("another task must be able to prepare while model work runs");
        drop(next_startup);
        assert!(!task.is_finished());
        cancel_tx.send(()).unwrap();
        let result = timeout(Duration::from_secs(5), task)
            .await
            .expect("turn must stop on cancellation")
            .unwrap();
        assert!(result.is_err(), "cancelled model work must not succeed");
        client.restart().await;
    }
}
