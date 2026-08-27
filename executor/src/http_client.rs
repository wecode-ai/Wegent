// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use reqwest::{Client, Url};
use url::Host;

pub(crate) fn client_for_url(url: &str) -> Result<Client, reqwest::Error> {
    let builder = Client::builder();
    if is_loopback_url(url) {
        return builder.no_proxy().build();
    }
    builder.build()
}

fn is_loopback_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    match url.host() {
        Some(Host::Domain(host)) => {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .to_ascii_lowercase()
                    .strip_suffix(".localhost")
                    .is_some_and(|prefix| !prefix.is_empty())
        }
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_loopback_url;

    #[test]
    fn identifies_loopback_http_urls() {
        assert!(is_loopback_url("http://127.0.0.1:8000/api"));
        assert!(is_loopback_url("http://localhost:8000/api"));
        assert!(is_loopback_url("http://worker.localhost:8000/api"));
        assert!(is_loopback_url("http://[::1]:8000/api"));
    }

    #[test]
    fn rejects_non_loopback_and_invalid_urls() {
        assert!(!is_loopback_url("https://api.example.com"));
        assert!(!is_loopback_url("http://192.168.1.10:8000"));
        assert!(!is_loopback_url("not-a-url"));
    }
}
