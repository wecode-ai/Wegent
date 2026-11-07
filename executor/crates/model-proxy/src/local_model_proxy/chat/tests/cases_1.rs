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
fn moves_tool_output_images_to_a_multimodal_user_message() {
    let input = json!({
        "model": "kimi-k3",
        "input": [
            {"type": "function_call", "call_id": "image_1", "name": "view_image", "arguments": "{}"},
            {"type": "function_call", "call_id": "text_1", "name": "exec_command", "arguments": "{}"},
            {
                "type": "function_call_output",
                "call_id": "image_1",
                "output": [{
                    "type": "input_image",
                    "image_url": "data:image/png;base64,aGVsbG8="
                }]
            },
            {"type": "function_call_output", "call_id": "text_1", "output": "done"}
        ],
        "tools": [
            {"type": "function", "name": "view_image", "parameters": {"type": "object"}},
            {"type": "function", "name": "exec_command", "parameters": {"type": "object"}}
        ]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let messages = converted["messages"].as_array().expect("messages");

    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0]["role"], "assistant");
    assert_eq!(messages[1]["role"], "tool");
    assert_eq!(messages[1]["tool_call_id"], "image_1");
    assert_eq!(
        messages[1]["content"],
        "[Image output attached in the following user message.]"
    );
    assert_eq!(messages[2]["role"], "tool");
    assert_eq!(messages[2]["tool_call_id"], "text_1");
    assert_eq!(messages[2]["content"], "done");
    assert_eq!(messages[3]["role"], "user");
    assert_eq!(
        messages[3]["content"][0]["text"],
        "Image output from tool view_image:"
    );
    assert_eq!(messages[3]["content"][1]["type"], "image_url");
    assert_eq!(
        messages[3]["content"][1]["image_url"]["url"],
        "data:image/png;base64,aGVsbG8="
    );
    assert!(!messages[1]["content"]
        .as_str()
        .is_some_and(|content| content.contains("aGVsbG8=")));
}

#[test]
fn converts_user_input_images_to_chat_image_parts() {
    let input = json!({
        "model": "kimi-k3",
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": "Describe this image"},
                {
                    "type": "input_image",
                    "image_url": "data:image/png;base64,dXNlci1pbWFnZQ=="
                }
            ]
        }]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");

    assert_eq!(converted["messages"][0]["content"][0]["type"], "text");
    assert_eq!(converted["messages"][0]["content"][1]["type"], "image_url");
    assert_eq!(
        converted["messages"][0]["content"][1]["image_url"]["url"],
        "data:image/png;base64,dXNlci1pbWFnZQ=="
    );
}

#[test]
fn preserves_tool_text_and_structured_content_while_extracting_images() {
    let mixed = split_tool_output(&json!([
        {"type": "text", "text": "Rendered preview"},
        {"type": "input_image", "image_url": "data:image/png;base64,bWl4ZWQ="}
    ]));
    assert_eq!(mixed.text, "Rendered preview");
    assert_eq!(mixed.images.len(), 1);

    let structured = split_tool_output(&json!({
        "content": [
            {"type": "text", "text": "Human-readable fallback"},
            {"type": "input_image", "image_url": "data:image/jpeg;base64,cHJldmlldw=="}
        ],
        "structuredContent": {
            "width": 1280,
            "business_value": {
                "type": "input_image",
                "image_url": "data:image/png;base64,bm90LWEtYmxvY2s="
            }
        }
    }));
    assert_eq!(
        serde_json::from_str::<Value>(&structured.text).unwrap(),
        json!({
            "width": 1280,
            "business_value": {
                "type": "input_image",
                "image_url": "data:image/png;base64,bm90LWEtYmxvY2s="
            }
        })
    );
    assert_eq!(structured.images.len(), 1);
    assert_eq!(
        structured.images[0]["image_url"],
        "data:image/jpeg;base64,cHJldmlldw=="
    );

    let malformed = split_tool_output(&json!([{"type": "input_image"}]));
    assert_eq!(malformed.text, "{\"type\":\"input_image\"}");
    assert!(malformed.images.is_empty());
}

