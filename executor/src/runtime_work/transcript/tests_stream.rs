// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::*;

#[test]
fn transcript_preserves_distinct_response_and_event_user_items() {
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
                        "timestamp": 1_780_000_000,
                        "payload": {
                            "id": "user-response",
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "start app"}]
                        }
                    },
                    {
                        "type": "event_msg",
                        "timestamp": 1_780_000_001,
                        "payload": {
                            "id": "user-event",
                            "type": "user_message",
                            "clientId": "runtime-local-pane-1",
                            "message": "start app\n"
                        }
                    },
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_002,
                        "payload": {
                            "id": "assistant-1",
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "working"}]
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let user_messages = messages
        .iter()
        .filter(|message| message["role"] == "user")
        .collect::<Vec<_>>();

    assert_eq!(user_messages.len(), 2);
    assert_eq!(user_messages[0]["content"], "start app");
    assert_eq!(
        user_messages[1]["clientUserMessageId"],
        "runtime-local-pane-1"
    );
    assert!(!messages.iter().any(|message| {
        message["content"]
            .as_str()
            .is_some_and(|content| content.contains("AGENTS.md"))
    }));
}

#[test]
fn transcript_preserves_distinct_attachment_wrapper_and_visible_user_items() {
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
                        "id": "wrapped-user",
                        "type": "userMessage",
                        "content": [{
                            "type": "inputText",
                            "text": "# Files mentioned by the user:\n\n## image.png: /tmp/image.png\n\n## My request for Codex:\n<application_context>\n[wework.terminal.current]\nterminal state\n</application_context>\n\nFix the sidebar"
                        }]
                    },
                    {
                        "id": "visible-user",
                        "type": "userMessage",
                        "clientId": "runtime-local-pane-1",
                        "message": "Fix the sidebar"
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let user_messages = messages
        .iter()
        .filter(|message| message["role"] == "user")
        .collect::<Vec<_>>();

    assert_eq!(user_messages.len(), 2);
    assert_eq!(
        user_messages[0]["content"],
        "# Files mentioned by the user:\n\n## image.png: /tmp/image.png\n\n## My request for Codex:\n<application_context>\n[wework.terminal.current]\nterminal state\n</application_context>\n\nFix the sidebar"
    );
    assert_eq!(
        user_messages[1]["clientUserMessageId"],
        "runtime-local-pane-1"
    );
}

#[test]
fn transcript_preserves_same_content_user_items_with_distinct_ids() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "completed",
                "items": [
                    {
                        "id": "user-initial",
                        "type": "userMessage",
                        "content": [{"type": "inputText", "text": "Continue the goal"}]
                    },
                    {
                        "id": "assistant-before",
                        "type": "agentMessage",
                        "text": "Initial progress"
                    },
                    {
                        "id": "user-guidance",
                        "type": "userMessage",
                        "clientId": "runtime-local-pane-1",
                        "content": [{"type": "inputText", "text": "Continue the goal"}]
                    },
                    {
                        "id": "assistant-after",
                        "type": "agentMessage",
                        "text": "Goal complete"
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(
        messages
            .iter()
            .map(|message| (
                message["role"].as_str().unwrap(),
                message["content"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("user", "Continue the goal"),
            ("assistant", "Initial progress"),
            ("user", "Continue the goal"),
            ("assistant", "Goal complete"),
        ]
    );
    assert_eq!(messages[2]["clientUserMessageId"], "runtime-local-pane-1");
}

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
fn transcript_prefers_original_mentioned_image_over_transient_model_input() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "completed",
                "items": [
                    {
                        "id": "user-event",
                        "type": "userMessage",
                        "clientId": "runtime-local-pane-1",
                        "message": "# Files mentioned by the user:\n\n## image.png: /tmp/attachments/image.png\n\n## My request for Codex:\nFix the preview",
                        "local_images": ["/tmp/attachments/image.model-input.png"]
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let attachment = &messages[0]["attachments"][0];

    assert_eq!(attachment["filename"], "image.png");
    assert_eq!(
        attachment["local_preview_url"],
        "/tmp/attachments/image.png"
    );
}

#[test]
fn transcript_normalizes_and_deduplicates_remote_image_urls() {
    let data_url = "data:image/png;base64,aW1hZ2U=";
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "status": "completed",
            "items": [{
                "id": "user-event",
                "type": "userMessage",
                "content": [
                    {"type": "image", "url": format!("  {data_url}  ")},
                    {"type": "image", "url": data_url}
                ]
            }]
        }]
    });

    let messages = transcript_messages(&thread, "device-1");
    let attachments = messages[0]["attachments"].as_array().unwrap();

    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["filename"], "image-1.png");
    assert_eq!(attachments[0]["local_preview_url"], data_url);
}

#[test]
fn transcript_uses_the_latest_snapshot_for_duplicate_item_ids() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "completed",
                "items": [
                    {
                        "id": "duplicate-user",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "first request"}]
                    },
                    {
                        "id": "duplicate-user",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "second request"}]
                    },
                    {
                        "id": "duplicate-file-change",
                        "type": "patchApplyEnd",
                        "status": "completed",
                        "changes": {
                            "/tmp/project/src/one.rs": {
                                "type": "update",
                                "unified_diff": "@@ -1 +1 @@\n-old\n+new\n",
                                "move_path": null
                            }
                        }
                    },
                    {
                        "id": "duplicate-file-change",
                        "type": "patchApplyEnd",
                        "status": "completed",
                        "changes": {
                            "/tmp/project/src/two.rs": {
                                "type": "update",
                                "unified_diff": "@@ -1 +1 @@\n-old\n+new\n",
                                "move_path": null
                            }
                        }
                    },
                    {
                        "id": "agent-1",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "Done"
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["id"], "duplicate-user");
    assert_eq!(messages[0]["content"], "second request");
    assert_eq!(messages[1]["blocks"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        messages[1]["blocks"][0]["id"],
        "file-changes-duplicate-file-change"
    );
    assert_eq!(
        messages[1]["blocks"][0]["file_changes"]["files"][0]["path"],
        "src/two.rs"
    );
}

