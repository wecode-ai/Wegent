use std::io::Write;
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};

fn query(home: &std::path::Path, request: Value) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .args(["--workbench-project-state", "--version"])
        .env_clear()
        .env("HOME", home)
        .env("WEGENT_EXECUTOR_HOME", home)
        .env("WEGENT_CODEX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn project_state_query_replays_native_operations_without_initializing_a_home() {
    let temporary = tempfile::tempdir().unwrap();
    let unused_home = temporary.path().join("unused-home");
    let workspace = temporary.path().join("synthetic-workspace");
    let operations = [
        json!({"version":1,"kind":"upsert_local_project","projectKey":"project-1","label":"Synthetic project","roots":[workspace]}),
        json!({"version":1,"kind":"activate_project","projectKey":"project-1","workspacePath":workspace}),
        json!({"version":1,"kind":"pin_thread","threadId":"thread-1","pinned":true}),
    ].map(|value| value.to_string()).join("\n");
    let output = query(
        &unused_home,
        json!({"protocol_version":1,"state":{},"oplog":operations}),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let projected: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(projected["protocol_version"], 1);
    assert_eq!(
        projected["state"]["local-projects"]["project-1"]["name"],
        "Synthetic project"
    );
    assert_eq!(
        projected["state"]["active-workspace-roots"],
        json!([workspace])
    );
    assert_eq!(projected["state"]["pinned-thread-ids"], json!(["thread-1"]));
    assert!(!unused_home.exists());
    assert!(!workspace.exists());
}

#[test]
fn invalid_project_operations_fail_without_echoing_private_input_or_partial_results() {
    let temporary = tempfile::tempdir().unwrap();
    let unused_home = temporary.path().join("unused-home");
    for oplog in [
        "{private-synthetic-value",
        r#"{"version":99,"kind":"pin_thread","threadId":"private-synthetic-value","pinned":true}"#,
        r#"{"version":1,"kind":"future-unknown-kind","label":"private-synthetic-value"}"#,
        "{\"version\":1,\"kind\":\"pin_thread\",\"threadId\":\"thread-1\",\"pinned\":true}\nmalformed-private-synthetic-value",
    ] {
        let output = query(&unused_home, json!({"protocol_version":1,"state":{},"oplog":oplog}));
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("operation at line"));
        assert!(!error.contains("private-synthetic-value"));
        assert!(!unused_home.exists());
    }
}

#[test]
fn replay_preserves_removal_and_rename_semantics() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("synthetic-workspace");
    let operations = [
        json!({"version":1,"kind":"rename","projectKey":"current","workspacePath":workspace,"label":"New title"}),
        json!({"version":1,"kind":"remove","projectKey":"removed","workspacePath":workspace}),
    ].map(|value| value.to_string()).join("\n");
    let output = query(
        &temporary.path().join("unused"),
        json!({"protocol_version":1,"state":{
        "local-projects":{"current":{"id":"current","name":"Old title"},"removed":{"id":"removed","name":"Removed"}},
        "project-order":["current","removed"]
    },"oplog":operations}),
    );
    assert!(output.status.success());
    let projected: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        projected["state"]["local-projects"]["current"]["name"],
        "New title"
    );
    assert!(projected["state"]["local-projects"]["removed"].is_null());
    assert_eq!(projected["state"]["project-order"], json!(["current"]));
}
