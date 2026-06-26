// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::json;
use wegent_executor::{
    runner::ExecutionOutcome,
    services::turn_file_changes::ClaudeToolFileChangeTracker,
    stream::{collect_ndjson_outcome, extract_claude_session_id},
};

#[test]
fn claude_tool_use_stream_blocks_do_not_leak_arguments_into_final_text() {
    let output = r#"
{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"Bash_0","name":"Bash"}}
{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"pwd\"}"}}
{"type":"content_block_stop","index":0}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"Bash_0","name":"Bash","input":{"command":"pwd"}}]}}
{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

#[test]
fn claude_thinking_deltas_are_not_final_answer_text() {
    let output = r#"
{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private reasoning"}}
{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque"}}
{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"visible answer"}}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "visible answer".to_owned()
        }
    );
}

#[test]
fn claude_interrupted_result_takes_precedence_over_prior_error_events() {
    let output = r#"
{"type":"error","message":"tool stream closed"}
{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Request interrupted","session_id":"session-1"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Cancelled {
            message: "Request interrupted".to_owned()
        }
    );
}

#[test]
fn claude_error_result_without_interruption_fails_with_result_message() {
    let output = r#"
{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}
{"type":"result","subtype":"error_during_execution","is_error":true,"result":"tool failed","session_id":"session-1"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "tool failed".to_owned()
        }
    );
}

#[test]
fn claude_success_result_keeps_completion_metadata_out_of_visible_text() {
    let output = r#"
{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}
{"type":"result","subtype":"success","duration_ms":10,"duration_api_ms":8,"is_error":false,"num_turns":1,"session_id":"claude-session-1","result":"done"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
    assert_eq!(
        extract_claude_session_id(output).as_deref(),
        Some("claude-session-1")
    );
}

#[test]
fn claude_write_tool_boundaries_finalize_file_change_completion_fields() {
    let root = unique_dir("claude-stream-file-change");
    let workspace = root.join("workspace");
    let home = root.join("home");
    fs::create_dir_all(&workspace).unwrap();
    let mut tracker =
        ClaudeToolFileChangeTracker::new(workspace.clone(), 11, 22, home.clone(), Some("device-1"));

    tracker.record_tool_use_start(
        "Write",
        "toolu_write",
        &json!({"file_path": "notes/result.txt", "content": "created\n"}),
    );
    write(workspace.join("notes/result.txt"), "created\n");
    tracker.record_tool_result("toolu_write", false);
    let fields = tracker.finalize();

    assert_eq!(fields["file_changes"]["file_count"], 1);
    assert_eq!(fields["file_changes"]["device_id"], "device-1");
    assert_eq!(
        fields["file_changes"]["files"][0]["path"],
        "notes/result.txt"
    );
    assert_eq!(fields["file_changes"]["files"][0]["change_type"], "created");
}

fn write(path: PathBuf, content: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn unique_dir(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}
