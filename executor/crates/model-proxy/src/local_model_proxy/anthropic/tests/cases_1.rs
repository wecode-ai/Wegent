use super::*;

#[test]
fn converts_history_tools_and_results() {
    let input = json!({
        "model": "kimi-for-coding",
        "instructions": "Be concise",
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "Edit"}]},
            {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "patch"},
            {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
        ],
        "tools": [{"type": "custom", "name": "apply_patch"}],
        "stream": true
    });
    let (converted, _) = responses_to_anthropic(&input).expect("request should convert");
    assert_eq!(converted["system"], "Be concise");
    assert_eq!(converted["messages"][1]["content"][0]["type"], "tool_use");
    assert_eq!(
        converted["messages"][2]["content"][0]["type"],
        "tool_result"
    );
    assert_eq!(converted["tools"][0]["name"], "apply_patch");
}

#[test]
fn keeps_assistant_text_and_tool_use_in_one_anthropic_message() {
    let input = json!({
        "model": "kimi-for-coding",
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "Inspect it"}]},
            {"role": "assistant", "content": [{"type": "output_text", "text": "I will inspect it."}]},
            {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
            {"type": "function_call_output", "call_id": "call_1", "output": "/workspace"}
        ],
        "tools": [{
            "type": "function",
            "name": "exec_command",
            "parameters": {"type": "object"}
        }]
    });

    let (converted, _) = responses_to_anthropic(&input).expect("request should convert");
    let messages = converted["messages"].as_array().expect("messages");

    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"][0]["type"], "text");
    assert_eq!(messages[1]["content"][0]["text"], "I will inspect it.");
    assert_eq!(messages[1]["content"][1]["type"], "tool_use");
    assert_eq!(messages[1]["content"][1]["name"], "exec_command");
    assert_eq!(messages[2]["content"][0]["type"], "tool_result");
    assert!(!messages
        .windows(2)
        .any(|pair| pair[0]["role"] == "assistant" && pair[1]["role"] == "assistant"));
}

#[test]
fn preserves_structured_app_tool_results_for_anthropic_messages() {
    let input = json!({
        "model": "kimi-for-coding",
        "input": [
            {
                "type": "function_call",
                "call_id": "call_1",
                "namespace": "wegent_apps",
                "name": "wegent-sites__get_site",
                "arguments": "{\"project_id\":\"prj_1\"}"
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": {
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
        ],
        "tools": [{
            "type": "namespace",
            "name": "wegent_apps",
            "tools": [{
                "type": "function",
                "name": "wegent-sites__get_site",
                "parameters": {"type": "object"}
            }]
        }]
    });

    let (converted, _) = responses_to_anthropic(&input).expect("request should convert");

    assert_eq!(
        converted["messages"][1]["content"][0]["content"],
        "{\"id\":\"prj_1\",\"title\":\"Palette\"}"
    );
}

#[test]
fn converts_tool_output_images_to_anthropic_image_blocks() {
    let input = json!({
        "model": "kimi-k3",
        "input": [
            {
                "type": "function_call",
                "call_id": "image_1",
                "name": "view_image",
                "arguments": "{}"
            },
            {
                "type": "function_call_output",
                "call_id": "image_1",
                "output": [
                    {"type": "text", "text": "Rendered preview"},
                    {
                        "type": "input_image",
                        "image_url": "data:image/png;base64,aGVsbG8="
                    }
                ]
            }
        ],
        "tools": [{
            "type": "function",
            "name": "view_image",
            "parameters": {"type": "object"}
        }]
    });

    let (converted, _) = responses_to_anthropic(&input).expect("request should convert");
    let messages = converted["messages"].as_array().expect("messages");

    assert_eq!(messages[0]["role"], "assistant");
    assert_eq!(messages[1]["content"][0]["type"], "tool_result");
    assert_eq!(messages[1]["content"][0]["content"], "Rendered preview");
    assert_eq!(messages[1]["role"], "user");
    assert_eq!(
        messages[1]["content"][1]["text"],
        "Image output from tool view_image:"
    );
    assert_eq!(messages[1]["content"][2]["type"], "image");
    assert_eq!(
        messages[1]["content"][2]["source"]["media_type"],
        "image/png"
    );
    assert_eq!(messages[1]["content"][2]["source"]["data"], "aGVsbG8=");
    assert!(!messages[1]["content"][0]["content"]
        .as_str()
        .is_some_and(|content| content.contains("aGVsbG8=")));
}

#[test]
fn converts_user_input_images_to_anthropic_image_blocks() {
    let input = json!({
        "model": "kimi-k3",
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": "Describe this image"},
                {
                    "type": "input_image",
                    "image_url": "data:image/jpeg;base64,dXNlci1pbWFnZQ=="
                },
                {
                    "type": "input_image",
                    "image_url": "https://example.com/image.png"
                }
            ]
        }]
    });

    let (converted, _) = responses_to_anthropic(&input).expect("request should convert");

    assert_eq!(converted["messages"][0]["content"][0]["type"], "text");
    assert_eq!(converted["messages"][0]["content"][1]["type"], "image");
    assert_eq!(
        converted["messages"][0]["content"][1]["source"]["media_type"],
        "image/jpeg"
    );
    assert_eq!(
        converted["messages"][0]["content"][1]["source"]["data"],
        "dXNlci1pbWFnZQ=="
    );
    assert_eq!(converted["messages"][0]["content"][2]["type"], "image");
    assert_eq!(
        converted["messages"][0]["content"][2]["source"],
        json!({"type": "url", "url": "https://example.com/image.png"})
    );
}

