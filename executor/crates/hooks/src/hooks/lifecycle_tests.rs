use super::*;
use crate::hooks::{model::HookUser, registry::HookRegistryStore};
use serde_json::{json, Value};
use std::{fs, path::Path, time::Duration};

fn context(cwd: &Path) -> LifecycleInput {
    LifecycleInput {
        schema_version: 1,
        emitted_at_ms: 0,
        event_id: String::new(),
        execution_id: "execution".into(),
        sequence: 0,
        task_id: Some("source-task".into()),
        request_id: Some("request".into()),
        runtime_task_id: Some("local-task".into()),
        device_id: Some("device".into()),
        runtime: Some("Codex".into()),
        executor_version: Some("test-version".into()),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        user: HookUser {
            id: None,
            name: "test".into(),
        },
        cwd: cwd.to_owned(),
        session_id: None,
        turn_id: None,
        model: Some("test-model".into()),
        model_provider: Some("test-provider".into()),
        permission_mode: "workspace-write".into(),
        hook_event_name: HookEventName::TurnStarted,
        status: "started".into(),
        is_test: false,
    }
}

#[tokio::test]
async fn stalled_scripts_never_block_publishers_and_events_drain_in_order() {
    let root = tempfile::tempdir().unwrap();
    let entered = root.path().join("entered");
    let release = root.path().join("release");
    let script = root.path().join("reporter.mjs");
    fs::write(
        &script,
        format!(
            "import{{readFileSync,writeFileSync,existsSync}}from'node:fs';\n\
         import{{setTimeout as delay}}from'node:timers/promises';\n\
         const input=JSON.parse(readFileSync(0,'utf8'));\n\
         if(input.hook_event_name==='TurnStarted'){{\n\
           writeFileSync({},'entered');\n\
           while(!existsSync({}))await delay(5);\n\
         }}\nconsole.log(JSON.stringify(input));",
            serde_json::to_string(&entered).unwrap(),
            serde_json::to_string(&release).unwrap(),
        ),
    )
    .unwrap();
    let registry = HookRegistryStore::new(root.path().join("home"));
    let handler = json!([{"matcher":".*","hooks":[{
        "type":"command", "command":format!("node \"{}\"", script.display()),
        "timeout":10, "async":false,
    }]}]);
    registry
        .create(
            serde_json::from_value(
                json!({"schemaVersion":1,"id":"events","name":"Events","version":"1"}),
            )
            .unwrap(),
            serde_json::from_value(
                json!({"TurnStarted":handler,"TurnCompleted":handler,"ExecutionCompleted":handler}),
            )
            .unwrap(),
        )
        .unwrap();
    let service = HookService::new(registry, root.path().join("codex"));
    let (sender, mut received) = tokio::sync::broadcast::channel(16);
    service.set_event_sender(sender);
    let mut hooks = LifecycleHooks::new(service.clone(), context(root.path()));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !entered.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    hooks.started("root-thread", "turn-1");
    for (thread, agent) in [
        ("child-thread", "/root/child"),
        ("root-thread", "/root/child"),
    ] {
        hooks.observe_codex(
            "root-thread",
            &json!({"method":"turn/completed","params":{
                "threadId":thread,"turn":{"id":"child","agentPath":agent,"status":"completed"}
            }}),
        );
    }
    hooks.observe_codex(
        "root-thread",
        &json!({"method":"turn/completed","params":{
            "threadId":"root-thread","turn":{"id":"turn-1","status":"completed"}
        }}),
    );
    hooks.observe_codex(
        "root-thread",
        &json!({"method":"turn/started","params":{
            "threadId":"root-thread","turn":{"id":"turn-2"}
        }}),
    );
    hooks.finish("interrupted");
    hooks.finish("interrupted");
    drop(hooks);
    assert!(
        received.try_recv().is_err(),
        "The first script must still be blocked"
    );
    fs::write(release, "release").unwrap();
    let mut events = Vec::new();
    for _ in 0..4 {
        let event = tokio::time::timeout(Duration::from_secs(10), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["payload"]["run"]["status"], "succeeded", "{event}");
        events.push(
            serde_json::from_str::<Value>(
                event["payload"]["run"]["stdoutPreview"].as_str().unwrap(),
            )
            .unwrap(),
        );
    }
    assert_eq!(
        events
            .iter()
            .map(|event| event["hook_event_name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "TurnStarted",
            "TurnCompleted",
            "TurnCompleted",
            "ExecutionCompleted"
        ]
    );
    assert!(events[0]["session_id"].is_null());
    assert_eq!(events[1]["turn_id"], "turn-1");
    assert_eq!(events[2]["turn_id"], "turn-2");
    assert_eq!(events[2]["status"], "interrupted");
    let expected_context = serde_json::to_value(context(root.path())).unwrap();
    for (sequence, event) in events.iter().enumerate() {
        assert_eq!(event["sequence"], sequence);
        assert_eq!(event["schema_version"], 1);
        assert!(event["emitted_at_ms"].as_i64().unwrap() > 0);
        for key in [
            "task_id",
            "request_id",
            "runtime_task_id",
            "device_id",
            "runtime",
            "executor_version",
            "platform",
            "arch",
            "model",
            "model_provider",
            "user",
        ] {
            assert_eq!(event[key], expected_context[key]);
        }
        assert!(event.get("file_changes").is_none());
    }
    assert!(!root.path().join(".git").exists());
}

#[tokio::test]
async fn synthetic_lifecycle_test_is_marked_without_native_identifiers() {
    let root = tempfile::tempdir().unwrap();
    let registry = HookRegistryStore::new(root.path().join("home"));
    let reader = root.path().join("reader.mjs");
    fs::write(
        &reader,
        "import{readFileSync}from'node:fs';console.log(readFileSync(0,'utf8'))",
    )
    .unwrap();
    registry
        .create(
            serde_json::from_value(
                json!({"schemaVersion":1,"id":"events","name":"Events","version":"1"}),
            )
            .unwrap(),
            serde_json::from_value(json!({"TurnCompleted":[{"matcher":".*","hooks":[{
                "type":"command","command":format!("node \"{}\"", reader.display())
            }]}]}))
            .unwrap(),
        )
        .unwrap();
    let service = HookService::new(registry, root.path().join("codex"));
    let run = service
        .test("events", "turn-completed-0-0", root.path().to_owned())
        .await
        .unwrap();
    let input: Value = serde_json::from_str(&run.stdout_preview).unwrap();
    assert_eq!(input["is_test"], true);
    assert_eq!(input["schema_version"], 1);
    assert!(input["emitted_at_ms"].as_i64().unwrap() > 0);
    for key in [
        "task_id",
        "request_id",
        "runtime_task_id",
        "device_id",
        "runtime",
        "executor_version",
        "model_provider",
    ] {
        assert!(input[key].is_null());
    }
    assert!(input["session_id"].is_null());
    assert!(input["turn_id"].is_null());
}
