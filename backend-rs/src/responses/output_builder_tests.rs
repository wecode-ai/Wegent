// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unit tests for `src/responses/output_builder.rs`.
//!
//! These exercise the recorded subtask result documents end to end through
//! the typed builders, including the tool item shapes and id numbering.

use super::output_builder::*;
use super::python_json::python_json_dumps;
use super::responses_repository::{SubtaskRow, TaskRow};
use serde_json::Value;

fn chain_subtask(result: Value) -> SubtaskRow {
    SubtaskRow {
        id: 429_771_607_670_244,
        user_id: 3127,
        task_id: 429_771_607_670_241,
        role: "ASSISTANT".to_string(),
        status: "COMPLETED".to_string(),
        result: Some(brz_mysql::Json(result.into())),
    }
}

fn serialized_items(subtask: &SubtaskRow) -> Vec<Value> {
    build_output_items_for_subtask(subtask)
        .iter()
        .map(|item| serde_json::to_value(item).expect("serializable"))
        .collect()
}

#[test]
fn messages_chain_builds_one_message_per_assistant_entry() {
    // Recorded case 0bb6eb20: the chain message carries a reasoning
    // block (text under `reasoning`) and a text block; only the text
    // block contributes, producing a single `msg_{id}_0` output message
    // with just the output_text content.
    let result = serde_json::json!({
        "value": "final answer",
        "blocks": [
            {"id": "t1", "type": "thinking", "content": "Straightforward."},
            {"id": "t2", "type": "text", "content": "final answer"}
        ],
        "messages_chain": [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "extras": {"index": 0}, "reasoning": "Straightforward."},
                    {"text": "final answer", "type": "text", "index": 1}
                ],
                "model_info": {}
            }
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], "msg_429771607670244_0");
    assert_eq!(items[0]["content"].as_array().unwrap().len(), 1);
    assert_eq!(items[0]["content"][0]["type"], "output_text");
    assert_eq!(items[0]["content"][0]["text"], "final answer");
}

#[test]
fn messages_chain_without_assistant_text_falls_back_to_value() {
    let result = serde_json::json!({
        "value": "the value",
        "messages_chain": [{"role": "assistant", "content": [], "model_info": {}}]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], "msg_429771607670244");
    assert_eq!(items[0]["content"][0]["text"], "the value");
}

#[test]
fn no_chain_keeps_the_blocks_path() {
    let result = serde_json::json!({
        "value": "v",
        "blocks": [{"type": "thinking", "content": "think"}, {"type": "text", "content": "v"}]
    });
    let items = serialized_items(&chain_subtask(result));
    // The blocks path emits one message per thinking/text block.
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["content"][0]["type"], "reasoning");
    assert_eq!(items[1]["content"][0]["type"], "output_text");
}

