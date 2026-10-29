use super::*;
use futures_util::TryStreamExt;

#[test]
fn messages_and_responses_are_peer_adapters_over_ir() {
    let source = serde_json::to_vec(&json!({
            "model": "claude-test",
            "max_tokens": 1024,
            "system": "Be useful",
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "call-1", "name": "shell", "input": {"command": "pwd"}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "ok"}]}
            ],
            "tools": [{"name": "shell", "description": "Run shell", "input_schema": {"type": "object"}}]
        }))
        .unwrap();
    let responses: Value = serde_json::from_slice(
        &adapt_messages_request(&source, "openai-responses", Some("gpt-test")).unwrap(),
    )
    .unwrap();
    let chat: Value = serde_json::from_slice(
        &adapt_messages_request(&source, "openai-chat-completions", Some("chat-test")).unwrap(),
    )
    .unwrap();
    let messages: Value = serde_json::from_slice(
        &adapt_messages_request(&source, "anthropic-messages", Some("claude-upstream")).unwrap(),
    )
    .unwrap();

    assert_eq!(responses["model"], "gpt-test");
    assert_eq!(responses["input"][1]["type"], "function_call");
    assert!(responses.get("temperature").is_none());
    assert!(responses.get("tool_choice").is_none());
    assert_eq!(chat["model"], "chat-test");
    assert_eq!(chat["messages"][3]["role"], "tool");
    assert!(chat.get("temperature").is_none());
    assert!(chat.get("tool_choice").is_none());
    assert_eq!(messages["model"], "claude-upstream");
    assert_eq!(messages["messages"][1]["content"][0]["type"], "tool_use");
}

#[test]
fn native_messages_adapter_preserves_unknown_capability_fields() {
    let source = serde_json::to_vec(&json!({
        "model": "harness-alias",
        "max_tokens": 2048,
        "thinking": {"type": "enabled", "budget_tokens": 1024},
        "messages": [{
            "role": "user",
            "content": [{
                "type": "text",
                "text": "hello",
                "cache_control": {"type": "ephemeral"}
            }]
        }]
    }))
    .unwrap();

    let messages: Value = serde_json::from_slice(
        &adapt_messages_request(&source, "anthropic-messages", Some("claude-upstream")).unwrap(),
    )
    .unwrap();

    assert_eq!(messages["model"], "claude-upstream");
    assert_eq!(messages["stream"], true);
    assert_eq!(messages["thinking"]["budget_tokens"], 1024);
    assert_eq!(
        messages["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
}

#[test]
fn adapters_strip_long_context_model_suffixes() {
    let source = serde_json::to_vec(&json!({
        "model": "deepseek-v4.1-flash[1m]",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": "hello"}]
    }))
    .unwrap();

    for upstream_format in [
        "anthropic-messages",
        "openai-chat-completions",
        "openai-responses",
    ] {
        let adapted: Value = serde_json::from_slice(
            &adapt_messages_request(&source, upstream_format, None).unwrap(),
        )
        .unwrap();

        assert_eq!(adapted["model"], "deepseek-v4.1-flash");
    }

    let routed: Value = serde_json::from_slice(
        &adapt_messages_request(&source, "anthropic-messages", Some("routed-model[1M]")).unwrap(),
    )
    .unwrap();
    assert_eq!(routed["model"], "routed-model");
}

fn responses_input_shape(source: &[u8]) -> Vec<(String, Option<String>)> {
    let responses: Value = serde_json::from_slice(
        &adapt_messages_request(source, "openai-responses", Some("gpt-test")).unwrap(),
    )
    .unwrap();
    responses["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                item.get("role").and_then(Value::as_str).map(str::to_owned),
            )
        })
        .collect()
}

#[test]
fn keeps_tool_calls_adjacent_to_their_outputs() {
    let source = serde_json::to_vec(&json!({
        "model": "harness-alias",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "build the dashboard"},
            {"role": "assistant", "content": [
                {"type": "text", "text": "I'll start by inspecting the data."},
                {"type": "tool_use", "id": "call-1", "name": "shell", "input": {"command": "pwd"}},
                {"type": "tool_use", "id": "call-2", "name": "shell", "input": {"command": "ls"}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call-1", "content": "workspace"},
                {"type": "tool_result", "tool_use_id": "call-2", "content": "files"}
            ]}
        ],
        "tools": [{"name": "shell", "description": "Run shell", "input_schema": {"type": "object"}}]
    }))
    .unwrap();

    assert_eq!(
        responses_input_shape(&source),
        vec![
            ("message".to_owned(), Some("user".to_owned())),
            ("message".to_owned(), Some("assistant".to_owned())),
            ("function_call".to_owned(), None),
            ("function_call".to_owned(), None),
            ("function_call_output".to_owned(), None),
            ("function_call_output".to_owned(), None),
        ]
    );
}

