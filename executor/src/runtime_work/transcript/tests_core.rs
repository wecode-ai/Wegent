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
fn mcp_tool_blocks_preserve_plugin_provenance() {
    let params = json!({
        "item": {
            "id": "call-plugin",
            "type": "mcpToolCall",
            "pluginId": "openai-developers@openai-official",
            "server": "openai-api-key-local-confirmation",
            "tool": "confirm_openai_api_key_local_destination",
            "arguments": {},
            "status": "inProgress"
        }
    });

    let block =
        workbench_block_from_notification(&params, "turn-1", "device-1", "/tmp", Some("pending"))
            .expect("MCP tool block");

    assert_eq!(block["plugin_id"], "openai-developers@openai-official");
    assert_eq!(block["mcp_server"], "openai-api-key-local-confirmation");
}

#[test]
fn image_generation_blocks_preserve_renderable_image_data() {
    let workspace = tempfile::tempdir().expect("workspace");
    let source_directory = tempfile::tempdir().expect("source directory");
    let source = source_directory.path().join("ig-1.png");
    image::RgbaImage::from_pixel(4, 2, image::Rgba([0, 0, 0, 255]))
        .save(&source)
        .expect("generated image");
    let item = json!({
        "id": "ig-1",
        "type": "imageGeneration",
        "status": "completed",
        "result": "a".repeat(1_800_000),
        "revisedPrompt": "A minimal blue circle",
        "savedPath": source
    });

    let block = workbench_block_from_codex_item(
        &item,
        "turn-1",
        "device-1",
        workspace.path().to_str().expect("workspace path"),
        1,
        TranscriptBuildOptions::truncated(),
    )
    .expect("image generation should produce a workbench block");

    assert_eq!(block["tool_name"], "image_generation");
    assert_eq!(block["render_payload"]["kind"], "image_generation");
    assert_eq!(block["render_payload"]["source"]["type"], "workspace_file");
    assert_eq!(block["render_payload"]["source"]["deviceId"], "device-1");
    assert_eq!(block["render_payload"]["width"], 4);
    assert_eq!(block["render_payload"]["height"], 2);
    assert!(block["render_payload"].get("imageBase64").is_none());
    assert!(block.get("tool_output").is_none());
    assert!(
        serde_json::to_vec(&block).unwrap().len() < 1_000_000,
        "projected image block must fit within the Socket.IO payload limit"
    );
    assert_eq!(
        block["render_payload"]["revisedPrompt"],
        "A minimal blue circle"
    );
    let relative_path = block["render_payload"]["source"]["path"]
        .as_str()
        .expect("relative image path");
    assert!(workspace.path().join(relative_path).exists());
}

#[test]
fn image_generation_updates_do_not_inline_base64_without_an_artifact() {
    let params = json!({
        "item": {
            "id": "ig-live-1",
            "type": "imageGeneration",
            "status": "completed",
            "result": "aW1hZ2U="
        }
    });

    let block = workbench_block_from_notification(
        &params,
        "turn-1",
        "device-1",
        "/missing-workspace",
        None,
    )
    .expect("live image generation block");
    let (_, updates) =
        tool_update_from_notification(&params).expect("live image generation update");

    assert!(block["render_payload"].get("imageBase64").is_none());
    assert!(updates.get("render_payload").is_none());
    assert!(updates.get("tool_output").is_none());
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
fn transcript_restores_pending_async_request_user_input_as_interactive_block() {
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
                            "call_id": "call-1",
                            "name": "request_user_input_async",
                            "arguments": "{\"questions\":[{\"title\":\"Which state jitters?\",\"options\":[\"Following\",\"Reading\"]}]}"
                        }
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call_output",
                            "call_id": "call-1",
                            "output": "{\"accepted\":true}"
                        }
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = messages
        .iter()
        .flat_map(|message| message["blocks"].as_array().into_iter().flatten().cloned())
        .find(|block| block["tool_name"] == "request_user_input")
        .expect("async question block");

    assert_eq!(block["type"], "tool");
    // The async tool call itself returns immediately, so only the render payload
    // marks the interaction; it stays unanswered until the next user message.
    assert_eq!(block["render_payload"]["kind"], "request_user_input");
    assert_eq!(block["render_payload"]["delivery"], "async");
    assert_eq!(block["render_payload"]["itemId"], "call-1");
    assert_eq!(
        block["render_payload"]["questions"][0]["question"],
        "Which state jitters?"
    );
    assert_eq!(
        block["render_payload"]["questions"][0]["options"][0]["label"],
        "Following"
    );
    // The `accepted` tool output is not an answer, so the card must stay open.
    assert!(block["render_payload"].get("response").is_none());
}

