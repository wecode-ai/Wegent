// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_executor::{
    runner::ExecutionOutcome,
    stream::{collect_ndjson_outcome, extract_claude_session_id},
};

#[test]
fn ndjson_parser_collects_claude_text_blocks_and_deltas() {
    let output = r#"
{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}
{"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "hello world".to_owned()
        }
    );
}

#[test]
fn ndjson_parser_collects_codex_agent_message_deltas() {
    let output = r#"
{"method":"item/agentMessage/delta","params":{"delta":"codex ","phase":"final_answer"}}
{"method":"item/agentMessage/delta","params":{"delta":"done","phase":"final_answer"}}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "codex done".to_owned()
        }
    );
}

#[test]
fn ndjson_parser_maps_error_event_to_failed_outcome() {
    let output = r#"{"type":"error","message":"permission denied"}"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "permission denied".to_owned()
        }
    );
}

#[test]
fn ndjson_parser_extracts_claude_session_id_from_init_or_result_events() {
    let output = r#"
{"type":"system","subtype":"init","session_id":"init-session"}
{"type":"result","session_id":"result-session","result":"done"}
"#;

    assert_eq!(
        extract_claude_session_id(output).as_deref(),
        Some("result-session")
    );
}
