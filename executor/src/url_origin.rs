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
            let host = host.trim_matches(['[', ']']);
            host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
        })
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

#[cfg(test)]
mod tests {
    use super::{host_is_loopback, http_origin};

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
            http_origin("ws://lan-backend.internal:8000"),
            Some("http://lan-backend.internal:8000".to_owned())
        );
        assert_eq!(http_origin("ftp://backend.example.com"), None);
    }
}