#[test]
fn transcript_generates_stable_ids_for_items_without_raw_ids() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "startedAt": 1_780_000_000,
                "status": "completed",
                "items": [
                    {
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "first request"}]
                    },
                    {
                        "type": "reasoning",
                        "text": "thinking"
                    },
                    {
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "Done"
                    }
                ]
            }
        ]
    });

    let first = transcript_messages(&thread, "device-1");
    let second = transcript_messages(&thread, "device-1");
    let first_ids = first
        .iter()
        .filter_map(|message| message["id"].as_str())
        .collect::<Vec<_>>();
    let second_ids = second
        .iter()
        .filter_map(|message| message["id"].as_str())
        .collect::<Vec<_>>();

    assert_eq!(first_ids, second_ids);
    assert_eq!(first_ids[0], "turn-1:item:1");
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
fn full_transcript_messages_keep_large_content_and_tool_output() {
    let assistant_content = format!(
        "{}assistant-tail",
        "a".repeat(MAX_TRANSCRIPT_MESSAGE_CONTENT_CHARS + 16)
    );
    let output = format!(
        "{}tool-tail",
        "x".repeat(MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES + 1024)
    );
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "completed",
                "items": [
                    {
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": assistant_content
                    },
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

    let messages = full_transcript_messages(&thread, "device-1");
    let message = &messages[0];
    let block = &message["blocks"][0];

    assert_eq!(message["content"], assistant_content);
    assert!(message.get("content_truncated").is_none());
    assert_eq!(block["tool_output"], output);
    assert!(block.get("tool_output_truncated").is_none());
}

#[test]
fn transcript_treats_non_zero_command_exit_as_error() {
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
                            "arguments": "{\"cmd\":\"grep missing file.txt\",\"workdir\":\"/tmp/project\"}"
                        }
                    },
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "exec_command_end",
                            "call_id": "call-1",
                            "command": ["/bin/zsh", "-lc", "grep missing file.txt"],
                            "cwd": "/tmp/project",
                            "aggregated_output": "",
                            "status": "failed",
                            "exit_code": 1
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["type"], "tool");
    assert_eq!(block["tool_name"], "exec_command");
    assert_eq!(block["status"], "error");
}

#[test]
fn transcript_keeps_command_failures_without_exit_code_as_error() {
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
                            "command": ["missing-binary"],
                            "cwd": "/tmp/project",
                            "status": "failed",
                            "error": "No such file or directory"
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["type"], "tool");
    assert_eq!(block["status"], "error");
}

#[test]
fn transcript_keeps_non_command_tool_failures_with_exit_code_as_error() {
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
                            "name": "custom_tool",
                            "arguments": "{\"path\":\"input.json\"}"
                        }
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call_output",
                            "call_id": "call-1",
                            "status": "failed",
                            "output": "{\"exit_code\":2,\"message\":\"tool failed\"}",
                            "exit_code": 2
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["type"], "tool");
    assert_eq!(block["tool_name"], "custom_tool");
    assert_eq!(block["status"], "error");
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
    assert_eq!(messages[1]["content"], "");
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
    assert_eq!(messages[1]["blocks"][2]["type"], "text");
    assert_eq!(messages[1]["blocks"][2]["content"], "partial answer");
    assert_eq!(messages[1]["blocks"][2]["timestamp"], 1_780_000_152_000_i64);
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

#[test]
fn running_turn_stays_streaming_without_final_file_changes_card() {
    let thread = json!({
        "id": "thread-running",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-running",
                "startedAt": 1_780_000_000,
                "status": "running",
                "items": [
                    {
                        "id": "user-1",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "keep working"}]
                    },
                    {
                        "id": "reasoning-1",
                        "type": "reasoning",
                        "summary": ["Still inspecting."]
                    },
                    {
                        "id": "call-1",
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"sed -n '1,20p' src/main.rs\",\"workdir\":\"/tmp/project\"}"
                    },
                    {
                        "id": "patch-1",
                        "type": "patchApplyEnd",
                        "status": "completed",
                        "changes": {
                            "/tmp/project/src/main.rs": {
                                "type": "update",
                                "unified_diff": "@@ -1 +1 @@\n-old\n+new\n",
                                "move_path": null
                            }
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["status"], "streaming");
    assert!(messages[1].get("completedAt").is_none());
    assert!(messages[1].get("fileChanges").is_none());
    assert_eq!(messages[1]["blocks"][0]["type"], "thinking");
    assert_eq!(messages[1]["blocks"][1]["tool_name"], "exec_command");
    assert_eq!(messages[1]["blocks"][1]["status"], "pending");
    assert_eq!(
        messages[1]["blocks"][1]["tool_input"]["cmd"],
        "sed -n '1,20p' src/main.rs"
    );
}
