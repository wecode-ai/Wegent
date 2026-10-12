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
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use brz_http_server::Query;
use brz_redis::Redis as _;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

use crate::http_compat::FastApiError;
use crate::state::AppState;

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

/// Cloud metadata endpoints that are always blocked (source `BLOCKED_HOSTS`).
const BLOCKED_HOSTS: [&str; 3] = [
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.gcp.internal",
];

/// IPv4 networks blocked for SSRF protection (source `BLOCKED_IP_NETWORKS`):
/// the three RFC1918 private ranges, loopback, link-local, RFC6598 shared
/// space, and the unspecified range, each as `(network, prefix length)`.
const BLOCKED_IPV4: [(u32, u32); 7] = [
    (0x0a00_0000, 8),  // RFC1918 private
    (0xac10_0000, 12), // RFC1918 private
    (0xc0a8_0000, 16), // RFC1918 private
    (0x7f00_0000, 8),  // loopback
    (0xa9fe_0000, 16), // link-local
    (0x6440_0000, 10), // RFC6598 shared address space
    (0x0000_0000, 8),  // unspecified
];

/// IPv6 networks blocked for SSRF protection: link-local and unique-local,
/// each as `(network, prefix length)`.
const BLOCKED_IPV6: [(u128, u32); 2] = [
    (0xfe80_0000_0000_0000_0000_0000_0000_0000, 10), // fe80::/10
    (0xfc00_0000_0000_0000_0000_0000_0000_0000, 7),  // fc00::/7
];

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
    let builder = brz_http::Client::builder().timeout(FETCH_TIMEOUT);
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
/// dependencies use only `gzip` and `br`.
fn decode_content(content: &[u8], encoding: &str) -> Option<Vec<u8>> {
    match encoding {
        "" | "identity" => Some(content.to_vec()),
        "gzip" | "deflate" => {
            use std::io::Read;
            let mut decoder = flate2::read::MultiGzDecoder::new(content);
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

/// `_validate_url_for_ssrf`: only `http`/`https`, and the host must not be a
/// blocked hostname or resolve to a blocked IP.
async fn validate_url_for_ssrf(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = parsed.host() else {
        return false;
    };
    match host {
        url::Host::Ipv4(address) => !is_ip_blocked(IpAddr::V4(address)),
        url::Host::Ipv6(address) => !is_ip_blocked(IpAddr::V6(address)),
        url::Host::Domain(name) => !is_host_blocked(name).await,
    }
}

/// `_is_host_blocked`: known metadata hostnames, then every resolved IP.
async fn is_host_blocked(host: &str) -> bool {
    let host_lower = host.to_ascii_lowercase();
    for blocked in BLOCKED_HOSTS {
        if host_lower == blocked || host_lower.ends_with(&format!(".{blocked}")) {
            return true;
        }
    }
    match tokio::net::lookup_host((host, 0)).await {
        Ok(addresses) => addresses.map(|address| address.ip()).any(is_ip_blocked),
        // A resolution failure is treated as blocked, like `socket.gaierror`.
        Err(error) => {
            tracing::warn!(%error, host, "DNS resolution failed for URL metadata host");
            true
        }
    }
}

/// `_is_ip_blocked`: membership in any blocked network. IPv4-mapped IPv6
/// addresses match `::ffff:0:0/96` and are blocked.
fn is_ip_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => is_blocked_ipv4(address),
        IpAddr::V6(address) => is_blocked_ipv6(address),
    }
}

fn is_blocked_ipv4(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    BLOCKED_IPV4
        .into_iter()
        .any(|(network, prefix)| value >> (32 - prefix) == network >> (32 - prefix))
}

fn is_blocked_ipv6(address: Ipv6Addr) -> bool {
    if address.to_ipv4_mapped().is_some() {
        // ::ffff:0:0/96
        return true;
    }
    if address.is_loopback() || address.is_unspecified() {
        // ::1/128 and ::/128
        return true;
    }
    let value = u128::from(address);
    BLOCKED_IPV6
        .into_iter()
        .any(|(network, prefix)| value >> (128 - prefix) == network >> (128 - prefix))
}

/// `_extract_meta_content`: the content of the first `<meta>` tag whose
/// `attr` (`property` or `name`) equals `property_name`. The attribute may
/// precede or follow `content`, mirroring the source's two regular expressions
/// in order.
fn extract_meta_content(html: &str, property_name: &str, attr: &str) -> Option<String> {
    let bodies = tag_bodies(html, "meta");

    // `<meta attr="property_name" content="...">`
    for body in &bodies {
        if !starts_with_space(body) {
            continue;
        }
        let attributes = parse_attributes(body);
        if attributes.len() < 2 {
            continue;
        }
        if attributes[0].name.eq_ignore_ascii_case(attr)
            && attributes[0].value.eq_ignore_ascii_case(property_name)
            && attributes[1].name.eq_ignore_ascii_case("content")
            && attributes[1].quoted
        {
            return Some(attributes[1].value.trim().to_owned());
        }
    }

    // `<meta content="..." attr="property_name">`
    for body in &bodies {
        if !starts_with_space(body) {
            continue;
        }
        let attributes = parse_attributes(body);
        if attributes.len() < 2 {
            continue;
        }
        if attributes[0].name.eq_ignore_ascii_case("content")
            && attributes[0].quoted
            && attributes[1].name.eq_ignore_ascii_case(attr)
            && attributes[1].value.eq_ignore_ascii_case(property_name)
        {
            return Some(attributes[0].value.trim().to_owned());
        }
    }

    None
}

/// `_extract_title`: Open Graph, then Twitter card, then `<title>`.
fn extract_title(html: &str) -> Option<String> {
    if let Some(title) = non_empty(extract_meta_content(html, "og:title", "property")) {
        return Some(title);
    }
    if let Some(title) = non_empty(extract_meta_content(html, "twitter:title", "name")) {
        return Some(title);
    }
    extract_title_tag(html)
}

/// `_extract_description`: Open Graph, then Twitter card, then `name`.
fn extract_description(html: &str) -> Option<String> {
    if let Some(description) = non_empty(extract_meta_content(html, "og:description", "property")) {
        return Some(description);
    }
    if let Some(description) = non_empty(extract_meta_content(html, "twitter:description", "name"))
    {
        return Some(description);
    }
    non_empty(extract_meta_content(html, "description", "name"))
}

/// The `<title[^>]*>([^<]+)</title>` fallback, case-insensitive.
fn extract_title_tag(html: &str) -> Option<String> {
    let bytes = html.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let name_end = name_start + 5;
        if name_end <= bytes.len()
            && bytes[name_start..name_end].eq_ignore_ascii_case(b"title")
            && let Some(gt) = html[name_end..].find('>')
        {
            let text_start = name_end + gt + 1;
            if let Some(lt) = html[text_start..].find('<') {
                let text = &html[text_start..text_start + lt];
                let close = text_start + lt;
                let close_end = close + 8;
                if !text.is_empty()
                    && close_end <= bytes.len()
                    && bytes[close..close_end].eq_ignore_ascii_case(b"</title>")
                {
                    return Some(text.trim().to_owned());
                }
            }
        }
        index += 1;
    }
    None
}

