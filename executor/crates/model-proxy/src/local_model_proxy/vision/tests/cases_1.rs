use super::*;

#[test]
fn validates_supported_image_sources_and_size() {
    assert!(validate_image_url("https://example.com/image.png").is_ok());
    assert!(validate_image_url("data:image/png;base64,YQ==").is_ok());
    assert!(validate_image_url("http://example.com/image.png").is_err());
    assert!(validate_image_url("data:image/svg+xml;base64,YQ==").is_err());
}

#[test]
fn validates_secure_or_loopback_vision_endpoints() {
    assert!(validate_vision_request_url("https://vision.example/v1/responses").is_ok());
    assert!(validate_vision_request_url("http://localhost:8080/v1/responses").is_ok());
    assert!(validate_vision_request_url("http://127.0.0.1:8080/v1/responses").is_ok());
    assert!(validate_vision_request_url("http://[::1]:8080/v1/responses").is_ok());
    assert!(validate_vision_request_url("http://vision.example/v1/responses").is_err());
    assert!(validate_vision_request_url("http://127.0.0.1.vision.example/v1").is_err());
    assert!(validate_vision_request_url("http://169.254.169.254/latest/meta-data").is_err());
    assert!(validate_vision_request_url("file:///tmp/vision").is_err());
}

#[test]
fn cache_identity_is_conversation_scoped_and_context_independent() {
    let sidecar = test_sidecar("https://vision.example/v1/responses".to_owned());
    let first = ImageJob {
        image_url: "https://images.example/screenshot.png".to_owned(),
        detail: Some("high".to_owned()),
        context: "First question".to_owned(),
    };
    let later = ImageJob {
        context: "A later turn asks something else".to_owned(),
        ..first.clone()
    };

    assert_eq!(
        description_cache_key(&first, &sidecar, Some("thread-one")),
        description_cache_key(&later, &sidecar, Some("thread-one"))
    );
    assert_ne!(
        description_cache_key(&first, &sidecar, Some("thread-one")),
        description_cache_key(&first, &sidecar, Some("thread-two"))
    );
    assert_eq!(description_cache_key(&first, &sidecar, None), None);
}

#[tokio::test]
async fn describes_images_over_every_supported_sidecar_protocol() {
    use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
    use std::sync::Arc;
    use tokio::{net::TcpListener, sync::Mutex};

    async fn responses(
        State(captured): State<CapturedVisionRequests>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        captured
            .lock()
            .await
            .push(("/responses".to_owned(), headers, body));
        Json(json!({
            "output": [{"content": [{"type": "output_text", "text": "A Responses description."}]}]
        }))
    }

    async fn chat_completions(
        State(captured): State<CapturedVisionRequests>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        captured
            .lock()
            .await
            .push(("/chat/completions".to_owned(), headers, body));
        Json(json!({
            "choices": [{"message": {"content": "A Chat Completions description."}}]
        }))
    }

    async fn messages(
        State(captured): State<CapturedVisionRequests>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        captured
            .lock()
            .await
            .push(("/v1/messages".to_owned(), headers, body));
        Json(json!({
            "content": [{"type": "text", "text": "An Anthropic Messages description."}]
        }))
    }

    let captured: CapturedVisionRequests = Arc::new(Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("sidecar listener");
    let address = listener.local_addr().expect("sidecar address");
    let app = Router::new()
        .route("/responses", post(responses))
        .route("/chat/completions", post(chat_completions))
        .route("/v1/messages", post(messages))
        .with_state(captured.clone());
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("sidecar server should run");
    });
    let body = serde_json::to_vec(&json!({
        "model": "text-only-primary",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "What does this screenshot show?"},
                {"type": "input_image", "image_url": "data:image/png;base64,YQ=="}
            ]
        }]
    }))
    .expect("request body");

    for (api_format, path, expected_description) in [
        ("openai-responses", "/responses", "A Responses description."),
        (
            "openai-chat-completions",
            "/chat/completions",
            "A Chat Completions description.",
        ),
        (
            "anthropic-messages",
            "/v1/messages",
            "An Anthropic Messages description.",
        ),
    ] {
        let mut sidecar = test_sidecar(format!("http://{address}{path}"));
        sidecar.api_format = api_format.to_owned();
        sidecar.model_id = "vision-model".to_owned();

        let rewritten = replace_images_with_descriptions(Some(&sidecar), None, &body)
            .await
            .expect("vision rewrite");
        let rewritten: Value = serde_json::from_slice(&rewritten).expect("rewritten request");

        assert_eq!(
            rewritten.pointer("/input/0/content/1/type"),
            Some(&json!("input_text")),
            "{api_format} should replace the image with text"
        );
        let replacement = rewritten
            .pointer("/input/0/content/1/text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(
            replacement.contains(expected_description),
            "{api_format} description should be inlined, got: {replacement}"
        );

        let (captured_path, headers, request) = captured
            .lock()
            .await
            .pop()
            .expect("captured sidecar request");
        assert_eq!(captured_path, path);
        assert_eq!(request["model"], "vision-model");
        assert_eq!(request["stream"], false);
        assert_eq!(
            headers
                .get(reqwest::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some(format!("Bearer {}", sidecar.api_key).as_str())
        );
        match api_format {
            "openai-responses" => assert_eq!(
                request.pointer("/input/0/content/1/image_url"),
                Some(&json!("data:image/png;base64,YQ=="))
            ),
            "openai-chat-completions" => assert_eq!(
                request.pointer("/messages/0/content/1/image_url/url"),
                Some(&json!("data:image/png;base64,YQ=="))
            ),
            _ => {
                assert_eq!(
                    request.pointer("/messages/0/content/0/source"),
                    Some(&json!({
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "YQ=="
                    }))
                );
                assert_eq!(request.get("max_tokens"), Some(&json!(2_000)));
                assert_eq!(
                    headers
                        .get("x-api-key")
                        .and_then(|value| value.to_str().ok()),
                    Some(sidecar.api_key.as_str())
                );
                assert_eq!(
                    headers
                        .get("anthropic-version")
                        .and_then(|value| value.to_str().ok()),
                    Some("2023-06-01")
                );
            }
        }
    }
}

