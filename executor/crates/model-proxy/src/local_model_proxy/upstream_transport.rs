use super::*;

const FORWARDED_OFFICIAL_AUTH_HEADERS: [&str; 5] = [
    "authorization",
    "chatgpt-account-id",
    "openai-organization",
    "openai-project",
    "x-openai-actor-authorization",
];

pub(super) fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())?
        .trim();
    let mut parts = auth.split_whitespace();
    if parts.next()?.eq_ignore_ascii_case("Bearer") {
        parts.next().map(str::to_owned)
    } else {
        None
    }
}

pub(super) fn proxy_client(proxy_url: Option<&str>) -> Result<reqwest::Client, HttpError> {
    proxy_client_builder(proxy_url)?
        .timeout(Duration::from_secs(
            LOCAL_MODEL_PROXY_REQUEST_TIMEOUT_SECONDS,
        ))
        .build()
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to configure local model proxy client: {error}"),
        })
}

pub(super) fn proxy_client_without_redirects(
    proxy_url: Option<&str>,
) -> Result<reqwest::Client, HttpError> {
    proxy_client_builder(proxy_url)?
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to configure local model proxy client: {error}"),
        })
}

pub(super) fn proxy_client_builder(
    proxy_url: Option<&str>,
) -> Result<reqwest::ClientBuilder, HttpError> {
    let Some(proxy_url) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) else {
        // The executor hydrates the user's login-shell environment, which may
        // export proxy variables for unrelated tooling. Reaching the backend
        // must depend only on the configured upstream, never on that shell.
        return Ok(reqwest::Client::builder().no_proxy());
    };
    Ok(
        reqwest::Client::builder().proxy(reqwest::Proxy::all(proxy_url).map_err(|error| {
            HttpError {
                status: StatusCode::BAD_GATEWAY,
                detail: format!("Invalid local model proxy URL: {error}"),
            }
        })?),
    )
}

pub(super) async fn send_upstream_request_with_rate_limit_retry(
    client: &reqwest::Client,
    upstream: &LocalModelProxyUpstream,
    gateway_credentials: Option<&GatewayCredentials>,
    request_url: &str,
    request_body: &[u8],
    incoming_headers: &HeaderMap,
    mut retry_wait: Option<retry_notifications::RetryWait>,
) -> Result<reqwest::Response, HttpError> {
    for retry_count in 0..=MAX_RATE_LIMIT_RETRIES {
        let request = build_upstream_request(
            client,
            upstream,
            request_url,
            request_body,
            incoming_headers,
        );
        let response = if let Some(credentials) = gateway_credentials {
            let mut request = request
                .timeout(Duration::from_secs(
                    LOCAL_MODEL_PROXY_REQUEST_TIMEOUT_SECONDS,
                ))
                .build()
                .map_err(upstream_transport_error)?;
            let mut authorization =
                HeaderValue::from_str(&format!("Bearer {}", credentials.current_token()?))
                    .map_err(|_| HttpError {
                        status: StatusCode::UNAUTHORIZED,
                        detail: "Invalid model gateway credential".to_owned(),
                    })?;
            authorization.set_sensitive(true);
            request
                .headers_mut()
                .insert(header::AUTHORIZATION, authorization);
            client.execute(request).await
        } else {
            request.send().await
        }
        .map_err(upstream_transport_error)?;
        // Official subscription rate limits are durable quota events owned by
        // the Executor. Retrying them here hides the reset window and turns a
        // quota error into an immediate model continuation.
        if upstream.uses_native_chatgpt_auth()
            || response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS
            || retry_count == MAX_RATE_LIMIT_RETRIES
        {
            return Ok(response);
        }

        let delay = rate_limit_retry_delay(response.headers(), retry_count);
        if let Some(wait) = retry_wait.as_mut() {
            wait.waiting();
        }
        log_executor_event(
            "local model proxy rate limited; retrying",
            &[
                ("api_format", upstream.api_format.clone()),
                ("retry", (retry_count + 1).to_string()),
                ("max_retries", MAX_RATE_LIMIT_RETRIES.to_string()),
                ("delay_ms", delay.as_millis().to_string()),
            ],
        );
        tokio::time::sleep(delay).await;
    }

    unreachable!("rate limit retry loop always returns a response")
}

fn upstream_transport_error(error: reqwest::Error) -> HttpError {
    HttpError {
        status: StatusCode::BAD_GATEWAY,
        detail: format!("Local model proxy request failed: {error:#}"),
    }
}

