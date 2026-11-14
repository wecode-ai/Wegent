use super::*;

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

#[test]
fn preserves_each_parallel_tool_completion_order() {
    let ids = [
        "call_00_wework_parallel",
        "call_01_wework_parallel",
        "call_02_wework_parallel",
    ];
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let mut messages = vec![json!({"role":"user","content":"run parallel tools"})];
        for id in ids {
            messages.push(json!({"role":"assistant","content":[{
                "type":"tool_use","id":id,"name":"Bash","input":{"command":"true"}
            }]}));
        }
        for index in order {
            messages.push(json!({"role":"user","content":[{
                "type":"tool_result","tool_use_id":ids[index],"content":format!("done:{}", ids[index])
            }]}));
        }
        let source =
            serde_json::to_vec(&json!({"model":"claude-test","messages":messages})).unwrap();
        let response: Value = serde_json::from_slice(
            &adapt_messages_request(&source, "openai-responses", Some("gpt-test")).unwrap(),
        )
        .unwrap();
        let outputs: Vec<_> = response["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .collect();
        let actual: Vec<_> = outputs
            .iter()
            .map(|item| item["call_id"].as_str().unwrap())
            .collect();
        let expected = order.map(|index| ids[index]);
        eprintln!("parallel tool completion raw={expected:?} forwarded={actual:?}");
        assert_eq!(actual, expected);
        for output in outputs {
            assert_eq!(
                output["output"],
                format!("done:{}", output["call_id"].as_str().unwrap())
            );
        }
    }
}
