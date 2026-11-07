use super::*;

fn test_sidecar(request_url: String) -> VisionSidecarUpstream {
    VisionSidecarUpstream {
        request_url,
        api_format: "openai-responses".to_owned(),
        api_key: "secret".to_owned(),
        default_headers: Vec::new(),
        proxy_url: None,
        model_id: format!("vision-test-{}", uuid::Uuid::new_v4()),
        max_descriptions_per_turn: 8,
        timeout: std::time::Duration::from_secs(5),
    }
}

type CapturedVisionRequests =
    std::sync::Arc<tokio::sync::Mutex<Vec<(String, axum::http::HeaderMap, Value)>>>;

mod cases_1;
