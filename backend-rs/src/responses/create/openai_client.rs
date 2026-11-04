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
//! Only the package version varies between Source images: one version string
//! drives both `user-agent` and `x-stainless-package-version`
//! (`openai._version`). It is deployment configuration, so it is read from
//! [`OPENAI_SDK_VERSION_ENV`] with [`OPENAI_CLIENT_HEADERS`] as the default.
//! `x-stainless-package-version` is pinned to the recorded Source client; the
//! installed SDK identity stays configurable.

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
/// `x-stainless-package-version` is the version of the Source `openai` client
/// that produced the recorded executor/chat-shell dependencies and is sent
/// verbatim; only the SDK `user-agent` follows the configured installed
/// version.
pub(crate) const OPENAI_CLIENT_HEADERS: &[(&str, &str)] = &[
    ("user-agent", "AsyncOpenAI/Python 3.37.0"),
    ("x-stainless-arch", "x64"),
    ("x-stainless-async", "async:asyncio"),
    ("x-stainless-lang", "python"),
    ("x-stainless-os", "Linux"),
    ("x-stainless-package-version", "3.42.1"),
    ("x-stainless-read-timeout", "300.0"),
    ("x-stainless-retry-count", "0"),
    ("x-stainless-runtime", "CPython"),
    ("x-stainless-runtime-version", "3.12.11"),
];

/// The `openai` package version the default `user-agent` advertises.
const OPENAI_SDK_DEFAULT_VERSION: &str = "3.37.0";

/// The installed `openai` package version (`WEGENT_OPENAI_SDK_VERSION`).
///
/// The Source deployment's SDK version is a property of the installed package,
/// not of the migration: the recorded batches pin different versions
/// (`3.37.0` and `3.39.0`), so one process-wide setting selects the identity.
/// Absent, it keeps the version [`OPENAI_CLIENT_HEADERS`] records.
pub(crate) const OPENAI_SDK_VERSION_ENV: &str = "WEGENT_OPENAI_SDK_VERSION";

/// The installed `openai` package version
/// (`AsyncOpenAI/_client.py` reads it from `openai._version`).
///
/// This is the SDK identity the `user-agent` advertises; the stainless
/// package-version header is pinned separately in [`OPENAI_CLIENT_HEADERS`].
fn default_openai_sdk_version() -> &'static str {
    OPENAI_SDK_DEFAULT_VERSION
}

/// The SDK version the client advertises: the configured value, or the version
/// [`OPENAI_CLIENT_HEADERS`] records when the setting is unset or blank.
fn configured_openai_sdk_version(lookup: impl FnOnce(&str) -> Option<String>) -> String {
    lookup(OPENAI_SDK_VERSION_ENV)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_openai_sdk_version().to_owned())
}

/// The process-wide SDK version, resolved once from the startup configuration
/// (the process environment, then the dotenv file).
fn openai_sdk_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION
        .get_or_init(|| configured_openai_sdk_version(crate::config::env_or_dotenv))
        .as_str()
}

/// [`OPENAI_CLIENT_HEADERS`] with the SDK-derived `user-agent` substituted.
///
/// The installed `openai` package derives `user-agent` and
/// `x-stainless-package-version` from one version string; the stainless
/// package-version header stays pinned to the recorded Source client, while
/// every other entry — including `user-agent` — keeps its configured identity.
fn openai_client_headers(version: &str) -> Vec<(&'static str, String)> {
    OPENAI_CLIENT_HEADERS
        .iter()
        .map(|(name, value)| match *name {
            "user-agent" => (*name, format!("AsyncOpenAI/Python {version}")),
            _ => (*name, (*value).to_string()),
        })
        .collect()
}

/// Apply the client identity to an outbound model request. Both the streaming
/// chat-shell path and the executor-manager dispatch use this so their client
/// identity cannot drift apart.
pub(crate) fn apply_openai_client_headers(
    mut request: brz_http::RequestBuilder,
) -> brz_http::RequestBuilder {
    for (name, value) in openai_client_headers(openai_sdk_version()) {
        request = request.header(name, value);
    }
    request
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header<'a>(headers: &'a [(&'static str, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(header, _)| *header == name)
            .map(|(_, value)| value.as_str())
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
        // A deployment legitimately runs another installed SDK version, so
        // compare `user-agent` against the effective configured version; the
        // stainless package-version stays the recorded Source client and every
        // other header keeps the constant.
        let version = openai_sdk_version();
        for (name, value) in OPENAI_CLIENT_HEADERS {
            let expected = match *name {
                "user-agent" => format!("AsyncOpenAI/Python {version}"),
                _ => (*value).to_string(),
            };
            assert_eq!(
                headers.get(*name).and_then(|value| value.to_str().ok()),
                Some(expected.as_str()),
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
    fn an_unset_sdk_version_keeps_the_recorded_client_identity() {
        // Unset configuration: the constant block is the identity.
        let version = configured_openai_sdk_version(|_| None);
        assert_eq!(version, "3.37.0");
        let headers = openai_client_headers(&version);
        assert_eq!(
            header(&headers, "user-agent"),
            Some("AsyncOpenAI/Python 3.37.0")
        );
        assert_eq!(
            header(&headers, "x-stainless-package-version"),
            Some("3.42.1")
        );
        for (name, value) in OPENAI_CLIENT_HEADERS {
            assert_eq!(
                header(&headers, name),
                Some(*value),
                "unrelated header {name} changed"
            );
        }
    }

    #[test]
    fn a_blank_sdk_version_keeps_the_recorded_client_identity() {
        // A blank setting counts as absent, matching the dotenv semantics.
        let version = configured_openai_sdk_version(|_| Some("   ".to_string()));
        assert_eq!(version, "3.37.0");
        assert_eq!(
            header(
                &openai_client_headers(&version),
                "x-stainless-package-version"
            ),
            Some("3.42.1")
        );
    }

    #[test]
    fn the_stainless_package_version_is_the_recorded_source_client() {
        // The recorded executor dependency pins the package-version header to
        // the Source's installed `openai` client, independent of the SDK
        // identity the deployment configures for `user-agent`.
        let headers = openai_client_headers("9.9.9");
        assert_eq!(
            header(&headers, "x-stainless-package-version"),
            Some("3.42.1")
        );
        assert_eq!(
            header(&headers, "user-agent"),
            Some("AsyncOpenAI/Python 9.9.9")
        );
    }

    #[test]
    fn a_configured_sdk_version_moves_only_the_user_agent() {
        // The setting selects the installed SDK `user-agent`; the stainless
        // package-version header remains the recorded Source client.
        let version = configured_openai_sdk_version(|name| {
            (name == OPENAI_SDK_VERSION_ENV).then(|| " 3.39.0 ".to_string())
        });
        assert_eq!(version, "3.39.0");
        let headers = openai_client_headers(&version);
        assert_eq!(
            header(&headers, "user-agent"),
            Some("AsyncOpenAI/Python 3.39.0")
        );
        assert_eq!(
            header(&headers, "x-stainless-package-version"),
            Some("3.42.1")
        );
        for (name, value) in OPENAI_CLIENT_HEADERS {
            if *name == "user-agent" {
                continue;
            }
            assert_eq!(
                header(&headers, name),
                Some(*value),
                "unrelated header {name} changed"
            );
        }
    }
}
