// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn runtime_rpc_dispatch_retains_control_creation_routes() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let handler = RuntimeWorkRpcHandler::new("creation-routes", "unused-codex-binary");
    let response = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.models.sync_creation_profiles", "payload":{"profiles":[]}
        }))
        .await
        .unwrap();
    assert_eq!(response, json!({"success":true,"count":0}));

    let error = handler
        .handle_runtime_rpc(json!({
            "method":"runtime.tasks.create_from_intent", "payload":{}
        }))
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalid_request");
}

#[test]
fn runtime_rpc_dispatch_fits_a_bounded_worker_stack() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let handler = runtime
        .block_on(async { RuntimeWorkRpcHandler::new("bounded-stack", "unused-codex-binary") });
    std::thread::Builder::new()
        .stack_size(512 * 1024)
        .spawn(move || {
            runtime.block_on(async {
                let error = handler
                    .dispatch("runtime.stand_in.run", json!({}))
                    .await
                    .unwrap_err();
                assert_eq!(error.code, "bad_request");
                assert_eq!(error.message, "projectId is required");
            });
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn remote_app_server_rpc_rejects_methods_outside_plugin_allowlist() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let handler = RuntimeWorkRpcHandler::new("device-1", "unused-codex-binary");

            let error = handler
                .handle_runtime_rpc(json!({
                    "method": "runtime.codex.app_server.request",
                    "payload": {"method": "thread/new", "params": {}}
                }))
                .await
                .unwrap_err();

            assert_eq!(error.code, "unsupported_codex_app_server_method");
            assert_eq!(
                error.message,
                "Unsupported Codex app-server method: thread/new"
            );
        });
}

#[test]
fn remote_app_server_rpc_requires_inner_method() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let handler = RuntimeWorkRpcHandler::new("device-1", "unused-codex-binary");

            let error = handler
                .handle_runtime_rpc(json!({
                    "method": "runtime.codex.app_server.request",
                    "payload": {"params": {}}
                }))
                .await
                .unwrap_err();

            assert_eq!(error.code, "bad_request");
            assert_eq!(error.message, "method is required");
        });
}
