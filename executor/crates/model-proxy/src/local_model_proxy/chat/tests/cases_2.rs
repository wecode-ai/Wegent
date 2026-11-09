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
async fn serializes_object_arguments_from_non_streaming_compatible_chunks() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.txt\"}}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("a.txt"));
    assert!(output.contains("path"));
}

#[tokio::test]
async fn ignores_repeated_complete_tool_name_and_id() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("\"name\":\"read_file\""));
    assert!(!output.contains("read_fileread_file"));
    assert!(!output.contains("call_1call_1"));
}

#[tokio::test]
async fn accepts_done_marker_without_finish_reason_after_a_choice() {
    let output = convert_stream(
        concat!(
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.completed"));
    assert!(!output.contains("response.failed"));
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
async fn converts_upstream_error_event_to_failed_response() {
    let output = convert_stream(
        concat!(
            "data: {\"error\":{\"message\":\"rate limited\",\"type\":\"rate_limit\"}}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.failed"));
    assert!(output.contains("rate limited"));
    assert!(!output.contains("response.completed"));
}

#[tokio::test]
async fn sparse_large_tool_index_does_not_create_placeholder_calls() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":4000000000,\"id\":\"call_sparse\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("\"call_id\":\"call_sparse\""));
    assert!(!output.contains("\"call_id\":\"call_0\""));
}

#[tokio::test]
async fn ignores_empty_upstream_error_placeholders() {
    let output = convert_stream(
        concat!(
            "data: {\"error\":{},\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.completed"));
    assert!(!output.contains("response.failed"));
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
async fn uses_full_message_when_delta_is_empty() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{},\"message\":{\"role\":\"assistant\",\"content\":\"full answer\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("full answer"));
    assert!(output.contains("response.completed"));
}

#[tokio::test]
async fn uses_array_position_for_complete_calls_without_indices() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"first\",\"arguments\":\"{}\"}},{\"id\":\"call_2\",\"function\":{\"name\":\"second\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("\"call_id\":\"call_1\""));
    assert!(output.contains("\"call_id\":\"call_2\""));
    assert!(output.contains("\"name\":\"first\""));
    assert!(output.contains("\"name\":\"second\""));
}

#[tokio::test]
async fn selects_choice_zero_instead_of_the_first_choice() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"wrong\"},\"finish_reason\":\"stop\"},{\"index\":0,\"delta\":{\"content\":\"right\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("right"));
    assert!(!output.contains("wrong"));
}

#[tokio::test]
async fn preserves_content_parts_refusal_and_reasoning_details() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_details\":[{\"type\":\"reasoning.text\",\"text\":\"think\"}],\"content\":[{\"type\":\"text\",\"text\":\"visible\"}],\"refusal\":\" denied\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("think"));
    assert!(output.contains("visible denied"));
}

