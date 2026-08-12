// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::*;

#[test]
fn visible_user_request_skips_nested_application_context_from_referenced_conversations() {
    let content = concat!(
        "<application_context>\n",
        "[referencedConversations]\n",
        "[{\"role\":\"user\",\"content\":\"<application_context>\\n",
        "[source]\\nstate\\n</application_context>\\n\\nOriginal question\"}]\n",
        "</application_context>\n\n",
        "Continue with the referenced conversation"
    );

    assert_eq!(
        normalized_user_request_content(content),
        "Continue with the referenced conversation"
    );
}

#[test]
fn transcript_restores_failed_turn_without_assistant_output() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "completedAt": 1_780_000_005,
            "status": "failed",
            "error": {
                "message": "stream disconnected before completion"
            },
            "items": [{
                "id": "user-1",
                "type": "userMessage",
                "content": [{
                    "type": "inputText",
                    "text": "Why did this fail?"
                }]
            }]
        }]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["subtaskId"], "turn-1");
    assert_eq!(messages[1]["status"], "failed");
    assert_eq!(
        messages[1]["error"],
        "stream disconnected before completion"
    );
    assert_eq!(messages[1]["content"], "");
}

#[test]
fn transcript_preserves_partial_output_on_failed_turn() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "completedAt": 1_780_000_005,
            "status": "failed",
            "error": {
                "message": "upstream stream closed"
            },
            "items": [{
                "id": "assistant-1",
                "type": "agentMessage",
                "phase": "final",
                "text": "Partial answer"
            }]
        }]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "assistant");
    assert_eq!(messages[0]["content"], "Partial answer");
    assert_eq!(messages[0]["status"], "failed");
    assert_eq!(messages[0]["error"], "upstream stream closed");
}

#[test]
fn split_assistant_messages_keep_the_canonical_turn_id() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "completedAt": 1_780_000_005,
            "status": "completed",
            "items": [
                {
                    "id": "assistant-1",
                    "type": "agentMessage",
                    "text": "First segment"
                },
                {
                    "id": "guidance-1",
                    "type": "userMessage",
                    "content": [{
                        "type": "inputText",
                        "text": "Additional guidance"
                    }]
                },
                {
                    "id": "assistant-2",
                    "type": "agentMessage",
                    "text": "Second segment"
                }
            ]
        }]
    });

    let assistant_messages = transcript_messages(&thread, "device-1")
        .into_iter()
        .filter(|message| message["role"] == "assistant")
        .collect::<Vec<_>>();

    assert_eq!(assistant_messages.len(), 2);
    assert_eq!(assistant_messages[0]["id"], "assistant-turn-1");
    assert_eq!(assistant_messages[1]["id"], "assistant-turn-1-1");
    assert_eq!(assistant_messages[0]["turnId"], "turn-1");
    assert_eq!(assistant_messages[1]["turnId"], "turn-1");
}

#[test]
fn web_search_updates_preserve_all_action_payloads() {
    let actions = [
        json!({
            "type": "openPage",
            "url": "https://docs.wegent.ai/guide"
        }),
        json!({
            "type": "findInPage",
            "url": "https://docs.wegent.ai/guide",
            "pattern": "install"
        }),
    ];

    for (index, action) in actions.into_iter().enumerate() {
        let params = json!({
            "item": {
                "id": format!("search-{index}"),
                "type": "webSearch",
                "query": "",
                "action": action.clone()
            }
        });

        let (_, updates) = tool_update_from_notification(&params)
            .expect("completed web search should produce a tool update");

        assert_eq!(updates["status"], "done");
        assert_eq!(updates["tool_input"], action);
    }
}

#[test]
fn completed_statusless_tools_are_done() {
    for (item_type, id) in [
        ("imageView", "image-view-1"),
        ("sleep", "sleep-1"),
        ("webSearch", "web-search-1"),
    ] {
        let params = json!({
            "item": {
                "id": id,
                "type": item_type
            }
        });

        let (block_id, updates) = tool_update_from_notification(&params)
            .expect("completed statusless tool should produce a tool update");

        assert_eq!(block_id, id);
        assert_eq!(updates["status"], "done");
    }
}

