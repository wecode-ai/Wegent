use super::*;

#[test]
fn converts_responses_request_with_history_and_custom_tool() {
    let input = json!({
        "model": "kimi-for-coding",
        "instructions": "You are a coding agent.",
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "Edit it"}]},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Need patch"}]},
            {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
            {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
        ],
        "tools": [{"type": "custom", "name": "apply_patch", "description": "Patch files"}],
        "stream": true
    });

    let (converted, context) = responses_to_chat(&input).expect("request should convert");
    assert!(context.is_custom("apply_patch"));
    assert!(converted["tools"][0]["function"]["description"]
        .as_str()
        .is_some_and(|value| value.contains("Original tool definition:")));
    let description = converted["tools"][0]["function"]["description"]
        .as_str()
        .expect("custom tool description");
    assert!(description.starts_with("Critical apply_patch input contract:"));
    assert!(description.contains("exactly `*** Begin Patch\\n`"));
    assert!(description.contains("with no blank line"));
    assert!(description.contains("Do not include Markdown code fences"));
    assert!(description.contains("every added-file content line must start with `+`"));
    assert!(description.contains("*** Add File: hello.txt\n+first line\n+\n+third line"));
    assert!(description.contains("*** Update File: hello.txt\n@@\n-old line\n+new line"));
    assert_eq!(
        converted["tools"][0]["function"]["parameters"]["properties"]["input"]["description"],
        CUSTOM_TOOL_INPUT_DESCRIPTION
    );
    assert_eq!(converted["messages"][0]["role"], "system");
    assert_eq!(
        converted["messages"][2]["tool_calls"][0]["function"]["name"],
        "apply_patch"
    );
    assert_eq!(converted["messages"][2]["reasoning_content"], "Need patch");
    assert_eq!(converted["messages"][3]["role"], "tool");
    assert_eq!(converted["stream_options"]["include_usage"], true);
}

#[test]
fn explains_apply_patch_hunk_failures_and_requests_a_retry() {
    let input = json!({
        "model": "kimi-for-coding",
        "input": [
            {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
            {"type": "custom_tool_call_output", "call_id": "call_1", "output": "apply_patch verification failed: invalid hunk at line 3"}
        ],
        "tools": [{"type": "custom", "name": "apply_patch"}]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let output = converted["messages"][1]["content"]
        .as_str()
        .expect("tool output should be text");

    assert!(output.starts_with("apply_patch verification failed: invalid hunk at line 3"));
    assert!(output.contains("prefix unchanged lines with one space"));
    assert!(output.contains("Correct update example:"));
    assert!(output.contains("Fix the reported error and call `apply_patch` again"));
    assert!(output.contains("Do not switch to shell redirection"));
}

#[tokio::test]
async fn converts_streaming_reasoning_text_and_custom_tool() {
    let chunks: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from(concat!(
        "data: {\"id\":\"chatcmpl-1\",\"model\":\"kimi-for-coding\",\"created\":1,",
        "\"choices\":[{\"delta\":{\"reasoning_content\":\"plan\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"patch\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
        "data: [DONE]\n\n"
    )))];
    let mut context = ToolContext::default();
    context.insert("apply_patch".to_owned(), ToolKind::Custom);

    let output = chat_sse_to_responses(futures_util::stream::iter(chunks), context)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|item| String::from_utf8(item.expect("stream should convert").to_vec()).unwrap())
        .collect::<String>();

    assert!(output.contains("response.reasoning_summary_text.delta"));
    assert!(output.contains("response.output_text.delta"));
    assert!(output.contains("response.custom_tool_call_input.delta"));
    assert!(output.contains("\"input\":\"patch\""));
    assert!(output.contains("response.completed"));
    assert!(output.contains("\"input_tokens\":10"));
}

#[test]
fn leaves_truncated_apply_patch_incomplete() {
    assert_eq!(
        normalize_apply_patch_input("prefix *** Begin Patch\n*** Update File: a.txt\n@@"),
        "*** Begin Patch\n*** Update File: a.txt\n@@"
    );
}

#[tokio::test]
async fn restores_namespace_on_chat_tool_calls() {
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
    let context = responses_to_chat(&input).expect("context should build").1;
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"wework_browser__browser_snapshot\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        context,
    )
    .await;

    assert!(output.contains("\"name\":\"browser_snapshot\""));
    assert!(output.contains("\"namespace\":\"wework_browser\""));
}

#[tokio::test]
async fn restores_tool_search_on_chat_tool_calls() {
    let input = json!({
        "tools": [{
            "type": "tool_search",
            "execution": "client",
            "parameters": {"type": "object"}
        }]
    });
    let context = responses_to_chat(&input).expect("context should build").1;
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"search_1\",\"function\":{\"name\":\"search_deferred_tools\",\"arguments\":\"{\\\"query\\\":\\\"GitHub\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        context,
    )
    .await;

    assert!(output.contains("\"type\":\"tool_search_call\""), "{output}");
    assert!(
        output.contains("\"arguments\":{\"query\":\"GitHub\"}"),
        "{output}"
    );
    assert!(output.contains("\"execution\":\"client\""), "{output}");
    assert!(!output.contains("\"name\":\"tool_search\""), "{output}");
}

#[tokio::test]
async fn reports_truncated_stream_as_failed() {
    let output = convert_stream(
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}",
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.failed"));
    assert!(!output.contains("response.completed"));
}
