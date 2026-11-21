// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The outbound OpenAI-compatible client identity.
//!
//! The Source backend talks to the chat shell through the `openai` Python SDK
//! (`AsyncOpenAI`, `chat_shell_client.py:38-51` and `dispatcher.py:673-679`:
//! `api_key="dummy"`, `timeout=300.0`, `max_retries=0`). The generated client
//! advertises a fixed set of stainless headers; the recorded dependency
//! exchanges pin them exactly.
//!
//! One version string drives both `user-agent` and
//! `x-stainless-package-version` (`openai._version`). It is the installed SDK
//! identity of the recorded deployment, so both headers come from the same
//! constant group: the recorded recording batch's Source client is `2.29.0`,
//! and no process configuration may make the identity nondeterministic.

/// `AsyncOpenAI(api_key="dummy")`'s bearer header
/// (`chat_shell_client.py:44`, `dispatcher.py:675`): the SDK sends a fixed
/// placeholder credential, which the recorded dependency request carries.
pub(crate) const OPENAI_DUMMY_AUTHORIZATION: &str = "Bearer dummy";

/// The OpenAI client's `Accept` header for the JSON/SSE create requests.
pub(crate) const OPENAI_ACCEPT: &str = "application/json";

/// The Source OpenAI Python SDK's generated client identity.
///
/// These are the SDK's stable identities, not per-request data: the package
/// version and the runtime/platform the SDK advertises, which stay fixed for a
/// deployment. `x-stainless-read-timeout` is the configured client timeout and
/// `x-stainless-retry-count` stays `0` because the Source client (and ours)
/// performs no retries. Dynamic values are deliberately not part of this set:
/// `X-Request-ID` is generated per request, `authorization` comes from the
/// client configuration, and `content-length` is computed by the HTTP stack.
///
/// `user-agent` and `x-stainless-package-version` both derive from one SDK
/// version, `2.29.0`, the installed `openai` client of the recorded
/// deployment. Both entries live in this constant group so the identity cannot
/// drift between them.
pub(crate) const OPENAI_CLIENT_HEADERS: &[(&str, &str)] = &[
    ("user-agent", "AsyncOpenAI/Python 2.29.0"),
    ("x-stainless-arch", "x64"),
    ("x-stainless-async", "async:asyncio"),
    ("x-stainless-lang", "python"),
    ("x-stainless-os", "Linux"),
    ("x-stainless-package-version", "2.29.0"),
    ("x-stainless-read-timeout", "300.0"),
    ("x-stainless-retry-count", "0"),
    ("x-stainless-runtime", "CPython"),
    ("x-stainless-runtime-version", "3.12.11"),
];

/// Apply the client identity to an outbound model request. Both the streaming
/// chat-shell path and the executor-manager dispatch use this so their client
/// identity cannot drift apart.
pub(crate) fn apply_openai_client_headers(
    mut request: brz_http::RequestBuilder,
) -> brz_http::RequestBuilder {
    for (name, value) in OPENAI_CLIENT_HEADERS {
        request = request.header(*name, *value);
    }
    request
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str) -> Option<&'static str> {
        OPENAI_CLIENT_HEADERS
            .iter()
            .find(|(header, _)| *header == name)
            .map(|(_, value)| *value)
    }

    #[test]
    fn outbound_model_requests_carry_the_source_openai_client_identity() {
        let client = brz_http::Client::builder().build().expect("client");
        let request = apply_openai_client_headers(
            client
                .post("http://example.test/v1/responses")
                .expect("request"),
        )
        .build()
        .expect("build");
        let headers = request.into_reqwest().headers().clone();
        for (name, value) in OPENAI_CLIENT_HEADERS {
            assert_eq!(
                headers.get(*name).and_then(|value| value.to_str().ok()),
                Some(*value),
                "missing or changed header {name}"
            );
        }
        // Dynamic values stay dynamic: `X-Request-ID` is generated per request
        // by the caller, authorization comes from the client configuration, and
        // the HTTP stack computes content-length.
        assert!(headers.get("x-request-id").is_none());
        assert!(headers.get("authorization").is_none());
        assert!(headers.get("content-length").is_none());
        assert!(
            !OPENAI_CLIENT_HEADERS
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("x-request-id"))
        );
    }

    #[test]
    fn both_sdk_version_headers_share_one_constant_identity() {
        // `user-agent` and `x-stainless-package-version` derive from one SDK
        // version; neither may drift from the other.
        assert_eq!(header("x-stainless-package-version"), Some("2.29.0"));
        assert_eq!(header("user-agent"), Some("AsyncOpenAI/Python 2.29.0"));
    }

    #[test]
    fn the_client_identity_does_not_read_process_configuration() {
        // The identity is a recorded deployment property, so no environment
        // variable can move either header.
        let source = include_str!("openai_client.rs");
        let production = source.split("#[cfg(test)]").next().expect("production");
        assert!(!production.contains("WEGENT_OPENAI_SDK_VERSION"));
        assert!(!production.contains("env_or_dotenv"));
    }
}
