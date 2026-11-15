// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::*;

#[test]
fn transcript_runtime_items_preserve_duplicate_block_contents_by_position() {
    let mut assistant = AssistantTurnAccumulation::new(None);
    assistant.blocks = vec![
        json!({"id": "duplicate-block", "title": "first"}),
        json!({"id": "duplicate-block", "title": "second"}),
    ];
    assistant.record_new_items(0, 0);

    let items = assistant.runtime_items();

    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["block"]["title"], "first");
    assert_eq!(items[1]["block"]["title"], "second");
}

#[test]
fn transcript_merges_exec_command_end_into_function_call_block() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "running",
                "items": [
                    {
                        "type": "response_item",
                        "payload": {
                            "id": "call-1",
                            "type": "function_call",
                            "call_id": "call-1",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"pwd\",\"workdir\":\"/tmp/project\"}"
                        }
                    },
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "exec_command_end",
                            "call_id": "call-1",
                            "command": ["/bin/zsh", "-lc", "pwd"],
                            "cwd": "/tmp/project",
                            "aggregated_output": "/tmp/project\n",
                            "status": "completed",
                            "exit_code": 0
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(messages[0]["status"], "streaming");
    assert_eq!(block["type"], "tool");
    assert_eq!(block["tool_name"], "exec_command");
    assert_eq!(block["tool_input"]["cmd"], "pwd");
    assert_eq!(block["tool_input"]["cwd"], "/tmp/project");
    assert_eq!(block["tool_output"], "/tmp/project\n");
    assert_eq!(block["status"], "done");
}

#[test]
fn transcript_truncates_large_exec_command_output() {
    let output = format!(
        "{}tail",
        "x".repeat(MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES + 1024)
    );
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "running",
                "items": [
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "exec_command_end",
                            "call_id": "call-1",
                            "command": ["/bin/zsh", "-lc", "cat large.log"],
                            "cwd": "/tmp/project",
                            "aggregated_output": output,
                            "status": "completed",
                            "exit_code": 0
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];
    let tool_output = block["tool_output"].as_str().unwrap();

    assert_eq!(tool_output.len(), MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES);
    assert!(tool_output.ends_with("tail"));
    assert_eq!(block["tool_output_truncated"], true);
    assert_eq!(
        block["tool_output_original_bytes"],
        MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES + 1028
    );
}

#[test]
fn transcript_renders_unknown_tool_events_with_default_blocks() {
    let thread = json!({
        "id": "thread-1",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "running",
                "items": [
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "custom_command_begin",
                            "call_id": "call-unknown",
                            "name": "unknown_runner",
                            "input": {"path": "src/main.rs"}
                        }
                    },
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "custom_command_end",
                            "call_id": "call-unknown",
                            "stdout": "ok\n"
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["type"], "tool");
    assert_eq!(block["tool_name"], "unknown_runner");
    assert_eq!(block["tool_input"]["input"]["path"], "src/main.rs");
    assert_eq!(block["tool_output"], "ok\n");
    assert_eq!(block["status"], "done");
}

