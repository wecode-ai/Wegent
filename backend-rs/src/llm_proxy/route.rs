// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Inbound header forwarding and route registration for the LLM proxy gateway.
//!
//! The source forwards every `x-wegent-upstream-header-*` header and the fixed
//! `RUNTIME_METADATA_HEADERS` set, which the function API's named-header
//! parameters cannot express; this hand-written [`Handler`] therefore owns the
//! route and reads the complete request header list.

use std::sync::Arc;

use brz_http_server::{
    AuthRequest, Handler, Header, IntoHttpError, IntoHttpResponse, Request, Response, StatusCode,
};

use crate::auth::{AppAuthenticator, SessionUser};
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::MODEL_TYPE_HEADER;

/// `UPSTREAM_HEADER_PREFIX`.
const UPSTREAM_HEADER_PREFIX: &str = "x-wegent-upstream-header-";

/// `PROTECTED_UPSTREAM_HEADERS` (normalized) plus the source's marker list.
const PROTECTED_UPSTREAM_HEADERS: [&str; 14] = [
    "accept",
    "authorization",
    "connection",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "proxy-authorization",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    MODEL_TYPE_HEADER,
];
/// `PROTECTED_UPSTREAM_HEADER_MARKERS`.
const PROTECTED_UPSTREAM_HEADER_MARKERS: [&str; 4] = ["api-key", "apikey", "credential", "token"];
/// `RUNTIME_METADATA_HEADERS`: Runtime request identity forwarded across the
/// cloud gateway. Names are compared lowercased, as Starlette exposes request
/// header names.
const RUNTIME_METADATA_HEADERS: [&str; 16] = [
    "openai-beta",
    "originator",
    "session-id",
    "thread-id",
    "user-agent",
    "x-client-request-id",
    "x-codex-beta-features",
    "x-codex-installation-id",
    "x-codex-parent-thread-id",
    "x-codex-turn-metadata",
    "x-codex-turn-state",
    "x-codex-window-id",
    "x-openai-internal-codex-responses-lite",
    "x-openai-memgen-request",
    "x-openai-subagent",
    "x-responsesapi-include-timing-metrics",
];

/// The migrated physical route (`llm_responses_proxy_endpoint`).
pub(crate) const ROUTE_PATH: &str = "/api/runtime-work/llm-responses-proxy/responses";
/// Route priority for the hand-written handler, matching the function API's
/// `(1 << 24) + specificity * 1024 + segment_count` rule for four literal path
/// segments.
const ROUTE_PRIORITY: usize = (1 << 24) + 4 * 1024 + 5;
/// `POST` in the platform router's method bitset
/// (`DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT`).
const POST_METHOD_BIT: u16 = 1 << 5;

/// The inbound request headers the proxy consumes.
///
/// Starlette exposes request header names lowercased and values decoded as
/// Latin-1, so this view mirrors `requests.headers.items()`: it keeps the wire
/// order for duplicate handling and decodes every byte to one character.
pub(super) struct InboundHeaders<'a> {
    headers: &'a [Header<'a>],
}

impl<'a> InboundHeaders<'a> {
    /// `headers.get(name)`; Starlette returns the first matching entry.
    pub(super) fn first(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case(name))
            .map(|header| latin1(header.value))
    }

    /// `_extract_custom_upstream_headers`: the Wework Runtime's forwarded
    /// identity headers with the `x-wegent-upstream-header-` prefix stripped,
    /// rejecting protected names.
    ///
    /// The source iterates every request header carrying the prefix, so this
    /// view forwards the complete set instead of a declared name list. The
    /// target name is the lowercased remainder, as produced by Starlette.
    pub(super) fn custom_upstream_headers(&self) -> Result<Vec<(String, String)>, FastApiError> {
        let mut custom: Vec<(String, String)> = Vec::new();
        for header in self.headers {
            let name = header.name.to_ascii_lowercase();
            let Some(target) = name.strip_prefix(UPSTREAM_HEADER_PREFIX) else {
                continue;
            };
            let target_name = target.trim();
            if target_name.is_empty() || target_name.starts_with('-') {
                return Err(FastApiError::detail(
                    StatusCode::BAD_REQUEST,
                    "Invalid custom upstream header name",
                ));
            }
            if is_protected_upstream_header(target_name) {
                return Err(FastApiError::detail(
                    StatusCode::BAD_REQUEST,
                    format!("Custom upstream header is protected: {target_name}"),
                ));
            }
            replace_header(&mut custom, target_name, latin1(header.value));
        }
        Ok(custom)
    }

    /// `_extract_runtime_metadata_headers`: preserve Runtime request identity
    /// across the cloud gateway. A repeated name keeps the last value, matching
    /// the source's dict comprehension.
    pub(super) fn runtime_metadata_headers(&self) -> Vec<(String, String)> {
        let mut runtime: Vec<(String, String)> = Vec::new();
        for header in self.headers {
            let name = header.name.to_ascii_lowercase();
            if !RUNTIME_METADATA_HEADERS.contains(&name.as_str()) {
                continue;
            }
            replace_header(&mut runtime, &name, latin1(header.value));
        }
        runtime
    }
}

