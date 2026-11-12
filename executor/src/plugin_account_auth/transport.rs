//! Credential exchange is a plugin boundary, independent of device routing.

use crate::local::backend::LocalBackendTransport;
use serde_json::Value;
use std::{future::Future, pin::Pin, time::Duration};

pub type PluginAuthFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// Native-only request/reply transport. Secrets must never enter renderer RPCs.
pub trait PluginAuthTransport: Clone + Send + Sync + 'static {
    fn available(&self, registered: bool) -> bool {
        registered
    }
    fn exchange<'a>(
        &'a self,
        operation: &'a str,
        payload: Value,
        timeout: Duration,
    ) -> PluginAuthFuture<'a>;
}

// Retain the released Socket protocol for cloud and legacy runtimes.
impl<T: LocalBackendTransport> PluginAuthTransport for T {
    fn exchange<'a>(
        &'a self,
        operation: &'a str,
        payload: Value,
        timeout: Duration,
    ) -> PluginAuthFuture<'a> {
        self.call(operation, payload, timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_account_auth::{ExecutionRequest, NativeAuthGateway};
    use serde_json::json;

    // This double intentionally cannot connect/register a device or emit events.
    #[derive(Clone)]
    struct AccountTransport;

    impl PluginAuthTransport for AccountTransport {
        fn exchange<'a>(
            &'a self,
            operation: &'a str,
            payload: Value,
            _: Duration,
        ) -> PluginAuthFuture<'a> {
            Box::pin(async move {
                assert_eq!(operation, "plugin.auth.execute");
                assert_eq!(payload["installed_plugin_id"], 42);
                Ok(json!({
                    "success": true,
                    "package": {
                        "installed_plugin_id": 42,
                        "connector_slug": "mail",
                        "checksum": format!("sha256:{}", "a".repeat(64)),
                        "auth_definition": {"protocolVersion": 1}
                    },
                    "credential": "{\"access_token\":\"test-only\"}"
                }))
            })
        }
    }

    #[tokio::test]
    async fn credential_gateway_requires_no_device_transport_contract() {
        let request = ExecutionRequest {
            installed_plugin_id: 42,
            connector_slug: "mail".into(),
            account_id: None,
            args: vec!["list".into()],
            working_directory: None,
        };
        let (package, _) = NativeAuthGateway::new(AccountTransport)
            .execution(&request)
            .await
            .expect("native exchange is independent of device registration");
        assert_eq!(package.installed_plugin_id, 42);
    }
}
