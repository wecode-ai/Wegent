// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/utils/url-metadata` — fetch Open Graph and `<meta>` metadata from
//! a web page so the frontend can render rich link cards.
//!
//! Mirrors `app.api.endpoints.utils.get_url_metadata` and
//! `app.services.url_metadata.fetch_url_metadata`: SSRF validation, a Redis
//! read-through cache keyed by the URL's MD5, a redirect-following HTML fetch
//! with a per-call cookie jar and a 1 MiB content cap, and Open Graph /
//! `<title>` extraction.
use std::time::Duration;

use brz_http_server::Query;
use brz_redis::Redis as _;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::url_metadata_extract::{extract_description, extract_favicon, extract_title};
use crate::url_ssrf::validate_url_for_ssrf;

/// Cache TTL for URL metadata (1 hour), source `URL_METADATA_CACHE_TTL`.
const CACHE_TTL_SECONDS: u64 = 3600;
/// Request timeout, source `URL_FETCH_TIMEOUT`.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum content size to download, source `MAX_CONTENT_SIZE`.
const MAX_CONTENT_SIZE: usize = 1024 * 1024;
/// Longest description kept before truncation, source `_extract_description`
/// post-processing.
const MAX_DESCRIPTION_CHARS: usize = 200;

const USER_AGENT: &str = "Mozilla/5.0 (compatible; WegentBot/1.0; +https://wegent.ai)";
const ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ACCEPT_LANGUAGE: &str = "en-US,en;q=0.5";

/// `UrlMetadataResult` (`app.services.url_metadata`); field order preserved and
/// `success` materialized to the pydantic `True` default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UrlMetadataResult {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub favicon: Option<String>,
    pub success: bool,
}

/// The required `url` query parameter (`Query(..., description=...)`).
#[derive(Debug, Deserialize)]
struct UrlMetadataQuery {
    url: String,
}

/// Build the process-lifetime metadata fetch transport: the source opens one
/// `httpx.AsyncClient(timeout=5, follow_redirects=True, verify=...)` per call,
/// while the target retains a single pooled transport with the same timeout.
/// Redirect following moves into [`fetch_html`] because the client-wide policy
/// in `brz-http` cannot reproduce the source's per-call cookie jar (each
/// redirect chain starts empty), so this builder disables the transport's own
/// redirect loop. The mounted Replay trust anchor joins the built-in roots
/// like the source's system trust store (`http_trust::trust_anchor`, the same
/// contract as the attachment storage client); `URL_METADATA_SSL_VERIFY`
/// still mirrors the source's optional certificate verification.
pub fn build_client() -> anyhow::Result<brz_http::Client> {
    let verify = crate::config::env_or_dotenv("URL_METADATA_SSL_VERIFY")
        .is_none_or(|value| value.eq_ignore_ascii_case("true"));
    if !verify {
        tracing::warn!("SSL verification disabled for URL metadata fetch");
    }
    // `brz-http` presets 400 ms connect/read timeouts for its api-commons
    // defaults; the source applies its single 5 s `httpx` timeout to every
    // phase, so the pooled transport must override all three timeout knobs.
    // A 6.6 MB recorded dependency (case c0da4dd0) otherwise trips the 400 ms
    // per-read cap while the replay streams the body and the fetch maps the
    // transport error to the failed result.
    let builder = brz_http::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(FETCH_TIMEOUT)
        .read_timeout(FETCH_TIMEOUT);
    let builder = builder.configure(|inner| {
        let inner = inner.redirect(brz_http::reqwest::redirect::Policy::none());
        if verify {
            match crate::http_trust::trust_anchor() {
                Some(anchor) => inner.add_root_certificate(anchor),
                None => inner,
            }
        } else {
            inner.danger_accept_invalid_certs(true)
        }
    });
    builder
        .build()
        .map_err(|error| anyhow::anyhow!("failed to build the url-metadata HTTP client: {error}"))
}