#[test]
fn flattens_namespace_tools_for_anthropic_messages() {
    let input = json!({
        "model": "kimi-for-coding",
        "input": [{"role": "user", "content": "Inspect the page"}],
        "tools": [{
            "type": "namespace",
            "name": "wework_browser",
            "tools": [{
                "type": "function",
                "name": "browser_snapshot",
                "description": "Capture the page",
                "parameters": {"type": "object", "properties": {}}
            }]
        }]
    });

    let (converted, _) = responses_to_anthropic(&input).expect("request should convert");

    assert_eq!(converted["tools"].as_array().unwrap().len(), 1);
    assert_eq!(converted["tools"][0]["name"], "browser_snapshot");
    assert_eq!(converted["tools"][0]["description"], "Capture the page");
    assert_eq!(
        converted["tools"][0]["input_schema"],
        json!({"type": "object", "properties": {}})
    );
}

#[test]
fn bridges_tool_search_and_history_for_anthropic_messages() {
    let input = json!({
        "model": "third-party-anthropic-model",
        "input": [
            {"role": "user", "content": "Find the GitHub App"},
            {
                "type": "tool_search_call",
                "call_id": "search_1",
                "execution": "client",
                "arguments": {"query": "GitHub"}
            },
            {
                "type": "tool_search_output",
                "call_id": "search_1",
                "execution": "client",
                "status": "completed",
                "tools": [{
                    "type": "namespace",
                    "name": "github",
                    "tools": [{
                        "type": "function",
                        "name": "create_issue",
                        "description": "Create an issue",
                        "parameters": {
                            "type": "object",
                            "properties": {"title": {"type": "string"}}
                        }
                    }]
                }]
            }
        ],
        "tools": [{
            "type": "tool_search",
            "execution": "client",
            "description": "Search available Apps",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"]
            }
        }]
    });

    let (converted, _) = responses_to_anthropic(&input).expect("request should convert");

    assert_eq!(
        converted["tools"][0]["name"],
        super::chat::BRIDGED_TOOL_SEARCH_NAME
    );
    assert_eq!(converted["tools"][1]["name"], "create_issue");
    assert_eq!(
        converted["tools"][0]["input_schema"]["required"],
        json!(["query"])
    );
    assert_eq!(converted["messages"][1]["role"], "assistant");
    assert_eq!(converted["messages"][1]["content"][0]["type"], "tool_use");
    assert_eq!(
        converted["messages"][1]["content"][0]["name"],
        super::chat::BRIDGED_TOOL_SEARCH_NAME
    );
    assert_eq!(
        converted["messages"][1]["content"][0]["input"],
        json!({"query": "GitHub"})
    );
    assert_eq!(converted["messages"][2]["role"], "user");
    assert_eq!(
        converted["messages"][2]["content"][0]["type"],
        "tool_result"
    );
    assert!(converted["messages"][2]["content"][0]["content"]
        .as_str()
        .is_some_and(|value| value.contains("\"tools\"")));
}

#[test]
fn preserves_friendly_apply_patch_failure_guidance() {
    let input = json!({
        "model": "kimi-for-coding",
        "input": [
            {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
            {"type": "custom_tool_call_output", "call_id": "call_1", "output": "apply_patch verification failed: Invalid Add File Line: raw text"}
        ],
        "tools": [{"type": "custom", "name": "apply_patch"}]
    });

    let (converted, _) = responses_to_anthropic(&input).expect("request should convert");
    let output = converted["messages"][1]["content"][0]["content"]
        .as_str()
        .expect("tool result should contain text");

    assert!(output.contains("every file-content line must start with `+`"));
    assert!(output.contains("Correct new-file example:"));
    assert!(output.contains("call `apply_patch` again"));
}

#[test]
fn converts_anthropic_cached_usage_to_full_chat_prompt_usage() {
    let response = json!({
        "id": "msg_1",
        "model": "kimi-for-coding",
        "content": [{"type": "text", "text": "Done"}],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 10,
            "cache_read_input_tokens": 90,
            "cache_creation_input_tokens": 20,
            "output_tokens": 7
        }
    });

    let converted = anthropic_response_to_chat(&response);

    assert_eq!(converted["usage"]["prompt_tokens"], json!(120));
    assert_eq!(
        converted["usage"]["prompt_tokens_details"]["cached_tokens"],
        json!(90)
    );
    assert_eq!(converted["usage"]["completion_tokens"], json!(7));
}

