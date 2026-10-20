// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.services.web_scraper.security.WebScraperUrlGuard`, the URL-validation
//! entry point used before any scrape strategy runs.

use super::{ERROR_INVALID_URL, ERROR_SSRF_BLOCKED};

/// A controlled scrape-security failure (`WebScraperSecurityError`).
#[derive(Debug, PartialEq, Eq)]
pub struct WebScraperSecurityError {
    pub error_code: &'static str,
    pub message: &'static str,
}

/// `validate_initial_url`: the URL needs an `http`/`https` scheme and a host,
/// then the shared `_validate_url_for_ssrf` guard must accept it.
pub async fn validate_initial_url(url: &str) -> Result<(), WebScraperSecurityError> {
    let Ok(parsed) = url::Url::parse(url) else {
        return Err(invalid_url());
    };
    if parsed.host_str().is_none_or(str::is_empty) || !matches!(parsed.scheme(), "http" | "https") {
        return Err(invalid_url());
    }
    if !crate::url_ssrf::validate_url_for_ssrf(url).await {
        return Err(WebScraperSecurityError {
            error_code: ERROR_SSRF_BLOCKED,
            message: "URL blocked by security policy (private/internal address)",
        });
    }
    Ok(())
}

fn invalid_url() -> WebScraperSecurityError {
    WebScraperSecurityError {
        error_code: ERROR_INVALID_URL,
        message: "Invalid URL format",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn urls_without_a_web_scheme_or_host_are_invalid() {
        for url in [
            "",
            "example.test/path",
            "file:///etc/passwd",
            "ftp://example.test/a",
        ] {
            let error = validate_initial_url(url)
                .await
                .expect_err("URL must be rejected");
            assert_eq!(error.error_code, ERROR_INVALID_URL);
            assert_eq!(error.message, "Invalid URL format");
        }
    }

    #[tokio::test]
    async fn loopback_and_private_addresses_are_blocked() {
        for url in [
            "http://127.0.0.1/internal",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/internal",
        ] {
            let error = validate_initial_url(url)
                .await
                .expect_err("SSRF guard must reject the address");
            assert_eq!(error.error_code, ERROR_SSRF_BLOCKED);
        }
    }
}