#[tokio::test]
async fn accepts_bom_and_indented_sse_fields() {
    let output = convert_stream(
        concat!(
            "\u{feff}  data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
            "  data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("response.completed"));
    assert!(output.contains("ok"));
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

#[test]
fn responses_to_responses_converts_custom_apply_patch_tool() {
    let input = json!({
        "model": "wework-gpt-5.6-sol",
        "instructions": "You are a coding agent.",
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "Edit it"}]},
            {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch\n*** End Patch"},
            {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
        ],
        "tools": [
            {"type": "function", "name": "exec_command", "description": "Run commands", "parameters": {"type": "object", "properties": {}}},
            {"type": "custom", "name": "apply_patch", "description": "Patch files"}
        ],
        "stream": true
    });

    let (converted, context) =
        responses_to_responses(&input, true.into(), false, false).expect("request should convert");
    assert!(context.is_custom("apply_patch"));
    assert_eq!(converted["tools"][0]["type"], "function");
    assert_eq!(converted["tools"][0]["name"], "exec_command");
    assert_eq!(converted["tools"][0]["description"], "Run commands");
    assert_eq!(converted["tools"][1]["type"], "function");
    assert_eq!(converted["tools"][1]["name"], "apply_patch");
    assert!(converted["tools"][1]["description"]
        .as_str()
        .is_some_and(
            |value| value.starts_with("Critical apply_patch input contract:")
                && !value.contains("Original tool definition:")
        ));
    assert_eq!(
        converted["tools"][1]["parameters"]["properties"]["input"]["type"],
        "string"
    );
    assert_eq!(converted["input"][1]["type"], "function_call");
    assert_eq!(
        converted["input"][1]["arguments"],
        "{\"input\":\"*** Begin Patch\\n*** End Patch\"}"
    );
    assert_eq!(converted["input"][2]["type"], "function_call_output");
}

#[test]
fn responses_to_responses_moves_tool_images_after_all_tool_results() {
    let input = json!({
        "model": "wework-gpt-5.6-sol",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_image",
                    "image_url": "data:image/png;base64,dXNlci1pbWFnZQ=="
                }]
            },
            {"type": "function_call", "call_id": "image_1", "name": "view_image", "arguments": "{}"},
            {"type": "function_call", "call_id": "text_1", "name": "exec_command", "arguments": "{}"},
            {
                "type": "function_call_output",
                "call_id": "image_1",
                "output": [{
                    "type": "input_image",
                    "image_url": "data:image/jpeg;base64,dG9vbC1pbWFnZQ=="
                }]
            },
            {"type": "function_call_output", "call_id": "text_1", "output": "done"}
        ],
        "tools": [
            {"type": "function", "name": "view_image", "parameters": {"type": "object"}},
            {"type": "function", "name": "exec_command", "parameters": {"type": "object"}}
        ]
    });

    let (converted, _) =
        responses_to_responses(&input, false.into(), true, true).expect("request should convert");
    let converted_input = converted["input"].as_array().expect("input");

    assert_eq!(converted_input.len(), 6);
    assert_eq!(
        converted_input[0]["content"][0]["image_url"],
        "data:image/png;base64,dXNlci1pbWFnZQ=="
    );
    assert_eq!(converted_input[3]["type"], "function_call_output");
    assert_eq!(converted_input[3]["output"], tool_image_output_notice());
    assert_eq!(converted_input[4]["type"], "function_call_output");
    assert_eq!(converted_input[4]["output"], "done");
    assert_eq!(converted_input[5]["role"], "user");
    assert_eq!(converted_input[5]["content"][0]["type"], "input_text");
    assert_eq!(
        converted_input[5]["content"][0]["text"],
        "Image output from tool view_image:"
    );
    assert_eq!(converted_input[5]["content"][1]["type"], "input_image");
    assert_eq!(
        converted_input[5]["content"][1]["image_url"],
        "data:image/jpeg;base64,dG9vbC1pbWFnZQ=="
    );
}

