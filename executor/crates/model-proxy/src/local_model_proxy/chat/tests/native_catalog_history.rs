use super::*;

const SCRIPT: &str = "text('preserved native result')";

fn saved_native_history() -> Value {
    json!({
        "tools": [{"type":"function","name":"exec","parameters":{
            "type":"object","properties":{"input":{"type":"string"}},"required":["input"]
        }}],
        "input": [
            {"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec"}
            ]}]},
            {"type":"custom_tool_call","namespace":"functions","name":"exec","call_id":"old-cell","input":SCRIPT},
            {"type":"custom_tool_call_output","call_id":"old-cell","output":"preserved native result"},
            {"type":"function_call","namespace":"functions","name":"wait","call_id":"old-wait","arguments":"{\"cell_id\":\"7\"}"},
            {"type":"function_call_output","call_id":"old-wait","output":"completed"},
            {"role":"user","content":"Continue the original conversation"}
        ]
    })
}

#[test]
fn standard_current_tools_remove_native_catalog_history_without_losing_calls() {
    let body = saved_native_history();
    let (standard, _) = responses_to_responses(&body, true, false, false).unwrap();
    let input = standard["input"].as_array().unwrap();
    assert!(!input.iter().any(|item| item["type"] == "additional_tools"));
    assert_eq!(standard["tools"], body["tools"]);
    let call = input
        .iter()
        .find(|item| item["type"] == "function_call")
        .unwrap();
    let arguments: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(arguments["input"], SCRIPT);
    assert_eq!(call["call_id"], "old-cell");
    assert_eq!(call["name"], "functions__exec");
    assert!(call.get("namespace").is_none());
    let wait = input
        .iter()
        .find(|item| item["call_id"] == "old-wait")
        .unwrap();
    assert_eq!(wait["name"], "functions__wait");
    assert_eq!(wait["arguments"], "{\"cell_id\":\"7\"}");
    assert!(wait.get("namespace").is_none());
    assert!(input
        .iter()
        .any(|item| item["type"] == "function_call_output"
            && item["call_id"] == "old-cell"
            && item["output"] == "preserved native result"));
    assert_eq!(
        input.last().unwrap(),
        body["input"].as_array().unwrap().last().unwrap()
    );
    assert_eq!(body["input"][0]["type"], "additional_tools");
    let (native, _) = responses_to_responses(&body, false, true, true).unwrap();
    assert_eq!(native["input"], body["input"]);
}

#[test]
fn chat_and_anthropic_keep_old_calls_without_advertising_old_tools() {
    let body = saved_native_history();
    let (chat, _) = responses_to_chat(&body).unwrap();
    assert_eq!(chat["tools"].as_array().unwrap().len(), 1);
    assert_eq!(chat["tools"][0]["function"]["name"], "exec");
    let chat_call = chat["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
        .find(|call| call["id"] == "old-cell")
        .unwrap();
    let arguments: Value =
        serde_json::from_str(chat_call["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(arguments["input"], SCRIPT);
    let (anthropic, _) =
        crate::local_model_proxy::anthropic::responses_to_anthropic(&body).unwrap();
    assert_eq!(anthropic["tools"].as_array().unwrap().len(), 1);
    assert_eq!(anthropic["tools"][0]["name"], "exec");
    let use_block = anthropic["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|block| block["type"] == "tool_use" && block["id"] == "old-cell")
        .unwrap();
    assert_eq!(use_block["input"]["input"], SCRIPT);
}

#[test]
fn standard_empty_current_catalog_does_not_restore_historical_tools() {
    let body = json!({"tools":[],"input":[
        {"type":"additional_tools","tools":[{"type":"custom","name":"revoked"}]},
        {"role":"user","content":"Continue"}
    ]});
    let (standard, _) = responses_to_responses(&body, true, false, false).unwrap();
    assert_eq!(standard["tools"], json!([]));
    assert_eq!(
        standard["input"],
        json!([{"role":"user","content":"Continue"}])
    );
}