#[test]
fn tool_notifications_preserve_item_lifecycle_timestamps() {
    let started = json!({
        "startedAtMs": 1_780_000_001_250_i64,
        "item": {
            "id": "call-1",
            "type": "commandExecution",
            "command": "sleep 3",
            "cwd": "/tmp",
            "status": "inProgress"
        }
    });
    let completed = json!({
        "completedAtMs": 1_780_000_004_750_i64,
        "item": {
            "id": "call-1",
            "type": "commandExecution",
            "command": "sleep 3",
            "cwd": "/tmp",
            "status": "completed",
            "durationMs": 3_500
        }
    });

    let started_block =
        workbench_block_from_notification(&started, "turn-1", "device-1", "/tmp", None)
            .expect("started tool block");
    let (_, completed_updates) =
        tool_update_from_notification(&completed).expect("completed tool update");

    assert_eq!(started_block["timestamp"], 1_780_000_001_250_i64);
    assert_eq!(completed_updates["completedAt"], 1_780_000_004_750_i64);
    assert_eq!(completed_updates["durationMs"], 3_500);
}

#[test]
fn completed_tool_duration_is_not_replaced_with_the_turn_duration() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "completedAt": 1_780_000_010,
            "status": "completed",
            "items": [{
                "id": "call-1",
                "type": "commandExecution",
                "command": "sleep 3",
                "cwd": "/tmp/project",
                "status": "completed",
                "durationMs": 3_500
            }]
        }]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["tool_name"], "bash");
    assert_eq!(block["timestamp"], 1_780_000_006_500_i64);
    assert_eq!(block["completedAt"], 1_780_000_010_000_i64);
}

#[test]
fn transcript_restores_precise_tool_timing_from_completed_rollout_events() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "completedAt": 1_780_000_020,
            "status": "completed",
            "items": [{
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "started_at_ms": 1_780_000_001_250_i64,
                    "completed_at_ms": 1_780_000_016_119_i64,
                    "item": {
                        "id": "call-1",
                        "type": "CommandExecution",
                        "command": ["sleep", "15"],
                        "cwd": "/tmp/project",
                        "status": "completed",
                        "duration": {
                            "secs": 14,
                            "nanos": 869_000_000
                        }
                    }
                }
            }]
        }]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["timestamp"], 1_780_000_001_250_i64);
    assert_eq!(block["completedAt"], 1_780_000_016_119_i64);
}

#[test]
fn transcript_merges_completed_command_timing_into_function_call_block() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "completedAt": 1_780_000_020,
            "status": "completed",
            "items": [{
                "type": "response_item",
                "timestamp": 1_780_000_001_100_i64,
                "payload": {
                    "id": "function-call-1",
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"sleep 15\",\"workdir\":\"/tmp/project\"}"
                }
            }, {
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "started_at_ms": 1_780_000_001_250_i64,
                    "completed_at_ms": 1_780_000_016_119_i64,
                    "item": {
                        "id": "call-1",
                        "type": "CommandExecution",
                        "command": ["/bin/zsh", "-lc", "sleep 15"],
                        "cwd": "/tmp/project",
                        "status": "completed",
                        "duration": {
                            "secs": 14,
                            "nanos": 869_000_000
                        }
                    }
                }
            }, {
                "type": "response_item",
                "timestamp": 1_780_000_016_120_i64,
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-1",
                    "output": "Chunk ID: test\nWall time: 14.869 seconds\nProcess exited with code 0\nFinal output:\n"
                }
            }]
        }]
    });

    let messages = transcript_messages(&thread, "device-1");
    let blocks = messages[0]["blocks"].as_array().expect("assistant blocks");

    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["tool_use_id"], "call-1");
    assert_eq!(blocks[0]["timestamp"], 1_780_000_001_250_i64);
    assert_eq!(blocks[0]["completedAt"], 1_780_000_016_119_i64);
    assert_eq!(blocks[0]["tool_input"]["cmd"], "sleep 15");
}

