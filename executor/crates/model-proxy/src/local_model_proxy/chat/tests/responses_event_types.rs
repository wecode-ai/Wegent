use super::*;

fn sse(events: &[Value], event_header: Option<&str>) -> String {
    events
        .iter()
        .map(|event| {
            let header = event_header
                .map(|name| format!("event: {name}\n"))
                .unwrap_or_default();
            format!("{header}data: {event}\n\n")
        })
        .collect()
}

fn event_values(output: &str) -> Vec<Value> {
    crate::local_model_proxy::responses_event_values(output)
}

#[tokio::test]
async fn responses_bridge_restores_code_mode_exec_from_data_event_types() {
    let script = "text('中文')\ntext(42)";
    let arguments = json!({"input": script}).to_string();
    let request = json!({"tools":[{"type":"custom","name":"exec","format":{"type":"text"}}]});
    for event_header in [None, Some("message"), Some("response.output_text.delta")] {
        let (converted, context) = responses_to_responses(&request, true, false, false).unwrap();
        assert_eq!(converted["tools"][0]["type"], "function");
        let item = json!({"id":"fc_exec","type":"function_call","call_id":"call_exec",
            "name":"exec","arguments":arguments});
        let events = [
            json!({"type":"response.output_item.added","output_index":0,
                "item":{"id":"fc_exec","type":"function_call","call_id":"call_exec",
                    "name":"exec","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_exec",
                "output_index":0,"delta":arguments}),
            json!({"type":"response.function_call_arguments.done","item_id":"fc_exec",
                "output_index":0,"arguments":arguments}),
            json!({"type":"response.output_item.done","output_index":0,"item":item}),
            json!({"type":"response.completed",
                "response":{"id":"resp_exec","status":"completed","output":[item]}}),
        ];
        let input = sse(&events, event_header);
        // Split even inside UTF-8 characters and SSE fields, as a transport may do.
        let chunks = input
            .as_bytes()
            .chunks(7)
            .map(|chunk| Ok::<_, std::io::Error>(Bytes::copy_from_slice(chunk)));
        let output = responses_sse_to_responses(
            futures_util::stream::iter(chunks.collect::<Vec<_>>()),
            context,
        )
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|chunk| String::from_utf8(chunk.unwrap().to_vec()).unwrap())
        .collect::<String>();
        let values = event_values(&output);
        for phase in ["response.output_item.added", "response.output_item.done"] {
            let call = &values.iter().find(|event| event["type"] == phase).unwrap()["item"];
            assert_eq!(call["type"], "custom_tool_call", "header={event_header:?}");
            assert_eq!(call["name"], "exec");
            assert_eq!(call["call_id"], "call_exec");
            assert!(call.get("arguments").is_none());
            if phase == "response.output_item.done" {
                assert_eq!(call["input"], script);
            }
        }
        let done = values
            .iter()
            .find(|event| event["type"] == "response.custom_tool_call_input.done")
            .unwrap();
        assert_eq!(done["input"], script);
        assert!(!values
            .iter()
            .any(|event| event["type"] == "response.function_call_arguments.delta"));
        let completed = values
            .iter()
            .find(|event| event["type"] == "response.completed")
            .unwrap();
        assert_eq!(
            completed["response"]["output"][0]["type"],
            "custom_tool_call"
        );
        assert_eq!(completed["response"]["output"][0]["input"], script);
    }
}

#[tokio::test]
async fn responses_bridge_restores_search_and_namespace_calls_without_event_headers() {
    let request = json!({"tools":[
        {"type":"tool_search","execution":"client"},
        {"type":"namespace","name":"files","tools":[
            {"type":"function","name":"read","parameters":{"type":"object"}}
        ]}
    ]});
    let (converted, context) = responses_to_responses(&request, true, false, false).unwrap();
    let search = json!({"id":"fc_search","type":"function_call","call_id":"call_search",
        "name":converted["tools"][0]["name"],"arguments":r#"{"query":"files"}"#});
    let read = json!({"id":"fc_read","type":"function_call","call_id":"call_read",
        "name":converted["tools"][1]["name"],"arguments":r#"{"path":"README.md"}"#});
    let events = [
        json!({"type":"response.output_item.done","output_index":0,"item":search}),
        json!({"type":"response.output_item.done","output_index":1,"item":read}),
        json!({"type":"response.completed",
            "response":{"id":"resp_tools","status":"completed","output":[search,read]}}),
    ];
    let output = convert_responses_stream(&sse(&events, None), context).await;
    let values = event_values(&output);
    for items in [
        vec![values[0]["item"].clone(), values[1]["item"].clone()],
        values[2]["response"]["output"].as_array().unwrap().clone(),
    ] {
        assert_eq!(items[0]["type"], "tool_search_call");
        assert_eq!(items[0]["execution"], "client");
        assert_eq!(items[0]["arguments"], json!({"query":"files"}));
        assert_eq!(items[1]["type"], "function_call");
        assert_eq!(items[1]["namespace"], "files");
        assert_eq!(items[1]["name"], "read");
        assert_eq!(items[1]["arguments"], r#"{"path":"README.md"}"#);
    }
}