/// `_extract_favicon`: a `rel="icon"`/`rel="shortcut icon"` link, then an
/// `apple-touch-icon`, then `scheme://netloc/favicon.ico`. Always returns a
/// URL for a parseable base URL.
fn extract_favicon(html: &str, base_url: &str) -> String {
    let bodies = tag_bodies(html, "link");
    for body in &bodies {
        let attributes = parse_attributes(body);
        if let Some(href) = icon_href(&attributes, false) {
            return normalize_favicon(href, base_url);
        }
    }
    for body in &bodies {
        let attributes = parse_attributes(body);
        if let Some(href) = icon_href(&attributes, true) {
            return normalize_favicon(href, base_url);
        }
    }
    fallback_favicon(base_url)
}

/// The `href` of a `<link>` whose `rel` is a favicon relation.
fn icon_href<'a>(attributes: &'a [TagAttr<'a>], apple: bool) -> Option<&'a str> {
    let rel = attributes
        .iter()
        .find(|attribute| attribute.name.eq_ignore_ascii_case("rel"))?;
    let matches = if apple {
        rel.value.eq_ignore_ascii_case("apple-touch-icon")
    } else {
        rel_is_icon(rel.value)
    };
    if !matches {
        return None;
    }
    attributes
        .iter()
        .find(|attribute| {
            attribute.name.eq_ignore_ascii_case("href")
                && attribute.quoted
                && !attribute.value.is_empty()
        })
        .map(|attribute| attribute.value.trim())
}

/// `(?:shortcut\s+)?icon`, case-insensitive against the whole `rel` value.
fn rel_is_icon(rel: &str) -> bool {
    if rel.eq_ignore_ascii_case("icon") {
        return true;
    }
    let Some(prefix) = rel.get(.."shortcut".len()) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("shortcut") {
        return false;
    }
    let after = &rel["shortcut".len()..];
    let trimmed = after.trim_start_matches(char::is_whitespace);
    after.len() > trimmed.len() && trimmed.eq_ignore_ascii_case("icon")
}

/// Resolve a favicon href like the source: absolute URLs pass through,
/// protocol-relative URLs gain `https:`, and relative URLs join the base.
fn normalize_favicon(href: &str, base_url: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_owned();
    }
    if href.starts_with("//") {
        return format!("https:{href}");
    }
    url::Url::parse(base_url)
        .and_then(|base| base.join(href))
        .map_or_else(|_| href.to_owned(), |joined| joined.to_string())
}

