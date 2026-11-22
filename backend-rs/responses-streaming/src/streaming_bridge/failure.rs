// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Streaming transport failure classification and completion ordering.

use wegent_http_compat::FastApiError;

pub const SUBTASK_NOT_DISPATCHABLE: &str = "Assistant subtask is no longer dispatchable";

pub fn is_subtask_not_dispatchable(error: &FastApiError) -> bool {
    error.status() == brz_http_server::StatusCode::CONFLICT
        && error.detail_message() == Some(SUBTASK_NOT_DISPATCHABLE)
}

/// Where the dispatch-exit `unregister_stream` DEL sits relative to the
/// FAILED completion (`_dispatch_chat_shell_sse`'s `finally` versus the
/// dispatcher's `except` branch).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FailureOrder {
    /// A transport failure propagates out of the dispatch loop, so its
    /// `finally` runs before `ExecutionDispatcher.dispatch` persists the
    /// error through `emit_error`.
    DispatchExitFirst,
    /// The stream ended without a terminal event: the dispatcher emits a
    /// synthetic ERROR through the emitter (completion first), then exits.
    CompletionFirst,
}

/// One FAILED dispatch the dispatcher's `except` branch persists.
///
/// `error_code` is `classify_error`'s independent result
/// (`shared/utils/error_classifier.py`); it never follows from where the
/// dispatch exits. `collect_completed_result` writes a code into
/// `result.error_type` before the FAILED row is persisted.
#[derive(Debug)]
pub(super) struct BridgeFailure {
    pub(super) message: String,
    pub(super) error_code: Option<&'static str>,
    pub(super) terminal_winner: bool,
}

impl BridgeFailure {
    /// `APIConnectionError` and `_classify_by_message`'s `network` rules:
    /// every connection-establishment failure renders `"Connection error."`.
    pub(super) fn network(message: String) -> Self {
        Self {
            message,
            error_code: Some("network_error"),
            terminal_winner: false,
        }
    }

    /// `classify_error`'s `generic_error` fallback for an exception the SDK
    /// class map does not know and whose message matches no keyword rule.
    pub(super) fn generic(message: String) -> Self {
        Self {
            message,
            error_code: Some("generic_error"),
            terminal_winner: false,
        }
    }

    pub(super) fn dispatch(error: &FastApiError) -> Self {
        let mut failure = Self::generic(
            error
                .detail_message()
                .unwrap_or("Execution could not start")
                .to_owned(),
        );
        failure.terminal_winner = is_subtask_not_dispatchable(error);
        failure
    }

    /// The response read failed. The Source classifies the raised `httpx`
    /// exception by message (`_classify_by_message`), so apply the same
    /// network/timeout keyword rules before the generic fallback.
    pub(super) fn from_message(message: String) -> Self {
        let lower = message.to_ascii_lowercase();
        let network = [
            "network",
            "connection refused",
            "connection reset",
            "connection error",
            "not connected",
            "peer closed connection",
            "upstream connection interrupted",
        ];
        let timeout = ["timeout", "timed out"];
        let error_code = if timeout.iter().any(|pattern| lower.contains(pattern)) {
            "timeout_error"
        } else if network.iter().any(|pattern| lower.contains(pattern)) {
            "network_error"
        } else {
            "generic_error"
        };
        Self {
            message,
            error_code: Some(error_code),
            terminal_winner: false,
        }
    }

    /// `open_chat_shell`'s non-2xx response. The Source SDK raises a typed
    /// `APIStatusError`; `classify_error` maps its class
    /// (`RateLimitError` -> `rate_limit`, `AuthenticationError` /
    /// `PermissionDeniedError` -> `forbidden`, `NotFoundError` /
    /// `InternalServerError` -> `model_unavailable`) and falls back to message
    /// classification for the rest.
    pub(super) fn status(status: u16) -> Self {
        let error_code = match status {
            401 | 403 => "forbidden",
            404 => "model_unavailable",
            429 => "rate_limit",
            500..=599 => "model_unavailable",
            _ => "generic_error",
        };
        Self {
            message: format!("HTTP status code: {status}"),
            error_code: Some(error_code),
            terminal_winner: false,
        }
    }
}
