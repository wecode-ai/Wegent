// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bound outbound image context without changing the stored Codex conversation.

use serde_json::{json, Value};

use crate::logging::log_executor_event;

const MAX_REQUEST_IMAGES: usize = 50;
const MAX_INITIAL_USER_IMAGES: usize = 3;
const OMITTED_IMAGE_NOTICE: &str =
    "[Earlier image omitted to fit the request image limit. Reopen it if needed.]";

struct RequestImage<'a> {
    content: &'a mut Value,
    preserve: bool,
}

pub(super) fn limit_request_images(request: &mut Value) -> usize {
    let images = request_images(request);
    let image_count = images.len();
    let omitted = image_count.saturating_sub(MAX_REQUEST_IMAGES);
    if omitted == 0 {
        return 0;
    }
    let preserved = images.iter().filter(|image| image.preserve).count();
    let mut recent_slots = MAX_REQUEST_IMAGES - preserved;
    // Reserve initial references, then fill the remaining slots from newest to oldest.
    for image in images.into_iter().rev() {
        if image.preserve {
            continue;
        }
        if recent_slots > 0 {
            recent_slots -= 1;
        } else {
            *image.content = json!({"type": "input_text", "text": OMITTED_IMAGE_NOTICE});
        }
    }
    log_executor_event(
        "local model proxy image budget applied",
        &[
            ("image_count", image_count.to_string()),
            ("retained_images", MAX_REQUEST_IMAGES.to_string()),
            ("preserved_user_images", preserved.to_string()),
            ("omitted_images", omitted.to_string()),
        ],
    );
    omitted
}

fn request_images(request: &mut Value) -> Vec<RequestImage<'_>> {
    let Some(input) = request.get_mut("input") else {
        return Vec::new();
    };
    let items = match input {
        Value::Array(items) => items.as_mut_slice(),
        Value::Object(_) => std::slice::from_mut(input),
        _ => return Vec::new(),
    };
    let mut images = Vec::new();
    let mut initial_user_slots = MAX_INITIAL_USER_IMAGES;
    for item in items {
        let is_user_message = item.get("role").and_then(Value::as_str) == Some("user")
            && matches!(
                item.get("type").and_then(Value::as_str),
                Some("message") | None
            );
        if let Some(parts) = image_content(item) {
            for part in parts {
                if part.get("type").and_then(Value::as_str) != Some("input_image") {
                    continue;
                }
                let preserve = is_user_message && initial_user_slots > 0;
                if preserve {
                    initial_user_slots -= 1;
                }
                images.push(RequestImage {
                    content: part,
                    preserve,
                });
            }
        }
    }
    images
}

