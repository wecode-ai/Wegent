// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `openapi.streaming_response`'s SSE framing
//! (`app/services/openapi/streaming.py:OpenAPIStreamingService.
//! create_streaming_response` + `app/api/endpoints/openapi_responses.py`).
//!
//! The stream opens with `response.created` and `response.in_progress`, each
//! carrying the `ResponseObject` with `status="in_progress"` and a
//! `sequence_number` from 0. The recorded create cases reach the chat-shell
//! upstream only after those two events, so their body is exactly:
//!
//! ```text
//! data: {"response": {…}, "sequence_number": 0, "type": "response.created"}\n\n
//! data: {"response": {…}, "sequence_number": 1, "type": "response.in_progress"}\n\n
//! ```
//!
//! `_format_sse_event` renders `json.dumps(data, ensure_ascii=False)` with the
//! default `", "` / `": "` separators, so this reuses the Rust port of that
//! renderer.
use brz_http_server::Bytes;
use serde_json::Value;

use crate::json_compat::python_json_value_no_ascii;

use super::dispatch::ExecutionRequest;
use super::response_object::ResponseObject;

/// `_format_sse_event`: `data: <json>\n\n`.
pub fn format_sse_event(data: &Value) -> String {
    format!("data: {}\n\n", python_json_value_no_ascii(data))
}

/// The two framing events (`response.created`, `response.in_progress`) for the
/// streaming create response.
pub fn framing_events(
    task_id: i64,
    created_at: i64,
    model: &str,
    previous_response_id: Option<String>,
) -> Vec<Bytes> {
    let response = ResponseObject::in_progress(task_id, created_at, model, previous_response_id);
    let response = serde_json::to_value(&response).expect("the response object serializes");
    let mut events = Vec::with_capacity(2);
    for (sequence_number, event_type) in
        [(0_i64, "response.created"), (1_i64, "response.in_progress")]
    {
        let mut event = serde_json::Map::new();
        event.insert("response".into(), response.clone());
        event.insert(
            "sequence_number".into(),
            Value::Number(sequence_number.into()),
        );
        event.insert("type".into(), Value::String(event_type.to_string()));
        events.push(Bytes::from(format_sse_event(&Value::Object(event))));
    }
    events
}

/// Whether the request's `bot[0].shell_type` routes to the SSE (chat-shell)
/// target. Mirrors `ExecutionDispatcher.supports_streaming`'s shell read.
pub fn request_shell_type(request: &ExecutionRequest) -> String {
    request
        .bot
        .as_array()
        .and_then(|bots| bots.first())
        .and_then(|bot| bot.get("shell_type"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "Chat".to_string())
}

/// `Starlette`'s `text/event-stream` media type as rendered on the wire.
pub const SSE_CONTENT_TYPE: &str = "text/event-stream; charset=utf-8";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_events_match_the_recorded_body() {
        let events = framing_events(
            388_814_799_879_330,
            1_791_613_529,
            "default#live-topic-generator-poc-v9",
            None,
        );
        let first = String::from_utf8(events[0].to_vec()).unwrap();
        assert!(first.starts_with("data: {\"response\": {\"id\": \"resp_388814799879330\""));
        assert!(first.contains("\"status\": \"in_progress\""));
        assert!(first.ends_with("\"sequence_number\": 0, \"type\": \"response.created\"}\n\n"));
        let second = String::from_utf8(events[1].to_vec()).unwrap();
        assert!(
            second.ends_with("\"sequence_number\": 1, \"type\": \"response.in_progress\"}\n\n")
        );
    }

    #[test]
    fn a_follow_up_keeps_the_previous_response_id_and_literal_unicode() {
        let events = framing_events(
            893_078_319_851_631,
            1_791_613_309,
            "tqt-weather#千问天气通#ali-qwen3.7-plus(公网)",
            Some("resp_893078319851631".to_string()),
        );
        let first = String::from_utf8(events[0].to_vec()).unwrap();
        // `ensure_ascii=False` keeps the Chinese literal.
        assert!(first.contains("千问天气通"));
        assert!(first.contains("\"previous_response_id\": \"resp_893078319851631\""));
    }
}