#[test]
fn keeps_assistant_text_and_tool_calls_in_one_chat_message() {
    let input = json!({
        "model": "kimi-for-coding",
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "Inspect it"}]},
            {"role": "assistant", "content": [{"type": "output_text", "text": "I will inspect it."}]},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Need the logs"}]},
            {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
            {"type": "function_call_output", "call_id": "call_1", "output": "/workspace"}
        ],
        "tools": [{
            "type": "function",
            "name": "exec_command",
            "parameters": {"type": "object"}
        }]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let messages = converted["messages"].as_array().expect("messages");

    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "I will inspect it.");
    assert_eq!(messages[1]["reasoning_content"], "Need the logs");
    assert_eq!(
        messages[1]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert_eq!(messages[2]["role"], "tool");
    assert!(!messages
        .windows(2)
        .any(|pair| pair[0]["role"] == "assistant" && pair[1]["role"] == "assistant"));
}

#[test]
fn flattens_namespace_tools_and_namespaced_history_for_chat() {
    let input = json!({
        "model": "kimi-for-coding",
        "input": [
            {
                "type": "function_call",
                "call_id": "call_1",
                "name": "browser_snapshot",
                "namespace": "wework_browser",
                "arguments": "{}"
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "snapshot"
            }
        ],
        "tools": [{
            "type": "namespace",
            "name": "wework_browser",
            "description": "Wework built-in browser tools",
            "tools": [{
                "type": "function",
                "name": "browser_snapshot",
                "description": "Capture the page",
                "parameters": {"type": "object", "properties": {}}
            }]
        }],
        "tool_choice": {
            "type": "function",
            "name": "browser_snapshot",
            "namespace": "wework_browser"
        }
    });

    let (converted, context) = responses_to_chat(&input).expect("request should convert");

    assert_eq!(converted["tools"].as_array().unwrap().len(), 1);
    assert_eq!(
        converted["tools"][0]["function"]["name"],
        "wework_browser__browser_snapshot"
    );
    assert_eq!(
        converted["messages"][0]["tool_calls"][0]["function"]["name"],
        "wework_browser__browser_snapshot"
    );
    assert_eq!(
        converted["tool_choice"]["function"]["name"],
        "wework_browser__browser_snapshot"
    );
    assert_eq!(
        context.identity("wework_browser__browser_snapshot"),
        Some(&ToolIdentity {
            name: "browser_snapshot".to_owned(),
            namespace: Some("wework_browser".to_owned()),
            kind: ToolKind::Function,
        })
    );
}

