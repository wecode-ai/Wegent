// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Small URL helpers shared by device configuration and request normalization.

/// Whether the URL host resolves to the machine running the executor.
pub(crate) fn host_is_loopback(raw: &str) -> bool {
    url::Url::parse(raw)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
        })
}

/// The `scheme://host[:port]` origin of a URL, without path, query, or fragment.
pub(crate) fn url_origin(raw: &str) -> Option<String> {
    let mut parsed = url::Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string().trim_end_matches('/').to_owned())
}

/// The HTTP origin of a Socket.IO URL, mapping `ws`/`wss` to `http`/`https`.
pub(crate) fn http_origin(raw: &str) -> Option<String> {
    let mut parsed = url::Url::parse(raw).ok()?;
    match parsed.scheme() {
        "ws" => parsed.set_scheme("http").ok()?,
        "wss" => parsed.set_scheme("https").ok()?,
        "http" | "https" => {}
        _ => return None,
    }
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string().trim_end_matches('/').to_owned())
}

/// Replace a URL's origin while keeping its path, query, and fragment.
pub(crate) fn replace_url_origin(raw: &str, origin: &str) -> Option<String> {
    let mut parsed = url::Url::parse(raw).ok()?;
    let origin = url::Url::parse(origin).ok()?;
    parsed.set_scheme(origin.scheme()).ok()?;
    parsed.set_host(origin.host_str())?;
    parsed.set_port(origin.port()).ok()?;
    Some(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use super::{host_is_loopback, http_origin, replace_url_origin, url_origin};

    #[test]
    fn detects_loopback_hosts() {
        for url in [
            "http://localhost:8000",
            "http://127.0.0.1:8000/api",
            "http://[::1]:8000",
            "http://LOCALHOST:9000",
        ] {
            assert!(host_is_loopback(url), "{url} should be loopback");
        }
        for url in [
            "http://backend.internal:8000",
            "https://example.com",
            "not-a-url",
        ] {
            assert!(!host_is_loopback(url), "{url} should not be loopback");
        }
    }

    #[test]
    fn converts_socket_schemes_to_http_origins() {
        assert_eq!(
            http_origin("wss://backend.example.com:8443/ws"),
            Some("https://backend.example.com:8443".to_owned())
        );
        assert_eq!(
            http_origin("ws://ZINFOID_07Q:8000"),
            Some("http://ZINFOID_07Q:8000".to_owned())
        );
        assert_eq!(http_origin("ftp://backend.example.com"), None);
    }

    #[test]
    fn keeps_path_when_replacing_origin() {
        assert_eq!(
            replace_url_origin(
                "http://localhost:8000/api/runtime-work/llm-responses-proxy",
                "http://backend.internal:8000"
            ),
            Some("http://backend.internal:8000/api/runtime-work/llm-responses-proxy".to_owned())
        );
        assert_eq!(
            replace_url_origin("http://localhost:8000/x", "https://backend.example.com"),
            Some("https://backend.example.com/x".to_owned())
        );
        assert_eq!(
            url_origin("http://localhost:8000/x"),
            Some("http://localhost:8000".to_owned())
        );
    }
}