/// `scheme://netloc/favicon.ico` fallback.
fn fallback_favicon(base_url: &str) -> String {
    let Ok(parsed) = url::Url::parse(base_url) else {
        return String::new();
    };
    let Some(host) = parsed.host_str() else {
        return String::new();
    };
    match parsed.port() {
        Some(port) => format!("{}://{host}:{port}/favicon.ico", parsed.scheme()),
        None => format!("{}://{host}/favicon.ico", parsed.scheme()),
    }
}

/// Returns `value` when it is non-empty, mirroring the source's `if x:` truth
/// checks on optional metadata.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// One attribute of a tag body, borrowed from the source HTML.
struct TagAttr<'a> {
    name: &'a str,
    value: &'a str,
    quoted: bool,
}

fn starts_with_space(body: &str) -> bool {
    body.chars().next().is_some_and(char::is_whitespace)
}

/// Iterate the bodies (the text between the tag name and its terminating `>`)
/// of every `<name ...>` opening tag, in source order.
fn tag_bodies<'a>(html: &'a str, name: &str) -> Vec<&'a str> {
    let bytes = html.as_bytes();
    let name_bytes = name.as_bytes();
    let mut bodies = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let name_end = name_start + name_bytes.len();
        if name_end <= bytes.len()
            && bytes[name_start..name_end].eq_ignore_ascii_case(name_bytes)
            && let Some(gt) = html[name_end..].find('>')
        {
            bodies.push(&html[name_end..name_end + gt]);
            index = name_end + gt + 1;
            continue;
        }
        index += 1;
    }
    bodies
}

/// Parse a tag body's attributes in source order. Values are unquoted; an
/// unterminated or missing value yields an empty `value`.
fn parse_attributes(body: &str) -> Vec<TagAttr<'_>> {
    let bytes = body.as_bytes();
    let mut attributes = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let name_start = index;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'=' {
            index += 1;
        }
        let name = &body[name_start..index];
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index < bytes.len() && bytes[index] == b'=' {
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            if index < bytes.len() && (bytes[index] == b'"' || bytes[index] == b'\'') {
                let quote = bytes[index];
                index += 1;
                let value_start = index;
                while index < bytes.len() && bytes[index] != quote {
                    index += 1;
                }
                let value = &body[value_start..index];
                if index < bytes.len() {
                    index += 1;
                }
                attributes.push(TagAttr {
                    name,
                    value,
                    quoted: true,
                });
            } else {
                let value_start = index;
                while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                attributes.push(TagAttr {
                    name,
                    value: &body[value_start..index],
                    quoted: false,
                });
            }
        } else {
            attributes.push(TagAttr {
                name,
                value: "",
                quoted: false,
            });
        }
    }
    attributes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The recorded alidocs page title and favicon-bearing `<head>` fragment.
    const ALIDOCS_HEAD: &str = r#"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" id="favicon" href="//gw.alicdn.com/imgextra/i3/O1CN01eMicSg1GVD4uXMWGv_!!6000000000627-73-tps-32-32.ico" type="image/x-icon" />
      <link rel="preconnect" href="https://login.dingtalk.com/" />
      <title>DingTalk Docs - DingTalk unified identity authentication</title>
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta
      name="viewport"
      content="viewport-fit=cover, width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
    />
  </head>
