use super::*;
use futures_util::TryStreamExt;

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

mod cases_1;
