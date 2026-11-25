// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use axum::{extract::OriginalUri, http::Method, routing::any};

use super::*;

pub const OFFICIAL_HTTP_ROUTE: &str = "/v1/codex-router/{token}/{*path}";
const ROUTE_PREFIX: &str = "/v1/codex-router/";

pub fn official_http_route<S: Clone + Send + Sync + 'static>() -> MethodRouter<S> {
    any(forward).layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

async fn forward(
    Path((token, path)): Path<(String, String)>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let upstream = registered_upstream(&token)?;
    let raw_path = uri
        .path()
        .strip_prefix(ROUTE_PREFIX)
        .and_then(|rest| rest.split_once('/'))
        .map(|(_, path)| path);
    let request_url = upstream_url(&upstream.base_url, &path, raw_path, uri.query())?;
    let client = upstream_transport::proxy_client_builder(upstream.proxy_url.as_deref())?
        .timeout(Duration::from_secs(
            LOCAL_MODEL_PROXY_REQUEST_TIMEOUT_SECONDS,
        ))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(proxy_error)?;
    let mut request = client
        .request(method.clone(), request_url)
        .headers(end_to_end_headers(&headers))
        .body(body);
    for (name, value) in &upstream.default_headers {
        request = request.header(name, value);
    }
    let incoming = request.send().await.map_err(proxy_error)?;
    let status = incoming.status();
    let response_headers = end_to_end_headers(incoming.headers());
    log_executor_event(
        "official Codex HTTP upstream responded",
        &[
            ("method", method.to_string()),
            ("status", status.as_u16().to_string()),
        ],
    );
    let mut response = Response::new(Body::from_stream(incoming.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    Ok(response)
}

fn upstream_url(
    base_url: &str,
    path: &str,
    raw_path: Option<&str>,
    query: Option<&str>,
) -> Result<reqwest::Url, HttpError> {
    let invalid_path = || HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "invalid official Codex request path".to_owned(),
    };
    if path.contains('\\') || path.split('/').any(|segment| matches!(segment, "." | "..")) {
        return Err(invalid_path());
    }
    let raw_path = raw_path.ok_or_else(invalid_path)?;
    let mut url = reqwest::Url::parse(base_url).map_err(|_| invalid_path())?;
    url.set_path(&format!("{}/{raw_path}", url.path().trim_end_matches('/')));
    url.set_query(query);
    url.set_fragment(None);
    Ok(url)
}

fn end_to_end_headers(headers: &HeaderMap) -> HeaderMap {
    let connection_headers: HashSet<_> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .collect();
    headers
        .iter()
        .filter(|(name, _)| {
            let name = name.as_str();
            !matches!(
                name,
                "connection"
                    | "content-length"
                    | "cookie"
                    | "forwarded"
                    | "host"
                    | "keep-alive"
                    | "set-cookie"
                    | "te"
                    | "trailer"
                    | "transfer-encoding"
                    | "upgrade"
            ) && !name.starts_with("proxy-")
                && !name.starts_with("sec-websocket-")
                && !name.starts_with("x-forwarded-")
                && !connection_headers.contains(name)
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn registered_upstream(token: &str) -> Result<LocalModelProxyUpstream, HttpError> {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    prune_registry(&mut registry);
    let route = registry
        .routes
        .get_mut(token)
        .filter(|route| {
            route.upstream.uses_native_chatgpt_auth()
                && is_official_chatgpt_codex_endpoint(&route.upstream.base_url)
        })
        .ok_or_else(|| HttpError {
            status: StatusCode::NOT_FOUND,
            detail: "unknown or expired official Codex HTTP route".to_owned(),
        })?;
    route.last_used = Instant::now();
    Ok(route.upstream.clone())
}

fn proxy_error(error: reqwest::Error) -> HttpError {
    HttpError {
        status: StatusCode::BAD_GATEWAY,
        detail: format!(
            "Official Codex HTTP proxy request failed: {}",
            error.without_url()
        ),
    }
}