</html>"#;

    #[test]
    fn cache_key_matches_the_recorded_redis_key() {
        assert_eq!(
            cache_key(
                "https://alidocs.dingtalk.com/i/nodes/dxXB52LJq0mp6zwpuZ42jrvYVqjMp697?utm_scene=team_space"
            ),
            "url_metadata:5cc19e76875fe9c64aeeed0c3dfaf82a"
        );
    }

    #[test]
    fn extracts_the_recorded_alidocs_metadata() {
        assert_eq!(
            extract_title(ALIDOCS_HEAD).as_deref(),
            Some("DingTalk Docs - DingTalk unified identity authentication")
        );
        assert_eq!(extract_description(ALIDOCS_HEAD), None);
        assert_eq!(
            extract_favicon(
                ALIDOCS_HEAD,
                "https://alidocs.dingtalk.com/i/nodes/dxXB52LJq0mp6zwpuZ42jrvYVqjMp697?utm_scene=team_space"
            ),
            "https://gw.alicdn.com/imgextra/i3/O1CN01eMicSg1GVD4uXMWGv_!!6000000000627-73-tps-32-32.ico"
        );
    }

    #[test]
    fn falls_back_to_the_site_favicon_when_no_link_matches() {
        assert_eq!(
            extract_favicon(
                "<html><head></head></html>",
                "https://www.douyin.com/video/7694847847698631970"
            ),
            "https://www.douyin.com/favicon.ico"
        );
        assert_eq!(extract_title("<html><head></head></html>"), None);
    }

    #[test]
    fn meta_content_prefers_open_graph_over_title_tag() {
        let html = r#"<meta property="og:title" content="OG title"><title>Tag title</title>"#;
        assert_eq!(extract_title(html).as_deref(), Some("OG title"));
        let html = r#"<meta name="twitter:title" content="Tweet title"><title>Tag title</title>"#;
        assert_eq!(extract_title(html).as_deref(), Some("Tweet title"));
        let html = r#"<meta content="Content first" name="twitter:title">"#;
        assert_eq!(extract_title(html).as_deref(), Some("Content first"));
        let html = r#"<meta property="og:title" content="">"#;
        assert_eq!(extract_title(html), None);
    }

    #[test]
    fn description_supports_twitter_and_plain_meta() {
        let html = r#"<meta name="twitter:description" content="tweet">"#;
        assert_eq!(extract_description(html).as_deref(), Some("tweet"));
        let html = r#"<meta name="description" content="plain">"#;
        assert_eq!(extract_description(html).as_deref(), Some("plain"));
        assert_eq!(extract_description("<html></html>"), None);
    }

    #[test]
    fn ip_networks_are_blocked() {
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(172, 31, 255, 255))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(is_ip_blocked(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_ip_blocked("fe80::1".parse().unwrap()));
        assert!(is_ip_blocked("fc00::1".parse().unwrap()));
        assert!(is_ip_blocked(IpAddr::V6(
            Ipv4Addr::new(10, 1, 2, 3).to_ipv6_mapped()
        )));
        // The recorder's fake DNS range, public IPs, and the RFC1918 holes
        // outside the /8 and /12 prefixes are not blocked.
        assert!(!is_ip_blocked(IpAddr::V4(Ipv4Addr::new(198, 19, 3, 136))));
        assert!(!is_ip_blocked(IpAddr::V4(Ipv4Addr::new(106, 11, 35, 100))));
        assert!(!is_ip_blocked(IpAddr::V4(Ipv4Addr::new(172, 32, 0, 1))));
        assert!(!is_ip_blocked(IpAddr::V4(Ipv4Addr::new(100, 63, 0, 1))));
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
}