#[test]
fn completed_mcp_tool_updates_preserve_structured_content() {
    let params = json!({
        "item": {
            "id": "call-app",
            "type": "mcpToolCall",
            "server": "wegent_apps",
            "tool": "wegent-sites__get_site",
            "arguments": {"project_id": "prj_1"},
            "status": "completed",
            "error": null,
            "result": {
                "_meta": null,
                "content": [{
                    "type": "text",
                    "text": "Wegent Sites tool completed successfully."
                }],
                "structuredContent": {
                    "id": "prj_1",
                    "title": "Palette"
                }
            }
        }
    });

    let (_, updates) = tool_update_from_notification(&params).expect("completed MCP tool update");

    assert_eq!(
        updates["tool_output"]["structuredContent"],
        json!({"id": "prj_1", "title": "Palette"})
    );
}

#[test]
fn transcript_marks_image_view_without_status_as_done() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "completedAt": 1_780_000_005,
            "status": "completed",
            "items": [{
                "type": "response_item",
                "payload": {
                    "id": "image-view-1",
                    "type": "imageView",
                    "path": "/tmp/image.png"
                }
            }]
        }]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["tool_name"], "view_image");
    assert_eq!(block["status"], "done");
}

#[test]
fn image_generation_blocks_preserve_renderable_image_data() {
    let item = json!({
        "id": "ig-1",
        "type": "imageGeneration",
        "status": "completed",
        "result": "aW1hZ2U=",
        "revisedPrompt": "A minimal blue circle",
        "savedPath": "/tmp/ig-1.png"
    });

    let block = workbench_block_from_codex_item(
        &item,
        "turn-1",
        "device-1",
        "/tmp",
        1,
        TranscriptBuildOptions::truncated(),
    )
    .expect("image generation should produce a workbench block");

    assert_eq!(block["tool_name"], "image_generation");
    assert_eq!(block["render_payload"]["kind"], "image_generation");
    assert_eq!(block["render_payload"]["imageBase64"], "aW1hZ2U=");
    assert_eq!(
        block["render_payload"]["revisedPrompt"],
        "A minimal blue circle"
    );
    assert_eq!(block["render_payload"]["savedPath"], "/tmp/ig-1.png");
}

#[test]
fn created_plain_content_counts_lines_as_additions() {
    let content = "# CPU System Report\n\n- CPU: Apple M1 Max\n- Thermal status: normal\n";

    assert_eq!(diff_stats(content, "created"), (4, 0));
}

#[test]
fn created_plain_content_with_diff_headers_counts_all_lines_as_additions() {
    let content = "--- release notes\n+++ follow-up\nplain content\n";

    assert_eq!(diff_stats(content, "created"), (3, 0));
}

#[test]
fn tool_call_ids_without_explicit_ids_are_stable_and_content_derived() {
    let first = json!({"type": "customToolCall", "name": "alpha", "input": {"value": 1}});
    let second = json!({"type": "customToolCall", "name": "alpha", "input": {"value": 2}});

    assert_eq!(tool_call_id(&first), tool_call_id(&first));
    assert_ne!(tool_call_id(&first), tool_call_id(&second));
}

#[test]
fn empty_tool_output_does_not_replace_existing_output() {
    let mut block = Map::from_iter([(
        "tool_output".to_owned(),
        Value::String("existing output".to_owned()),
    )]);
    let empty_output = json!({"type": "functionCallOutput", "output": ""});

    insert_tool_output_fields(
        &mut block,
        &empty_output,
        TranscriptBuildOptions::truncated(),
    );

    assert_eq!(block["tool_output"], "existing output");
}