/// GET /api/utils/url-metadata: the utils free function. The source requires no
/// authenticated user, so the route is public.
#[brz_http_server::get("/api/utils/url-metadata", access = public)]
async fn get_url_metadata(
    #[inject(state)] state: &AppState,
    query: Query<UrlMetadataQuery>,
) -> Result<UrlMetadataResult, FastApiError> {
    Ok(fetch_url_metadata(state, &query.url).await)
}

/// `fetch_url_metadata`: validate, read the cache, fetch, extract, and cache.
async fn fetch_url_metadata(state: &AppState, url: &str) -> UrlMetadataResult {
    if !validate_url_for_ssrf(url).await {
        return failed(url);
    }

    let redis = state.redis.as_ref();
    if let Some(redis) = redis {
        match redis.get::<_, String>(cache_key(url).as_str()).await {
            Ok(Some(cached)) => {
                if let Ok(result) = serde_json::from_str::<UrlMetadataResult>(&cached) {
                    return result;
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "failed to read URL metadata from cache"),
        }
    }

    match fetch_html(&state.url_metadata_http, url).await {
        FetchOutcome::BlockedRedirect => failed(url),
        FetchOutcome::Failed => failed(url),
        FetchOutcome::NotHtml => {
            let result = UrlMetadataResult {
                url: url.to_owned(),
                title: None,
                description: None,
                favicon: None,
                success: true,
            };
            cache_result(redis, url, &result).await;
            result
        }
        FetchOutcome::Html(html) => {
            let title = extract_title(&html);
            let mut description = extract_description(&html);
            if let Some(value) = description.as_mut() {
                let length = value.chars().count();
                if length > MAX_DESCRIPTION_CHARS {
                    let kept: String = value.chars().take(MAX_DESCRIPTION_CHARS - 3).collect();
                    *value = format!("{kept}...");
                }
            }
            let result = UrlMetadataResult {
                url: url.to_owned(),
                title,
                description,
                favicon: Some(extract_favicon(&html, url)),
                success: true,
            };
            cache_result(redis, url, &result).await;
            result
        }
    }
}

/// A successful fetch that is not an HTML page yields the minimal result.
enum FetchOutcome {
    Html(String),
    NotHtml,
    BlockedRedirect,
    Failed,
}

/// Fetch the URL, following redirects like the source's
/// `follow_redirects=True`, re-validating the final URL for SSRF protection and
/// reading at most [`MAX_CONTENT_SIZE`] bytes.
///
/// The source opens a fresh `httpx.AsyncClient` per call, so each redirect
/// chain starts with an empty client-level cookie jar: `Set-Cookie` responses
/// feed `client.cookies` (`_client.py` `extract_cookies`), and every redirect
/// request carries that jar's cookies for its URL (`_redirect_headers` pops the
/// outgoing `Cookie` header and the new `Request` re-adds it from the jar). The
/// target keeps one pooled transport, so this loop reproduces the per-call jar
/// by following redirects manually: the recorded chain shows the first
/// response's `Set-Cookie` (`cna=...`) on the second request, without which the
/// upstream returns a bot-check page instead of the real document.
async fn fetch_html(client: &brz_http::Client, url: &str) -> FetchOutcome {
    // `httpx` negotiates `Accept-Encoding: gzip, deflate, br, zstd` (its
    // `[brotli]` extra is installed) and transparently decodes the response
    // body. The shared transport advertises and decodes only what its own
    // compression features enable, so pin the recorded negotiation set here
    // and decode the body in [`read_document`].
    const ACCEPT_ENCODING: &str = "gzip, deflate, br, zstd";

    // One jar per call, like the source's per-call `httpx.AsyncClient`.
    let mut jar: Vec<JarCookie> = Vec::new();
    let mut current = url.to_owned();
    // `httpx` `DEFAULT_MAX_REDIRECTS` (20): exceeding it raises
    // `TooManyRedirects`, an `httpx.RequestError` subclass mapping to the
    // failed result.
    for _ in 0..20 {
        let Ok(request) = client.get(&current) else {
            return FetchOutcome::Failed;
        };
        let mut request = request
            .header("user-agent", USER_AGENT)
            .header("accept", ACCEPT)
            .header("accept-language", ACCEPT_LANGUAGE)
            .header("accept-encoding", ACCEPT_ENCODING);
        if let Some(cookies) = cookie_header(&jar, &current) {
            request = request.header("cookie", cookies);
        }
        // A timeout, DNS, connection, or TLS failure all map to the source's
        // `success=False` result (`httpx.TimeoutException`/`RequestError`).
        let Ok(response) = request.send().await else {
            tracing::warn!(url, "error fetching URL metadata");
            return FetchOutcome::Failed;
        };

        let status = response.status();
        if !is_redirect(status) {
            // `httpx` extracts every `Set-Cookie` into the client jar before
            // building the redirect request, so the terminal leg still
            // records them (unused by this call's fetch).
            return read_document(response, url, &current).await;
        }

        for value in response
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|value| value.to_str().ok())
        {
            extract_cookie(value, &current, &mut jar);
        }
        let Some(location) = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
        else {
            return FetchOutcome::Failed;
        };
        let Some(next) = resolve_redirect(&current, location) else {
            return FetchOutcome::Failed;
        };
        if next == current {
            return FetchOutcome::Failed;
        }
        current = next;
    }
    // Exceeded the source's redirect budget (`TooManyRedirects`).
    FetchOutcome::Failed
}

