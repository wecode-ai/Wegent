//! Forward HTTP error diagnostics to the desktop host that owns consent.
use axum::{body::Bytes, http::StatusCode};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{sync::OnceLock, time::Duration};

pub(crate) fn capture_model_http_error(status: StatusCode, body: &Bytes, model: Option<&str>) {
    if !status.is_client_error() && !status.is_server_error() {
        return;
    }
    let (Ok(endpoint), Ok(token)) = (
        std::env::var("WEWORK_MODEL_DIAGNOSTICS_URL"),
        std::env::var("WEWORK_MODEL_DIAGNOSTICS_TOKEN"),
    ) else {
        return;
    };
    let Ok(url) = url::Url::parse(&endpoint) else {
        return;
    };
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return;
    }
    let body = body.clone();
    let model = model.map(str::to_owned);
    tokio::spawn(async move {
        static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
        let Some(client) = CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()
                .ok()
        }) else {
            return;
        };
        let (text, encoding) = match std::str::from_utf8(&body) {
            Ok(text) => (text.to_owned(), "utf-8"),
            Err(_) => (STANDARD.encode(&body), "base64"),
        };
        let _ = client
            .post(url)
            .bearer_auth(token)
            .json(&json!({
                "$ai_model": model,
                "http_status": status.as_u16(),
                "response_body": text,
                "response_body_encoding": encoding
            }))
            .send()
            .await;
    });
}