#[test]
fn interrupted_turn_keeps_commentary_visible_and_cancelled_status() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "interruptedAt": 1_780_000_152,
                "status": "interrupted",
                "items": [
                    {
                        "id": "user-1",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "inspect package"}]
                    },
                    {
                        "id": "commentary-1",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": "I will inspect the package file."
                    },
                    {
                        "id": "call-1",
                        "type": "functionCall",
                        "call_id": "call-1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"cat package.json\",\"workdir\":\"/tmp/project\"}",
                        "status": "completed"
                    },
                    {
                        "id": "final-1",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "partial answer"
                    },
                    {
                        "id": "user-2",
                        "type": "userMessage",
                        "timestamp": 1_780_000_140,
                        "content": [{"type": "text", "text": "# Files mentioned by the user:\n\n## pnpm-lock.yaml: /tmp/project/pnpm-lock.yaml\n\n## My request for Codex:\n"}]
                    },
                    {
                        "id": "commentary-2",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "timestamp": 1_780_000_145,
                        "text": "I will use the lockfile context."
                    },
                    {
                        "id": "abort-marker",
                        "type": "userMessage",
                        "timestamp": 1_780_000_150,
                        "content": [{"type": "text", "text": "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"}]
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(messages.len(), 4);
    assert_eq!(messages[1]["status"], "cancelled");
    assert_eq!(messages[1]["stoppedNotice"], true);
    assert_eq!(messages[1]["content"], "partial answer");
    assert_eq!(messages[1]["completedAt"], 1_780_000_152_000_i64);
    assert_eq!(messages[1]["blocks"][0]["type"], "text");
    assert_eq!(
        messages[1]["blocks"][0]["content"],
        "I will inspect the package file."
    );
    assert_eq!(messages[1]["blocks"][1]["tool_name"], "exec_command");
    assert_eq!(
        messages[1]["blocks"][1]["tool_input"]["cmd"],
        "cat package.json"
    );
    assert_eq!(messages[1]["blocks"].as_array().unwrap().len(), 2);
    let final_item = messages[1]["runtimeItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "final-1")
        .unwrap();
    assert_eq!(final_item["type"], "assistant_text");
    assert_eq!(final_item["content"], "partial answer");
    assert_eq!(messages[2]["role"], "user");
    assert_eq!(messages[2]["createdAt"], 1_780_000_140_000_i64);
    assert!(messages[2]["content"]
        .as_str()
        .unwrap_or_default()
        .contains("pnpm-lock.yaml"));
    assert_eq!(messages[3]["status"], "cancelled");
    assert_eq!(messages[3]["stoppedNotice"], false);
    assert_eq!(
        messages[3]["blocks"][0]["tool_name"],
        "conversation_guidance"
    );
    assert_eq!(messages[3]["blocks"][1]["type"], "text");
    assert_eq!(
        messages[3]["blocks"][1]["content"],
        "I will use the lockfile context."
    );
    assert_eq!(messages[3]["runtimeItems"][0]["id"], "commentary-2");
    assert_eq!(messages[3]["runtimeItems"].as_array().unwrap().len(), 1);
}

#[test]
fn cancelled_assistant_projection_preserves_final_and_narrative_visibility() {
    use crate::runtime_work::transcript_search_text::{
        codex_turn_search_regions, visible_assistant_content, AsyncReplySearchProjection,
    };

    for (status, body, narrative, visible_body) in [
        ("interrupted", "interrupted", None, ""),
        ("interrupted", "partial answer", None, "partial answer"),
        ("interrupted", "aborted", Some("interrupted"), ""),
        ("completed", "interrupted", None, "interrupted"),
    ] {
        let mut items = Vec::new();
        if let Some(text) = narrative {
            items.push(json!({
                "id": "narrative-1", "type": "agentMessage",
                "phase": "commentary", "text": text,
            }));
        }
        items.push(json!({
            "id": "final-1", "type": "agentMessage",
            "phase": "final_answer", "text": body,
        }));
        let turn = json!({"id": "turn-1", "status": status, "items": items});
        let messages = search_transcript_messages(&json!({"turns": [turn.clone()]}));
        assert_eq!(messages.len(), 1);
        let message = &messages[0];
        assert_eq!(message["content"], body);
        assert_eq!(
            message["status"],
            if status == "interrupted" {
                "cancelled"
            } else {
                "done"
            }
        );
        let final_item = message["runtimeItems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "final-1")
            .unwrap();
        assert_eq!(final_item["type"], "assistant_text");
        assert_eq!(final_item["content"], body);
        let blocks = message["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), usize::from(narrative.is_some()));
        if let Some(text) = narrative {
            assert_eq!(blocks[0]["type"], "text");
            assert_eq!(blocks[0]["content"], text);
        }
        assert_eq!(
            visible_assistant_content(body, message["status"].as_str().unwrap(), None),
            visible_body
        );

        let regions = codex_turn_search_regions(
            &turn,
            &HashMap::new(),
            None,
            &mut AsyncReplySearchProjection::default(),
        );
        let mut expected = Vec::new();
        if let Some(text) = narrative {
            expected.push(("narrative-1".to_owned(), text.to_owned()));
        }
        if !visible_body.is_empty() {
            expected.push(("final-1".to_owned(), visible_body.to_owned()));
        }
        assert_eq!(
            regions
                .into_iter()
                .map(|region| (region.id, region.text))
                .collect::<Vec<_>>(),
            expected
        );
    }
}

#[test]
fn transcript_ignores_subagent_items() {
    let thread = json!({
        "turns": [
            {
                "id": "turn-1",
                "status": "completed",
                "items": [
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "agent_path": "/root/worker",
                            "content": [{"type": "output_text", "text": "child output"}]
                        }
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "agent_path": "/root",
                            "content": [{"type": "output_text", "text": "root output"}]
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "root output");
}

#[test]
fn transcript_ignores_cross_thread_items() {
    let thread = json!({
        "id": "root-thread",
        "turns": [
            {
                "id": "turn-1",
                "status": "completed",
                "items": [
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "threadId": "child-thread",
                            "content": [{"type": "output_text", "text": "child output"}]
                        }
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "threadId": "root-thread",
                            "content": [{"type": "output_text", "text": "root output"}]
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "root output");
}

#[test]
fn transcript_ignores_cross_thread_turns() {
    let thread = json!({
        "id": "root-thread",
        "turns": [
            {
                "id": "child-turn",
                "threadId": "child-thread",
                "status": "completed",
                "items": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "child output"}]
                    }
                ]
            },
            {
                "id": "root-turn",
                "threadId": "root-thread",
                "status": "completed",
                "items": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "root output"}]
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "root output");
}