/// Starlette decodes ASGI header bytes as Latin-1.
fn latin1(value: &[u8]) -> String {
    value.iter().map(|byte| char::from(*byte)).collect()
}

/// Replace an existing case-insensitive entry or append a new one.
fn replace_header(headers: &mut Vec<(String, String)>, name: &str, value: String) {
    if let Some(entry) = headers
        .iter_mut()
        .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
    {
        *entry = (name.to_string(), value);
    } else {
        headers.push((name.to_string(), value));
    }
}

/// `_is_protected_upstream_header`.
fn is_protected_upstream_header(name: &str) -> bool {
    let normalized = name.trim().to_lowercase().replace('_', "-");
    let parts: Vec<&str> = normalized.split('-').collect();
    PROTECTED_UPSTREAM_HEADERS.contains(&normalized.as_str())
        || parts.contains(&"auth")
        || parts.contains(&"authentication")
        || PROTECTED_UPSTREAM_HEADER_MARKERS
            .iter()
            .any(|marker| normalized.contains(marker))
}

/// `POST /api/runtime-work/llm-responses-proxy/responses`.
pub struct LlmResponsesProxyRoute {
    state: Arc<AppState>,
    upstream_http: brz_http::Client,
}

impl LlmResponsesProxyRoute {
    /// Builds the route handler over the shared application state.
    ///
    /// # Errors
    /// Returns an error when the dedicated upstream transport cannot be built.
    pub fn new(state: Arc<AppState>) -> anyhow::Result<Self> {
        Ok(Self {
            state,
            upstream_http: super::transport::build_http()?,
        })
    }
}

/// Route selection for the hand-written handler.
fn route_priority(path: &str, method: &str) -> Option<usize> {
    (path == ROUTE_PATH && method == "POST").then_some(ROUTE_PRIORITY)
}

/// Advertised methods for the matching path, so another method renders 405
/// rather than an unmatched 404.
fn route_methods(path: &str) -> u16 {
    if path == ROUTE_PATH {
        POST_METHOD_BIT
    } else {
        0
    }
}

impl Handler<AppAuthenticator> for LlmResponsesProxyRoute {
    fn route_priority(&self, path: &str, method: &str) -> Option<usize> {
        route_priority(path, method)
    }

    fn route_methods(&self, path: &str) -> u16 {
        route_methods(path)
    }

