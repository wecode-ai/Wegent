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
        id: 100_000_000_000_004,
        user_id: 301,
        task_id: 100_000_000_000_001,
        role: "ASSISTANT".to_string(),
        status: "COMPLETED".to_string(),
        result: Some(brz_mysql::Json(result.into())),
    }
}

fn serialized_items(subtask: &SubtaskRow) -> Vec<Value> {
    build_output_items_for_subtask(subtask, &test_config(), "", None)
        .expect("builds")
        .iter()
        .map(|item| serde_json::to_value(item).expect("serializable"))
        .collect()
}

/// A minimal `AuthConfig` for the generation download-URL signing.
fn test_config() -> crate::config::AuthConfig {
    crate::config::AuthConfig {
        jwt_key: "test-key".to_string(),
        legacy_jwt_keys: Vec::new(),
        algorithm: "HS256".to_string(),
    }
}

#[test]
fn messages_chain_builds_one_message_per_assistant_entry() {
    // Message shape: the chain message carries a reasoning
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
    assert_eq!(items[0]["id"], "msg_100000000000004_0");
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
    assert_eq!(items[0]["id"], "msg_100000000000004");
    assert_eq!(items[0]["content"][0]["text"], "the value");
}

#[test]
fn no_chain_keeps_the_blocks_path() {
    let result = serde_json::json!({
        "value": "v",
        "blocks": [{"type": "thinking", "content": "think"}, {"type": "text", "content": "v"}]
    });
    let items = serialized_items(&chain_subtask(result));
    // The blocks path emits one message per thinking/text block; each id
    // indexes the emitted output like the source's `append_message`
    // (`len(output)`), so the second message carries `_1`.
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["content"][0]["type"], "reasoning");
    assert_eq!(items[0]["id"], "msg_100000000000004_0");
    assert_eq!(items[1]["content"][0]["type"], "output_text");
    assert_eq!(items[1]["id"], "msg_100000000000004_1");
}

