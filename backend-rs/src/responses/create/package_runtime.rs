// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Internal Python runtime addresses and credentials.

const RUNTIME_PATH: &str = "/_runtime/chat-shell";
const IMAGE_PATH: &str = "/v1/image-execution";

pub(crate) fn base_url() -> String {
    let origin = crate::config::env_or_dotenv("WEGENT_PYTHON_UPSTREAM_URL")
        .unwrap_or_else(|| crate::hybrid::DEFAULT_PYTHON_UPSTREAM.to_owned());
    format!("{}{RUNTIME_PATH}", origin.trim_end_matches('/'))
}

pub(crate) fn is_target(url: &str) -> bool {
    matches_origin(url, &base_url())
}

pub(crate) fn image_url() -> String {
    format!("{}{IMAGE_PATH}", base_url())
}

pub(crate) fn is_image_target(url: &str) -> bool {
    matches_image_target(url, &base_url())
}

fn matches_image_target(url: &str, base: &str) -> bool {
    url == format!("{base}{IMAGE_PATH}")
}

fn matches_origin(url: &str, base: &str) -> bool {
    url.trim_end_matches('/') == base.trim_end_matches('/')
        || url == format!("{}/v1/responses", base.trim_end_matches('/'))
}

pub(crate) fn authorize(request: brz_http::RequestBuilder, url: &str) -> brz_http::RequestBuilder {
    let internal = is_target(url) || is_image_target(url);
    let token = internal
        .then(|| crate::config::env_or_dotenv("INTERNAL_SERVICE_TOKEN").unwrap_or_default());
    authorize_target(request, internal, token.as_deref().unwrap_or_default())
}

fn authorize_target(
    request: brz_http::RequestBuilder,
    package: bool,
    token: &str,
) -> brz_http::RequestBuilder {
    if package {
        // Bearer authentication marks the internal credential as sensitive.
        // Empty configuration remains fail-closed at the embedded engine.
        request.bearer_auth(token.trim())
    } else {
        request.header(
            "authorization",
            super::openai_client::OPENAI_DUMMY_AUTHORIZATION,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_credentials_are_bound_to_the_configured_python_origin() {
        let base = "http://python:8004/_runtime/chat-shell";
        assert!(matches_origin(base, base));
        assert!(matches_origin(&format!("{base}/v1/responses"), base));
        assert!(matches_image_target(&format!("{base}{IMAGE_PATH}"), base));
        assert!(!matches_image_target(
            "http://untrusted:8004/_runtime/chat-shell/v1/image-execution",
            base
        ));
        for url in [
            "http://untrusted:8004/_runtime/chat-shell/v1/responses",
            "http://python:8004/_runtime/chat-shell-other/v1/responses",
            "http://python:8004/v1/responses",
        ] {
            assert!(!matches_origin(url, base));
        }
    }

    #[test]
    fn engine_requests_have_one_sensitive_bearer_header() {
        let client = brz_http::Client::builder().build().unwrap();
        let request = client.post("http://python:8004/runtime").unwrap();
        let request = authorize_target(request, true, " unit-package-token ")
            .build()
            .unwrap();
        let values: Vec<_> = request.headers().get_all("authorization").iter().collect();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0], "Bearer unit-package-token");
        assert!(values[0].is_sensitive());

        let request = client.post("http://chat-shell:8100/v1/responses").unwrap();
        let request = authorize_target(request, false, "internal-must-not-leak")
            .build()
            .unwrap();
        assert_eq!(
            request.headers()["authorization"],
            super::super::openai_client::OPENAI_DUMMY_AUTHORIZATION
        );
    }
}
