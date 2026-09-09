// SPDX-License-Identifier: Apache-2.0
//! Exchanges secrets only on the already authenticated native device socket.

use super::{AuthError, Credential, ExecutionRequest, ExportedCredential, PreparedPackage};
use crate::local::backend::LocalBackendTransport;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionMetadata {
    pub id: String,
    pub installed_plugin_id: u64,
    pub plugin_key: String,
    pub connector_slug: String,
    pub account_id: String,
    pub account_label: String,
    pub credential_type: String,
    pub status: String,
    pub revision: u64,
    pub device_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_revocation: Option<String>,
}

/// Must remain in the native host. Never expose call/read as a tool or IPC result.
pub struct NativeAuthGateway<T: LocalBackendTransport> {
    transport: T,
}

pub struct RefreshLease {
    pub connection_id: String,
    pub operation_id: String,
    pub package: PreparedPackage,
    pub credential: Credential,
}

impl<T: LocalBackendTransport> NativeAuthGateway<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    pub async fn prepare(
        &self,
        migration_id: &str,
    ) -> Result<super::migration::PreparedEnrollment, AuthError> {
        let response = self
            .call("plugin.auth.prepare", json!({"migration_id": migration_id}))
            .await?;
        Ok(super::migration::PreparedEnrollment {
            package: serde_json::from_value(response["package"].clone())
                .map_err(|_| AuthError("plugin_auth_invalid_response"))?,
            operation: serde_json::from_value(response["operation"].clone())
                .map_err(|_| AuthError("plugin_auth_invalid_response"))?,
        })
    }

    pub async fn begin_refresh(
        &self,
        request: &ExecutionRequest,
    ) -> Result<Option<RefreshLease>, AuthError> {
        let response = self
            .call(
                "plugin.auth.oauth.begin",
                json!({
                    "installed_plugin_id":request.installed_plugin_id,
                    "connector_slug":request.connector_slug,"account_id":request.account_id,
                }),
            )
            .await?;
        if response["state"] == "ready" {
            return Ok(None);
        }
        if response["state"] != "claimed" {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        let id = |key| {
            response[key]
                .as_str()
                .filter(|value| {
                    value.len() == 64
                        && value
                            .bytes()
                            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                })
                .map(str::to_owned)
                .ok_or(AuthError("plugin_auth_invalid_response"))
        };
        Ok(Some(RefreshLease {
            connection_id: id("connection_id")?,
            operation_id: id("operation_id")?,
            package: serde_json::from_value(response["package"].clone())
                .map_err(|_| AuthError("plugin_auth_invalid_response"))?,
            credential: Credential::from_json(
                response["credential"]
                    .as_str()
                    .ok_or(AuthError("plugin_auth_invalid_response"))?,
            )?,
        }))
    }

    pub async fn stage_transfer(
        &self,
        migration_id: &str,
        exported: ExportedCredential,
    ) -> Result<(), AuthError> {
        let payload = json!({
            "migration_id":migration_id,"account_id":exported.account_id,
            "credential":exported.credential.into_native_json(),
        });
        let response = self
            .transfer_call("plugin.auth.transfer.stage", payload)
            .await?;
        if response["state"] != "staged" && response["state"] != "completed" {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        Ok(())
    }

    pub async fn prepare_transfer(
        &self,
        migration_id: &str,
    ) -> Result<Option<(PreparedPackage, Credential)>, AuthError> {
        let response = self
            .call(
                "plugin.auth.transfer.prepare",
                json!({"migration_id":migration_id}),
            )
            .await?;
        if response["state"] == "completed" {
            return Ok(None);
        }
        if response["state"] != "staged" {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        let package = serde_json::from_value(response["package"].clone())
            .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
        let credential = Credential::from_json(
            response["credential"]
                .as_str()
                .ok_or(AuthError("plugin_auth_invalid_response"))?,
        )?;
        Ok(Some((package, credential)))
    }

    pub async fn abort_transfer(&self, migration_id: &str) -> Result<(), AuthError> {
        let response = self
            .transfer_call(
                "plugin.auth.transfer.abort",
                json!({"migration_id":migration_id}),
            )
            .await?;
        if response["state"] != "aborted" {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        Ok(())
    }

    pub async fn finish_transfer(
        &self,
        migration_id: &str,
    ) -> Result<ConnectionMetadata, AuthError> {
        let response = self
            .transfer_call(
                "plugin.auth.transfer.finish",
                json!({"migration_id":migration_id}),
            )
            .await?;
        serde_json::from_value(response["connection"].clone())
            .map_err(|_| AuthError("plugin_auth_invalid_response"))
    }

    async fn transfer_call(&self, event: &str, payload: Value) -> Result<Value, AuthError> {
        match self.call(event, payload.clone()).await {
            Err(AuthError("plugin_auth_backend_unavailable")) => self.call(event, payload).await,
            other => other,
        }
    }

    pub async fn finish_refresh(
        &self,
        connection_id: &str,
        operation_id: &str,
        result: Option<ExportedCredential>,
        attempted: bool,
    ) -> Result<(), AuthError> {
        let succeeded = result.is_some();
        let mut payload = json!({"connection_id":connection_id,"operation_id":operation_id,"succeeded":succeeded,"attempted":attempted});
        if let Some(result) = result {
            payload["account_id"] = json!(result.account_id);
            payload["credential"] = json!(result.credential.into_native_json());
        }
        let first = self.call("plugin.auth.oauth.finish", payload.clone()).await;
        let response = match first {
            Err(AuthError("plugin_auth_backend_unavailable")) => {
                self.call("plugin.auth.oauth.finish", payload).await?
            }
            other => other?,
        };
        let expected = if succeeded {
            "finished"
        } else if attempted {
            "uncertain"
        } else {
            "cancelled"
        };
        if response["state"] != expected {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        Ok(())
    }

    pub async fn execution(
        &self,
        request: &ExecutionRequest,
    ) -> Result<(PreparedPackage, Credential), AuthError> {
        let response = self
            .call(
                "plugin.auth.execute",
                json!({
                    "installed_plugin_id": request.installed_plugin_id,
                    "connector_slug": request.connector_slug,
                    "account_id": request.account_id,
                }),
            )
            .await?;
        let package = serde_json::from_value(response["package"].clone())
            .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
        let credential = Credential::from_json(
            response["credential"]
                .as_str()
                .ok_or(AuthError("plugin_auth_invalid_response"))?,
        )?;
        Ok((package, credential))
    }

    pub async fn enroll(
        &self,
        migration_id: &str,
        exported: ExportedCredential,
    ) -> Result<ConnectionMetadata, AuthError> {
        let response = self
            .call(
                "plugin.auth.enroll",
                json!({
                    "migration_id": migration_id,
                    "account_id": exported.account_id,
                    "credential": exported.credential.into_native_json(),
                }),
            )
            .await?;
        serde_json::from_value(response["connection"].clone())
            .map_err(|_| AuthError("plugin_auth_invalid_response"))
    }

    pub async fn read(&self, connection: &ConnectionMetadata) -> Result<Credential, AuthError> {
        let response = self
            .call(
                "plugin.auth.read",
                json!({
                    "connection_id": connection.id,
                    "installed_plugin_id": connection.installed_plugin_id,
                    "expected_revision": connection.revision,
                }),
            )
            .await?;
        Credential::from_json(
            response["credential"]
                .as_str()
                .ok_or(AuthError("plugin_auth_invalid_response"))?,
        )
    }

    pub(super) async fn call(&self, event: &str, payload: Value) -> Result<Value, AuthError> {
        let value = self
            .transport
            .call(event, payload, Duration::from_secs(15))
            .await
            .map_err(|_| AuthError("plugin_auth_backend_unavailable"))?;
        let response = if value.is_array() {
            value.get(0).cloned().unwrap_or(Value::Null)
        } else {
            value
        };
        if response["success"] != true {
            // Server/provider bodies are never forwarded into the model transcript.
            let code = match response["error"].as_str() {
                Some("plugin_auth_device_not_granted") => "plugin_auth_device_not_granted",
                Some("plugin_auth_refresh_required") => "plugin_auth_refresh_required",
                Some("plugin_auth_refresh_in_progress") => "plugin_auth_refresh_in_progress",
                Some("plugin_auth_reconnect_required") => "plugin_auth_reconnect_required",
                Some("plugin_auth_account_selection_required") => {
                    "plugin_auth_account_selection_required"
                }
                Some("plugin_auth_account_mismatch") => "plugin_auth_account_mismatch",
                Some("plugin_auth_package_sync_required") => "plugin_auth_package_sync_required",
                Some("plugin_auth_revision_conflict") => "plugin_auth_revision_conflict",
                Some("plugin_auth_migration_expired") => "plugin_auth_migration_expired",
                Some("plugin_auth_source_changed") => "plugin_auth_source_changed",
                Some("plugin_auth_keyring_unavailable") => "plugin_auth_keyring_unavailable",
                _ => "plugin_auth_exchange_rejected",
            };
            return Err(AuthError(code));
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::backend::{EventHandler, LocalBackendConfig};
    type TransportFuture<'a, T> =
        std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>>;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Transport {
        response: Value,
        calls: Arc<Mutex<Vec<(String, Value)>>>,
    }

    impl LocalBackendTransport for Transport {
        fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
        fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
        fn call<'a>(
            &'a self,
            event: &'a str,
            payload: Value,
            _: Duration,
        ) -> TransportFuture<'a, Value> {
            self.calls.lock().unwrap().push((event.to_owned(), payload));
            Box::pin(async { Ok(self.response.clone()) })
        }
        fn emit<'a>(&'a self, _: &'a str, _: Value) -> TransportFuture<'a, ()> {
            panic!("credentials must not use broadcast events")
        }
        fn on(&self, _: &str, _: EventHandler) {
            panic!("credentials must not use subscriptions")
        }
    }

    fn connection() -> ConnectionMetadata {
        ConnectionMetadata {
            id: "a".repeat(64),
            installed_plugin_id: 42,
            plugin_key: "mail".into(),
            connector_slug: "mail".into(),
            account_id: "alice".into(),
            account_label: "".into(),
            credential_type: "password".into(),
            status: "connected".into(),
            revision: 3,
            device_ids: vec!["device".into()],
            provider_revocation: None,
        }
    }

    #[tokio::test]
    async fn reads_are_scoped_to_connection_revision_and_never_assert_user_identity() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let gateway = NativeAuthGateway::new(Transport {
            response: json!([{"success":true,"credential":"{\"token\":\"synthetic\"}"}]),
            calls: calls.clone(),
        });
        let credential = gateway.read(&connection()).await.unwrap();
        assert_eq!(credential.into_native_json(), r#"{"token":"synthetic"}"#);
        let values = calls.lock().unwrap();
        assert_eq!(values[0].0, "plugin.auth.read");
        assert_eq!(
            values[0].1,
            json!({"connection_id":"a".repeat(64),"installed_plugin_id":42,"expected_revision":3})
        );
    }

    #[tokio::test]
    async fn enrollment_returns_only_typed_metadata_and_rejects_extra_secret_fields() {
        let mut value = serde_json::to_value(connection()).unwrap();
        value["credential"] = json!("synthetic-secret");
        let gateway = NativeAuthGateway::new(Transport {
            response: json!({"success":true,"connection":value}),
            calls: Arc::new(Mutex::new(Vec::new())),
        });
        let error = gateway
            .enroll(
                "migration",
                ExportedCredential {
                    account_id: "alice".into(),
                    credential: Credential::from_json(r#"{"token":"synthetic"}"#).unwrap(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error, AuthError("plugin_auth_invalid_response"));
    }

    #[tokio::test]
    async fn unknown_backend_errors_are_not_forwarded() {
        let gateway = NativeAuthGateway::new(Transport {
            response: json!({"success":false,"error":"synthetic-secret"}),
            calls: Arc::new(Mutex::new(Vec::new())),
        });
        let error = gateway.read(&connection()).await.err().unwrap();
        assert_eq!(error, AuthError("plugin_auth_exchange_rejected"));
    }
}
