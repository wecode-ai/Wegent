// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn reply_prediction_does_not_resume_legacy_in_memory_chats() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let _codex_home = ScalarEnv::set("CODEX_HOME", root.path().to_str().unwrap());
    let _wegent_codex_home = ScalarEnv::set("WEGENT_CODEX_HOME", root.path().to_str().unwrap());
    let _workbench_home = ScalarEnv::set("WEGENT_WORKBENCH_HOME", root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            // A native RPC would fail: legacy chats must be rejected before process startup.
            let handler = RuntimeWorkRpcHandler::new("device-1", "unused-codex-binary");
            let mut link = RuntimeTaskLink::new_pending(
                "legacy-side-chat".into(),
                root.path().to_string_lossy().into_owned(),
                "Temporary chat".into(),
            );
            link.ephemeral = true;
            link.thread_id = Some("legacy-in-memory-thread".into());
            handler.upsert_local_task(link);

            let result = handler
                .handle_runtime_rpc(json!({
                    "method": "runtime.text.predict_reply",
                    "payload": {
                        "taskId": "legacy-side-chat",
                        "requestId": "prediction-1"
                    }
                }))
                .await
                .unwrap();

            assert_eq!(result, json!({"suggestion": null}));
            assert!(handler.active_text_generations.lock().unwrap().is_empty());
        });
}
