use super::*;

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
    request_url: &str,
    request_body: &[u8],
    incoming_headers: &HeaderMap,
    mut retry_wait: Option<retry_notifications::RetryWait>,
) -> Result<reqwest::Response, HttpError> {
    for retry_count in 0..=MAX_RATE_LIMIT_RETRIES {
        let response = build_upstream_request(
            client,
            upstream,
            request_url,
            request_body,
            incoming_headers,
        )
        .send()
        .await
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Local model proxy request failed: {error:#}"),
        })?;
        if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS
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

pub(super) fn build_upstream_request(
    client: &reqwest::Client,
    upstream: &LocalModelProxyUpstream,
    request_url: &str,
    request_body: &[u8],
    incoming_headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    let mut request = client
        .post(request_url)
        .bearer_auth(&upstream.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .body(request_body.to_vec());
    if upstream.api_format == "anthropic-messages" {
        request = request
            .header("x-api-key", &upstream.api_key)
            .header("anthropic-version", "2023-06-01");
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
