use serde_json::Value;

/// Classify native metadata without inferring a cause from human-readable text.
pub(crate) fn codex_error_type(error: &Value) -> Option<&'static str> {
    let info = error.get("codexErrorInfo")?;
    if let Some(name) = info.as_str() {
        return match name {
            "serverOverloaded" => Some("server_overloaded"),
            "rateLimitExceeded" => Some("rate_limit"),
            "usageLimitExceeded" => Some("quota_exceeded"),
            "contextWindowExceeded" => Some("context_length_exceeded"),
            "unauthorized" => Some("forbidden"),
            _ => None,
        };
    }
    let variants = info.as_object()?;
    if variants
        .values()
        .any(|value| value.get("httpStatusCode").and_then(Value::as_u64) == Some(429))
    {
        return Some("rate_limit");
    }
    if variants.values().any(|value| {
        matches!(
            value.get("httpStatusCode").and_then(Value::as_u64),
            Some(408 | 504)
        )
    }) {
        return Some("timeout_error");
    }
    variants
        .keys()
        .any(|name| {
            matches!(
                name.as_str(),
                "httpConnectionFailed"
                    | "responseStreamConnectionFailed"
                    | "responseStreamDisconnected"
                    | "responseTooManyFailedAttempts"
            )
        })
        .then_some("network_error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_native_metadata_independently_of_message() {
        for (info, expected) in [
            (json!("serverOverloaded"), Some("server_overloaded")),
            (json!("rateLimitExceeded"), Some("rate_limit")),
            (
                json!({"httpConnectionFailed": {"httpStatusCode": 504}}),
                Some("timeout_error"),
            ),
            (
                json!({"responseStreamDisconnected": {"httpStatusCode": 429}}),
                Some("rate_limit"),
            ),
            (
                json!({"httpConnectionFailed": {"httpStatusCode": 503}}),
                Some("network_error"),
            ),
            (json!("unknown"), None),
            (Value::Null, None),
        ] {
            assert_eq!(
                codex_error_type(&json!({"codexErrorInfo": info, "message": "429 overloaded"})),
                expected
            );
        }
    }

    #[test]
    fn retains_terminal_type_and_clears_it_for_the_next_turn() {
        let mut state = super::super::CodexRunState::default();
        let error = json!({"codexErrorInfo": "serverOverloaded", "message": "Disconnected"});
        assert!(state
            .handle_message(&json!({"method": "error", "params": {
                "error": error, "willRetry": true,
            }}))
            .is_none());
        assert_eq!(state.error_type, None);
        assert!(state
            .handle_message(&json!({"method": "error", "params": {
                "error": error, "willRetry": false,
            }}))
            .is_some());
        assert_eq!(state.error_type.as_deref(), Some("server_overloaded"));
        state.handle_message(&json!({"method": "turn/started", "params": {}}));
        assert_eq!(state.error_type, None);
        let result = super::super::completed_native_codex_turn(
            "thread",
            &json!({
                "id": "turn", "status": "failed", "error": error, "items": [],
            }),
        );
        assert_eq!(result.error_type.as_deref(), Some("server_overloaded"));
    }
}