/// The terminal, non-redirect leg of the fetch: SSRF re-validation of the
/// final URL, the content-type gate, and the size-capped body read.
async fn read_document(
    mut response: brz_http::Response,
    url: &str,
    final_url: &str,
) -> FetchOutcome {
    // Re-validate the final URL after redirects for SSRF protection.
    if final_url != url && !validate_url_for_ssrf(final_url).await {
        tracing::warn!(url, final_url, "blocked redirect to internal URL");
        return FetchOutcome::BlockedRedirect;
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.contains("text/html") && !content_type.contains("application/xhtml") {
        return FetchOutcome::NotHtml;
    }

    let encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut content: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                content.extend_from_slice(&chunk);
                if content.len() > MAX_CONTENT_SIZE {
                    // The source stops reading past the cap without draining
                    // the body, dropping the response mid-stream like
                    // `httpx`'s `aiter_bytes` break; the transport tolerates
                    // the dropped response.
                    break;
                }
            }
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, url, "failed reading URL metadata body");
                return FetchOutcome::Failed;
            }
        }
    }
    match decode_content(&content, &encoding) {
        Some(decoded) => FetchOutcome::Html(String::from_utf8_lossy(&decoded).into_owned()),
        None => {
            // The source's `httpx` decodes every encoding it advertises, so an
            // undecodable body means the shared transport was built without the
            // matching compression feature (for example `br` without `brotli`).
            // Surface it instead of failing the fetch silently.
            tracing::warn!(url, %encoding, "unsupported URL metadata content encoding");
            FetchOutcome::Failed
        }
    }
}

