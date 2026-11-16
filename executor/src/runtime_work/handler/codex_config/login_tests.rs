// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::super::tests::{install_native_history, isolated_runtime_work_handler, ScalarEnv};
use super::*;

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide Codex authentication paths.
async fn login_dispatch_preserves_native_response_and_supports_device_code() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_CODEX_HOME", home.path().to_str().unwrap());
    let (mut handler, root) = isolated_runtime_work_handler("codex-device-code-login");
    install_native_history(&mut handler, &root, vec![], None);
    let (events, mut received) = broadcast::channel(8);
    handler.event_tx = Some(events);

    for (payload, login_type, response) in [
        (
            json!({}),
            "chatgpt",
            json!({"type":"chatgpt", "loginId":"browser-login", "authUrl":"https://auth.example/login"}),
        ),
        (
            json!({"type":"chatgptDeviceCode"}),
            "chatgptDeviceCode",
            json!({"type":"chatgptDeviceCode", "loginId":"device-login", "verificationUrl":"https://auth.example/device", "userCode":"ABCD-1234"}),
        ),
    ] {
        fs::write(root.join("account_login_start.json"), response.to_string()).unwrap();
        let completed = json!({"loginId":response["loginId"], "success":true, "error":null});
        fs::write(
            root.join("account_login_start.notifications.jsonl"),
            format!(
                "{}\n",
                json!({"method":"account/login/completed", "params":completed})
            ),
        )
        .unwrap();
        let mut result = handler
            .dispatch("runtime.codex.auth.login.start", payload)
            .await
            .unwrap();
        let generation = result
            .as_object_mut()
            .unwrap()
            .remove("processGeneration")
            .unwrap();
        assert_eq!(result, response);
        let completion = tokio::time::timeout(Duration::from_secs(1), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(completion["event"], "runtime.codex.auth.login.completed");
        assert_eq!(completion["payload"]["loginId"], completed["loginId"]);
        assert_eq!(completion["payload"]["success"], true);
        assert_eq!(completion["payload"]["deviceId"], "device-1");
        assert!(generation.as_u64().unwrap() > 0);
        assert_eq!(completion["payload"]["processGeneration"], generation);
        let requests = fs::read_to_string(root.join("requests.jsonl")).unwrap();
        let request: Value = requests
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .rev()
            .find(|request| request["method"] == "account/login/start")
            .unwrap();
        assert_eq!(request["params"], json!({"type":login_type}));
    }

    handler.codex_app_server.restart().await;
    if let Some(router) = handler.notification_router.lock().unwrap().take() {
        router.abort();
    }
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn login_completion_and_exit_do_not_require_a_conversation_route() {
    let (mut handler, root) = isolated_runtime_work_handler("codex-login-notifications");
    let (events, mut received) = broadcast::channel(8);
    handler.event_tx = Some(events);
    let (native, receiver) = mpsc::channel(8);
    let completions = [
        json!({"loginId":"rejected-login", "success":false, "error":"Authorization declined"}),
        json!({"loginId":"expired-login", "success":false, "error":"Device code expired"}),
        json!({"loginId":null, "success":true, "error":null}),
    ];
    for params in &completions {
        native
            .send(
                CodexNotification::from(json!({
                    "method":"account/login/completed", "params":params,
                }))
                .with_process_generation(12),
            )
            .await
            .unwrap();
    }
    native
        .send(
            CodexNotification::from(json!({
                "method":"codex/app-server/exited", "params":{"message":"native process stopped"},
            }))
            .with_process_generation(12),
        )
        .await
        .unwrap();
    drop(native);
    handler.run_notification_router(receiver).await;
    for mut params in completions {
        params["deviceId"] = json!("device-1");
        params["processGeneration"] = json!(12);
        let event = received.try_recv().unwrap();
        assert_eq!(
            event,
            json!({"type":"event", "event":"runtime.codex.auth.login.completed", "payload":params})
        );
    }
    let exit = received.try_recv().unwrap();
    assert_eq!(
        exit,
        json!({"type":"event", "event":"runtime.codex.app_server.exited", "payload":{
            "deviceId":"device-1", "processGeneration":12, "message":"native process stopped",
        }})
    );
    assert!(received.try_recv().is_err());
    assert!(!root.exists());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide Codex authentication paths.
async fn login_does_not_start_when_notification_subscription_fails() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_CODEX_HOME", home.path().to_str().unwrap());
    let (mut handler, root) = isolated_runtime_work_handler("codex-login-subscription-failure");
    handler.codex_app_server = CodexAppServerClient::isolated_for_test(
        root.join("missing-codex").to_str().unwrap(),
        home.path().to_path_buf(),
    );
    let error = handler
        .start_codex_login(json!({"type":"chatgptDeviceCode"}))
        .await
        .unwrap_err();
    assert_eq!(error.code, "codex_login_start_failed");
    assert!(handler.notification_router.lock().unwrap().is_none());
    assert!(!root.exists());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Isolate process-wide Codex authentication paths.
async fn login_rejects_invalid_types_before_reading_or_mutating_accounts() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_CODEX_HOME", home.path().to_str().unwrap());
    let auth_path = home.path().join("auth.json");
    fs::write(&auth_path, "invalid-auth-must-not-be-read").unwrap();
    let (handler, root) = isolated_runtime_work_handler("codex-invalid-login-type");
    for login_type in [json!("apiKey"), json!(""), json!(true), Value::Null] {
        let error = handler
            .dispatch_method("runtime.codex.auth.login.start", json!({"type":login_type}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_request");
    }
    assert_eq!(
        fs::read_to_string(auth_path).unwrap(),
        "invalid-auth-must-not-be-read"
    );
    assert_eq!(fs::read_dir(home.path()).unwrap().count(), 1);
    assert!(!root.exists());
}
