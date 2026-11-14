// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::StandardEventProjection;
use super::*;

fn file(path: &str, kind: &str, additions: u64) -> Value {
    json!({"path": path, "change_type": kind, "additions": additions, "deletions": 0})
}

fn created(files: Vec<Value>, status: &str) -> Value {
    json!({"block": {
        "id": "patch-1", "type": "file_changes", "status": status,
        "timestamp": 10, "parent_tool_use_id": "child-1",
        "file_changes": {"files": files}
    }})
}

#[test]
fn rename_failure_and_resumed_response_preserve_file_identity() {
    let mut projection = StandardEventProjection::default();
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    let mut renamed = file("new/name.txt", "renamed", 3);
    renamed["old_path"] = json!("old/name.txt");
    let events = projection
        .project_events(
            "response.block.created",
            created(vec![renamed], "pending"),
            &builder,
        )
        .unwrap();
    let id = events[0].data["block"]["id"].clone();
    assert_eq!(
        events[0].data["block"]["tool_output"],
        "renamed: old/name.txt -> new/name.txt (+3, -0)"
    );
    projection.begin_response();
    let builder = ResponsesEventBuilder::new("1", "3", "test");
    let events = projection
        .project_events(
            "response.block.updated",
            json!({
                "block_id":"patch-1", "updates":{"status":"failed"}
            }),
            &builder,
        )
        .unwrap();
    assert_eq!(events[0].subtask_id, "3");
    assert_eq!(events[0].event_type, "response.block.created");
    assert_eq!(events[0].data["block"]["id"], id);
    assert_eq!(events[0].data["block"]["status"], "error");
}

#[test]
fn same_path_in_different_patches_does_not_merge_and_invalid_files_fail() {
    let mut projection = StandardEventProjection::default();
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    let initial = created(vec![file("a.txt", "modified", 1)], "done");
    let first = projection
        .project_events("response.block.created", initial.clone(), &builder)
        .unwrap();
    let mut next = initial;
    next["block"]["id"] = json!("patch-2");
    let second = projection
        .project_events("response.block.created", next, &builder)
        .unwrap();
    assert_ne!(first[0].data["block"]["id"], second[0].data["block"]["id"]);
    assert!(projection
        .project_events(
            "response.block.created",
            created(vec![json!({})], "done"),
            &builder
        )
        .is_err());
}

#[test]
fn native_file_content_is_scoped_per_path_and_changes_even_when_line_counts_match() {
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    let mut projection = StandardEventProjection::default();
    let mut data = created(vec![file("space name.txt", "created", 1)], "streaming");
    data["block"]["file_changes"]["workspace_path"] = json!("/synthetic/repo");
    let mut notification = json!({"method":"item/fileChange/patchUpdated", "params": {
        "changes":[
            {"path":"other.txt", "kind":{"type":"add"}, "diff":"not this file"},
            {"path":"/synthetic/repo/space name.txt", "kind":{"type":"add"}, "diff":"hello\n"}
        ]
    }});
    StandardEventProjection::include_file_details(&mut data, &notification);
    let first = projection
        .project_events("response.block.created", data.clone(), &builder)
        .unwrap();
    assert_eq!(first[0].data["block"]["tool_name"], "Write");
    assert_eq!(first[0].data["block"]["tool_input"]["content"], "hello\n");
    notification["params"]["changes"][1]["diff"] = json!("updated\n");
    StandardEventProjection::include_file_details(&mut data, &notification);
    let second = projection
        .project_events("response.block.created", data, &builder)
        .unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].event_type, "response.block.updated");
    assert_eq!(
        second[0].data["updates"]["tool_input"]["content"],
        "updated\n"
    );
}