/// `301`/`302`/`303`/`307`/`308`, the statuses `httpx` follows with
/// `follow_redirects=True` (`has_redirect_location`).
fn is_redirect(status: brz_http::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// One cookie held in the per-call jar: `(name, value, domain)`. Only the
/// recorded dependency contract needs cookie replay across one redirect chain;
/// `Secure`, `Path`, and expiry attributes of the transient jar do not change
/// the requests the source emits within a single fetch.
struct JarCookie {
    name: String,
    value: String,
    domain: String,
}

/// `_client.py:Cookies.extract_cookies` for the jar subset the source's fetch
/// observes: the first `name=value` pair of each `Set-Cookie` header, stored
/// under the response URL's host. A `Set-Cookie` for a parent domain
/// (`Domain=dingtalk.com`) matches every host under it, like `http.cookiejar`.
fn extract_cookie(set_cookie: &str, response_url: &str, jar: &mut Vec<JarCookie>) {
    let first = set_cookie.split(';').next().unwrap_or_default().trim();
    let Some((name, value)) = first.split_once('=') else {
        return;
    };
    let name = name.trim();
    if name.is_empty() {
        return;
    }
    let mut domain = url::Url::parse(response_url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .unwrap_or_default();
    for attribute in set_cookie.split(';').skip(1) {
        let attribute = attribute.trim();
        if let Some(declared) = attribute
            .strip_prefix("domain=")
            .or_else(|| attribute.strip_prefix("Domain="))
        {
            let declared = declared.trim().trim_start_matches('.');
            if !declared.is_empty() {
                domain = declared.to_ascii_lowercase();
            }
        }
    }
    jar.retain(|cookie| !(cookie.name == name && cookie.domain == domain));
    jar.push(JarCookie {
        name: name.to_owned(),
        value: value.trim().to_owned(),
        domain,
    });
}

/// `Cookies.set_cookie_header`: the `Cookie` request header for `request_url`,
/// the jar entries whose stored domain matches the request host (exact or a
/// parent domain), joined like `http.cookiejar` in insertion order.
fn cookie_header(jar: &[JarCookie], request_url: &str) -> Option<String> {
    let host = url::Url::parse(request_url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))?;
    let host_lower = host.to_ascii_lowercase();
    let pairs: Vec<String> = jar
        .iter()
        .filter(|cookie| {
            let domain = &cookie.domain;
            host_lower == *domain
                || (host_lower.ends_with(&format!(".{domain}")) && !domain.is_empty())
        })
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect();
    if pairs.is_empty() {
        None
    } else {
        Some(pairs.join("; "))
    }
}

/// `_redirect_url`: an absolute `Location` passes through; a relative one joins
/// the request URL. A malformed location fails the fetch like httpx's
/// `RemoteProtocolError` mapping to `RequestError`.
fn resolve_redirect(request_url: &str, location: &str) -> Option<String> {
    let parsed = url::Url::parse(location)
        .or_else(|_| url::Url::parse(request_url).and_then(|base| base.join(location)))
        .ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(parsed.to_string())
}

/// Transparent response-body decoding for the `Accept-Encoding` set the source
/// advertises. `gzip`/`deflate` decode through `flate2`; `br` and `zstd` fail
/// the fetch unless the shared transport's own compression features enabled
/// them (it then decodes them itself and strips the header). The recorded
/// dependencies use `gzip`, `br` (douyin, figma), and `zstd` (breakbreak).
fn decode_content(content: &[u8], encoding: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    match encoding {
        "" | "identity" => Some(content.to_vec()),
        "gzip" | "deflate" => {
            let mut decoder = flate2::read::MultiGzDecoder::new(content);
            let mut decoded = Vec::new();
            decoder.read_to_end(&mut decoded).ok()?;
            Some(decoded)
        }
        "br" => {
            let mut decoder = brotli::Decompressor::new(content, MAX_CONTENT_SIZE);
            let mut decoded = Vec::new();
            decoder.read_to_end(&mut decoded).ok()?;
            Some(decoded)
        }
        "zstd" => {
            let mut decoder = zstd::stream::read::Decoder::new(content).ok()?;
            let mut decoded = Vec::new();
            decoder.read_to_end(&mut decoded).ok()?;
            Some(decoded)
        }
        _ => None,
    }
}

/// The SSRF-blocked and fetch-failure result shape: the original URL with
/// `success=False` and no metadata.
fn failed(url: &str) -> UrlMetadataResult {
    UrlMetadataResult {
        url: url.to_owned(),
        title: None,
        description: None,
        favicon: None,
        success: false,
    }
}

/// `_get_cache_key`: `url_metadata:<md5 hex of the URL>`.
fn cache_key(url: &str) -> String {
    const HEX: [char; 16] = [
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
    ];
    let mut hasher = Md5::new();
    hasher.update(url.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(32);
    for byte in digest {
        hex.push(HEX[usize::from(byte >> 4)]);
        hex.push(HEX[usize::from(byte & 0x0f)]);
    }
    format!("url_metadata:{hex}")
}

/// `_cache_result`: best-effort `SETEX` of the Python `json.dumps` rendering.
async fn cache_result(
    redis: Option<&brz_redis::RedisService>,
    url: &str,
    result: &UrlMetadataResult,
) {
    let Some(redis) = redis else {
        return;
    };
    let document = serde_json::json!({
        "url": result.url,
        "title": result.title,
        "description": result.description,
        "favicon": result.favicon,
        "success": result.success,
    });
    let payload = crate::json_compat::python_json_value(&document);
    if let Err(error) = redis
        .set_ex(cache_key(url).as_str(), CACHE_TTL_SECONDS, payload)
        .await
    {
        tracing::warn!(%error, "failed to cache URL metadata");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_matches_the_recorded_redis_key() {
        assert_eq!(
            cache_key(
                "https://alidocs.dingtalk.com/i/nodes/dxXB52LJq0mp6zwpuZ42jrvYVqjMp697?utm_scene=team_space"
            ),
            "url_metadata:5cc19e76875fe9c64aeeed0c3dfaf82a"
        );
    }

    /// The source's `httpx.AsyncClient(timeout=5)` applies one 5 s budget to
    /// connect, read, and the whole request. `brz-http` presets 400 ms
    /// connect/read timeouts, so the metadata transport must override all
    /// three knobs; a large recorded body otherwise trips the per-read cap.
    #[test]
    fn build_client_overrides_the_breeze_short_read_default() {
        let client = build_client().expect("client builds");
        let _ = client;
    }

    /// The recorded dependencies include `br` (douyin, figma) and `zstd`
    /// (breakbreak) response bodies, which the source's `httpx` decodes
    /// transparently because it advertises them in `Accept-Encoding`.
    #[test]
    fn decodes_the_recorded_brotli_and_zstd_bodies() {
        let html = b"<html><title>T</title></html>";
        let mut brotli_encoded = Vec::new();
        {
            let mut encoder = brotli::CompressorWriter::new(&mut brotli_encoded, 4096, 5, 22);
            use std::io::Write;
            encoder.write_all(html).unwrap();
        }
        let decoded = decode_content(&brotli_encoded, "br").expect("br body decodes");
        assert_eq!(decoded, html);

        let zstd_encoded = zstd::encode_all(html.as_slice(), 3).unwrap();
        let decoded = decode_content(&zstd_encoded, "zstd").expect("zstd body decodes");
        assert_eq!(decoded, html);
    }

    #[test]
    fn rejects_unknown_content_encodings() {
        assert!(decode_content(b"x", "unsupported").is_none());
    }

    #[test]
    fn response_body_serializes_compactly_like_starlette() {
        let result = UrlMetadataResult {
            url: "https://alidocs.dingtalk.com/i/nodes/dxXB52LJq0mp6zwpuZ42jrvYVqjMp697?utm_scene=team_space".to_owned(),
            title: Some("DingTalk Docs - DingTalk unified identity authentication".to_owned()),
            description: None,
            favicon: Some("https://gw.alicdn.com/imgextra/i3/O1CN01eMicSg1GVD4uXMWGv_!!6000000000627-73-tps-32-32.ico".to_owned()),
            success: true,
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            "{\"url\":\"https://alidocs.dingtalk.com/i/nodes/dxXB52LJq0mp6zwpuZ42jrvYVqjMp697?utm_scene=team_space\",\
             \"title\":\"DingTalk Docs - DingTalk unified identity authentication\",\
             \"description\":null,\
             \"favicon\":\"https://gw.alicdn.com/imgextra/i3/O1CN01eMicSg1GVD4uXMWGv_!!6000000000627-73-tps-32-32.ico\",\
             \"success\":true}"
        );
    }

    #[test]
    fn cached_document_matches_python_json_dumps() {
        let result = UrlMetadataResult {
            url: "https://example.com".to_owned(),
            title: Some("T".to_owned()),
            description: None,
            favicon: Some("https://example.com/favicon.ico".to_owned()),
            success: true,
        };
        let document = serde_json::json!({
            "url": result.url,
            "title": result.title,
            "description": result.description,
            "favicon": result.favicon,
            "success": result.success,
        });
        assert_eq!(
            crate::json_compat::python_json_value(&document),
            "{\"url\": \"https://example.com\", \"title\": \"T\", \"description\": null, \"favicon\": \"https://example.com/favicon.ico\", \"success\": true}"
        );
    }

    /// The cutover and the handler registration must agree. An inactive route
    /// entry sends `GET /api/utils/url-metadata` to the Python fallback (the
    /// hybrid gateway answers `fallback upstream unavailable` in Replay), so
    /// the recorded metadata document is never served by this handler.
    #[test]
    fn selected_route_is_registered_in_the_shared_group() {
        const PATH: &str = "/api/utils/url-metadata";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must be selected for Rust"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(table.matches(&http::Method::GET, PATH));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    /// `httpx` follows exactly these statuses with `follow_redirects=True`;
    /// every other status is a terminal response even when it carries a
    /// `Location` header.
    #[test]
    fn redirects_follow_the_httpx_status_set() {
        for status in [301, 302, 303, 307, 308] {
            let status = brz_http::StatusCode::from_u16(status).unwrap();
            assert!(is_redirect(status), "httpx follows {status}");
        }
        for status in [200, 204, 304, 404, 500] {
            let status = brz_http::StatusCode::from_u16(status).unwrap();
            assert!(!is_redirect(status), "httpx stops at {status}");
        }
    }

    /// `_redirect_url`: a relative `Location` joins the request URL, an
    /// absolute one passes through, and a non-HTTP target fails the fetch.
    #[test]
    fn relative_redirect_location_joins_the_request_url() {
        assert_eq!(
            resolve_redirect("https://example.com/u/1", "/next").as_deref(),
            Some("https://example.com/next")
        );
        assert_eq!(
            resolve_redirect("https://example.com/a/page", "https://other.example/b").as_deref(),
            Some("https://other.example/b")
        );
        assert_eq!(
            resolve_redirect("https://example.com/a/page", "ftp://example.com/x"),
            None
        );
    }

    /// The source opens a fresh `httpx.AsyncClient` per call, so each redirect
    /// chain starts with an empty cookie jar: a `Set-Cookie` from one leg is
    /// sent on the following leg for its domain, and nowhere else.
    #[test]
    fn redirect_chain_replays_the_per_call_cookie_jar() {
        let mut jar = Vec::new();
        extract_cookie(
            "session=abc123; Path=/; Domain=.example.com; Secure",
            "https://www.example.com/page",
            &mut jar,
        );
        assert_eq!(
            cookie_header(&jar, "https://www.example.com/next").as_deref(),
            Some("session=abc123")
        );
        assert_eq!(cookie_header(&jar, "https://other.example.net/next"), None);

        // A host-only cookie is sent back to its own host only.
        extract_cookie("host_only=1; Path=/", "https://api.example.org/a", &mut jar);
        assert_eq!(
            cookie_header(&jar, "https://api.example.org/b").as_deref(),
            Some("host_only=1")
        );
        assert_eq!(cookie_header(&jar, "https://example.org/b"), None);

        // Re-setting the same name and domain replaces the stored value; a
        // host-only cookie for the same name is a distinct jar entry.
        extract_cookie(
            "session=def456; Domain=.example.com",
            "https://www.example.com/page",
            &mut jar,
        );
        assert_eq!(
            cookie_header(&jar, "https://www.example.com/next").as_deref(),
            Some("session=def456")
        );
    }
}
