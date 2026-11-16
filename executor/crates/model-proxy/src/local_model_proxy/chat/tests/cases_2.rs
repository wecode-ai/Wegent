use super::*;

#[tokio::test]
async fn reports_max_token_finish_as_incomplete() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"still thinking\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;

    assert!(output.contains("response.incomplete"));
    assert!(output.contains("\"status\":\"incomplete\""));
    assert!(output.contains("\"reason\":\"max_output_tokens\""));
    assert!(!output.contains("response.completed"));
}

#[tokio::test]
async fn restores_parallel_fragmented_tool_calls() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}},{\"index\":3,\"id\":\"call_2\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}},{\"index\":3,\"function\":{\"arguments\":\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("\"call_id\":\"call_1\""));
    assert!(output.contains("\"call_id\":\"call_2\""));
    assert!(output.contains("a.txt"));
    assert!(output.contains("path"));
}

#[tokio::test]
async fn handles_crlf_stream_delimiters() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\r\n\r\n",
            "data: [DONE]\r\n\r\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.output_text.delta"));
    assert!(output.contains("response.completed"));
}

#[tokio::test]
async fn rejects_done_stream_without_completion_chunks() {
    let output = convert_stream(": keepalive\n\ndata: [DONE]\n\n", ToolContext::default()).await;
    assert!(output.contains("response.failed"));
    assert!(output.contains("without a completion choice"));
    assert!(!output.contains("response.completed"));
}

#[tokio::test]
async fn rejects_choiceless_usage_stream() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":0}}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.failed"));
    assert!(!output.contains("response.completed"));
}

#[tokio::test]
async fn rejects_named_error_events_without_an_error_wrapper() {
    let output = convert_stream(
        "event: error\ndata: {\"message\":\"quota exhausted\"}\n\n",
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.failed"));
    assert!(output.contains("quota exhausted"));
    assert!(!output.contains("response.completed"));
}

#[tokio::test]
async fn rejects_malformed_complete_sse_blocks() {
    let output = convert_stream(
        "data: {\"choices\":[{not-json}]}\n\n",
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.failed"));
    assert!(output.contains("Failed to parse upstream SSE chunk"));
}

#[tokio::test]
async fn ignores_a_truncated_tail_after_a_finish_reason() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":["
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.completed"));
    assert!(!output.contains("response.failed"));
}

#[tokio::test]
async fn responses_sse_to_responses_restores_tool_search_and_app_namespace() {
    let request = json!({
        "tools": [
            {
                "type": "tool_search",
                "execution": "client",
                "parameters": {"type": "object"}
            },
            {
                "type": "namespace",
                "name": "github",
                "tools": [{
                    "type": "function",
                    "name": "create_issue",
                    "parameters": {"type": "object"}
                }]
            }
        ]
    });
    let (_, context) =
        responses_to_responses(&request, false, false, false).expect("request should convert");
    let output = convert_responses_stream(
        concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_search\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"search_1\",\"name\":\"search_deferred_tools\",\"arguments\":\"\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_search\",\"output_index\":0,\"delta\":\"{\\\"query\\\":\\\"GitHub\\\"}\"}\n\n",
            "event: response.function_call_arguments.done\n",
            "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_search\",\"output_index\":0,\"arguments\":\"{\\\"query\\\":\\\"GitHub\\\"}\"}\n\n",
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_search\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"search_1\",\"name\":\"search_deferred_tools\",\"arguments\":\"{\\\"query\\\":\\\"GitHub\\\"}\"}}\n\n",
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"github__create_issue\",\"arguments\":\"\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_app\",\"output_index\":1,\"delta\":\"{\\\"title\\\":\\\"Bug\\\"}\"}\n\n",
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"github__create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_search\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"search_1\",\"name\":\"search_deferred_tools\",\"arguments\":\"{\\\"query\\\":\\\"GitHub\\\"}\"},{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"github__create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}]}}\n\n"
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
    assert!(output.contains("\"namespace\":\"github\""), "{output}");
    assert!(output.contains("\"name\":\"create_issue\""), "{output}");
    assert!(
        !output.contains("\"name\":\"github__create_issue\""),
        "{output}"
    );
}

#[test]
fn lite_namespaced_custom_exec_preserves_raw_input_in_all_adapters() {
    let script = "text('中文');\ntext(42)";
    let declaration = json!({"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec","description":"Native code execution"}]});
    let body = json!({"input":[
        {"type":"additional_tools","tools":[declaration]},
        {"type":"custom_tool_call","namespace":"functions","name":"exec","call_id":"cell-1","input":script},
        {"type":"custom_tool_call_output","call_id":"cell-1","output":"42"}
    ]});
    let (chat, context) = responses_to_chat(&body).unwrap();
    assert!(context.is_custom("functions__exec"));
    assert_eq!(
        chat["tools"][0]["function"]["parameters"]["required"],
        json!(["input"])
    );
    let arguments: Value = serde_json::from_str(
        chat["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(arguments["input"], script);
    let (standard, context) = responses_to_responses(&body, true, false, false).unwrap();
    assert!(context.is_custom("functions__exec"));
    assert_eq!(standard["tools"][0]["name"], "functions__exec");
    assert!(!standard["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["type"] == "additional_tools"));
    let (native, _) = responses_to_responses(&body, false, true, true).unwrap();
    assert_eq!(native["input"], body["input"]);
    assert!(native.get("tools").is_none());
    let (anthropic, _) =
        crate::local_model_proxy::anthropic::responses_to_anthropic(&body).unwrap();
    assert_eq!(
        anthropic["tools"][0]["input_schema"]["required"],
        json!(["input"])
    );
    assert!(anthropic["messages"].to_string().contains("中文"));
}
