// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{payload_to_value, Payload, Value, NAMESPACE};
use crate::local::backend::connection::retry::{AUTHENTICATION_ERROR, AUTHENTICATION_RATE_LIMITED};

pub(super) fn setup_error(payload: Payload, namespace: &str) -> String {
    let value = payload_to_value(payload);
    let error = match &value {
        Value::String(text) => text
            .strip_prefix("Received an ConnectError frame: ")
            .and_then(|json| serde_json::from_str::<Value>(json).ok())
            .unwrap_or_else(|| value.clone()),
        _ => value,
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or_default();
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(
        message,
        "Invalid or expired API key"
            | "Invalid or expired token"
            | "Invalid or revoked runner credential"
            | "Missing authentication token"
            | "No authentication token provided"
            | "invalid token"
    ) || matches!(code, "UNAUTHENTICATED" | "INVALID_TOKEN" | "TOKEN_EXPIRED")
    {
        if namespace == NAMESPACE {
            AUTHENTICATION_ERROR.to_owned()
        } else {
            "Socket.IO authentication failed: token is invalid or expired".to_owned()
        }
    } else if matches!(
        message,
        "Too many device connection attempts" | "Too many device authentication failures"
    ) || matches!(code, "RATE_LIMITED" | "AUTH_RATE_LIMITED")
    {
        if namespace == NAMESPACE {
            AUTHENTICATION_RATE_LIMITED.to_owned()
        } else {
            "Socket.IO authentication rate limited: waiting for the retry cooldown".to_owned()
        }
    } else if message == "Authentication service unavailable" {
        "Socket.IO namespace connection rejected: authentication service unavailable".to_owned()
    } else if message == "EngineIO Error" {
        "Socket.IO Engine.IO transport error".to_owned()
    } else {
        // The auth error may contain an arbitrary server payload. Never echo it
        // into logs, where it could expose the device's credential.
        "Socket.IO connection error".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_the_vendored_connect_error_callback_and_explains_pairing() {
        let error = setup_error(
            Payload::from(json!(
                "Received an ConnectError frame: {\"message\":\"Invalid or expired API key\"}"
            )),
            NAMESPACE,
        );
        assert_eq!(error, AUTHENTICATION_ERROR);
        assert!(error.contains("re-pair this device"));
    }

    #[test]
    fn storage_failure_does_not_request_new_credentials() {
        let error = setup_error(
            Payload::from(json!({
                "message": "Authentication service unavailable"
            })),
            NAMESPACE,
        );
        assert!(!error.starts_with("device authentication failed:"));
    }

    #[test]
    fn token_cooldown_uses_auth_backoff_without_telling_good_clients_to_re_pair() {
        use crate::local::backend::connection::retry::AUTHENTICATION_RETRY_PREFIX;

        let error = setup_error(Payload::from(json!(
            "Received an ConnectError frame: {\"message\":\"Too many device authentication failures\"}"
        )), NAMESPACE);
        assert_eq!(error, AUTHENTICATION_RATE_LIMITED);
        assert!(error.starts_with(AUTHENTICATION_RETRY_PREFIX));
        assert!(!error.contains("re-pair this device"));
    }

    #[test]
    fn unknown_error_does_not_echo_a_token_or_unbounded_payload() {
        let error = setup_error(
            Payload::from(json!({
                "message": "debug token=secret-device-token"
            })),
            NAMESPACE,
        );
        assert!(!error.contains("secret-device-token"));
    }
}

#[cfg(test)]
mod namespace_tests {
    use super::*;
    #[test]
    fn shared_runtime_namespace_does_not_request_device_pairing() {
        let error = setup_error(
            Payload::from(serde_json::json!({
                "message": "Invalid or expired token"
            })),
            "/wework-runtime",
        );
        assert_eq!(
            error,
            "Socket.IO authentication failed: token is invalid or expired"
        );
    }
}