#[test]
fn keeps_tool_calls_adjacent_when_the_assistant_turn_also_has_thinking() {
    let source = serde_json::to_vec(&json!({
        "model": "harness-alias",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "build the dashboard"},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "The data needs inspecting first."},
                {"type": "tool_use", "id": "call-1", "name": "shell", "input": {"command": "pwd"}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call-1", "content": "workspace"}
            ]}
        ],
        "tools": [{"name": "shell", "description": "Run shell", "input_schema": {"type": "object"}}]
    }))
    .unwrap();

    assert_eq!(
        responses_input_shape(&source),
        vec![
            ("message".to_owned(), Some("user".to_owned())),
            ("message".to_owned(), Some("assistant".to_owned())),
            ("function_call".to_owned(), None),
            ("function_call_output".to_owned(), None),
        ]
    );
}

#[test]
fn closes_unresolved_tool_uses_for_responses_and_chat_adapters() {
    let source = serde_json::to_vec(&json!({
            "model": "claude-test",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": "inspect the machine"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call-ok", "name": "shell", "input": {"command": "uptime"}},
                    {"type": "tool_use", "id": "call-denied", "name": "shell", "input": {"command": "top -l 1 -n 0"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-ok", "content": "up 14 days"},
                    {"type": "text", "text": "continue"}
                ]}
            ],
            "tools": [{"name": "shell", "description": "Run shell", "input_schema": {"type": "object"}}]
        }))
        .unwrap();

    let responses: Value = serde_json::from_slice(
        &adapt_messages_request(&source, "openai-responses", Some("gpt-test")).unwrap(),
    )
    .unwrap();
    let chat: Value = serde_json::from_slice(
        &adapt_messages_request(&source, "openai-chat-completions", Some("chat-test")).unwrap(),
    )
    .unwrap();

    let responses_result = responses["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| {
            item.get("type").and_then(Value::as_str) == Some("function_call_output")
                && item.get("call_id").and_then(Value::as_str) == Some("call-denied")
        })
        .expect("synthetic Responses tool result");
    assert_eq!(
        responses_result["output"],
        "Tool execution failed before producing a result."
    );

    let chat_result = chat["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| {
            message.get("role").and_then(Value::as_str) == Some("tool")
                && message.get("tool_call_id").and_then(Value::as_str) == Some("call-denied")
        })
        .expect("synthetic chat tool result");
    assert_eq!(
        chat_result["content"],
        "Tool execution failed before producing a result."
    );
}

#[test]
fn preserves_split_parallel_tool_results_that_arrive_out_of_order() {
    let source = serde_json::to_vec(&json!({
            "model": "claude-test",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": "inspect the repository"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call-00", "name": "shell", "input": {"command": "pwd"}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call-01", "name": "shell", "input": {"command": "git status"}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call-02", "name": "shell", "input": {"command": "git log -1"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-00", "content": "workspace"}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-02", "content": "latest commit"}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call-01", "content": "clean"}
                ]}
            ],
            "tools": [{"name": "shell", "description": "Run shell", "input_schema": {"type": "object"}}]
        }))
        .unwrap();

    let responses: Value = serde_json::from_slice(
        &adapt_messages_request(&source, "openai-responses", Some("gpt-test")).unwrap(),
    )
    .unwrap();
    let input = responses["input"].as_array().unwrap();

    for call_id in ["call-00", "call-01", "call-02"] {
        let outputs = input
            .iter()
            .filter(|item| {
                item.get("type").and_then(Value::as_str) == Some("function_call_output")
                    && item.get("call_id").and_then(Value::as_str) == Some(call_id)
            })
            .count();
        assert_eq!(outputs, 1, "{call_id} should have exactly one output");
    }
    assert!(!input.iter().any(|item| {
        item.get("output").and_then(Value::as_str)
            == Some("Tool execution failed before producing a result.")
    }));
}

#[tokio::test]
async fn chat_stream_adapter_emits_tool_use_messages_sse() {
    let source = stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\"}}]}}]}\n\n",
            )),
            Ok(Bytes::from(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"pwd\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"completion_tokens\":3}}\n\n",
            )),
        ]);
    let output = adapt_upstream_sse("openai-chat-completions".to_owned(), source)
        .try_collect::<Vec<_>>()
        .await
        .unwrap()
        .concat();
    let text = String::from_utf8(output).unwrap();

    assert!(text.contains("\"name\":\"shell\""));
    assert!(text.contains("\"partial_json\""));
    assert!(text.contains("command"));
    assert!(text.contains("pwd"));
    assert!(text.contains("\"stop_reason\":\"tool_use\""));
    assert!(text.contains("event: message_stop"));
}

#[tokio::test]
async fn responses_stream_adapter_emits_messages_sse() {
    let source = stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from(
                "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"hello\"}\n\n",
            )),
            Ok(Bytes::from(
                "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"output_tokens\":1}}}\n\n",
            )),
        ]);
    let output = adapt_upstream_sse("openai-responses".to_owned(), source)
        .try_collect::<Vec<_>>()
        .await
        .unwrap()
        .concat();
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("\"text\":\"hello\""));
    assert!(text.contains("event: message_stop"));
}