#[test]
fn blocks_path_indexes_tool_items_into_message_ids() {
    // Interleaved content shape: tool blocks and text blocks interleave;
    // a message after tool items carries the item count as its index.
    let result = serde_json::json!({
        "value": "v",
        "blocks": [
            {"type": "tool", "id": "toolu_a", "tool_name": "Bash", "tool_use_id": "toolu_a",
             "tool_protocol": "function", "tool_input": {"command": "ls"}, "tool_output": "out"},
            {"type": "thinking", "content": "think"},
            {"type": "text", "content": "v"}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["type"], "function_call");
    assert_eq!(items[1]["id"], "msg_100000000000004_1");
    assert_eq!(items[2]["id"], "msg_100000000000004_2");
}

#[test]
fn chain_tool_calls_emit_tool_items_in_order() {
    // Assistant content shape: one assistant chain entry with two
    // mcp tool calls followed by text; the mcp blocks provide protocol,
    // server_label, and tool_output. Item ids index the emitted output.
    let result = serde_json::json!({
        "value": "",
        "messages_chain": [{
            "role": "assistant",
            "tool_calls": [
                {"id": "call_a", "function": {"name": "example_video_tool",
                    "arguments": "{\"input\": \"alert\"}"}},
                {"id": "call_b", "function": {"name": "wegent-knowledge_wegent-knowledge_wegent_kb_search_knowledge_base",
                    "arguments": "{\"knowledge_base_id\": 212868}"}}
            ],
            "content": "Analyze this alert."
        }],
        "blocks": [
            {"id": "text-1", "type": "text", "status": "done", "content": "Analyze this alert."},
            {"id": "call_a", "type": "tool", "status": "done", "tool_name": "example_video_tool",
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
    assert_eq!(items[2]["id"], "msg_100000000000004_2");
    assert_eq!(items[2]["content"][0]["text"], "Analyze this alert.");
}

#[test]
fn shell_tool_call_builds_shell_item_from_arguments() {
    // Tool call shape: `exec` tool calls map to the
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
                "function": {"name": "load_skill", "arguments": "{\"skill_name\": \"example-skill\"}"}
            }],
            "content": []
        }],
        "blocks": [
            {"id": "call_fn", "type": "tool", "status": "done", "tool_name": "load_skill",
             "tool_protocol": "function_call", "tool_use_id": "call_fn",
             "tool_input": {"skill_name": "example-skill"}}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["type"], "function_call");
    assert_eq!(items[0]["id"], "call_fn");
    assert_eq!(items[0]["call_id"], "call_fn");
    assert_eq!(items[0]["name"], "load_skill");
    assert_eq!(items[0]["arguments"], "{\"skill_name\": \"example-skill\"}");
}

#[test]
fn chain_reasoning_only_entry_falls_back_to_bare_id_message() {
    // Reasoning-only assistant entry: the chain entry
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
        id: 100_000_000_000_008,
        user_id: 301,
        task_id: 100_000_000_000_003,
        role: "ASSISTANT".to_string(),
        status: "COMPLETED".to_string(),
        result: Some(brz_mysql::Json(result.into())),
    };
    let items = serialized_items(&subtask);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], "msg_100000000000008");
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
            {"id": "call_m", "type": "tool", "status": "error", "tool_name": "example_lookup",
             "tool_protocol": "mcp_call", "server_label": "example", "tool_use_id": "call_m",
             "tool_input": {"mid": "Example01"}, "tool_output": [{"id": "lc_3", "text": "1000000000000001", "type": "text"}]}
        ]
    });
    let items = serialized_items(&chain_subtask(result));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["type"], "mcp_call");
    assert_eq!(items[0]["status"], "failed");
    assert_eq!(items[0]["server_label"], "example");
    assert_eq!(items[0]["arguments"], "{\"mid\": \"Example01\"}");
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
        id: 100_000_000_000_011,
        user_id: 301,
        json: brz_mysql::Json(brz_json::OpaqueJson::from(task_json())),
        created_at: None,
    };
    let response =
        task_to_response_object(&task, "example#example-team", &[], None, &test_config())
            .expect("builds");
    assert_eq!(response.id, "resp_100000000000011");
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
        json: brz_mysql::Json(brz_json::OpaqueJson::from(serde_json::json!({
            "status": {"status": "FAILED", "errorMessage": "boom"}
        }))),
        created_at: None,
    };
    let response = task_to_response_object(&task, "m", &[], None, &test_config()).expect("builds");
    let error = response.error.expect("error present");
    assert_eq!(error.code, "task_failed");
    assert_eq!(error.message, "boom");
    assert_eq!(response.status, "failed");
}

fn subtask(role: &str, status: &str, result: Option<Value>) -> SubtaskRow {
    SubtaskRow {
        id: 100_000_000_000_014,
        user_id: 301,
        task_id: 100_000_000_000_011,
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
    assert!(
        build_response_output(&subtasks, &test_config(), None)
            .expect("builds")
            .is_empty()
    );
}

#[test]
fn value_result_builds_message() {
    let subtasks = vec![subtask(
        "ASSISTANT",
        "COMPLETED",
        Some(serde_json::json!({"value": "hello"})),
    )];
    let output = build_response_output(&subtasks, &test_config(), None).expect("builds");
    assert_eq!(output.len(), 1);
    let item = serde_json::to_value(&output[0]).unwrap();
    assert_eq!(item["id"], "msg_100000000000014");
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
    let output = build_response_output(&subtasks, &test_config(), None).expect("builds");
    let item = serde_json::to_value(&output[0]).unwrap();
    assert_eq!(item["status"], "in_progress");
}

#[test]
fn video_generation_block_builds_the_recorded_item() {
    // Video placeholder shape: the assistant subtask carries one streaming
    // `video` placeholder block (no attachment) and the response output is a
    // single `wegent_video_generation_call` with only `progress` in metadata.
    let result = serde_json::json!({
        "blocks": [{
            "id": "video-example-01", "type": "video", "status": "streaming",
            "content": "", "video_url": "",
            "is_placeholder": true, "video_duration": null, "video_progress": 0,
            "video_thumbnail": null, "video_attachment_id": null
        }],
        "video_job": {"status": "creating", "progress": 0, "video_block_id": "video-example-01"}
    });
    let items = serialized_items(&subtask("ASSISTANT", "RUNNING", Some(result)));
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0],
        serde_json::json!({
            "type": "wegent_video_generation_call",
            "id": "video-example-01",
            "status": "in_progress",
            "video_url": null,
            "video_attachment_id": null,
            "metadata": {"progress": 0}
        })
    );
}