#[test]
fn bridges_tool_search_and_history_for_chat_completions() {
    let input = json!({
        "model": "third-party-chat-model",
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

    let (converted, _) = responses_to_chat(&input).expect("request should convert");

    assert_eq!(converted["tools"][0]["type"], "function");
    assert_eq!(
        converted["tools"][0]["function"]["name"],
        BRIDGED_TOOL_SEARCH_NAME
    );
    assert_eq!(
        converted["tools"][1]["function"]["name"],
        "github__create_issue"
    );
    assert_eq!(
        converted["messages"][1]["tool_calls"][0]["function"]["name"],
        BRIDGED_TOOL_SEARCH_NAME
    );
    assert_eq!(
        converted["messages"][1]["tool_calls"][0]["function"]["arguments"],
        "{\"query\":\"GitHub\"}"
    );
    assert_eq!(converted["messages"][2]["role"], "tool");
    assert!(converted["messages"][2]["content"]
        .as_str()
        .is_some_and(|value| value.contains("\"tools\"")));
}

#[test]
fn preserves_structured_app_tool_results_for_chat_completions() {
    let input = json!({
        "model": "third-party-chat-model",
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

    let (converted, _) = responses_to_chat(&input).expect("request should convert");

    assert_eq!(
        converted["messages"][1]["content"],
        "{\"id\":\"prj_1\",\"title\":\"Palette\"}"
    );
}

#[test]
fn maps_kimi_reasoning_to_thinking_toggle() {
    let input = json!({
        "model": "moonshot-kimi-k3",
        "reasoning": {"effort": "low"},
        "input": "hello"
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");

    assert_eq!(converted["thinking"], json!({"type": "enabled"}));
    assert!(converted.get("reasoning_effort").is_none());
}

#[test]
fn matches_only_model_names_containing_kimi_k3() {
    assert!(is_kimi_k3_model("moonshot-kimi-k3"));
    assert!(is_kimi_k3_model("vendor/MOONSHOT-KIMI-K3-turbo"));
    assert!(!is_kimi_k3_model("moonshot-v1-128k"));
    assert!(!is_kimi_k3_model("moonshotai/kimi-k2.5"));
}

#[test]
fn preserves_reasoning_effort_for_non_kimi_chat_models() {
    let input = json!({
        "model": "gpt-compatible-model",
        "reasoning": {"effort": "none"},
        "input": "hello"
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");

    assert_eq!(converted["reasoning_effort"], "none");
    assert!(converted.get("thinking").is_none());
}

#[test]
fn keeps_kimi_reasoning_on_each_assistant_turn() {
    let input = json!({
        "model": "kimi-k3",
        "input": [
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "first thought"}]},
            {"type": "message", "role": "assistant", "content": "First answer."},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "second thought"}]},
            {"type": "message", "role": "assistant", "content": "Second answer."},
            {"type": "message", "role": "user", "content": "Continue"}
        ]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let messages = converted["messages"].as_array().expect("messages");

    assert_eq!(messages[0]["reasoning_content"], "first thought");
    assert_eq!(messages[1]["reasoning_content"], "second thought");
    assert!(messages[2].get("reasoning_content").is_none());
}

#[test]
fn appends_trailing_kimi_reasoning_before_user_boundary() {
    let input = json!({
        "model": "kimi-k3",
        "input": [
            {
                "type": "message",
                "role": "assistant",
                "reasoning_content": "Embedded thought.",
                "content": "Done."
            },
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Trailing thought."}]},
            {"type": "message", "role": "user", "content": "Continue"}
        ]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let messages = converted["messages"].as_array().expect("messages");

    assert_eq!(
        messages[0]["reasoning_content"],
        "Embedded thought.\n\nTrailing thought."
    );
    assert!(messages[1].get("reasoning_content").is_none());
}

#[test]
fn does_not_move_reasoning_across_a_user_boundary() {
    let input = json!({
        "model": "kimi-k3",
        "input": [
            {"type": "message", "role": "assistant", "content": "Done."},
            {"type": "message", "role": "user", "content": "Continue"},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "New thought."}]},
            {"type": "message", "role": "user", "content": "Changed direction"}
        ]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let messages = converted["messages"].as_array().expect("messages");

    assert!(messages[0].get("reasoning_content").is_none());
    assert!(messages[1].get("reasoning_content").is_none());
    assert!(messages[2].get("reasoning_content").is_none());
}

#[test]
fn backfills_kimi_tool_call_reasoning_and_normalizes_parameters() {
    let input = json!({
        "model": "kimi-k3",
        "input": [{
            "type": "function_call",
            "call_id": "call_1",
            "name": "read_file",
            "arguments": "{}"
        }],
        "tools": [{
            "type": "function",
            "name": "read_file",
            "parameters": {"type": null, "properties": {}}
        }]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");

    assert_eq!(converted["messages"][0]["reasoning_content"], "tool call");
    assert_eq!(
        converted["tools"][0]["function"]["parameters"]["type"],
        "object"
    );
}

#[test]
fn normalizes_typed_any_of_schemas_for_kimi_k3() {
    let input = json!({
        "model": "kimi-k3",
        "tools": [{
            "type": "namespace",
            "name": "wegent_apps",
            "tools": [{
                "type": "function",
                "name": "wegent_sites__update_site_metadata",
                "parameters": typed_any_of_parameters()
            }]
        }]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let parameters = &converted["tools"][0]["function"]["parameters"];

    assert_eq!(parameters["type"], "object");
    assert!(parameters.get("anyOf").is_none());
    assert!(parameters["properties"]["metadata"].get("type").is_none());
    assert!(parameters["allOf"][0]["anyOf"]
        .as_array()
        .expect("root anyOf")
        .iter()
        .all(|branch| branch["type"] == "object"));
    assert!(parameters["properties"]["metadata"]["anyOf"]
        .as_array()
        .expect("nested anyOf")
        .iter()
        .all(|branch| branch["type"] == "object"));
}

#[test]
fn normalizes_untyped_root_any_of_schema_for_kimi_k3() {
    let input = json!({
        "model": "kimi-k3",
        "tools": [{
            "type": "function",
            "name": "update_site_metadata",
            "parameters": {
                "anyOf": [{"required": ["title"]}]
            }
        }]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let parameters = &converted["tools"][0]["function"]["parameters"];

    assert_eq!(parameters["type"], "object");
    assert!(parameters.get("anyOf").is_none());
    assert_eq!(parameters["allOf"][0]["anyOf"][0]["type"], "object");
}

#[test]
fn preserves_existing_root_all_of_when_nesting_any_of_for_kimi_k3() {
    let existing_constraint = json!({
        "type": "object",
        "required": ["project_id"]
    });
    let input = json!({
        "model": "kimi-k3",
        "tools": [{
            "type": "function",
            "name": "update_site_metadata",
            "parameters": {
                "type": "object",
                "allOf": [existing_constraint.clone()],
                "anyOf": [{"required": ["title"]}]
            }
        }]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let parameters = &converted["tools"][0]["function"]["parameters"];
    let all_of = parameters["allOf"].as_array().expect("root allOf");

    assert_eq!(parameters["type"], "object");
    assert_eq!(all_of.len(), 2);
    assert_eq!(all_of[0], existing_constraint);
    assert_eq!(all_of[1]["anyOf"][0]["type"], "object");
}

#[test]
fn preserves_typed_any_of_schema_for_non_kimi_chat_models() {
    let input = json!({
        "model": "gpt-compatible-model",
        "tools": [{
            "type": "function",
            "name": "update_site_metadata",
            "parameters": typed_any_of_parameters()
        }]
    });

    let (converted, _) = responses_to_chat(&input).expect("request should convert");
    let parameters = &converted["tools"][0]["function"]["parameters"];

    assert_eq!(parameters["type"], "object");
    assert_eq!(parameters["properties"]["metadata"]["type"], "object");
}

#[test]
fn disambiguates_colliding_namespace_tool_names() {
    let input = json!({
        "tools": [
            {
                "type": "namespace",
                "name": "calendar",
                "tools": [{
                    "type": "function",
                    "name": "search",
                    "parameters": {"type": "object"}
                }]
            },
            {
                "type": "namespace",
                "name": "mail",
                "tools": [{
                    "type": "function",
                    "name": "search",
                    "parameters": {"type": "object"}
                }]
            }
        ]
    });

    let (converted, context) = responses_to_chat(&input).expect("request should convert");
    let names = converted["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
        .collect::<Vec<_>>();

    assert_eq!(names, vec!["calendar__search", "mail__search"]);
    assert_eq!(
        context
            .identity("calendar__search")
            .and_then(|tool| tool.namespace.as_deref()),
        Some("calendar")
    );
    assert_eq!(
        context
            .identity("mail__search")
            .and_then(|tool| tool.namespace.as_deref()),
        Some("mail")
    );
}

#[test]
fn keeps_legacy_anthropic_names_for_colliding_tools() {
    let input = json!({
        "tools": [
            {
                "type": "namespace",
                "name": "calendar",
                "tools": [{"type": "function", "name": "search"}]
            },
            {
                "type": "namespace",
                "name": "mail",
                "tools": [{"type": "function", "name": "search"}]
            },
            {"type": "function", "name": "search"}
        ]
    });

    let (converted, _) = responses_to_chat_for_anthropic(&input).expect("request should convert");
    let names = converted["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
        .collect::<Vec<_>>();

    assert_eq!(
        names,
        vec!["calendar__search", "mail__search", "functions__search"]
    );
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

#[test]
fn leaves_successful_apply_patch_output_unchanged() {
    assert_eq!(friendly_apply_patch_output("Done!"), "Done!");
}

#[test]
fn converts_chat_usage_to_responses_usage() {
    assert_eq!(
        responses_usage(Some(&json!({
            "prompt_tokens": 12,
            "completion_tokens": 7,
            "prompt_tokens_details": {"cached_tokens": 3},
            "completion_tokens_details": {"reasoning_tokens": 4}
        }))),
        json!({
            "input_tokens": 12,
            "input_tokens_details": {"cached_tokens": 3},
            "output_tokens": 7,
            "output_tokens_details": {"reasoning_tokens": 4},
            "total_tokens": 19
        })
    );
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

#[tokio::test]
async fn normalizes_provider_tool_call_ids_in_responses_streams() {
    let chunks = vec![Ok::<_, std::io::Error>(Bytes::from(concat!(
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"tool_calls\":[{",
        "\"index\":0,\"id\":\"functions.exec_command:0\",\"function\":{",
        "\"name\":\"exec_command\",\"arguments\":\"{\"}}]},",
        "\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"tool_calls\":[{",
        "\"index\":0,\"id\":\"functions.exec_command:0\",\"function\":{",
        "\"name\":\"exec_command\",\"arguments\":\"}\"}}]},",
        "\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    )))];

    let output = chat_sse_to_responses(futures_util::stream::iter(chunks), ToolContext::default())
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<String>();
    let call_id = crate::local_model_proxy::normalized_responses_api_id("functions.exec_command:0");
    let item_id = format!("fc_{}", call_id.trim_start_matches("call_"));

    assert!(output.contains(&format!("\"call_id\":\"{call_id}\"")));
    assert!(output.contains(&format!("\"id\":\"{item_id}\"")));
    assert!(!output.contains("functions.exec_command:0"));
}

#[tokio::test]
async fn normalizes_wrapped_apply_patch_function_arguments() {
    let chunks = vec![Ok::<_, std::io::Error>(Bytes::from(
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"apply_patch\",\"arguments\":\"{\\\"patch\\\":\\\"```diff\\\\n*** Update File: a.txt\\\\n@@\\\\n-old\\\\n+new\\\\n```\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
    ))];
    let mut context = ToolContext::default();
    context.insert("apply_patch".to_owned(), ToolKind::Custom);

    let output = chat_sse_to_responses(futures_util::stream::iter(chunks), context)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(Result::unwrap)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .collect::<String>();

    assert!(output.contains("*** Begin Patch\\n*** Update File: a.txt"));
    assert!(output.contains("+new\\n*** End Patch"));
    assert!(!output.contains("```diff"));
}

#[test]
fn leaves_truncated_apply_patch_incomplete() {
    assert_eq!(
        normalize_apply_patch_input("prefix *** Begin Patch\n*** Update File: a.txt\n@@"),
        "*** Begin Patch\n*** Update File: a.txt\n@@"
    );
}

#[tokio::test]
async fn converts_legacy_function_call() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"function_call\":{\"name\":\"read_file\",\"arguments\":\"{}\"}},\"finish_reason\":\"function_call\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("\"type\":\"function_call\""));
    assert!(output.contains("\"name\":\"read_file\""));
}

#[tokio::test]
async fn converts_complete_message_tool_calls_without_delta() {
    let output = convert_stream(
        concat!(
            "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        ),
        ToolContext::default(),
    )
    .await;
    assert!(output.contains("\"call_id\":\"call_1\""));
    assert!(output.contains("\"name\":\"read_file\""));
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
