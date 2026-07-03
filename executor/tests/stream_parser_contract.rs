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
fn ndjson_parser_recoverable_midstream_error_yields_to_success_result() {
    // GLM streaming can emit "Tool call preview did not complete before the
    // turn ended" as a mid-stream `type:error` while the SDK still finishes the
    // turn successfully. The success `type:result` must win.
    let output = r#"
{"type":"assistant","message":{"content":[{"type":"text","text":"editing"}]}}
{"type":"error","message":"Tool call preview did not complete before the turn ended"}
{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "editing".to_owned()
        }
    );
}

#[test]
fn ndjson_parser_maps_interactive_form_waiting_result_to_waiting_outcome() {
    let output = r#"
{"type":"assistant","message":{"content":[{"type":"text","text":"please fill the form"}]}}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"tool_deferred","result":"{\"__deferred_user_input__\":true,\"success\":true,\"status\":\"waiting_for_user_response\"}"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::WaitingForUserInput {
            stop_reason: "tool_deferred".to_owned()
        }
    );
}

#[test]
fn ndjson_parser_maps_interactive_form_tool_result_to_waiting_outcome() {
    let output = r#"
{"type":"assistant","message":{"content":[{"id":"toolu_form","input":{"questions":[]},"name":"mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question","type":"tool_use"}]}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_form","type":"tool_result","content":"{\"result\":\"{\\\"__silent_exit__\\\": true, \\\"__deferred_user_input__\\\": true, \\\"success\\\": true, \\\"status\\\": \\\"waiting_for_user_response\\\"}\"}"}]}}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","result":"form displayed"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::WaitingForUserInput {
            stop_reason: "tool_deferred".to_owned()
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