#[test]
fn value_string_tool_output_respects_truncation_options() {
    let output = format!("{}tail", "x".repeat(MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES + 32));
    let item = json!({"type": "functionCallOutput", "output": output});
    let mut block = Map::new();

    insert_tool_output_fields(&mut block, &item, TranscriptBuildOptions::truncated());

    assert_eq!(
        block["tool_output"].as_str().unwrap().len(),
        MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES
    );
    assert!(block["tool_output"].as_str().unwrap().ends_with("tail"));
    assert_eq!(block["tool_output_truncated"], true);
}

#[test]
fn unified_diff_counts_prefixed_lines() {
    let diff = "@@ -1,2 +1,2 @@\n-old\n+new\n context\n";

    assert_eq!(diff_stats(diff, "modified"), (1, 1));
}

#[test]
fn modified_plain_patch_counts_prefixed_lines() {
    let diff = "-old\n+new\n context\n";

    assert_eq!(diff_stats(diff, "modified"), (1, 1));
}

#[test]
fn transcript_unwraps_codex_response_item_and_event_msg_items() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "completedAt": 1_780_000_005,
                "status": "completed",
                "items": [
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_000,
                        "payload": {
                            "id": "context-response",
                            "type": "message",
                            "role": "user",
                            "content": [
                                {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"}
                            ]
                        }
                    },
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_000,
                        "payload": {
                            "id": "user-1",
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "inspect runtime"}]
                        }
                    },
                    {
                        "type": "event_msg",
                        "timestamp": 1_780_000_000,
                        "payload": {
                            "id": "user-event-1",
                            "type": "user_message",
                            "message": "inspect runtime"
                        }
                    },
                    {
                        "type": "event_msg",
                        "timestamp": 1_780_000_001,
                        "payload": {
                            "id": "commentary-1",
                            "type": "agent_message",
                            "phase": "commentary",
                            "message": "I will inspect the runtime."
                        }
                    },
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_002,
                        "payload": {
                            "id": "reasoning-1",
                            "type": "reasoning",
                            "summary": ["Checking the relevant files."]
                        }
                    },
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_003,
                        "payload": {
                            "id": "call-1",
                            "type": "function_call",
                            "call_id": "call-1",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"rg runtime\",\"workdir\":\"/tmp/project\"}"
                        }
                    },
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_004,
                        "payload": {
                            "id": "call-output-1",
                            "type": "function_call_output",
                            "call_id": "call-1",
                            "output": "runtime.rs"
                        }
                    },
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_005,
                        "payload": {
                            "id": "final-1",
                            "type": "message",
                            "role": "assistant",
                            "phase": "final_answer",
                            "content": [{"type": "output_text", "text": "Done."}]
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(
        messages[0]["content"],
        "# AGENTS.md instructions\n\n<environment_context>"
    );
    assert_eq!(messages[1]["role"], "user");
    assert_eq!(messages[1]["content"], "inspect runtime");
    assert_eq!(messages[2]["role"], "user");
    assert_eq!(messages[2]["content"], "inspect runtime");
    assert_eq!(messages[3]["role"], "assistant");
    assert_eq!(messages[3]["content"], "Done.");
    assert_eq!(messages[3]["blocks"][0]["type"], "text");
    assert_eq!(
        messages[3]["blocks"][0]["content"],
        "I will inspect the runtime."
    );
    assert_eq!(messages[3]["blocks"][0]["timestamp"], 1_780_000_001_000_i64);
    assert_eq!(messages[3]["blocks"][1]["type"], "thinking");
    assert_eq!(
        messages[3]["blocks"][1]["content"],
        "Checking the relevant files."
    );
    assert_eq!(messages[3]["blocks"][2]["tool_name"], "exec_command");
    assert_eq!(messages[3]["blocks"][2]["tool_input"]["cmd"], "rg runtime");
    assert_eq!(messages[3]["blocks"][2]["tool_output"], "runtime.rs");
    assert_eq!(messages[3]["blocks"][2]["status"], "done");
    assert_eq!(messages[3]["runtimeItems"][0]["id"], "commentary-1");
    assert_eq!(messages[3]["runtimeItems"][0]["type"], "block");
    assert_eq!(messages[3]["runtimeItems"][1]["id"], "reasoning-1");
    assert_eq!(messages[3]["runtimeItems"][1]["type"], "block");
    assert_eq!(messages[3]["runtimeItems"][2]["id"], "call-1");
    assert_eq!(messages[3]["runtimeItems"][2]["type"], "block");
    assert_eq!(messages[3]["runtimeItems"][3]["id"], "final-1");
    assert_eq!(messages[3]["runtimeItems"][3]["type"], "assistant_text");
    assert_eq!(
        messages[3]["runtimeItems"][3]["createdAt"],
        1_780_000_005_000_i64
    );
}

