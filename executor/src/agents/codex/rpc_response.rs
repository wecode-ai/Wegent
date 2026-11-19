// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::diagnostics::raw_log_preview;

#[derive(Clone, Copy)]
pub(super) enum CodexRpcOrigin {
    Shared(Option<u64>),
    Dedicated(Option<u64>),
}

pub(super) fn response_result(
    message: Value,
    method: &str,
    origin: CodexRpcOrigin,
) -> Result<Value, String> {
    if let Some(fields) = error_fields(&message, method, origin) {
        crate::logging::write_executor_error_line(&crate::logging::format_executor_log(
            "codex JSON-RPC request failed",
            &fields,
        ));
    }
    if let Some(error) = message.get("error") {
        let reason = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| raw_log_preview(error));
        if error.pointer("/data/reason").and_then(Value::as_str) == Some("cloudConfigBundle")
            && !super::is_codex_cloud_config_error(&reason)
        {
            return Err(format!("cloud config bundle: {reason}"));
        }
        return Err(reason);
    }
    Ok(message.get("result").cloned().unwrap_or_else(|| json!({})))
}

fn error_fields(
    message: &Value,
    method: &str,
    origin: CodexRpcOrigin,
) -> Option<[(&'static str, String); 6]> {
    let error = message.get("error")?;
    let (scope, generation) = match origin {
        CodexRpcOrigin::Shared(generation) => ("shared", generation),
        CodexRpcOrigin::Dedicated(generation) => ("dedicated", generation),
    };
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
        ("process_scope", scope.to_owned()),
        (
            "process_generation",
            generation.map_or_else(|| "unknown".to_owned(), |value| value.to_string()),
        ),
        ("executor_pid", std::process::id().to_string()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_rpc_failure_reaches_the_error_stream() {
        const CHILD: &str = "WEGENT_TEST_RPC_ERROR_STREAM_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let error = response_result(
                json!({"id": 57, "error": {
                    "code": -32600,
                    "message": "invalid config read parameters",
                    "data": {"apiKey": "rpc-stream-private-key"}
                }}),
                "config/read",
                CodexRpcOrigin::Shared(Some(9)),
            )
            .unwrap_err();
            assert_eq!(error, "invalid config read parameters");
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agents::codex::rpc_response::tests::native_rpc_failure_reaches_the_error_stream",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        let stderr = String::from_utf8(output.stderr).unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stderr.contains("codex JSON-RPC request failed"), "{stderr}");
        assert!(stderr.contains("method=config/read"));
        assert!(stderr.contains("process_scope=shared process_generation=9"));
        assert!(stderr.contains("-32600"));
        assert!(!stderr.contains("rpc-stream-private-key"));
        assert!(!stdout.contains("codex JSON-RPC request failed"));
    }

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
        let origin = CodexRpcOrigin::Shared(Some(7));
        let fields = error_fields(&response, "config/batchWrite", origin).unwrap();
        assert_eq!(fields[0], ("method", "config/batchWrite".to_owned()));
        assert_eq!(fields[1], ("request_id", "42".to_owned()));
        assert_eq!(fields[5], ("executor_pid", std::process::id().to_string()));
        let recorded: Value = serde_json::from_str(&fields[2].1).unwrap();
        assert_eq!(recorded["code"], -32600);
        assert_eq!(
            recorded["data"]["config_write_error_code"],
            "configVersionConflict"
        );
        assert!(!fields[2].1.contains("private-"));
        assert_eq!(
            response_result(response, "config/batchWrite", origin).unwrap_err(),
            "Configuration changed"
        );
    }

    #[test]
    fn preserves_success_and_bounds_failed_response_diagnostics() {
        let response = json!({"id": 43, "result": {"status": "ok"}});
        let origin = CodexRpcOrigin::Dedicated(Some(8));
        assert!(error_fields(&response, "config/read", origin).is_none());
        assert_eq!(
            response_result(response, "config/read", origin).unwrap(),
            json!({"status": "ok"})
        );
        let response = json!({"id": 44, "error": {"message": "诊断".repeat(4000)}});
        let fields = error_fields(&response, "config/batchWrite", origin).unwrap();
        assert!(fields[2].1.chars().count() <= 1201);
    }

    #[test]
    fn malformed_errors_cannot_disclose_credentials_through_the_returned_error() {
        let response = json!({
            "id": 45,
            "error": {"code": -32603, "data": {"apiKey": "private-key"}}
        });
        let error = response_result(
            response,
            "config/batchWrite",
            CodexRpcOrigin::Dedicated(None),
        )
        .unwrap_err();
        let recorded: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(recorded["code"], -32603);
        assert_eq!(recorded["data"]["apiKey"], "[redacted]");
    }

    #[test]
    fn equal_request_ids_remain_distinguishable_across_native_processes() {
        let response = json!({"id": 206, "error": {"code": -32600, "message": "thread not found"}});
        let fields = |origin| error_fields(&response, "mcpServerStatus/list", origin).unwrap();
        let shared = fields(CodexRpcOrigin::Shared(Some(2)));
        let dedicated = fields(CodexRpcOrigin::Dedicated(Some(3)));
        assert_eq!(&shared[..3], &dedicated[..3]);
        assert_eq!(shared[3], ("process_scope", "shared".to_owned()));
        assert_eq!(shared[4], ("process_generation", "2".to_owned()));
        assert_eq!(dedicated[3], ("process_scope", "dedicated".to_owned()));
        assert_eq!(dedicated[4], ("process_generation", "3".to_owned()));
        assert_ne!(shared, fields(CodexRpcOrigin::Shared(Some(4))));
        assert_eq!(
            fields(CodexRpcOrigin::Shared(None))[4],
            ("process_generation", "unknown".to_owned())
        );
    }
}