#[tokio::test]
async fn keeps_file_id_and_image_url_descriptions_positionally_aligned() {
    use axum::{routing::post, Json, Router};
    use tokio::net::TcpListener;

    async fn describe() -> Json<Value> {
        Json(json!({"output_text": "The valid second image."}))
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("sidecar listener");
    let address = listener.local_addr().expect("sidecar address");
    tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/responses", post(describe)))
            .await
            .expect("sidecar server should run");
    });
    let sidecar = test_sidecar(format!("http://{address}/responses"));
    let body = serde_json::to_vec(&json!({
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_image", "file_id": "file-not-supported"},
                {"type": "input_image", "image_url": "data:image/png;base64,c2Vjb25k"}
            ]
        }]
    }))
    .expect("request body");

    let rewritten = replace_images_with_descriptions(Some(&sidecar), None, &body)
        .await
        .expect("vision rewrite");
    let rewritten: Value = serde_json::from_slice(&rewritten).expect("rewritten request");
    let first = rewritten
        .pointer("/input/0/content/0/text")
        .and_then(Value::as_str)
        .expect("first replacement");
    let second = rewritten
        .pointer("/input/0/content/1/text")
        .and_then(Value::as_str)
        .expect("second replacement");

    assert!(first.contains("unsupported image URL scheme"));
    assert!(second.contains("The valid second image."));
}

