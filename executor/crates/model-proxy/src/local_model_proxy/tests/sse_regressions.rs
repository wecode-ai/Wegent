use super::*;

fn multiline_frame(event: &Value, ending: &str) -> String {
    let data = serde_json::to_string_pretty(event)
        .unwrap()
        .lines()
        .map(|line| format!("data: {line}{ending}"))
        .collect::<String>();
    format!("{data}{ending}")
}

fn parsed_events(output: &str) -> Vec<Value> {
    output
        .replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|block| {
            let data = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|line| line.strip_prefix(' ').unwrap_or(line))
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                return None;
            }
            Some(
                serde_json::from_str(&data)
                    .expect("each rewritten SSE event must contain valid JSON"),
            )
        })
        .collect()
}

async fn branch_output(branch: &str, input: &str, chunk_size: usize) -> String {
    let chunks = input
        .as_bytes()
        .chunks(chunk_size)
        .map(|chunk| Ok::<_, std::io::Error>(Bytes::copy_from_slice(chunk)))
        .collect::<Vec<_>>();
    let stream = futures_util::stream::iter(chunks);
    let output: std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>> =
        match branch {
            "native" => Box::pin(normalize_responses_stream(stream, HashSet::new())),
            "bridge" => {
                let (_, context) = chat::responses_to_responses(
                    &json!({"tools":[{"type":"custom","name":"exec"}]}),
                    true,
                    false,
                    false,
                )
                .unwrap();
                Box::pin(chat::responses_sse_to_responses(stream, context))
            }
            "passthrough" => Box::pin(passthrough_stream::guard(stream)),
            "chat" => Box::pin(chat::chat_sse_to_responses(
                stream,
                chat::ToolContext::default(),
            )),
            "anthropic" => Box::pin(anthropic::anthropic_sse_to_responses(
                stream,
                chat::ToolContext::default(),
            )),
            _ => panic!("unknown branch"),
        };
    let bytes = output
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flat_map(|chunk| chunk.unwrap())
        .collect::<Vec<_>>();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn sse_regression_framing_consumes_the_earliest_event_with_mixed_line_endings() {
    for (first, second) in [("\n", "\r\n"), ("\r\n", "\n")] {
        let mut input = format!("data: 1{first}{first}data: 2{second}{second}");
        assert_eq!(take_sse_block(&mut input).as_deref(), Some("data: 1"));
        assert_eq!(take_sse_block(&mut input).as_deref(), Some("data: 2"));
        assert!(input.is_empty());
    }
}

#[tokio::test]
async fn sse_regression_multiline_custom_tool_rewrite_keeps_one_valid_payload() {
    let script = "text('中文')";
    let call = json!({"id":"fc_exec","type":"function_call","call_id":"call_exec",
        "name":"exec","arguments":json!({"input":script}).to_string()});
    let input = [
        json!({"type":"response.output_item.done","item":call}),
        json!({"type":"response.completed","response":{"status":"completed","output":[call]}}),
    ]
    .iter()
    .map(|event| multiline_frame(event, "\n"))
    .collect::<String>();
    let output = branch_output("bridge", &input, 7).await;
    let events = parsed_events(&output);
    assert_eq!(events[0]["item"]["type"], "custom_tool_call");
    assert_eq!(events[0]["item"]["input"], script);
    assert_eq!(events[1]["response"]["output"][0], events[0]["item"]);
}

#[test]
fn sse_regression_terminal_detection_uses_json_type() {
    for terminal in [
        "response.completed",
        "response.failed",
        "response.incomplete",
    ] {
        assert!(!is_responses_terminal_event(&format!(
            "event: {terminal}\ndata: {{\"type\":\"response.output_text.delta\",\"delta\":\"continue\"}}")));
        assert!(!is_responses_terminal_event(&format!(
            "event: {terminal}\ndata: invalid"
        )));
        assert!(is_responses_terminal_event(&format!(
            "event: message\ndata: {{\"type\":\"{terminal}\"}}"
        )));
    }
}

#[tokio::test]
async fn sse_regression_false_terminal_headers_do_not_drop_later_chunks() {
    let first = "event: response.completed\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"continue\"}\n\n";
    let last =
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n";
    for branch in ["native", "bridge"] {
        let output = branch_output(branch, &format!("{first}{last}"), first.len()).await;
        assert!(
            parsed_events(&output)
                .iter()
                .any(|event| event["type"] == "response.completed"),
            "{branch}"
        );
    }
    let output = branch_output("passthrough", first, first.len()).await;
    assert!(output.starts_with(first));
    assert_eq!(
        parsed_events(&output).last().unwrap()["type"],
        "response.failed"
    );
}

async fn assert_branch_handles_multiline_and_mixed_framing(branch: &str) {
    let events = match branch {
        "chat" => vec![
            json!({"id":"chatcmpl_1","choices":[{"index":0,"delta":{"content":"中文"}}]}),
            json!({"id":"chatcmpl_1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        ],
        "anthropic" => vec![
            json!({"type":"message_start","message":{"id":"msg_1","model":"test","usage":{"input_tokens":1}}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"中文"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
            json!({"type":"message_stop"}),
        ],
        _ => vec![
            json!({"type":"response.output_text.delta","delta":"中文"}),
            json!({"type":"response.completed","response":{"status":"completed","output":[],
                "usage":{"input_tokens_details":{},"output_tokens_details":{}}}}),
        ],
    };
    for endings in [["\n", "\r\n"], ["\r\n", "\n"]] {
        let input = events
            .iter()
            .enumerate()
            .map(|(index, event)| multiline_frame(event, endings[index % 2]))
            .collect::<String>();
        for chunk_size in [1, input.len()] {
            let output = branch_output(branch, &input, chunk_size).await;
            let parsed = parsed_events(&output);
            assert!(
                parsed
                    .iter()
                    .any(|event| event["type"] == "response.output_text.delta"
                        && event["delta"] == "中文"),
                "{branch}: {output}"
            );
            assert_eq!(
                parsed.last().unwrap()["type"],
                "response.completed",
                "{branch}"
            );
            if branch == "native" {
                assert_eq!(
                    parsed.last().unwrap()["response"]["usage"]["input_tokens_details"]
                        ["cached_tokens"],
                    0
                );
            }
            if branch == "passthrough" {
                assert_eq!(output, input);
            }
        }
    }
}

#[tokio::test]
async fn sse_regression_native_multiline_and_mixed_framing() {
    assert_branch_handles_multiline_and_mixed_framing("native").await;
}

#[tokio::test]
async fn sse_regression_bridge_multiline_and_mixed_framing() {
    assert_branch_handles_multiline_and_mixed_framing("bridge").await;
}

#[tokio::test]
async fn sse_regression_passthrough_multiline_and_mixed_framing() {
    assert_branch_handles_multiline_and_mixed_framing("passthrough").await;
}

#[tokio::test]
async fn sse_regression_chat_multiline_and_mixed_framing() {
    assert_branch_handles_multiline_and_mixed_framing("chat").await;
}

#[tokio::test]
async fn sse_regression_anthropic_multiline_and_mixed_framing() {
    assert_branch_handles_multiline_and_mixed_framing("anthropic").await;
}

#[tokio::test]
async fn sse_regression_history_records_multiline_events_across_utf8_chunks() {
    let history = Arc::new(history::CodexToolHistory::default());
    let input = multiline_frame(
        &json!({"type":"response.completed","response":{
            "id":"resp_history","output":[{"type":"function_call","call_id":"call_history",
                "name":"read","arguments":r#"{"path":"中文"}"#}]
        }}),
        "\r\n",
    );
    let chunks = input
        .bytes()
        .map(|byte| Ok::<_, std::io::Error>(Bytes::from(vec![byte])))
        .collect::<Vec<_>>();
    let output =
        history::record_responses_stream(futures_util::stream::iter(chunks), history.clone())
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .flat_map(|chunk| chunk.unwrap())
            .collect::<Vec<_>>();
    assert_eq!(output, input.as_bytes());
    let mut request = json!({"previous_response_id":"resp_history","input":[
        {"type":"function_call_output","call_id":"call_history","output":"ok"}
    ]});
    assert_eq!(history.enrich_request(&mut request).await, 1);
    assert_eq!(request["input"][0]["arguments"], r#"{"path":"中文"}"#);
}

#[tokio::test]
async fn sse_regression_harness_preserves_utf8_and_multiline_crlf_events() {
    for (format, events) in [
        (
            "openai-responses",
            vec![
                json!({"type":"response.output_text.delta","delta":"中文"}),
                json!({"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}),
            ],
        ),
        (
            "openai-chat-completions",
            vec![
                json!({"choices":[{"delta":{"content":"中文"}}]}),
                json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
            ],
        ),
    ] {
        let input = events
            .iter()
            .map(|event| multiline_frame(event, "\r\n"))
            .collect::<String>();
        let chunks = input
            .bytes()
            .map(|byte| Ok::<_, std::io::Error>(Bytes::from(vec![byte])))
            .collect::<Vec<_>>();
        let output = harness_protocol::adapt_upstream_sse(
            format.to_owned(),
            futures_util::stream::iter(chunks),
        )
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|chunk| String::from_utf8(chunk.unwrap().to_vec()).unwrap())
        .collect::<String>();
        assert!(
            parsed_events(&output)
                .iter()
                .any(|event| event["type"] == "content_block_delta"
                    && event["delta"]["text"] == "中文"),
            "{format}: {output}"
        );
    }
}
