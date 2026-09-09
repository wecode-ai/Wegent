//! Native revoke-only worker. No credential or provider output leaves this module.

use super::{
    migration::interpreter_for, resolve_managed_package, AuthError, Credential, NativeAdapter,
    NativeAuthGateway, OAuthOperation, PreparedPackage,
};
use crate::local::backend::LocalBackendTransport;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

pub async fn revoke_pending<T: LocalBackendTransport>(
    transport: T,
    home: &Path,
) -> Result<(), AuthError> {
    let gateway = NativeAuthGateway::new(transport);
    let response = gateway
        .call("plugin.auth.oauth.revocations", json!({}))
        .await?;
    let ids = response["connection_ids"]
        .as_array()
        .filter(|ids| ids.len() <= 10)
        .ok_or(AuthError("plugin_auth_invalid_response"))?;
    for id in ids {
        let id = identifier(id)?;
        // One unavailable provider must not prevent other queued revocations.
        let _ = revoke_one(&gateway, home, id).await;
    }
    Ok(())
}

fn identifier(value: &Value) -> Result<&str, AuthError> {
    value
        .as_str()
        .filter(|id| {
            id.len() == 64
                && id
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        .ok_or(AuthError("plugin_auth_invalid_response"))
}

async fn revoke_one<T: LocalBackendTransport>(
    gateway: &NativeAuthGateway<T>,
    home: &Path,
    connection_id: &str,
) -> Result<(), AuthError> {
    let lease = gateway
        .call(
            "plugin.auth.oauth.revoke_begin",
            json!({"connection_id": connection_id}),
        )
        .await?;
    if lease["state"] == "unavailable" {
        return Ok(());
    }
    if lease["state"] != "claimed" || lease["connection_id"] != connection_id {
        return Err(AuthError("plugin_auth_invalid_response"));
    }
    let operation_id = identifier(&lease["operation_id"])?;
    let succeeded = revoke_adapter(home, &lease).await.is_ok();
    let payload = json!({"connection_id": connection_id, "operation_id": operation_id, "succeeded": succeeded});
    let result = gateway
        .call("plugin.auth.oauth.revoke_finish", payload.clone())
        .await;
    match result {
        Err(AuthError("plugin_auth_backend_unavailable")) => {
            gateway
                .call("plugin.auth.oauth.revoke_finish", payload)
                .await?;
        }
        result => {
            result?;
        }
    }
    Ok(())
}

async fn revoke_adapter(home: &Path, lease: &Value) -> Result<(), AuthError> {
    let package: PreparedPackage = serde_json::from_value(lease["package"].clone())
        .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
    let root = resolve_managed_package(home, &package)?;
    let adapter = NativeAdapter::load(&root, &package.connector_slug, &package.auth_definition)?;
    let interpreter = interpreter_for(&package.auth_definition)?;
    let credential = Credential::from_json(
        lease["credential"]
            .as_str()
            .ok_or(AuthError("plugin_auth_invalid_response"))?,
    )?;
    adapter
        .oauth_operation(
            &interpreter,
            OAuthOperation::Revoke,
            Some(credential),
            Duration::from_secs(30),
        )
        .await?;
    Ok(())
}