#[tokio::test]
async fn does_not_follow_vision_endpoint_redirects() {
    use axum::{extract::State, response::Redirect, routing::post, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::net::TcpListener;

    async fn redirect(State(target): State<String>) -> Redirect {
        Redirect::temporary(&target)
    }

    async fn redirected_target(State(calls): State<Arc<AtomicUsize>>) {
        calls.fetch_add(1, Ordering::SeqCst);
    }

    let redirected_calls = Arc::new(AtomicUsize::new(0));
    let target_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("redirect target listener");
    let target_address = target_listener
        .local_addr()
        .expect("redirect target address");
    let target_app = Router::new()
        .route("/captured", post(redirected_target))
        .with_state(redirected_calls.clone());
    tokio::spawn(async move {
        axum::serve(target_listener, target_app)
            .await
            .expect("redirect target should run");
    });

    let redirect_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("redirect listener");
    let redirect_address = redirect_listener.local_addr().expect("redirect address");
    let redirect_app = Router::new()
        .route("/responses", post(redirect))
        .with_state(format!("http://{target_address}/captured"));
    tokio::spawn(async move {
        axum::serve(redirect_listener, redirect_app)
            .await
            .expect("redirect server should run");
    });

    let sidecar = test_sidecar(format!("http://{redirect_address}/responses"));
    let job = ImageJob {
        image_url: "data:image/png;base64,YQ==".to_owned(),
        detail: None,
        context: "describe".to_owned(),
    };
    let error = describe_image(&sidecar, &job)
        .await
        .expect_err("redirect must fail closed");

    assert_eq!(error, "vision model returned HTTP 307");
    assert_eq!(redirected_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn caches_view_image_descriptions_per_conversation() {
    use axum::{extract::State, routing::post, Json, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::net::TcpListener;

    async fn describe(State(calls): State<Arc<AtomicUsize>>) -> Json<Value> {
        calls.fetch_add(1, Ordering::SeqCst);
        Json(json!({"output_text": "A cached screenshot description."}))
    }

    let calls = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("sidecar listener");
    let address = listener.local_addr().expect("sidecar address");
    let app = Router::new()
        .route("/responses", post(describe))
        .with_state(calls.clone());
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("sidecar server should run");
    });
    let sidecar = test_sidecar(format!("http://{address}/responses"));
    let request_body = |prompt: &str| {
        serde_json::to_vec(&json!({
            "model": "deepseek-v4-flash",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": prompt}]
                },
                {
                    "type": "function_call",
                    "call_id": "image_1",
                    "name": "view_image",
                    "arguments": "{}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "image_1",
                    "output": [{
                        "type": "input_image",
                        "image_url": "data:image/png;base64,Y2FjaGU="
                    }]
                }
            ],
            "tools": [{
                "type": "function",
                "name": "view_image",
                "parameters": {"type": "object"}
            }]
        }))
        .expect("request body")
    };
    let first_body = request_body("Inspect the rendered screen");
    let later_body = request_body("Now fix the issue shown earlier");

    replace_images_with_descriptions(Some(&sidecar), Some("cache-thread"), &first_body)
        .await
        .expect("first vision rewrite");
    let rewritten =
        replace_images_with_descriptions(Some(&sidecar), Some("cache-thread"), &later_body)
            .await
            .expect("cached vision rewrite");

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let rewritten: Value = serde_json::from_slice(&rewritten).expect("rewritten request");
    assert_eq!(
        rewritten.pointer("/input/2/output/0/type"),
        Some(&json!("input_text"))
    );
    assert!(rewritten
        .pointer("/input/2/output/0/text")
        .and_then(Value::as_str)
        .is_some_and(|text| text.contains("cached screenshot description")));

    let (converted, _) = crate::local_model_proxy::chat::responses_to_chat(&rewritten)
        .expect("rewritten view_image output should convert for the primary model");
    let converted_text = converted.to_string();
    assert!(converted_text.contains("cached screenshot description"));
    assert!(!converted_text.contains("data:image/png;base64,Y2FjaGU="));

    replace_images_with_descriptions(Some(&sidecar), Some("different-thread"), &later_body)
        .await
        .expect("different conversation vision rewrite");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn describes_images_with_bounded_concurrency() {
    use axum::{extract::State, routing::post, Json, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{net::TcpListener, time::sleep};

    #[derive(Clone)]
    struct ConcurrencyState {
        active: Arc<AtomicUsize>,
        maximum: Arc<AtomicUsize>,
    }

    async fn describe(State(state): State<ConcurrencyState>) -> Json<Value> {
        let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
        state.maximum.fetch_max(active, Ordering::SeqCst);
        sleep(std::time::Duration::from_millis(50)).await;
        state.active.fetch_sub(1, Ordering::SeqCst);
        Json(json!({"output_text": "A screenshot."}))
    }

    let state = ConcurrencyState {
        active: Arc::new(AtomicUsize::new(0)),
        maximum: Arc::new(AtomicUsize::new(0)),
    };
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("sidecar listener");
    let address = listener.local_addr().expect("sidecar address");
    let app = Router::new()
        .route("/responses", post(describe))
        .with_state(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("sidecar server should run");
    });
    let sidecar = test_sidecar(format!("http://{address}/responses"));
    let body = serde_json::to_vec(&json!({
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_image", "image_url": "https://example.com/1.png"},
                {"type": "input_image", "image_url": "https://example.com/2.png"},
                {"type": "input_image", "image_url": "https://example.com/3.png"},
                {"type": "input_image", "image_url": "https://example.com/4.png"}
            ]
        }]
    }))
    .expect("request body");

    let second_body = serde_json::to_vec(&json!({
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_image", "image_url": "https://example.com/5.png"},
                {"type": "input_image", "image_url": "https://example.com/6.png"},
                {"type": "input_image", "image_url": "https://example.com/7.png"},
                {"type": "input_image", "image_url": "https://example.com/8.png"}
            ]
        }]
    }))
    .expect("second request body");

    let (first, second) = tokio::join!(
        replace_images_with_descriptions(Some(&sidecar), None, &body),
        replace_images_with_descriptions(Some(&sidecar), None, &second_body)
    );
    first.expect("first vision rewrite");
    second.expect("second vision rewrite");

    let maximum = state.maximum.load(Ordering::SeqCst);
    assert!(maximum > 1, "descriptions should run concurrently");
    assert!(
        maximum <= VISION_CONCURRENCY,
        "concurrency must be bounded across simultaneous turns"
    );
}

#[tokio::test]
async fn invalid_images_fail_closed_without_reaching_primary_model() {
    let sidecar = test_sidecar("http://127.0.0.1:1/responses".to_owned());
    let body = serde_json::to_vec(&json!({
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_image",
                "image_url": "data:image/svg+xml;base64,YQ=="
            }]
        }]
    }))
    .expect("request body");

    let rewritten = replace_images_with_descriptions(Some(&sidecar), None, &body)
        .await
        .expect("vision rewrite");
    let rewritten: Value = serde_json::from_slice(&rewritten).expect("rewritten request");

    assert_eq!(
        rewritten.pointer("/input/0/content/0/type"),
        Some(&Value::String("input_text".to_owned()))
    );
    assert!(rewritten
        .pointer("/input/0/content/0/text")
        .and_then(Value::as_str)
        .is_some_and(|text| text.contains("unsupported image type")));
    assert!(rewritten.pointer("/input/0/content/0/image_url").is_none());
}
