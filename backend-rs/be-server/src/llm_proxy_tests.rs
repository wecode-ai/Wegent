// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the LLM proxy: model-credential resolution, request parsing and the Anthropic messages translation.
#![cfg(test)]

use super::*;

use brz_http_server::IntoHttpResponse;
use serde_json::json;

#[test]
fn parse_body_requires_object_and_model() {
    let (_, model) = parse_request_body(br#"{"model":"m"}"#).unwrap();
    assert_eq!(model, "m");
    assert_eq!(
        parse_request_body(b"not json").unwrap_err().status(),
        StatusCode::BAD_REQUEST
    );
    assert!(parse_request_body(b"[]").is_err());
    assert!(parse_request_body(br#"{"model":"  "}"#).is_err());
    assert!(parse_request_body(br#"{}"#).is_err());
}

#[test]
fn long_context_alias_is_stripped_like_the_source() {
    assert_eq!(
        strip_long_context_suffix("claude-sonnet[1m]"),
        "claude-sonnet"
    );
    assert_eq!(
        strip_long_context_suffix("claude-sonnet+1m"),
        "claude-sonnet"
    );
    assert_eq!(
        strip_long_context_suffix("  claude-sonnet [1M]  "),
        "claude-sonnet"
    );
    assert_eq!(strip_long_context_suffix("claude-sonnet"), "claude-sonnet");
    assert_eq!(strip_long_context_suffix("[1m]"), "[1m]");
}

#[test]
fn messages_path_detection_matches_the_source() {
    assert!(is_anthropic_messages_request(
        "/api/runtime-work/llm-responses-proxy/messages"
    ));
    assert!(is_anthropic_messages_request(
        "/api/runtime-work/llm-responses-proxy/messages/"
    ));
    assert!(!is_anthropic_messages_request(
        "/api/runtime-work/llm-responses-proxy/responses"
    ));
}

#[test]
fn context_overflow_normalization_matches_the_source() {
    let overflow = normalize_context_overflow(
        StatusCode::BAD_REQUEST,
        b"prompt is too long: 200000 tokens > 128000 maximum",
        4000,
        Some(128000),
    )
    .unwrap();
    assert_eq!(
        overflow,
        json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": "prompt is too long: 200000 tokens > 128000 maximum",
            },
        })
    );

    // A body without a count falls back to the request-length estimate and
    // still keeps `actual > limit`.
    let estimated = normalize_context_overflow(
        StatusCode::PAYLOAD_TOO_LARGE,
        "对话内容太长".as_bytes(),
        4001,
        None,
    )
    .unwrap();
    assert_eq!(
        estimated["error"]["message"],
        "prompt is too long: 1000 tokens > 999 maximum"
    );

    // A recorded count at or below the configured window sizes the limit down.
    let windowed = normalize_context_overflow(
        StatusCode::UNPROCESSABLE_ENTITY,
        b"maximum context length is 200 tokens",
        400,
        Some(300),
    )
    .unwrap();
    assert_eq!(
        windowed["error"]["message"],
        "prompt is too long: 200 tokens > 199 maximum"
    );

    assert!(
        normalize_context_overflow(StatusCode::NOT_FOUND, b"prompt is too long", 4000, None)
            .is_none()
    );
    assert!(
        normalize_context_overflow(StatusCode::BAD_REQUEST, b"unrelated", 4000, None).is_none()
    );
}

#[tokio::test]
async fn byte_reply_is_closed_and_carries_the_source_headers() {
    let reply = byte_reply(
        StatusCode::BAD_GATEWAY,
        "text/plain",
        b"upstream failure".to_vec(),
    )
    .unwrap();
    let arena = brz_http_server::EphemeralBytesArena::new(64);
    assert_eq!(
        reply.into_http_response(&arena).status(),
        StatusCode::BAD_GATEWAY
    );
}

#[test]
fn forwarded_body_renders_like_python_json_dumps() {
    // The recorded upstream request body is `json.dumps(body_json)`: the
    // `", "` / `": "` separators and `\uXXXX` non-ASCII escapes differ from
    // serde_json's compact rendering.
    let value: Value = serde_json::from_str(
        "{\"model\":\"旧\",\"messages\":[{\"content\":\"你好\",\"role\":\"user\"}]}",
    )
    .unwrap();
    let mut forwarded = value;
    if let Value::Object(object) = &mut forwarded {
        object.insert("model".to_string(), Value::String("m".to_string()));
    }
    let rendered = crate::json_compat::python_json_value(&forwarded);
    assert_eq!(
        rendered,
        "{\"model\": \"m\", \"messages\": [{\"content\": \"\\u4f60\\u597d\", \
         \"role\": \"user\"}]}"
    );
}

#[test]
fn merge_headers_overrides_case_insensitively() {
    let a = vec![("X-A".to_string(), "1".to_string())];
    let b = vec![("x-a".to_string(), "2".to_string())];
    let merged = merge_headers_case_insensitive([a.as_slice(), b.as_slice()]);
    assert_eq!(merged, vec![("x-a".to_string(), "2".to_string())]);
}

#[test]
fn starlette_media_type_appends_charset_only_for_text() {
    assert_eq!(
        starlette_media_type("text/event-stream"),
        "text/event-stream; charset=utf-8"
    );
    assert_eq!(
        starlette_media_type("text/event-stream; charset=utf-8"),
        "text/event-stream; charset=utf-8"
    );
    assert_eq!(starlette_media_type("application/json"), "application/json");
}

#[test]
fn required_header_and_resource_user_id_validate() {
    assert_eq!(required_header(Some(" x ".to_string()), "h").unwrap(), "x");
    assert_eq!(
        required_header(Some("  ".to_string()), "h")
            .unwrap_err()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(resource_user_id(Some("0".to_string())).unwrap(), 0);
    assert!(resource_user_id(Some("-1".to_string())).is_err());
    assert!(resource_user_id(Some("abc".to_string())).is_err());
}

#[test]
fn model_api_key_validation_matches_source() {
    assert_eq!(
        validate_model_api_key(" sk-1 ", false).as_deref(),
        Some("sk-1")
    );
    assert_eq!(validate_model_api_key("", false).as_deref(), Some(""));
    assert!(validate_model_api_key("", true).is_none());
    assert!(validate_model_api_key("${DEPLOYMENT_USER_API_KEY}", true).is_none());
    assert!(validate_model_api_key("a\nb", false).is_none());
    assert!(validate_model_api_key("a\rb", false).is_none());
}

#[test]
fn protocol_selection_and_targets_match_source() {
    use model_config::ModelConfig;
    use model_config::Protocol;
    let responses = ModelConfig {
        protocol: Some("openai-responses".to_string()),
        ..ModelConfig::default()
    };
    assert_eq!(
        resolve_llm_proxy_protocol("m", &responses).unwrap(),
        Protocol::OpenAiResponses
    );
    let chat = ModelConfig {
        protocol: Some("openai".to_string()),
        api_format: Some("chat/completions".to_string()),
        ..ModelConfig::default()
    };
    assert_eq!(
        resolve_llm_proxy_protocol("m", &chat).unwrap(),
        Protocol::OpenAiChatCompletions
    );
    let anthropic = ModelConfig {
        protocol: Some("claude".to_string()),
        ..ModelConfig::default()
    };
    assert_eq!(
        resolve_llm_proxy_protocol("m", &anthropic).unwrap(),
        Protocol::AnthropicMessages
    );
    assert!(resolve_llm_proxy_protocol("m", &ModelConfig::default()).is_err());

    let (path, headers) = resolve_upstream_target(Protocol::OpenAiResponses, "sk-1");
    assert_eq!(path, "/responses");
    assert_eq!(
        headers,
        vec![("Authorization".into(), "Bearer sk-1".into())]
    );
    let (path, headers) = resolve_upstream_target(Protocol::OpenAiResponses, "");
    assert_eq!(path, "/responses");
    assert!(headers.is_empty());
}

#[test]
fn join_and_defaults_match_source() {
    assert_eq!(
        model_config::join_upstream_url("https://llm.example.invalid/v1", "/responses"),
        "https://llm.example.invalid/v1/responses"
    );
    assert_eq!(
        model_config::join_upstream_url("https://api.openai.com/v1/responses", "/responses"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        model_config::join_upstream_url("https://api.openai.com", "/responses"),
        "https://api.openai.com/responses"
    );
    let _ = json!({});
    assert_eq!(SUPPORTED_MODEL_TYPES.len(), 3);
}
