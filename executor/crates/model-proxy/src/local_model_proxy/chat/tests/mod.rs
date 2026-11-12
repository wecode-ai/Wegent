use super::*;
use futures_util::StreamExt;

fn typed_any_of_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "project_id": {"type": "string"},
            "title": {"type": "string"},
            "metadata": {
                "type": "object",
                "anyOf": [
                    {"type": "object", "required": ["label"]},
                    {"required": ["description"]}
                ]
            }
        },
        "required": ["project_id"],
        "anyOf": [
            {"type": "object", "required": ["title"]},
            {"type": "object", "required": ["metadata"]}
        ],
        "additionalProperties": false
    })
}

async fn convert_stream(input: &str, context: ToolContext) -> String {
    chat_sse_to_responses(
        futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(input.to_owned()))]),
        context,
    )
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .map(|item| String::from_utf8_lossy(&item.expect("stream item")).into_owned())
    .collect()
}

async fn convert_responses_stream(input: &str, context: ToolContext) -> String {
    responses_sse_to_responses(
        futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(input.to_owned()))]),
        context,
    )
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .map(|item| String::from_utf8_lossy(&item.expect("stream item")).into_owned())
    .collect()
}

mod cases_1;

mod cases_2;

mod custom_namespaces;

mod responses_event_types;

mod native_catalog_history;
