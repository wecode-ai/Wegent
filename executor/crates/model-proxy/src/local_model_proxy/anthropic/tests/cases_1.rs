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