fn image_content(item: &mut Value) -> Option<&mut Vec<Value>> {
    match item.get("type").and_then(Value::as_str) {
        Some("function_call_output" | "custom_tool_call_output") => {
            let output = item.get_mut("output")?;
            if output.is_array() {
                output.as_array_mut()
            } else {
                output.get_mut("content")?.as_array_mut()
            }
        }
        Some("message") | None => item.get_mut("content")?.as_array_mut(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Bytes},
        http::{header, HeaderMap, HeaderValue, StatusCode},
        response::IntoResponse,
        routing::post,
        Json, Router,
    };

    fn images(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| {
                json!({
                    "type": "input_image",
                    "image_url": format!("https://example.com/{index}.png"),
                    "detail": "original"
                })
            })
            .collect()
    }

    #[test]
    fn enforces_image_count_boundaries_and_preserves_initial_and_recent_images() {
        for count in [0, 1, 49, 50, 51, 120] {
            let mut request = json!({"input": [{"role": "user", "content": images(count)}]});
            let original = request.clone();
            let omitted = count.saturating_sub(MAX_REQUEST_IMAGES);

            assert_eq!(limit_request_images(&mut request), omitted);

            for index in 0..count {
                let part = &request["input"][0]["content"][index];
                if index >= 3 && index < omitted + 3 {
                    assert_eq!(
                        part,
                        &json!({"type": "input_text", "text": OMITTED_IMAGE_NOTICE})
                    );
                } else {
                    assert_eq!(part, &original["input"][0]["content"][index]);
                }
            }
            if omitted == 0 {
                assert_eq!(request, original);
            }
            let limited = request.clone();
            assert_eq!(limit_request_images(&mut request), 0);
            assert_eq!(request, limited);
        }
    }

    #[test]
    fn shares_budget_across_messages_and_tool_results_without_removing_turns() {
        let mut request = json!({
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "Inspect these images"},
                    {"type": "input_image", "file_id": "file-old"}
                ]},
                {"type": "function_call", "call_id": "call-1", "name": "view_image", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "call-1", "output": images(2)},
                {"type": "custom_tool_call", "call_id": "call-2", "name": "inspect", "input": "inspect"},
                {"type": "custom_tool_call_output", "call_id": "call-2", "output": {"content": images(49)}},
                {"role": "user", "content": [
                    {"type": "input_image", "file_id": "file-new", "detail": "high"},
                    {"type": "input_text", "text": "Continue"}
                ]}
            ]
        });
        let mut expected = request.clone();
        let notice = json!({"type": "input_text", "text": OMITTED_IMAGE_NOTICE});
        expected["input"][2]["output"][0] = notice.clone();
        expected["input"][2]["output"][1] = notice.clone();
        expected["input"][4]["output"]["content"][0] = notice;

        assert_eq!(limit_request_images(&mut request), 3);
        assert_eq!(request, expected);
    }

    #[test]
    fn uses_all_remaining_slots_for_recent_tool_images() {
        for user_count in 0..=3 {
            let mut request = json!({"input": [
                {"role": "user", "content": images(user_count)},
                {"type": "function_call_output", "call_id": "call-1", "output": images(60)}
            ]});
            let original = request.clone();
            assert_eq!(limit_request_images(&mut request), 10 + user_count);
            assert_eq!(request["input"][0], original["input"][0]);
            for index in 0..60 {
                if index < 10 + user_count {
                    assert_eq!(
                        request["input"][1]["output"][index]["text"],
                        OMITTED_IMAGE_NOTICE
                    );
                } else {
                    assert_eq!(
                        request["input"][1]["output"][index],
                        original["input"][1]["output"][index]
                    );
                }
            }
        }
    }

    #[test]
    fn preserves_only_three_initial_user_images_across_messages() {
        let mut input = (0..4).map(|index| json!({
            "role": "user", "content": [{"type": "input_image", "file_id": format!("file-{index}")}]
        })).collect::<Vec<_>>();
        input.push(
            json!({"type": "custom_tool_call_output", "call_id": "call-1", "output": images(50)}),
        );
        let mut request = json!({"input": input});
        let mut expected = request.clone();
        let notice = json!({"type": "input_text", "text": OMITTED_IMAGE_NOTICE});
        expected["input"][3]["content"][0] = notice.clone();
        for index in 0..3 {
            expected["input"][4]["output"][index] = notice.clone();
        }

        assert_eq!(limit_request_images(&mut request), 4);
        assert_eq!(request, expected);
    }

    #[test]
    fn ignores_text_tool_definitions_and_structured_business_data() {
        let business_data = json!({"content": images(60)});
        let mut request = json!({
            "input": [
                {"role": "user", "content": "input_image is a type name"},
                {"type": "function_call_output", "call_id": "call-1", "output": {
                    "content": images(50),
                    "structuredContent": business_data
                }},
                {"type": "function_call_output", "call_id": "call-2", "output": business_data.to_string()},
                {"type": "tool_search_output", "tools": [business_data]}
            ],
            "tools": [{"type": "function", "parameters": business_data}],
            "metadata": business_data
        });
        let original = request.clone();

        assert_eq!(limit_request_images(&mut request), 0);
        assert_eq!(request, original);
    }

    #[test]
    fn supports_single_message_input_and_leaves_text_input_unchanged() {
        let mut request = json!({"input": {"role": "user", "content": images(51)}});
        assert_eq!(limit_request_images(&mut request), 1);
        for mut request in [json!({}), json!({"input": null}), json!({"input": "Hello"})] {
            let original = request.clone();
            assert_eq!(limit_request_images(&mut request), 0);
            assert_eq!(request, original);
        }
    }

    #[test]
    fn applies_image_budget_before_each_provider_conversion() {
        let request = json!({
            "model": "test-model",
            "input": [{"role": "user", "content": images(51)}]
        });
        for api_format in [
            "openai-responses",
            "openai-chat-completions",
            "anthropic-messages",
        ] {
            let (body, _, _) = super::super::prepare_request(
                api_format,
                false,
                None,
                &serde_json::to_vec(&request).unwrap(),
            )
            .expect("converted request");
            let converted: Value = serde_json::from_slice(&body).unwrap();
            let content = if api_format == "openai-responses" {
                &converted["input"][0]["content"]
            } else {
                &converted["messages"][0]["content"]
            };
            let content = content.as_array().expect("multimodal content");
            assert_eq!(content.len(), 51);
            assert_eq!(content[3]["text"], OMITTED_IMAGE_NOTICE);
            assert_eq!(
                content
                    .iter()
                    .filter(|part| {
                        matches!(
                            part["type"].as_str(),
                            Some("input_image" | "image_url" | "image")
                        )
                    })
                    .count(),
                50
            );
            assert!(converted.to_string().contains("https://example.com/50.png"));
            for index in 0..3 {
                assert!(converted
                    .to_string()
                    .contains(&format!("https://example.com/{index}.png")));
            }
            assert!(!converted.to_string().contains("https://example.com/3.png"));
        }
    }

    async fn image_limited_upstream(Json(request): Json<Value>) -> axum::response::Response {
        let image_count = request["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["content"].as_array())
            .flatten()
            .filter(|part| part["type"] == "input_image")
            .count();
        if image_count > 50 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": {
                    "message": "Exceeded maximum number of images (50) allowed in the request.",
                    "type": "invalid_request_error", "param": "input"
                }})),
            )
                .into_response();
        }
        assert_eq!(image_count, 50);
        assert_eq!(request["input"][0]["content"], json!(images(1)));
        assert!(request.to_string().contains(OMITTED_IMAGE_NOTICE));
        assert!(request.to_string().contains("https://example.com/49.png"));
        (
            [(header::CONTENT_TYPE, "text/event-stream")],
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_images\",\"status\":\"completed\",\"output\":[]}}\n\n",
        )
            .into_response()
    }

    #[tokio::test]
    async fn proxy_bounds_image_history_for_retry_and_compaction_requests() {
        use super::super::{handle, register, unregister, upstream_from_model_config};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/responses", post(image_limited_upstream)),
            )
            .await
            .expect("upstream server");
        });
        let token = register(
            "image-budget-retry-compaction-test",
            upstream_from_model_config(&json!({"base_url": format!("http://{address}")})).unwrap(),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        for instructions in [
            "Continue the task",
            "Summarize the conversation for compaction",
        ] {
            let request = json!({
                "model": "test-model", "stream": true, "instructions": instructions,
                "tools": [],
                "input": [
                    {"role": "user", "content": images(1)},
                    {"type": "function_call", "call_id": "view-1", "name": "view_image", "arguments": "{}"},
                    {"type": "function_call_output", "call_id": "view-1", "output": images(50)},
                    {"role": "user", "content": "Continue"}
                ]
            });
            let response = handle(
                headers.clone(),
                Bytes::from(serde_json::to_vec(&request).unwrap()),
            )
            .await
            .expect("proxy response");
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let body = String::from_utf8(body.to_vec()).unwrap();
            assert!(body.contains("response.completed"), "{body}");
            assert!(!body.contains("response.failed"), "{body}");
        }
        unregister(&token);
        server.abort();
    }
}