#[test]
fn chain_tool_calls_emit_tool_items_in_order() {
    // Recorded case 8e0862f6 shape: one assistant chain entry with two
    // mcp tool calls followed by text; the mcp blocks provide protocol,
    // server_label, and tool_output. Item ids index the emitted output.
    let result = serde_json::json!({
        "value": "",
        "messages_chain": [{
            "role": "assistant",
            "tool_calls": [
                {"id": "call_a", "function": {"name": "alertor-proxy-mcp_video_agent",
                    "arguments": "{\"input\": \"alert\"}"}},
                {"id": "call_b", "function": {"name": "wegent-knowledge_wegent-knowledge_wegent_kb_search_knowledge_base",
                    "arguments": "{\"knowledge_base_id\": 212868}"}}
            ],
            "content": "Analyze this alert."
        }],
        "blocks": [
            {"id": "text-1", "type": "text", "status": "done", "content": "Analyze this alert."},
            {"id": "call_a", "type": "tool", "status": "done", "tool_name": "alertor-proxy-mcp_video_agent",
             "tool_protocol": "mcp_call", "server_label": "", "tool_use_id": "call_a",
             "tool_input": {"input": "alert"}, "tool_output": [{"id": "lc_1", "text": "example output", "type": "text"}]},
            {"id": "call_b", "type": "tool", "status": "done", "tool_name": "wegent-knowledge_wegent-knowledge_wegent_kb_search_knowledge_base",
             "tool_protocol": "mcp_call", "server_label": "", "tool_use_id": "call_b",
             "tool_input": {"knowledge_base_id": 212868}, "tool_output": [{"id": "lc_2", "text": "{}", "type": "text"}]}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["type"], "mcp_call");
    assert_eq!(items[0]["id"], "call_a");
    assert_eq!(items[0]["server_label"], "");
    assert_eq!(items[0]["status"], "completed");
    assert_eq!(items[0]["arguments"], "{\"input\": \"alert\"}");
    assert_eq!(items[0]["output"][0]["id"], "lc_1");
    assert_eq!(items[1]["type"], "mcp_call");
    assert_eq!(items[1]["id"], "call_b");
    assert_eq!(items[2]["type"], "message");
    assert_eq!(items[2]["id"], "msg_429771607670244_2");
    assert_eq!(items[2]["content"][0]["text"], "Analyze this alert.");
}

#[test]
fn shell_tool_call_builds_shell_item_from_arguments() {
    // Recorded case b4aa819f shape: `exec` tool calls map to the
    // shell_call item with parsed commands and `input`.
    let result = serde_json::json!({
        "value": "",
        "messages_chain": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_sh",
                "function": {"name": "exec", "arguments": "{\"command\": \"ls -la\"}"}
            }],
            "content": []
        }],
        "blocks": [
            {"id": "call_sh", "type": "tool", "status": "done", "tool_name": "exec",
             "tool_protocol": "shell_call", "tool_use_id": "call_sh",
             "tool_input": {"command": "ls -la"}}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["type"], "shell_call");
    assert_eq!(items[0]["id"], "call_sh");
    assert_eq!(items[0]["call_id"], "call_sh");
    assert_eq!(items[0]["status"], "completed");
    assert_eq!(items[0]["name"], "exec");
    assert_eq!(
        items[0]["action"]["commands"],
        serde_json::json!(["ls -la"])
    );
    assert_eq!(items[0]["input"]["command"], "ls -la");
}

#[test]
fn function_call_uses_plain_item_shape() {
    let result = serde_json::json!({
        "value": "",
        "messages_chain": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_fn",
                "function": {"name": "load_skill", "arguments": "{\"skill_name\": \"live-outlook-skill\"}"}
            }],
            "content": []
        }],
        "blocks": [
            {"id": "call_fn", "type": "tool", "status": "done", "tool_name": "load_skill",
             "tool_protocol": "function_call", "tool_use_id": "call_fn",
             "tool_input": {"skill_name": "live-outlook-skill"}}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["type"], "function_call");
    assert_eq!(items[0]["id"], "call_fn");
    assert_eq!(items[0]["call_id"], "call_fn");
    assert_eq!(items[0]["name"], "load_skill");
    assert_eq!(
        items[0]["arguments"],
        "{\"skill_name\": \"live-outlook-skill\"}"
    );
}

#[test]
fn chain_reasoning_only_entry_falls_back_to_bare_id_message() {
    // Recorded case b4aa819f subtask 10445360621078: the chain entry
    // carries only a reasoning content block, so the message is built
    // from result.reasoning_content with the bare `msg_{id}` id.
    let result = serde_json::json!({
        "value": "",
        "reasoning_content": "The user has multiple requests.",
        "messages_chain": [{
            "role": "assistant",
            "content": [{"type": "reasoning", "reasoning": "The user has multiple requests."}]
        }],
        "blocks": [{"id": "thinking-1", "type": "thinking", "status": "done",
            "content": "The user has multiple requests."}]
    });
    let subtask = SubtaskRow {
        id: 10_445_360_621_078,
        user_id: 76,
        task_id: 10_445_360_621_073,
        role: "ASSISTANT".to_string(),
        status: "COMPLETED".to_string(),
        result: Some(brz_mysql::Json(result.into())),
    };
    let items = serialized_items(&subtask);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], "msg_10445360621078");
    assert_eq!(items[0]["content"][0]["type"], "reasoning");
    assert_eq!(
        items[0]["content"][0]["text"],
        "The user has multiple requests."
    );
}

