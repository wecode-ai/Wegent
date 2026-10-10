//! Account revocation must fence synchronization before local credentials are removed.

use std::future::Future;

use serde_json::{json, Value};

use crate::local::app_ipc::AppIpcError;

pub(super) async fn complete(
    account: impl Future<Output = Result<Option<Value>, AppIpcError>>,
    local: impl Future<Output = Result<Value, AppIpcError>>,
) -> Result<Value, AppIpcError> {
    let account_revoked = account.await?.is_some();
    let result = local.await;
    match result {
        Ok(value) if value["status"] == "ok" => Ok(value),
        Ok(_) if account_revoked => Ok(partial_result("local_auth_logout_failed")),
        Err(error) if account_revoked => Ok(partial_result(&error.code)),
        Ok(value) => Ok(value),
        Err(error) => Err(error),
    }
}

fn partial_result(code: &str) -> Value {
    json!({"status":"error", "accountRevoked":true, "errorCode":code})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn rejection_does_not_poll_local_cleanup() {
        let called = Cell::new(false);
        let result = complete(
            async { Err(AppIpcError::new("plugin_auth_not_supported", "rejected")) },
            async {
                called.set(true);
                Ok(json!({"status":"ok"}))
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "plugin_auth_not_supported");
        assert!(!called.get());
    }

    #[tokio::test]
    async fn revocation_completes_before_cleanup_and_retry_is_idempotent() {
        for _ in 0..2 {
            let revoked = Cell::new(false);
            let result = complete(
                async {
                    revoked.set(true);
                    Ok(Some(json!({"status":"ok"})))
                },
                async {
                    assert!(revoked.get());
                    Ok(json!({"status":"ok"}))
                },
            )
            .await
            .unwrap();
            assert_eq!(result["status"], "ok");
        }
    }

    #[tokio::test]
    async fn partial_failure_reports_revocation_without_forwarding_cli_messages() {
        let result = complete(async { Ok(Some(json!({"status":"ok"}))) }, async {
            Err(AppIpcError::new(
                "local_auth_command_failed",
                "synthetic-secret",
            ))
        })
        .await
        .unwrap();
        assert_eq!(result, partial_result("local_auth_command_failed"));
        assert!(!result.to_string().contains("synthetic-secret"));
    }

    #[tokio::test]
    async fn non_ok_cli_result_does_not_become_success_after_revocation() {
        let result = complete(async { Ok(Some(json!({"status":"ok"}))) }, async {
            Ok(json!({"status":"error", "hint":"synthetic-secret"}))
        })
        .await
        .unwrap();
        assert_eq!(result, partial_result("local_auth_logout_failed"));
    }

    #[tokio::test]
    async fn local_only_connector_preserves_cleanup_errors() {
        let result = complete(async { Ok(None) }, async {
            Err(AppIpcError::new(
                "local_auth_command_failed",
                "cleanup failed",
            ))
        })
        .await;
        assert_eq!(result.unwrap_err().code, "local_auth_command_failed");
    }
}
