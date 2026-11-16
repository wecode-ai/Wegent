//! Local snapshots retain their source login independently of cloud synchronization.

use std::future::Future;

use serde_json::{json, Value};

use crate::local::app_ipc::AppIpcError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AccountAuth {
    None,
    Managed,
    LocalSnapshot,
}

impl AccountAuth {
    pub(super) fn from_connector(connector: &Value) -> Self {
        let definition = &connector["accountAuth"];
        if !definition.is_object() {
            Self::None
        } else if definition["credentialType"] == "bearer" {
            Self::LocalSnapshot
        } else {
            Self::Managed
        }
    }

    pub(super) async fn health(
        self,
        local: Result<Value, AppIpcError>,
        account: impl Future<Output = Result<Option<Value>, AppIpcError>>,
    ) -> Result<Value, AppIpcError> {
        // A cloud snapshot cannot replace the local credential that renews it.
        if self != Self::Managed || local.as_ref().is_ok_and(|value| value["status"] == "ok") {
            return local;
        }
        match account.await? {
            Some(status) => Ok(status),
            None => local,
        }
    }

    pub(super) async fn complete_login(
        self,
        mut local: Value,
        account: impl Future<Output = Result<Option<Value>, AppIpcError>>,
    ) -> Result<Value, AppIpcError> {
        if self == Self::None || local["status"] != "ok" {
            return Ok(local);
        }
        match account.await {
            Err(error) if self == Self::LocalSnapshot => {
                // Never forward provider text or imply that the cloud connection is ready.
                local["accountSyncStatus"] = json!("failed");
                crate::logging::log_executor_event(
                    "plugin auth local login synchronization failed",
                    &[("code", error.code)],
                );
                Ok(local)
            }
            Err(error) => Err(error),
            Ok(_) => Ok(local),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn local_snapshot_never_uses_cloud_status_to_hide_source_failure() {
        let mode = AccountAuth::from_connector(&json!({"accountAuth":{"credentialType":"bearer"}}));
        for local in [
            Ok(json!({"status":"need_login"})),
            Err(AppIpcError::new("local_auth_failed", "failed")),
        ] {
            let expected = local.as_ref().cloned().map_err(|error| error.code.clone());
            let actual = mode
                .health(local, async {
                    panic!("Cloud status must not authorize a local snapshot")
                })
                .await;
            assert_eq!(actual.map_err(|error| error.code), expected);
        }
    }

    #[tokio::test]
    async fn managed_health_can_still_reuse_an_account_after_exclusive_handoff() {
        let result = AccountAuth::Managed
            .health(Ok(json!({"status":"need_login"})), async {
                Ok(Some(json!({"status":"ok"})))
            })
            .await
            .unwrap();
        assert_eq!(result["status"], "ok");
    }

    #[tokio::test]
    async fn local_success_does_not_probe_the_cloud_for_any_account_type() {
        for mode in [
            AccountAuth::None,
            AccountAuth::Managed,
            AccountAuth::LocalSnapshot,
        ] {
            assert_eq!(
                mode.health(Ok(json!({"status":"ok"})), async {
                    panic!("Local health is authoritative")
                })
                .await
                .unwrap()["status"],
                "ok"
            );
        }
    }

    #[tokio::test]
    async fn snapshot_login_preserves_local_success_and_reports_sync_failure() {
        let result = AccountAuth::LocalSnapshot
            .complete_login(
                json!({"status":"ok", "sessionId":"synthetic-session"}),
                async {
                    Err(AppIpcError::new(
                        "plugin_auth_backend_unavailable",
                        "synthetic-secret",
                    ))
                },
            )
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({"status":"ok", "sessionId":"synthetic-session", "accountSyncStatus":"failed"})
        );
        assert!(!result.to_string().contains("synthetic-secret"));
    }

    #[tokio::test]
    async fn managed_login_rejections_remain_errors_and_snapshot_retry_clears_failure() {
        let error = AccountAuth::Managed
            .complete_login(json!({"status":"ok"}), async {
                Err(AppIpcError::new(
                    "plugin_auth_device_not_granted",
                    "rejected",
                ))
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, "plugin_auth_device_not_granted");
        let result = AccountAuth::LocalSnapshot
            .complete_login(json!({"status":"ok"}), async {
                Ok(Some(json!({"status":"ok"})))
            })
            .await
            .unwrap();
        assert_eq!(result, json!({"status":"ok"}));
    }

    #[tokio::test]
    async fn failed_local_login_and_unmanaged_login_never_start_account_sync() {
        for (mode, status) in [
            (AccountAuth::LocalSnapshot, "need_login"),
            (AccountAuth::None, "ok"),
        ] {
            let called = Cell::new(false);
            let result = mode
                .complete_login(json!({"status":status}), async {
                    called.set(true);
                    Ok(None)
                })
                .await
                .unwrap();
            assert_eq!(result["status"], status);
            assert!(!called.get());
        }
    }

    #[test]
    fn account_classification_preserves_password_oauth_and_local_only_connectors() {
        for kind in ["password", "oauth2"] {
            assert_eq!(
                AccountAuth::from_connector(&json!({"accountAuth":{"credentialType":kind}})),
                AccountAuth::Managed
            );
        }
        assert_eq!(
            AccountAuth::from_connector(&json!({"localAuth":{}})),
            AccountAuth::None
        );
    }
}
