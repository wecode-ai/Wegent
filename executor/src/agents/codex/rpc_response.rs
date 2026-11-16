// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::diagnostics::raw_log_preview;

pub(super) fn response_result(message: Value, method: &str) -> Result<Value, String> {
    if let Some(fields) = error_fields(&message, method) {
        crate::logging::log_executor_event("codex JSON-RPC request failed", &fields);
    }
    if let Some(error) = message.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| raw_log_preview(error)));
    }
    Ok(message.get("result").cloned().unwrap_or_else(|| json!({})))
}

fn error_fields(message: &Value, method: &str) -> Option<[(&'static str, String); 3]> {
    let error = message.get("error")?;
    Some([
        ("method", method.to_owned()),
        (
            "request_id",
            message
                .get("id")
                .and_then(Value::as_u64)
                .map(|id| id.to_string())
                .unwrap_or_default(),
        ),
        ("rpc_error", raw_log_preview(error)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_structured_error_identity_and_redacts_sensitive_data() {
        let response = json!({
            "id": 42,
            "error": {
                "code": -32600,
                "message": "Configuration changed",
                "data": {
                    "config_write_error_code": "configVersionConflict",
                    "apiKey": "private-key",
                    "fileContent": "private-file",
                    "details": "Authorization: Bearer private-token"
                }
            }
        });
        let fields = error_fields(&response, "config/batchWrite").unwrap();
        assert_eq!(fields[0], ("method", "config/batchWrite".to_owned()));
        assert_eq!(fields[1], ("request_id", "42".to_owned()));
        let recorded: Value = serde_json::from_str(&fields[2].1).unwrap();
        assert_eq!(recorded["code"], -32600);
        assert_eq!(
            recorded["data"]["config_write_error_code"],
            "configVersionConflict"
        );
        assert!(!fields[2].1.contains("private-"));
        assert_eq!(
            response_result(response, "config/batchWrite").unwrap_err(),
            "Configuration changed"
        );
    }

    #[test]
    fn preserves_success_and_bounds_failed_response_diagnostics() {
        let response = json!({"id": 43, "result": {"status": "ok"}});
        assert!(error_fields(&response, "config/read").is_none());
        assert_eq!(
            response_result(response, "config/read").unwrap(),
            json!({"status": "ok"})
        );
        let response = json!({"id": 44, "error": {"message": "诊断".repeat(4000)}});
        let fields = error_fields(&response, "config/batchWrite").unwrap();
        assert!(fields[2].1.chars().count() <= 1201);
    }

    #[test]
    fn malformed_errors_cannot_disclose_credentials_through_the_returned_error() {
        let response = json!({
            "id": 45,
            "error": {"code": -32603, "data": {"apiKey": "private-key"}}
        });
        let error = response_result(response, "config/batchWrite").unwrap_err();
        let recorded: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(recorded["code"], -32603);
        assert_eq!(recorded["data"]["apiKey"], "[redacted]");
    }
}
