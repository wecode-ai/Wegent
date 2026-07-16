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
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}
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
fn ndjson_parser_uses_last_assistant_message_as_final_content() {
    let output = r#"
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"done"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"final"},{"type":"text","text":" answer"}]}}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "final answer".to_owned()
        }
    );
}

#[test]
fn ndjson_parser_ignores_child_agent_assistant_messages() {
    let output = r#"
{"type":"assistant","parent_tool_use_id":"Agent_0","message":{"role":"assistant","content":[{"type":"text","text":"child draft"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"root final"}]}}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "root final".to_owned()
        }
    );
}

#[test]
fn ndjson_parser_ignores_root_assistant_text_while_async_agent_is_running() {
    let output = r#"
{"type":"assistant","message":{"role":"assistant","content":[{"id":"Agent_0","name":"Agent","type":"tool_use","input":{"description":"write"}}]}}
{"type":"system","subtype":"task_started","task_type":"local_agent","tool_use_id":"Agent_0","task_id":"agent-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"draft before agent finishes"}]}}
{"type":"assistant","parent_tool_use_id":"Agent_0","message":{"role":"assistant","content":[{"type":"text","text":"child transcript"}]}}
{"type":"system","subtype":"task_notification","status":"completed","tool_use_id":"Agent_0","task_id":"agent-1","summary":"child result"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"final after agent"}]}}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","result":"draft before agent finishes"}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","origin":{"kind":"task-notification"},"result":"final after agent"}
"#;

    let outcome = collect_ndjson_outcome(output);

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "final after agent".to_owned()
        }
    );
}

#[test]
fn ndjson_parser_skips_non_json_stdout_lines() {
    let output = r#"
[SandboxDebug] enabled
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}
{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}
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
fn ndjson_parser_fails_claude_stdout_without_result_message() {
    let output = r#"
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"broken
"#;

    let outcome = collect_ndjson_outcome(output);

    assert!(matches!(outcome, ExecutionOutcome::Failed { .. }));
    if let ExecutionOutcome::Failed { message } = outcome {
        assert!(message.contains("Claude stdout ended before result message"));
    }
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