pub(super) fn build_upstream_request(
    client: &reqwest::Client,
    upstream: &LocalModelProxyUpstream,
    request_url: &str,
    request_body: &[u8],
    incoming_headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    let native_chatgpt_auth = upstream.uses_native_chatgpt_auth();
    let mut request = client
        .post(request_url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .body(request_body.to_vec());
    if !native_chatgpt_auth {
        request = request.bearer_auth(&upstream.api_key);
    }
    if upstream.api_format == "anthropic-messages" {
        request = request
            .header("x-api-key", &upstream.api_key)
            .header("anthropic-version", "2023-06-01");
    }
    with_upstream_headers(request, upstream, incoming_headers)
}

pub(super) fn with_upstream_headers(
    mut request: reqwest::RequestBuilder,
    upstream: &LocalModelProxyUpstream,
    incoming_headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    if upstream.uses_native_chatgpt_auth() {
        for name in FORWARDED_OFFICIAL_AUTH_HEADERS {
            if let Some(value) = incoming_headers.get(name) {
                request = request.header(name, value);
            }
        }
    }
    for name in FORWARDED_CODEX_REQUEST_HEADERS {
        if let Some(value) = incoming_headers.get(name) {
            request = request.header(name, value);
        }
    }
    for (key, value) in &upstream.default_headers {
        request = request.header(key, value);
    }
    request
}

pub(super) fn detect_upstream_error_code(response_body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(response_body);
    [
        "invalid_encrypted_content",
        "context_length_exceeded",
        "rate_limit_exceeded",
    ]
    .into_iter()
    .find(|code| text.contains(code))
    .map(str::to_owned)
}

pub(super) fn is_event_stream_content_type(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"))
}

pub(super) fn rate_limit_retry_delay(
    headers: &reqwest::header::HeaderMap,
    retry_count: u32,
) -> Duration {
    let retry_after = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after);
    retry_after
        .unwrap_or_else(|| configured_rate_limit_delay(retry_count))
        .min(MAX_RATE_LIMIT_RETRY_DELAY)
}

pub(super) fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let retry_at = httpdate::parse_http_date(value).ok()?;
    Some(
        retry_at
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO),
    )
}

pub(super) fn configured_rate_limit_delay(retry_count: u32) -> Duration {
    RATE_LIMIT_RETRY_DELAYS
        .get(retry_count as usize)
        .copied()
        .unwrap_or(MAX_RATE_LIMIT_RETRY_DELAY)
}

pub(super) fn safe_url(value: &str) -> String {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?;
            let port = url
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default();
            Some(format!("{}://{}{}{}", url.scheme(), host, port, url.path()))
        })
        .unwrap_or_else(|| "<invalid-url>".to_owned())
}

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderMap, HeaderValue};
    use serde_json::json;

    use super::*;

    fn upstream(base_url: &str, api_key: &str) -> LocalModelProxyUpstream {
        upstream_from_model_config(&json!({
            "base_url": base_url,
            "api_key": api_key
        }))
        .unwrap()
        .unwrap()
    }

    #[test]
    fn official_chatgpt_forwards_native_oauth_headers_without_logging_values() {
        let upstream = upstream(
            crate::local_model_proxy::OFFICIAL_CHATGPT_CODEX_BASE_URL,
            "",
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer native-oauth"),
        );
        headers.insert("chatgpt-account-id", HeaderValue::from_static("account-1"));

        let request = build_upstream_request(
            &reqwest::Client::new(),
            &upstream,
            &upstream.resolved_request_url(),
            b"{}",
            &headers,
        )
        .build()
        .unwrap();

        assert_eq!(
            request.headers()[header::AUTHORIZATION],
            "Bearer native-oauth"
        );
        assert_eq!(request.headers()["chatgpt-account-id"], "account-1");
    }

    #[test]
    fn official_chatgpt_with_explicit_api_key_uses_bearer_auth() {
        let upstream = upstream(
            crate::local_model_proxy::OFFICIAL_CHATGPT_CODEX_BASE_URL,
            "explicit-key",
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer native-oauth"),
        );
        headers.insert("chatgpt-account-id", HeaderValue::from_static("account-1"));

        let request = build_upstream_request(
            &reqwest::Client::new(),
            &upstream,
            &upstream.resolved_request_url(),
            b"{}",
            &headers,
        )
        .build()
        .unwrap();

        assert_eq!(
            request.headers()[header::AUTHORIZATION],
            "Bearer explicit-key"
        );
        assert!(request.headers().get("chatgpt-account-id").is_none());
    }

    #[test]
    fn configured_upstreams_keep_the_provider_bearer_token() {
        let upstream = upstream("https://models.example/v1", "model-key");

        let request = build_upstream_request(
            &reqwest::Client::new(),
            &upstream,
            &upstream.resolved_request_url(),
            b"{}",
            &HeaderMap::new(),
        )
        .build()
        .unwrap();

        assert_eq!(request.headers()[header::AUTHORIZATION], "Bearer model-key");
    }
}
