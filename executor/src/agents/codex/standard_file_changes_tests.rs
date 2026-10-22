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
fn patch_stream_creates_one_edit_per_file_and_updates_without_duplicate_cards() {
    let mut projection = StandardEventProjection::default();
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    let initial = created(vec![file("index.html", "created", 1)], "streaming");
    let events = projection
        .project_events("response.block.created", initial.clone(), &builder)
        .unwrap();
    assert_eq!(events.len(), 1);
    let first = &events[0].data["block"];
    assert_eq!(first["type"], "tool");
    assert_eq!(first["tool_name"], "Edit");
    assert_eq!(first["tool_input"]["file_path"], "index.html");
    assert_eq!(first["parent_tool_use_id"], "child-1");
    assert_eq!(first["status"], "streaming");
    assert_eq!(initial["block"]["type"], "file_changes");

    let progress = created(
        vec![
            file("index.html", "created", 20),
            file("styles.css", "modified", 7),
        ],
        "streaming",
    );
    let update = json!({"block_id":"patch-1", "updates": {
        "file_changes": progress["block"]["file_changes"], "status": "streaming"
    }});
    let events = projection
        .project_events("response.block.updated", update, &builder)
        .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event_type, "response.block.updated");
    assert_eq!(events[0].data["block_id"], first["id"]);
    assert_eq!(
        events[0].data["updates"]["tool_output"],
        "created: index.html (+20, -0)"
    );
    assert_eq!(events[1].event_type, "response.block.created");
    assert!(projection
        .project_events("response.block.created", progress, &builder)
        .unwrap()
        .is_empty());

    let events = projection
        .project_events(
            "response.block.updated",
            json!({"block_id":"patch-1", "updates":{"status":"done"}}),
            &builder,
        )
        .unwrap();
    assert_eq!(events.len(), 2);
    assert!(
        events
            .iter()
            .all(|e| e.event_type == "response.block.updated"
                && e.data["updates"]["status"] == "done")
    );
}

#[test]
fn update_before_create_is_visible_and_repeated_creation_does_not_reset_time() {
    let mut projection = StandardEventProjection::default();
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    let original = created(vec![file("space name.txt", "deleted", 0)], "streaming");
    let events = projection
        .project_events(
            "response.block.updated",
            json!({
                "block_id":"patch-1", "updates":original["block"]
            }),
            &builder,
        )
        .unwrap();
    assert_eq!(events[0].event_type, "response.block.created");
    let mut repeated = original;
    repeated["block"]["timestamp"] = json!(99);
    assert!(projection
        .project_events("response.block.created", repeated, &builder)
        .unwrap()
        .is_empty());
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

#[test]
fn native_diff_is_preserved_for_edits_renames_and_unified_additions() {
    let builder = ResponsesEventBuilder::new("1", "2", "test");
    let diff = "@@ -1 +1 @@\n-old\n+new\n@@ -30 +30 @@\n-before\n+after\n";
    for kind in ["update", "add", "delete"] {
        let mut data = created(vec![file("new.txt", "modified", 2)], "done");
        let notification = json!({"method":"item/completed", "params":{"item":{
            "type":"fileChange", "changes":[{
                "path":"new.txt", "kind":{"type":kind}, "diff":diff
            }]
        }}});
        StandardEventProjection::include_file_details(&mut data, &notification);
        let events = StandardEventProjection::default()
            .project_events("response.block.created", data, &builder)
            .unwrap();
        let input = &events[0].data["block"]["tool_input"];
        assert_eq!(input["diff"], diff);
        assert!(input.get("content").is_none());
        assert!(input.get("old_string").is_none());
    }
    let mut data = created(vec![file("new.txt", "renamed", 2)], "done");
    let notification = json!({"method":"item/started", "params":{"item":{
        "type":"fileChange", "changes":[{
            "path":"old.txt", "kind":{"type":"update", "movePath":"new.txt"}, "diff":diff
        }]
    }}});
    StandardEventProjection::include_file_details(&mut data, &notification);
    assert_eq!(data["block"]["file_changes"]["files"][0]["diff"], diff);
    let mut text = json!({"delta":"hello"});
    let before = text.clone();
    StandardEventProjection::include_file_details(&mut text, &notification);
    assert_eq!(text, before);
}