#[test]
fn transcript_restores_async_question_recorded_as_agent_message() {
    let thread = json!({
        "id": "thread-1",
        "turns": [
            {
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "status": "completed",
                "items": [
                    {
                        "type": "AgentMessage",
                        "id": "call-question",
                        "content": [{"type": "Text", "text": "Which state jitters?\n- Following\n- Reading"}],
                        "phase": "final_answer",
                        "delivery": "async",
                        "questions": [
                            {"title": "Which state jitters?", "options": ["Following", "Reading"]}
                        ]
                    }
                ]
            }
        ]
    });

    let messages = transcript_messages(&thread, "device-1");
    let block = messages
        .iter()
        .flat_map(|message| message["blocks"].as_array().into_iter().flatten().cloned())
        .find(|block| block["tool_name"] == "request_user_input")
        .expect("async question block");

    assert_eq!(block["type"], "tool");
    assert_eq!(block["render_payload"]["kind"], "request_user_input");
    assert_eq!(block["render_payload"]["delivery"], "async");
    assert_eq!(block["render_payload"]["itemId"], "call-question");
    assert_eq!(
        block["render_payload"]["questions"][0]["question"],
        "Which state jitters?"
    );
    assert_eq!(
        block["render_payload"]["questions"][0]["options"][1]["label"],
        "Reading"
    );
    // The plain-text fallback must not also become the assistant's final text.
    assert!(messages.iter().all(|message| !message["content"]
        .as_str()
        .unwrap_or_default()
        .contains("Reading")));
    // Turn projection feeds the workspace from `runtimeItems`, so the interactive
    // block has to be listed there as well.
    let runtime_block = messages
        .iter()
        .flat_map(|message| {
            message["runtimeItems"]
                .as_array()
                .into_iter()
                .flatten()
                .cloned()
        })
        .find(|item| {
            item["type"] == "block"
                && item["block"]["tool_name"].as_str() == Some("request_user_input")
        });
    assert!(
        runtime_block.is_some(),
        "runtimeItems must carry the question block"
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
fn context_compaction_history_keeps_provider_completion_after_turn_interruption() {
    let messages = transcript_messages(
        &json!({
            "turns": [{
                "id": "turn-1", "status": "interrupted",
                "items": [{"id": "compact-1", "type": "contextCompaction"}]
            }]
        }),
        "device-1",
    );
    assert_eq!(messages[0]["status"], "cancelled");
    assert_eq!(messages[0]["blocks"][0]["status"], "done");
}

#[test]
fn canonical_turn_retains_artifacts_from_segments_before_guidance() {
    let thread = json!({"id":"thread-1","cwd":"/tmp/project","turns":[{
        "id":"turn-1","status":"completed","items":[
            {"id":"patch","type":"patchApplyEnd","status":"completed","changes":{
                "/tmp/project/src/one.rs":{"type":"update","unified_diff":"@@ -1 +1 @@\n-old\n+new\n"}
            }},
            {"id":"guidance","type":"userMessage","content":[{"type":"inputText","text":"Continue"}]},
            {"id":"final","type":"agentMessage","phase":"final_answer","text":"Done"}
        ]
    }]});
    let projection = project_transcript(&thread, "device-1", false);
    assert_eq!(
        projection.turns[0]["fileChanges"]["files"][0]["path"],
        "src/one.rs"
    );
}