#[test]
fn transcript_keeps_unphased_text_before_tools_in_processing() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [{
            "id": "turn-1",
            "startedAt": 1_780_000_000,
            "completedAt": 1_780_000_005,
            "status": "completed",
            "items": [
                {
                    "id": "user-1",
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect runtime"}]
                },
                {
                    "id": "process-1",
                    "type": "agentMessage",
                    "role": "assistant",
                    "text": "I will inspect the runtime."
                },
                {
                    "id": "call-1",
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"rg runtime\"}"
                },
                {
                    "id": "call-output-1",
                    "type": "function_call_output",
                    "call_id": "call-1",
                    "output": "runtime.rs"
                },
                {
                    "id": "final-1",
                    "type": "agentMessage",
                    "role": "assistant",
                    "text": "The runtime is correct."
                }
            ]
        }]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "The runtime is correct.");
    assert_eq!(messages[1]["blocks"][0]["type"], "text");
    assert_eq!(
        messages[1]["blocks"][0]["content"],
        "I will inspect the runtime."
    );
    assert_eq!(messages[1]["blocks"][1]["type"], "tool");
    assert_eq!(messages[1]["blocks"][1]["tool_name"], "exec_command");
}

#[test]
fn transcript_marks_successful_legacy_mcp_tool_call_end_as_done() {
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
                        "timestamp": 1_780_000_001,
                        "payload": {
                            "type": "function_call",
                            "id": "fc-1",
                            "name": "ask",
                            "namespace": "askhuman",
                            "arguments": "{\"message\":\"Confirm?\"}",
                            "call_id": "call-ask"
                        }
                    },
                    {
                        "type": "event_msg",
                        "timestamp": 1_780_000_002,
                        "payload": {
                            "type": "mcp_tool_call_end",
                            "call_id": "call-ask",
                            "invocation": {
                                "server": "askhuman",
                                "tool": "ask",
                                "arguments": {"message": "Confirm?"}
                            },
                            "result": {
                                "Ok": {
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "{\"answers\":[{\"question_index\":0,\"user_input\":\"done\"}]}"
                                        }
                                    ],
                                    "structuredContent": {
                                        "answers": [
                                            {"question_index": 0, "user_input": "done"}
                                        ]
                                    },
                                    "isError": false
                                }
                            }
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["type"], "tool");
    assert_eq!(block["tool_name"], "ask");
    assert_eq!(block["tool_output"]["isError"], false);
    assert_eq!(
        block["tool_output"]["structuredContent"]["answers"][0]["user_input"],
        "done"
    );
    assert_eq!(block["status"], "done");
}

#[test]
fn transcript_marks_completed_mcp_tool_call_with_null_error_as_done() {
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
                        "timestamp": 1_780_000_001,
                        "payload": {
                            "type": "mcpToolCall",
                            "id": "call-mcp",
                            "server": "codex",
                            "tool": "list_mcp_resources",
                            "arguments": {},
                            "status": "completed",
                            "error": null,
                            "result": {
                                "_meta": null,
                                "content": [
                                    {
                                        "type": "text",
                                        "text": "{\"resources\":[]}"
                                    }
                                ],
                                "structuredContent": null
                            }
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["type"], "tool");
    assert_eq!(block["tool_name"], "codex.list_mcp_resources");
    assert_eq!(block["status"], "done");
}