#[test]
fn responses_to_responses_bridges_tool_search_and_loaded_app_tools() {
    let input = json!({
        "model": "third-party-responses-model",
        "input": [
            {"role": "user", "content": "Create an issue"},
            {
                "type": "tool_search_call",
                "id": "tsc_bridge_1",
                "call_id": "search_1",
                "execution": "client",
                "arguments": {"query": "GitHub create issue"}
            },
            {
                "type": "tool_search_output",
                "id": "tso_bridge_1",
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
            },
            {
                "type": "function_call",
                "call_id": "call_1",
                "namespace": "github",
                "name": "create_issue",
                "arguments": "{\"title\":\"Bug\"}"
            }
        ],
        "tools": [
            {
                "type": "tool_search",
                "execution": "client",
                "description": "Search available Apps",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"]
                }
            }
        ]
    });

    let (converted, context) =
        responses_to_responses(&input, false.into(), false, false).expect("request should convert");

    assert_eq!(converted["tools"].as_array().unwrap().len(), 2);
    assert_eq!(converted["tools"][0]["type"], "function");
    assert_eq!(converted["tools"][0]["name"], BRIDGED_TOOL_SEARCH_NAME);
    assert_eq!(converted["tools"][1]["type"], "function");
    assert_eq!(converted["tools"][1]["name"], "github__create_issue");
    assert_eq!(converted["input"][1]["type"], "function_call");
    assert_eq!(converted["input"][1]["name"], BRIDGED_TOOL_SEARCH_NAME);
    assert!(converted["input"][1].get("id").is_none());
    assert_eq!(converted["input"][1]["call_id"], "search_1");
    assert_eq!(
        converted["input"][1]["arguments"],
        "{\"query\":\"GitHub create issue\"}"
    );
    assert_eq!(converted["input"][2]["type"], "function_call_output");
    assert!(converted["input"][2].get("id").is_none());
    assert_eq!(converted["input"][2]["call_id"], "search_1");
    assert!(converted["input"][2]["output"]
        .as_str()
        .is_some_and(|value| value.contains("\"tools\"")));
    assert_eq!(converted["input"][3]["name"], "github__create_issue");
    assert!(converted["input"][3].get("namespace").is_none());
    assert_eq!(
        context.identity("github__create_issue"),
        Some(&ToolIdentity {
            name: "create_issue".to_owned(),
            namespace: Some("github".to_owned()),
            kind: ToolKind::Function,
        })
    );
}

#[test]
fn responses_bridge_removes_defer_loading_without_native_tool_search() {
    let input = json!({
        "model": "third-party-responses-model",
        "tools": [{
            "type": "tool_search",
            "execution": "client",
            "parameters": {"type": "object"}
        }, {
            "type": "function",
            "name": "multi_agent_v1__spawn_agent",
            "parameters": {"type": "object"},
            "defer_loading": true
        }, {
            "type": "namespace",
            "name": "github",
            "defer_loading": true,
            "tools": [{
                "type": "function",
                "name": "create_issue",
                "parameters": {"type": "object"},
                "defer_loading": true
            }]
        }]
    });

    let (converted, _) =
        responses_to_responses(&input, false.into(), false, true).expect("request should convert");

    assert_eq!(converted["tools"][0]["type"], "function");
    assert_eq!(
        converted["tools"][0]["description"],
        TOOL_SEARCH_DESCRIPTION
    );
    assert_eq!(
        converted["tools"][0]["parameters"]["properties"]["query"]["type"],
        "string"
    );
    assert_eq!(
        converted["tools"][0]["parameters"]["properties"]["limit"]["type"],
        "integer"
    );
    assert_eq!(
        converted["tools"][0]["parameters"]["required"],
        json!(["query"])
    );
    assert_eq!(
        converted["tools"][0]["parameters"]["additionalProperties"],
        false
    );
    assert!(converted["tools"][1].get("defer_loading").is_none());
    assert!(converted["tools"][2].get("defer_loading").is_none());
    assert!(converted["tools"][2]["tools"][0]
        .get("defer_loading")
        .is_none());
}

#[test]
fn responses_to_responses_preserves_native_tool_search_and_namespaces() {
    let input = json!({
        "model": "native-responses-model",
        "input": [
            {
                "type": "tool_search_call",
                "id": "tsc_native_1",
                "call_id": "search_1",
                "execution": "client",
                "arguments": {"query": "GitHub"}
            },
            {
                "type": "tool_search_output",
                "id": "tso_native_1",
                "call_id": "search_1",
                "execution": "client",
                "status": "completed",
                "tools": [{"namespace": "github", "name": "create_issue"}]
            },
            {
                "type": "function_call",
                "call_id": "call_1",
                "namespace": "github",
                "name": "create_issue",
                "arguments": "{\"title\":\"Bug\"}"
            }
        ],
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
            },
            {
                "type": "function",
                "name": "multi_agent_v1__spawn_agent",
                "parameters": {"type": "object"},
                "defer_loading": true
            },
            {"type": "web_search_preview"}
        ],
        "tool_choice": {
            "type": "function",
            "namespace": "github",
            "name": "create_issue"
        }
    });

    let (converted, bridge_context) =
        responses_to_responses(&input, false.into(), true, true).expect("request should convert");

    assert_eq!(converted, input);
    assert!(bridge_context.is_empty());
}

