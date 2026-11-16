// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn cold_compaction_restores_api_inference_context() {
    verify_compaction_context(false, false).await;
}

#[tokio::test]
async fn cold_compaction_preserves_native_account_context() {
    verify_compaction_context(true, false).await;
}

#[tokio::test]
async fn loaded_compaction_replaces_the_process_profile_with_native_account_context() {
    verify_compaction_context(true, true).await;
}

#[tokio::test]
async fn loaded_compaction_replaces_the_process_profile_with_api_inference_context() {
    verify_compaction_context(false, true).await;
}

async fn verify_compaction_context(native: bool, loaded: bool) {
    let _lock = env_lock().await;
    let binary = temp_path("cold-compaction-codex", "sh");
    write_executable(
        &binary,
        &wegent_executor_test_support::with_codex_bundled_catalog(include_str!(
            "../fixtures/codex_cold_compaction.sh"
        )),
    );
    if loaded {
        fs::write(format!("{}.loaded", binary.display()), "loaded").unwrap();
    }
    let model = if native {
        json!({"model":"openai","model_id":"gpt-4.1","protocol":"openai-responses"})
    } else {
        json!({"model":"api-provider","model_id":"api-model","protocol":"openai-responses",
            "base_url":"http://127.0.0.1:9/v1","api_key":"fresh-test-key"})
    };
    let saved = execution_request_with_model_config(
        "existing conversation",
        "/tmp/project",
        json!({"model":"openai","model_id":"stale-model"}),
    );
    seed_runtime_task(
        &PathBuf::from(std::env::var("WEGENT_EXECUTOR_HOME").unwrap()),
        "cold-compaction-task",
        "thread-1",
        "/tmp/project",
        json!({"threadId":"thread-1","threadPath":"/tmp/legacy-thread.jsonl","executionRequest":saved}),
        false,
    );
    let handler = RuntimeWorkRpcHandler::new("device-1", binary.display().to_string());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        handler.handle_runtime_rpc(json!({"method":"runtime.tasks.compact","payload":{
            "taskId":"cold-compaction-task","workspacePath":"/tmp/project","modelConfig":model
        }})),
    )
    .await
    .expect("compaction must observe native completion")
    .unwrap();
    assert_eq!(result["success"], true, "{result}");
    assert_eq!(result["turnId"], "compact-turn");
    let calls = read_json_lines(&PathBuf::from(format!("{}.requests", binary.display())));
    let resume = calls
        .iter()
        .position(|call| call["method"] == "thread/resume")
        .unwrap();
    let compact = calls
        .iter()
        .position(|call| call["method"] == "thread/compact/start")
        .unwrap();
    assert!(resume < compact);
    if loaded {
        let unsubscribe = calls
            .iter()
            .position(|call| call["method"] == "thread/unsubscribe")
            .expect("loaded inference profiles must be unloaded before resume");
        assert!(unsubscribe < resume);
    }
    let params = &calls[resume]["params"];
    assert_eq!(params["path"], "/tmp/legacy-thread.jsonl");
    assert_eq!(params["excludeTurns"], true);
    assert_eq!(
        params["modelProvider"], "~",
        "cold inference must replace the process profile"
    );
    assert_eq!(params["model"], model["model_id"]);
    let provider = &params["config"]["model_providers.~"];
    assert_eq!(
        provider["name"],
        if native {
            "OpenAI"
        } else {
            "Wework model router"
        }
    );
    assert_eq!(provider["requires_openai_auth"], native);
    assert_eq!(provider["supports_websockets"], native);
}