#[test]
fn transcript_restores_pending_request_user_input_as_interactive_block() {
    let thread = json!({
        "id": "thread-1",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "running",
                "items": [
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call",
                            "call_id": "request-1",
                            "name": "request_user_input",
                            "arguments": "{\"questions\":[{\"id\":\"direction\",\"question\":\"Which direction?\",\"options\":[{\"label\":\"Complete\",\"description\":\"Cover the full flow.\"}]}]}"
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["tool_name"], "request_user_input");
    assert_eq!(block["status"], "pending");
    assert_eq!(block["render_payload"]["kind"], "request_user_input");
    assert_eq!(block["render_payload"]["requestId"], "request-1");
    assert_eq!(
        block["render_payload"]["questions"][0]["question"],
        "Which direction?"
    );
}

#[test]
fn transcript_restores_answered_request_user_input_response() {
    let thread = json!({
        "id": "thread-1",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "completed",
                "items": [
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call",
                            "call_id": "request-1",
                            "name": "request_user_input",
                            "arguments": "{\"questions\":[{\"id\":\"direction\",\"question\":\"Which direction?\"}]}"
                        }
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call_output",
                            "call_id": "request-1",
                            "output": "{\"answers\":{\"direction\":{\"answers\":[\"Complete\"]}}}"
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = &messages[0]["blocks"][0];

    assert_eq!(block["status"], "done");
    assert_eq!(
        block["render_payload"]["response"]["answers"]["direction"]["answers"][0],
        "Complete"
    );
}

#[test]
fn transcript_unwraps_codex_plan_items_as_plan_blocks() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "completedAt": 1_780_000_010,
                "status": "completed",
                "items": [
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_001,
                        "payload": {
                            "id": "user-1",
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "make a plan"}]
                        }
                    },
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_002,
                        "payload": {
                            "id": "plan-1",
                            "type": "plan",
                            "text": "# Plan\n\n- Inspect the repo."
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "");
    assert_eq!(messages[1]["blocks"][0]["id"], "plan-plan-1");
    assert_eq!(messages[1]["blocks"][0]["type"], "plan");
    assert_eq!(messages[1]["blocks"][0]["process_kind"], "plan");
    assert_eq!(
        messages[1]["blocks"][0]["content"],
        "# Plan\n\n- Inspect the repo."
    );
    assert_eq!(messages[1]["blocks"][0]["status"], "done");
}

#[test]
fn transcript_unwraps_completed_plan_events_and_skips_duplicate_final_text() {
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "completedAt": 1_780_000_010,
                "status": "completed",
                "items": [
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_001,
                        "payload": {
                            "id": "user-1",
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "make a plan"}]
                        }
                    },
                    {
                        "type": "event_msg",
                        "timestamp": 1_780_000_002,
                        "payload": {
                            "type": "item_completed",
                            "completed_at_ms": 1_780_000_003,
                            "item": {
                                "id": "turn-1-plan",
                                "type": "Plan",
                                "text": "# Plan\n\n- Inspect the repo."
                            }
                        }
                    },
                    {
                        "type": "response_item",
                        "timestamp": 1_780_000_004,
                        "payload": {
                            "id": "assistant-final",
                            "type": "message",
                            "role": "assistant",
                            "phase": "final_answer",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "<proposed_plan>\n# Plan\n\n- Inspect the repo.\n</proposed_plan>"
                                }
                            ]
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "");
    assert_eq!(messages[1]["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(messages[1]["blocks"][0]["id"], "plan-turn-1-plan");
    assert_eq!(messages[1]["blocks"][0]["type"], "plan");
    assert_eq!(
        messages[1]["blocks"][0]["content"],
        "# Plan\n\n- Inspect the repo."
    );
}
