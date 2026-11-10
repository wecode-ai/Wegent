use super::*;
use crate::local_model_proxy::chat::responses_events::format_sse_event;

fn request() -> Value {
    json!({
        "tools": [
            {"type":"function","name":"exec","parameters":{"type":"object"}},
            {"type":"namespace","name":"functions","description":"Code Mode tools",
                "tools":[{"type":"custom","name":"exec","format":{"type":"text"}}]}
        ],
        "input":[
            {"type":"custom_tool_call","namespace":"functions","name":"exec",
                "call_id":"call_1","input":"text('中文')"},
            {"type":"custom_tool_call_output","call_id":"call_1","output":"中文"}
        ],
        "tool_choice":{"type":"custom","namespace":"functions","name":"exec"}
    })
}

#[tokio::test]
async fn custom_namespace_conversion_preserves_declarations_history_choices_and_streams() {
    for (convert_custom, native_namespace) in [(true, true), (true, false), (false, false)] {
        let original = request();
        let (converted, context) =
            responses_to_responses(&original, convert_custom, true, native_namespace).unwrap();
        let tool = if native_namespace {
            assert_eq!(converted["tools"][1]["description"], "Code Mode tools");
            &converted["tools"][1]["tools"][0]
        } else {
            &converted["tools"][1]
        };
        let wire_name = if native_namespace {
            "exec"
        } else {
            "functions__exec"
        };
        assert_eq!(converted["tools"][0], original["tools"][0]);
        assert_eq!(tool["type"], "function");
        assert_eq!(tool["name"], wire_name);
        assert_eq!(tool["parameters"]["required"], json!(["input"]));
        assert!(tool.get("format").is_none());
        assert_eq!(converted["input"][0]["type"], "function_call");
        assert_eq!(converted["input"][0]["name"], wire_name);
        assert_eq!(
            converted["input"][0]["arguments"],
            r#"{"input":"text('中文')"}"#
        );
        assert_eq!(converted["input"][1]["type"], "function_call_output");
        assert_eq!(converted["tool_choice"]["type"], "function");
        assert_eq!(converted["tool_choice"]["name"], wire_name);
        for item in [&converted["input"][0], &converted["tool_choice"]] {
            if native_namespace {
                assert_eq!(item["namespace"], "functions");
            } else {
                assert!(item.get("namespace").is_none());
            }
        }

        let mut item = json!({"type":"function_call","id":"fc_1","call_id":"call_2",
            "name":wire_name,"arguments":r#"{"input":"text(42)"}"#});
        if native_namespace {
            item["namespace"] = json!("functions");
        }
        let events = [
            json!({"type":"response.output_item.added","output_index":0,"item":item}),
            json!({"type":"response.function_call_arguments.done","output_index":0,
                "item_id":"fc_1","arguments":item["arguments"]}),
            json!({"type":"response.output_item.done","output_index":0,"item":item}),
            json!({"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[item]}}),
        ].iter().map(|event| format_sse_event(event["type"].as_str().unwrap(), event)).collect::<String>();
        let output = convert_responses_stream(&events, context).await;
        let events: Vec<Value> = output
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str(data).ok())
            .collect();
        assert!(events.iter().any(
            |event| event["type"] == "response.custom_tool_call_input.done"
                && event["input"] == "text(42)"
        ));
        let restored = &events
            .iter()
            .find(|event| event["type"] == "response.completed")
            .expect("completed response")["response"]["output"][0];
        assert_eq!(restored["type"], "custom_tool_call");
        assert_eq!(restored["name"], "exec");
        assert_eq!(restored["namespace"], "functions");
        assert_eq!(restored["input"], "text(42)");
        assert!(restored.get("arguments").is_none());
    }
}

#[test]
fn native_custom_namespace_without_conversion_is_unchanged() {
    let original = request();
    let (converted, context) = responses_to_responses(&original, false, true, true).unwrap();
    assert_eq!(converted, original);
    assert!(context.is_empty());
}