#[test]
fn block_tool_items_render_from_tool_input() {
    // Blocks path (`_build_tool_item_from_block`) when the chain built
    // nothing: the tool block's own input/output fields feed the item.
    let result = serde_json::json!({
        "value": "",
        "messages_chain": [{"role": "tool", "content": "ok"}],
        "blocks": [
            {"id": "call_m", "type": "tool", "status": "error", "tool_name": "statusServer_convertMid",
             "tool_protocol": "mcp_call", "server_label": "status", "tool_use_id": "call_m",
             "tool_input": {"mid": "RbO0njLRG"}, "tool_output": [{"id": "lc_3", "text": "5328138314712228", "type": "text"}]}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["type"], "mcp_call");
    assert_eq!(items[0]["status"], "failed");
    assert_eq!(items[0]["server_label"], "status");
    assert_eq!(items[0]["arguments"], "{\"mid\": \"RbO0njLRG\"}");
    assert_eq!(items[0]["output"][0]["id"], "lc_3");
}

#[test]
fn tool_output_string_payload_parses_and_sanitizes() {
    let sanitized = normalize_tool_output(Some(&serde_json::json!(
        "{\"a\": 1, \"pending_user_input\": true, \"pending_user_input_payload\": {\"x\": 1}}"
    )));
    match sanitized {
        ToolOutput::Json(Value::Object(map)) => {
            assert_eq!(map.len(), 1, "pending_user_input keys are dropped");
            assert!(map.contains_key("a"));
        }
        other => panic!("expected object output, got {other:?}"),
    }
    let passthrough = normalize_tool_output(Some(&serde_json::json!("plain text")));
    assert!(matches!(passthrough, ToolOutput::Json(Value::String(_))));
    assert!(matches!(normalize_tool_output(None), ToolOutput::Null));
}

#[test]
fn python_dumps_matches_json_dumps_defaults() {
    // `json.dumps(..., ensure_ascii=False)`: `", "` / `": "` separators,
    // non-ASCII kept verbatim, control characters escaped.
    let value = serde_json::json!({"命令": ["a", "b"], "n": 1, "t": true});
    assert_eq!(
        python_json_dumps(&value),
        "{\"命令\": [\"a\", \"b\"], \"n\": 1, \"t\": true}"
    );
    assert_eq!(python_json_dumps(&Value::Null), "null");
}

fn task_json() -> Value {
    serde_json::json!({
        "status": {
            "status": "RUNNING",
            "createdAt": "2026-09-05T09:10:52.897612",
            "errorMessage": "",
        }
    })
}

#[test]
fn converts_the_recorded_running_task() {
    let task = TaskRow {
        id: 12_232_067_055_387,
        user_id: 1001,
        json: brz_mysql::Json(crate::json_compat::OpaqueJson::from(task_json())),
        created_at: None,
    };
    let response = task_to_response_object(&task, "example#example-team", &[], None);
    assert_eq!(response.id, "resp_12232067055387");
    assert_eq!(response.object, "response");
    // 2026-09-05T09:10:52 (+08:00) == 1788570652.
    assert_eq!(response.created_at, 1_788_570_652);
    assert_eq!(response.status, "in_progress");
    assert!(response.error.is_none());
    assert!(response.output.is_empty());
    assert!(response.pending_user_input.is_none());
}

#[test]
fn status_mapping_matches_source_table() {
    assert_eq!(wegent_status_to_openai_status("PENDING"), "queued");
    assert_eq!(wegent_status_to_openai_status("RUNNING"), "in_progress");
    assert_eq!(wegent_status_to_openai_status("COMPLETED"), "completed");
    assert_eq!(wegent_status_to_openai_status("FAILED"), "failed");
    assert_eq!(wegent_status_to_openai_status("CANCELLED"), "cancelled");
    assert_eq!(wegent_status_to_openai_status("CANCELLING"), "in_progress");
    assert_eq!(wegent_status_to_openai_status("DELETE"), "failed");
    assert_eq!(wegent_status_to_openai_status("WHATEVER"), "incomplete");
}

#[test]
fn failed_task_with_message_builds_error() {
    let task = TaskRow {
        id: 1,
        user_id: 1,
        json: brz_mysql::Json(crate::json_compat::OpaqueJson::from(serde_json::json!({
            "status": {"status": "FAILED", "errorMessage": "boom"}
        }))),
        created_at: None,
    };
    let response = task_to_response_object(&task, "m", &[], None);
    let error = response.error.expect("error present");
    assert_eq!(error.code, "task_failed");
    assert_eq!(error.message, "boom");
    assert_eq!(response.status, "failed");
}

fn subtask(role: &str, status: &str, result: Option<Value>) -> SubtaskRow {
    SubtaskRow {
        id: 12_232_067_055_390,
        user_id: 1001,
        task_id: 12_232_067_055_387,
        role: role.to_string(),
        status: status.to_string(),
        result: result.map(|result| brz_mysql::Json(result.into())),
    }
}

#[test]
fn null_result_produces_no_output() {
    // Recorded case: assistant subtask with SQL NULL result -> [].
    let subtasks = vec![
        subtask("USER", "COMPLETED", Some(Value::Null)),
        subtask("ASSISTANT", "RUNNING", None),
    ];
    assert!(build_response_output(&subtasks).is_empty());
}

#[test]
fn value_result_builds_message() {
    let subtasks = vec![subtask(
        "ASSISTANT",
        "COMPLETED",
        Some(serde_json::json!({"value": "hello"})),
    )];
    let output = build_response_output(&subtasks);
    assert_eq!(output.len(), 1);
    let item = serde_json::to_value(&output[0]).unwrap();
    assert_eq!(item["id"], "msg_12232067055390");
    assert_eq!(item["status"], "completed");
    assert_eq!(item["content"][0]["text"], "hello");
}

#[test]
fn running_assistant_message_is_in_progress() {
    let subtasks = vec![subtask(
        "ASSISTANT",
        "RUNNING",
        Some(serde_json::json!({"value": "partial"})),
    )];
    let output = build_response_output(&subtasks);
    let item = serde_json::to_value(&output[0]).unwrap();
    assert_eq!(item["status"], "in_progress");
}

#[test]
fn shell_input_passes_arguments_dict_through() {
    // Recorded case b4aa819f: the shell item's `input` is the parsed
    // arguments dict verbatim — only the arguments' own keys, their
    // order, and original number forms (30 stays an int), while
    // `action` re-renders commands/timeout_ms.
    let result = serde_json::json!({
        "value": "",
        "messages_chain": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_sh",
                "function": {"name": "exec",
                    "arguments": "{\"command\": \"ls\", \"timeout_seconds\": 30, \"working_dir\": \"/tmp\"}"}
            }],
            "content": []
        }],
        "blocks": [
            {"id": "call_sh", "type": "tool", "status": "done", "tool_name": "exec",
             "tool_protocol": "shell_call", "tool_use_id": "call_sh",
             "tool_input": {"command": "ls", "timeout_seconds": 30, "working_dir": "/tmp"}}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0]["input"],
        serde_json::json!({"command": "ls", "timeout_seconds": 30, "working_dir": "/tmp"}),
        "input echoes the parsed arguments with their own keys and order"
    );
    assert_eq!(items[0]["action"]["commands"], serde_json::json!(["ls"]));
    assert_eq!(items[0]["action"]["timeout_ms"], 30000);
    assert_eq!(items[0]["action"]["max_output_length"], Value::Null);

    // A plain command keeps a single-key input and a null timeout.
    let result = serde_json::json!({
        "value": "",
        "messages_chain": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_sh2",
                "function": {"name": "exec", "arguments": "{\"command\": \"pwd\"}"}
            }],
            "content": []
        }],
        "blocks": [
            {"id": "call_sh2", "type": "tool", "status": "done", "tool_name": "exec",
             "tool_protocol": "shell_call", "tool_use_id": "call_sh2",
             "tool_input": {"command": "pwd"}}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items[0]["input"], serde_json::json!({"command": "pwd"}));
    assert_eq!(items[0]["action"]["timeout_ms"], Value::Null);
}