#[tokio::test]
async fn native_namespaces_keep_custom_declarations_history_choice_and_stream_consistent() {
    let input = json!({
        "tools":[{"type":"namespace","name":"functions","description":"Native namespace",
            "tools":[{"type":"custom","name":"exec"},{"type":"custom","name":"apply_patch"}]}],
        "input":[{"type":"custom_tool_call","namespace":"functions","name":"exec",
            "call_id":"call-1","input":"raw tool input"},
            {"type":"custom_tool_call_output","call_id":"call-1","output":"result"}],
        "tool_choice":{"type":"custom","namespace":"functions","name":"exec"}
    });
    for policy in [CustomToolConversion::All, CustomToolConversion::ExceptApplyPatch] {
        let (converted, context) = responses_to_responses(&input, policy, true, true).unwrap();
        assert_eq!(converted["tools"][0]["type"], "namespace");
        assert_eq!(converted["tools"][0]["name"], "functions");
        assert_eq!(converted["tools"][0]["description"], "Native namespace");
        assert_eq!(converted["tools"][0]["tools"][0]["type"], "function");
        assert_eq!(converted["tools"][0]["tools"][1]["type"],
            if policy == CustomToolConversion::All { "function" } else { "custom" });
        assert_eq!(converted["input"][0]["type"], "function_call");
        assert_eq!(converted["input"][0]["namespace"], "functions");
        assert_eq!(converted["input"][0]["name"], "exec");
        assert_eq!(converted["input"][0]["arguments"], r#"{"input":"raw tool input"}"#);
        assert_eq!(converted["input"][1]["type"], "function_call_output");
        assert_eq!(converted["tool_choice"], json!({"type":"function","namespace":"functions","name":"exec"}));
        let item = json!({"id":"fc-1","type":"function_call","namespace":"functions",
            "name":"exec","call_id":"call-2","arguments":r#"{"input":"new raw input"}"#});
        let stream = [
            json!({"type":"response.output_item.added","output_index":0,"item":item}),
            json!({"type":"response.output_item.done","output_index":0,"item":item}),
            json!({"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[item]}}),
        ].iter().map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap())).collect::<String>();
        let output = convert_responses_stream(&stream, context).await;
        assert!(output.contains("\"type\":\"custom_tool_call\""), "{output}");
        assert!(output.contains("\"namespace\":\"functions\""), "{output}");
        assert!(output.contains("\"input\":\"new raw input\""), "{output}");
        assert!(!output.contains("\"type\":\"function_call\""), "{output}");
    }
    let (native, context) = responses_to_responses(&input, CustomToolConversion::None, true, true).unwrap();
    assert_eq!(native, input);
    assert!(context.is_empty());
}

#[tokio::test]
async fn normalizes_provider_ids_in_responses_streams() {
    let output = convert_responses_stream(
        concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_functions.exec_command:0\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"functions.exec_command:0\",\"name\":\"exec_command\",\"arguments\":\"\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_functions.exec_command:0\",\"output_index\":0,\"delta\":\"{}\"}\n\n",
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_functions.exec_command:0\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"functions.exec_command:0\",\"name\":\"exec_command\",\"arguments\":\"{}\"}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_functions.exec_command:0\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"functions.exec_command:0\",\"name\":\"exec_command\",\"arguments\":\"{}\"}]}}\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    let call_id = crate::local_model_proxy::normalized_responses_api_id("functions.exec_command:0");
    let item_id =
        crate::local_model_proxy::normalized_responses_api_id("fc_functions.exec_command:0");

    assert!(output.contains(&format!("\"call_id\":\"{call_id}\"")));
    assert!(output.contains(&format!("\"item_id\":\"{item_id}\"")));
    assert!(output.contains(&format!("\"id\":\"{item_id}\"")));
    assert!(!output.contains("functions.exec_command:0"));
}

#[tokio::test]
async fn responses_sse_to_responses_rewrites_function_call_for_custom_tool() {
    let mut context = ToolContext::default();
    context.insert("apply_patch".to_owned(), ToolKind::Custom);

    let output = convert_responses_stream(
        concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}\n\n",
            "event: response.function_call_arguments.done\n",
            "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}\n\n",
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}]}}\n\n"
        ),
        context,
    )
    .await;

    assert!(
        output.contains("\"type\":\"custom_tool_call\""),
        "output: {output}"
    );
    assert!(
        output.contains("\"input\":\"*** Begin Patch\\n*** End Patch\""),
        "output: {output}"
    );
    assert!(
        !output.contains("\"type\":\"function_call\""),
        "output: {output}"
    );
    assert!(
        output.contains("response.custom_tool_call_input.delta"),
        "output: {output}"
    );
    assert!(
        output.contains("response.custom_tool_call_input.done"),
        "output: {output}"
    );
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
    let (_, context) = responses_to_responses(&request, false.into(), false, false)
        .expect("request should convert");
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

