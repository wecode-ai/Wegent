// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

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

#[test]
fn marketplace_mutations_wait_for_bundled_configuration_reconciliation() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut handler = RuntimeWorkRpcHandler::new("device-1", "unused-codex-binary");
            let native = root.path().join("native");
            install_native_history(&mut handler, &native, vec![], None);
            let expected = json!({"marketplaceName":"connection-fixture"});
            for method in [
                "marketplace_add",
                "marketplace_remove",
                "marketplace_upgrade",
            ] {
                fs::write(native.join(format!("{method}.json")), expected.to_string()).unwrap();
            }
            fs::write(native.join("plugin_list.json"), r#"{"marketplaces":[]}"#).unwrap();
            handler.codex_app_server.ensure_started().await.unwrap();
            for method in [
                "marketplace/add",
                "marketplace/remove",
                "marketplace/upgrade",
            ] {
                assert_marketplace_mutation_serialized(&handler, method, &expected).await;
            }
            handler
                .codex_app_server
                .request("test/stop", json!({}))
                .await
                .unwrap();
        });
}

async fn assert_marketplace_mutation_serialized(
    handler: &RuntimeWorkRpcHandler,
    method: &str,
    expected: &Value,
) {
    let guard = handler
        .bundled_plugin_marketplace_reconciliation
        .lock()
        .await;
    let mutation = handler.handle_codex_app_server_rpc(json!({"method":method,"params":{}}));
    tokio::pin!(mutation);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), &mut mutation)
            .await
            .is_err(),
        "{method} was admitted during a full bundled configuration rewrite"
    );
    let read = handler.handle_codex_app_server_rpc(json!({"method":"plugin/list","params":{}}));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), read)
            .await
            .unwrap()
            .unwrap(),
        json!({"marketplaces":[]}),
        "Catalog reads must remain independent of the configuration mutation gate"
    );
    drop(guard);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), &mut mutation)
            .await
            .unwrap()
            .unwrap(),
        *expected
    );
}
