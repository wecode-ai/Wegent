// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Real Executor process, MCP transport, SQLite and delivery file coverage.

use super::*;
use wegent_executor::task_runtime::{
    BinaryInput, DeliveryCreate, LocalTaskStore, ProjectCreate, TaskCreate, TaskRuntime,
};

#[tokio::test]
async fn child_executor_reads_parent_context_without_parent_write_authority() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("data")).unwrap();
    let store = LocalTaskStore::open(home.path().join("data/tasks.sqlite")).unwrap();
    let project = store
        .create_project(
            serde_json::from_value::<ProjectCreate>(json!({
                "name": "Parent context", "project_key": "PARENT",
            }))
            .unwrap(),
        )
        .unwrap();
    let parent = store
        .create_task(
            &project.id,
            serde_json::from_value::<TaskCreate>(json!({
                "title": "Parent", "description": "Parent requirements",
            }))
            .unwrap(),
        )
        .unwrap();
    let child = store
        .create_task(
            &project.id,
            serde_json::from_value::<TaskCreate>(json!({
                "title": "Child", "parent_id": parent.id,
            }))
            .unwrap(),
        )
        .unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    runtime
        .add_comment(&project.id, &parent.id, "Parent review feedback")
        .await
        .unwrap();
    let delivery = runtime
        .create_delivery(
            &project.id,
            &parent.id,
            DeliveryCreate {
                title: "Handoff".to_owned(),
                markdown: "Parent delivery".to_owned(),
                chat: None,
                source_task: None,
            },
        )
        .await
        .unwrap();
    let asset = runtime
        .add_delivery_asset(
            &delivery.id,
            "evidence.txt",
            BinaryInput {
                display_name: "evidence.txt".to_owned(),
                content_type: None,
                base64: STANDARD.encode(b"Parent evidence"),
            },
        )
        .unwrap();
    drop(runtime);

    let grant = STANDARD.encode(
        serde_json::to_vec(&json!({
            "version": 1, "task_id": "child-runtime", "space_id": project.id,
            "item_id": child.id, "role": "executor", "categories": ["execution"],
            "expires_at_unix": 4_102_444_800_i64,
        }))
        .unwrap(),
    );
    let mut process = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("space-mcp-server")
        .env("WEGENT_EXECUTOR_HOME", home.path())
        .env("WEWORK_SPACE_CONTEXT_GRANT", grant)
        .env_remove("WEWORK_SPACE_BACKEND_URL")
        .env_remove("WEWORK_SPACE_AUTH_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let output_path = home.path().join("downloaded-evidence.txt");
    let calls = [
        ("get_board_item", json!({"item_id": parent.id})),
        ("list_board_item_comments", json!({"item_id": parent.id})),
        ("list_deliveries", json!({"item_id": parent.id})),
        (
            "read_delivery",
            json!({"item_id": parent.id, "delivery_id": delivery.id}),
        ),
        (
            "download_delivery_asset",
            json!({"item_id": parent.id, "delivery_id": delivery.id, "asset_id": asset.id, "output_path": output_path}),
        ),
        (
            "add_board_item_comment",
            json!({"item_id": parent.id, "body": "Forbidden parent comment"}),
        ),
        ("get_current_context", json!({})),
    ];
    let mut stdin = process.stdin.take().unwrap();
    for (id, (name, arguments)) in calls.iter().enumerate() {
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {
                "name": name, "arguments": arguments,
            }})
        )
        .unwrap();
    }
    drop(stdin);
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let results: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()["result"].clone())
        .collect();
    assert_eq!(results.len(), calls.len());
    for result in &results[..5] {
        assert_eq!(result["isError"], false, "{result}");
    }
    assert!(results[0]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Parent requirements"));
    assert!(results[1]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Parent review feedback"));
    assert!(results[3]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Parent delivery"));
    assert_eq!(std::fs::read(output_path).unwrap(), b"Parent evidence");
    assert_eq!(results[5]["isError"], true);
    let context: Value =
        serde_json::from_str(results[6]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(context["item_id"], child.id);
    let store = LocalTaskStore::open(home.path().join("data/tasks.sqlite")).unwrap();
    assert!(!store
        .list_comments(&project.id, &parent.id, 0)
        .unwrap()
        .iter()
        .any(|comment| comment.content == "Forbidden parent comment"));
}