    async fn call<'a>(
        &'a self,
        request: Request<'a>,
        authenticator: &'a AppAuthenticator,
    ) -> Response {
        let deadline = tokio::time::Instant::now() + super::REQUEST_TIMEOUT;
        let authentication = brz_http_server::__private::authenticate_required(
            authenticator,
            AuthRequest::from_request(&request),
            request.response_arena(),
        );
        let user: SessionUser = match tokio::time::timeout_at(deadline, authentication).await {
            Ok(Ok(user)) => user,
            Ok(Err(response)) => return response,
            Err(_) => {
                return super::httpx_request_error("authentication exceeded the request deadline")
                    .into_http_error(request.response_arena());
            }
        };
        let headers = InboundHeaders {
            headers: request.headers(),
        };
        match super::proxy_llm_responses(
            &self.state,
            &self.upstream_http,
            &user.0,
            &headers,
            request.body(),
            deadline,
        )
        .await
        {
            Ok(reply) => reply.into_http_response(request.response_arena()),
            Err(error) => error.into_http_error(request.response_arena()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::merge_headers_case_insensitive;
    use super::*;

    #[test]
    fn protected_upstream_headers_match_source_rules() {
        assert!(is_protected_upstream_header("Authorization"));
        assert!(is_protected_upstream_header("x_api_key"));
        assert!(is_protected_upstream_header(MODEL_TYPE_HEADER));
        assert!(is_protected_upstream_header("x-my-auth-header"));
        assert!(!is_protected_upstream_header("x-runtime-action"));
    }

    #[test]
    fn custom_and_runtime_headers_follow_the_source_contract() {
        let headers = [
            Header {
                name: "x-wegent-upstream-header-x-runtime-action",
                value: b"wework",
            },
            Header {
                name: "x-wegent-upstream-header-x-runtime-session-id",
                value: b"runtime-1",
            },
            Header {
                name: "originator",
                value: b"Codex",
            },
            Header {
                name: "x-codex-window-id",
                value: b"w:4",
            },
            Header {
                name: "x-openai-subagent",
                value: b"1",
            },
            Header {
                name: "authorization",
                value: b"Bearer t",
            },
        ];
        let view = InboundHeaders { headers: &headers };
        assert_eq!(
            view.custom_upstream_headers().unwrap(),
            vec![
                ("x-runtime-action".to_string(), "wework".to_string()),
                ("x-runtime-session-id".to_string(), "runtime-1".to_string()),
            ]
        );
        assert_eq!(
            view.runtime_metadata_headers(),
            vec![
                ("originator".to_string(), "Codex".to_string()),
                ("x-codex-window-id".to_string(), "w:4".to_string()),
                ("x-openai-subagent".to_string(), "1".to_string()),
            ]
        );
        assert_eq!(view.first("AUTHORIZATION").as_deref(), Some("Bearer t"));
        assert!(view.first(MODEL_TYPE_HEADER).is_none());
    }

    #[test]
    fn protected_custom_upstream_header_is_rejected() {
        let headers = [Header {
            name: "x-wegent-upstream-header-authorization",
            value: b"Bearer caller",
        }];
        let error = InboundHeaders { headers: &headers }
            .custom_upstream_headers()
            .unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn invalid_custom_upstream_header_name_is_rejected() {
        let headers = [Header {
            name: "x-wegent-upstream-header--",
            value: b"v",
        }];
        assert!(
            InboundHeaders { headers: &headers }
                .custom_upstream_headers()
                .is_err()
        );
    }

    #[test]
    fn runtime_metadata_repeated_name_keeps_last_value() {
        let headers = [
            Header {
                name: "session-id",
                value: b"first",
            },
            Header {
                name: "Session-Id",
                value: b"second",
            },
        ];
        assert_eq!(
            InboundHeaders { headers: &headers }.runtime_metadata_headers(),
            vec![("session-id".to_string(), "second".to_string())]
        );
    }

    #[test]
    fn forwarded_provider_headers_match_the_recorded_contract() {
        // `EXECUTOR_ENV.DEFAULT_HEADERS` after placeholder processing: the
        // `wegent-agent-*` entries resolve empty and are stripped.
        let configured = vec![
            ("x-runtime-source".to_string(), "agent".to_string()),
            ("x-runtime-user".to_string(), "sample-user".to_string()),
            ("x-runtime-action".to_string(), "wegent".to_string()),
            ("x-runtime-executor".to_string(), "chat".to_string()),
            ("x-runtime-session-id".to_string(), String::new()),
        ];
        let inbound = [
            Header {
                name: "x-wegent-upstream-header-x-runtime-action",
                value: b"wework",
            },
            Header {
                name: "x-wegent-upstream-header-x-runtime-executor",
                value: b"codex",
            },
            Header {
                name: "x-wegent-upstream-header-x-runtime-session-id",
                value: b"runtime-42",
            },
            Header {
                name: "x-wegent-upstream-header-x-runtime-source",
                value: b"wegent-local",
            },
            Header {
                name: "x-wegent-upstream-header-x-runtime-user",
                value: b"sample-user",
            },
            Header {
                name: "originator",
                value: b"Codex",
            },
            Header {
                name: "session-id",
                value: b"01a142c2",
            },
            Header {
                name: "thread-id",
                value: b"01a142c2",
            },
            Header {
                name: "user-agent",
                value: b"Codex/0.163.0-alpha.5",
            },
            Header {
                name: "x-client-request-id",
                value: b"01a142c2",
            },
            Header {
                name: "x-codex-beta-features",
                value: b"remote_compaction_v2",
            },
            Header {
                name: "x-codex-turn-metadata",
                value: b"{\"turn\":1}",
            },
            Header {
                name: "x-codex-window-id",
                value: b"01a142c2:4",
            },
        ];
        let view = InboundHeaders { headers: &inbound };
        let custom = view.custom_upstream_headers().unwrap();
        let runtime = view.runtime_metadata_headers();
        let merged = merge_headers_case_insensitive([
            configured.as_slice(),
            custom.as_slice(),
            runtime.as_slice(),
        ]);
        let protocol = vec![
            ("Authorization".to_string(), "Bearer sk".to_string()),
            ("content-type".to_string(), "application/json".to_string()),
            ("accept".to_string(), "text/event-stream".to_string()),
        ];
        let merged = merge_headers_case_insensitive([merged.as_slice(), protocol.as_slice()]);
        let names: std::collections::BTreeSet<&str> =
            merged.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            std::collections::BTreeSet::from([
                "Authorization",
                "accept",
                "content-type",
                "originator",
                "session-id",
                "thread-id",
                "user-agent",
                "x-runtime-action",
                "x-runtime-executor",
                "x-runtime-session-id",
                "x-runtime-source",
                "x-runtime-user",
                "x-client-request-id",
                "x-codex-beta-features",
                "x-codex-turn-metadata",
                "x-codex-window-id",
            ])
        );
        let get = |name: &str| {
            merged
                .iter()
                .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("x-runtime-action"), Some("wework"));
        assert_eq!(get("x-runtime-user"), Some("sample-user"));
        assert_eq!(get("x-runtime-session-id"), Some("runtime-42"));
        assert_eq!(get("x-runtime-source"), Some("wegent-local"));
        assert_eq!(get("x-runtime-executor"), Some("codex"));
        assert_eq!(get("accept"), Some("text/event-stream"));
        assert_eq!(get("content-type"), Some("application/json"));
    }

    #[test]
    fn route_selects_only_the_assigned_method() {
        assert_eq!(route_priority(ROUTE_PATH, "POST"), Some(ROUTE_PRIORITY));
        assert_eq!(route_priority(ROUTE_PATH, "GET"), None);
        assert_eq!(route_priority("/api/other", "POST"), None);
        assert_eq!(route_methods(ROUTE_PATH), POST_METHOD_BIT);
        assert_eq!(route_methods("/api/other"), 0);
    }
}