#[test]
fn completed_video_block_signs_a_download_url() {
    // A finished video block carries an attachment id; the item exposes the
    // signed one-hour public download URL plus its expiry metadata.
    let result = serde_json::json!({
        "blocks": [{
            "id": "video-1", "type": "video", "status": "completed",
            "video_url": "", "video_progress": 100, "video_duration": 8,
            "video_attachment_id": 101
        }]
    });
    let items = serialized_items(&subtask("ASSISTANT", "COMPLETED", Some(result)));
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item["type"], "wegent_video_generation_call");
    assert_eq!(item["status"], "completed");
    assert_eq!(item["video_attachment_id"], 101);
    assert_eq!(item["metadata"]["progress"], 100);
    assert_eq!(item["metadata"]["duration"], 8);
    assert_eq!(item["metadata"]["download_url_expires_in_seconds"], 3600);
    let url = item["video_url"].as_str().expect("signed URL");
    assert!(
        url.contains("/api/attachments/download/shared?token="),
        "{url}"
    );
}

#[test]
fn shell_input_passes_arguments_dict_through() {
    // Shell input shape: the shell item's `input` is the parsed
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

#[test]
fn active_assistant_overrides_replace_status_and_fallback_text() {
    // `build_response_output(active_assistant_subtask_id=…,
    // active_assistant_status="completed",
    // active_assistant_content="<collected>")`: the accumulated stream content
    // replaces the stored `value` and the status override wins over the row.
    let subtasks = vec![subtask(
        "ASSISTANT",
        "RUNNING",
        Some(serde_json::json!({"value": "partial"})),
    )];
    let active = ActiveAssistant {
        subtask_id: 100_000_000_000_014,
        status: "completed",
        content: "collected text",
    };
    let output = build_response_output(&subtasks, &test_config(), Some(active)).expect("builds");
    assert_eq!(output.len(), 1);
    let item = serde_json::to_value(&output[0]).unwrap();
    assert_eq!(item["status"], "completed");
    assert_eq!(item["content"][0]["text"], "collected text");

    // An override for a different subtask leaves the row untouched.
    let other = ActiveAssistant {
        subtask_id: 1,
        status: "completed",
        content: "ignored",
    };
    let item = serde_json::to_value(
        &build_response_output(&subtasks, &test_config(), Some(other)).expect("builds")[0],
    )
    .unwrap();
    assert_eq!(item["status"], "in_progress");
    assert_eq!(item["content"][0]["text"], "partial");
}

#[test]
fn active_content_wins_when_a_chain_has_no_message_entry() {
    // `_build_items_from_messages_chain` final fallback:
    // `content_override or str(result.get("value") or "")`.
    let result = serde_json::json!({
        "value": "stored",
        "messages_chain": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_1",
                "function": {"name": "exec", "arguments": "{}"}
            }],
            "content": ""
        }],
        "blocks": [{
            "id": "call_1", "type": "tool", "status": "done", "tool_name": "exec",
            "tool_protocol": "shell_call", "tool_use_id": "call_1", "tool_input": {}
        }]
    });
    let subtask = chain_subtask(result);
    let active = ActiveAssistant {
        subtask_id: subtask.id,
        status: "completed",
        content: "streamed",
    };
    let items = build_response_output(std::slice::from_ref(&subtask), &test_config(), Some(active))
        .expect("builds");
    let serialized: Vec<Value> = items
        .iter()
        .map(|item| serde_json::to_value(item).unwrap())
        .collect();
    assert_eq!(serialized[1]["type"], "message");
    assert_eq!(serialized[1]["content"][0]["text"], "streamed");
}