#[tokio::test]
async fn responses_sse_to_responses_extracts_input_for_generic_custom_tool() {
    let mut context = ToolContext::default();
    context.insert("my_custom_tool".to_owned(), ToolKind::Custom);

    let output = convert_responses_stream(
        concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"my_custom_tool\",\"arguments\":\"\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}\n\n",
            "event: response.function_call_arguments.done\n",
            "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}\n\n",
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"my_custom_tool\",\"arguments\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}}\n\n"
        ),
        context,
    )
    .await;

    assert!(
        output.contains("\"type\":\"custom_tool_call\""),
        "output: {output}"
    );
    assert!(
        output.contains("\"input\":\"raw custom input\""),
        "output: {output}"
    );
    assert!(!output.contains("\"arguments\""), "output: {output}");
    assert!(
        output.contains("response.custom_tool_call_input.done"),
        "output: {output}"
    );
}

#[tokio::test]
async fn responses_sse_to_responses_extracts_input_from_done_item_without_delta() {
    let mut context = ToolContext::default();
    context.insert("apply_patch".to_owned(), ToolKind::Custom);

    let output = convert_responses_stream(
        concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"apply_patch\"}}\n\n",
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}]}}\n\n"
        ),
        context,
    )
    .await;

    assert!(
        output.contains("\"type\":\"custom_tool_call\""),
        "output: {output}"
    );
    assert!(
        output.contains("\"input\":\"*** Begin Patch\\n*** End Patch\""),
        "output: {output}"
    );
    assert!(
        !output.contains("\"type\":\"function_call\""),
        "output: {output}"
    );
    assert!(!output.contains("\"arguments\""), "output: {output}");
}

#[tokio::test]
async fn responses_sse_to_responses_leaves_regular_function_calls_unchanged() {
    let output = convert_responses_stream(
        concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"\"}}\n\n",
            "event: response.function_call_arguments.delta\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}\n\n",
            "event: response.function_call_arguments.done\n",
            "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[]}}\n\n"
        ),
        ToolContext::default(),
    )
    .await;

    assert!(
        output.contains("\"type\":\"function_call\""),
        "output: {output}"
    );
    assert!(
        output.contains("response.function_call_arguments.delta"),
        "output: {output}"
    );
    assert!(!output.contains("custom_tool_call"), "output: {output}");
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
    let (standard, context) = responses_to_responses(&body, true.into(), false, false).unwrap();
    assert!(context.is_custom("functions__exec"));
    assert_eq!(standard["tools"][0]["name"], "functions__exec");
    assert!(!standard["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["type"] == "additional_tools"));
    let (native, _) = responses_to_responses(&body, false.into(), true, true).unwrap();
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