#[tokio::test]
async fn converts_anthropic_text_and_tool_stream() {
    let events = [
        json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{
            "input_tokens":10,
            "cache_read_input_tokens":90,
            "cache_creation_input_tokens":20
        }}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool_1","name":"apply_patch","input":{}}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"input\":\"patch\"}"}}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}),
    ];
    let source = futures_util::stream::iter(
        events
            .into_iter()
            .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
    );
    let output = anthropic_sse_to_responses(source, {
        let input = json!({"tools": [{"type": "custom", "name": "apply_patch"}]});
        chat::responses_to_chat_for_anthropic(&input)
            .expect("context should build")
            .1
    })
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .map(Result::unwrap)
    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    .collect::<String>();
    assert!(output.contains("response.reasoning_summary_text.delta"));
    assert!(output.contains("response.output_text.delta"));
    assert!(output.contains("response.custom_tool_call_input.done"));
    assert!(output.contains("\"input_tokens\":120"));
    assert!(output.contains("\"cached_tokens\":90"));
}

#[tokio::test]
async fn preserves_utf8_text_split_across_upstream_chunks() {
    let events = [
        json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{"input_tokens":1}}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"实现成本主要在 UI。"}}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
    ];
    let payload = events
        .into_iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>()
        .into_bytes();
    let target = "在".as_bytes();
    let target_offset = payload
        .windows(target.len())
        .position(|window| window == target)
        .expect("payload should contain the target character");
    let chunks = vec![
        payload[..target_offset + 1].to_vec(),
        payload[target_offset + 1..target_offset + 2].to_vec(),
        payload[target_offset + 2..].to_vec(),
    ];
    let source = futures_util::stream::iter(
        chunks
            .into_iter()
            .map(|chunk| Ok::<_, std::io::Error>(Bytes::from(chunk))),
    );

    let output = anthropic_sse_to_responses(source, ToolContext::default())
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8(bytes.to_vec()).expect("converted stream should be UTF-8"))
        .collect::<String>();

    assert!(output.contains("实现成本主要在 UI。"));
    assert!(!output.contains('\u{fffd}'));
}

#[tokio::test]
async fn fails_when_anthropic_reports_tokens_without_output() {
    let events = [
        json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-k2.5","usage":{"input_tokens":1}}}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":157}}),
        json!({"type":"message_stop"}),
    ];
    let source = futures_util::stream::iter(
        events
            .into_iter()
            .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
    );

    let output = anthropic_sse_to_responses(source, ToolContext::default())
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<String>();

    assert!(output.contains("response.failed"));
    assert!(output.contains("reported output tokens without returning content"));
    assert!(!output.contains("response.completed"));
}

#[tokio::test]
async fn completes_zero_token_anthropic_response_without_output() {
    let events = [
        json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-k2.5","usage":{"input_tokens":1}}}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}),
        json!({"type":"message_stop"}),
    ];
    let source = futures_util::stream::iter(
        events
            .into_iter()
            .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
    );

    let output = anthropic_sse_to_responses(source, ToolContext::default())
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<String>();

    assert!(output.contains("response.completed"));
    assert!(!output.contains("response.failed"));
}

#[tokio::test]
async fn restores_namespace_on_anthropic_tool_calls() {
    let events = [
        json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{"input_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"browser_snapshot","input":{}}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}),
    ];
    let source = futures_util::stream::iter(
        events
            .into_iter()
            .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
    );
    let input = json!({
        "tools": [{
            "type": "namespace",
            "name": "wework_browser",
            "tools": [{
                "type": "function",
                "name": "browser_snapshot",
                "parameters": {"type": "object"}
            }]
        }]
    });
    let context = chat::responses_to_chat_for_anthropic(&input)
        .expect("context should build")
        .1;
    let output = anthropic_sse_to_responses(source, context)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<String>();

    assert!(output.contains("\"name\":\"browser_snapshot\""));
    assert!(output.contains("\"namespace\":\"wework_browser\""));
}

#[test]
fn maps_anthropic_tool_stop_reason_to_tool_calls() {
    assert_eq!(anthropic_finish_reason("tool_use"), "tool_calls");
    assert_eq!(anthropic_finish_reason("max_tokens"), "length");
    assert_eq!(anthropic_finish_reason("end_turn"), "stop");
}

#[tokio::test]
async fn normalizes_anthropic_apply_patch_alias_and_fence() {
    let events = [
        json!({"type":"message_start","message":{"id":"msg_1","model":"kimi-for-coding","usage":{"input_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"apply_patch","input":{}}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"content\":\"```patch\\n*** Update File: a.txt\\n@@\\n-old\\n+new\\n```\"}"}}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}),
    ];
    let source = futures_util::stream::iter(
        events
            .into_iter()
            .map(|event| Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")))),
    );
    let output = anthropic_sse_to_responses(source, {
        let input = json!({"tools": [{"type": "custom", "name": "apply_patch"}]});
        chat::responses_to_chat_for_anthropic(&input)
            .expect("context")
            .1
    })
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .map(Result::unwrap)
    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    .collect::<String>();

    assert!(output.contains("*** Begin Patch\\n*** Update File: a.txt"));
    assert!(output.contains("+new\\n*** End Patch"));
    assert!(!output.contains("```patch"));
}
