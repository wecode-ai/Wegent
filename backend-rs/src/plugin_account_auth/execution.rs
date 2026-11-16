// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_mysql::MysqlTransaction;
use serde_json::{Value, json};

use super::connections::{self, AuthFailure};
use super::credential_cipher::CredentialCipher;
use super::{native_credential, route};
use crate::device_identity::DeviceKindRow;

pub(super) async fn execute_on<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    data: &Value,
) -> Result<Value, AuthFailure> {
    let (row, package, raw) = resolve_on(transaction, user_id, device_id, data).await?;
    let credential = business_credential(&row.json["spec"], raw)?;
    Ok(json!({"success": true, "package": package, "credential": credential}))
}

pub(super) async fn resolve_on<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    data: &Value,
) -> Result<(DeviceKindRow, Value, String), AuthFailure> {
    let id = data["installed_plugin_id"]
        .as_i64()
        .ok_or(AuthFailure::Internal)?;
    let slug = data["connector_slug"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let (plugin, definition) = connections::plugin(transaction, user_id, id, slug).await?;
    let package = connections::package_metadata(&plugin, slug, definition)?;
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    let source = connections::source_identity(&plugin.json["spec"]["source"]);
    let rows = connections::connection_rows(
        transaction,
        user_id,
        &source,
        slug,
        data["account_id"].as_str(),
    )
    .await
    .map_err(|_| AuthFailure::Internal)?;
    let mut candidates = rows.into_iter().filter(|row| {
        let spec = &row.json["spec"];
        spec["installedPluginId"] == id
            && spec["status"] == "connected"
            && spec["deviceGrants"]
                .get(&binding.logical_device_id)
                .is_some()
    });
    let row = candidates
        .next()
        .ok_or(AuthFailure::Refusal("plugin_auth_device_not_granted"))?;
    if candidates.next().is_some() {
        return Err(AuthFailure::Refusal(
            "plugin_auth_account_selection_required",
        ));
    }
    let spec = &row.json["spec"];
    let raw = authorized_credential_on(transaction, user_id, device_id, spec).await?;
    Ok((row, package, raw))
}

pub(super) async fn read_on<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    data: &Value,
) -> Result<Value, AuthFailure> {
    let name = data["connection_id"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let row = connections::find_connection(transaction, user_id, name)
        .await?
        .ok_or(AuthFailure::Refusal("plugin_auth_connection_not_found"))?;
    let spec = &row.json["spec"];
    require_connected(spec)?;
    if spec["revision"] != data["expected_revision"] {
        return Err(AuthFailure::Refusal("plugin_auth_revision_conflict"));
    }
    if spec["installedPluginId"] != data["installed_plugin_id"] {
        return Err(AuthFailure::Refusal("plugin_auth_plugin_mismatch"));
    }
    let raw = authorized_credential_on(transaction, user_id, device_id, spec).await?;
    let credential = business_credential(spec, raw)?;
    Ok(json!({"success": true, "credential": credential}))
}

pub(super) fn require_connected(spec: &Value) -> Result<(), AuthFailure> {
    if spec["status"] != "connected" || spec["credential"].is_null() {
        return Err(AuthFailure::Refusal("plugin_auth_disconnected"));
    }
    Ok(())
}

async fn authorized_credential_on<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    spec: &Value,
) -> Result<String, AuthFailure> {
    require_connected(spec)?;
    connections::current_plugin(transaction, user_id, spec).await?;
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    if spec["deviceGrants"].get(&binding.logical_device_id) != Some(&binding.document) {
        return Err(AuthFailure::Refusal("plugin_auth_device_not_granted"));
    }
    let context = connections::credential_context(user_id, spec);
    CredentialCipher::from_environment()?.decrypt(&spec["credential"], &context)
}

pub(super) fn business_credential(spec: &Value, raw: String) -> Result<String, AuthFailure> {
    if spec["credentialType"] != "oauth2" {
        return Ok(raw);
    }
    oauth_business_credential(&raw, super::revocations::unix_seconds())
}

fn oauth_business_credential(raw: &str, now: f64) -> Result<String, AuthFailure> {
    let mut payload = native_credential::oauth_payload(raw)?;
    if requires_refresh(&payload, now) {
        return Err(AuthFailure::Refusal("plugin_auth_refresh_required"));
    }
    let fields = payload.as_object_mut().ok_or(AuthFailure::Internal)?;
    for name in [
        "refresh_token",
        "provider_private",
        "client_secret",
        "persistent_code",
    ] {
        fields.shift_remove(name);
    }
    Ok(crate::json_compat::python_json_compact(&payload))
}

pub(super) fn requires_refresh(payload: &Value, now: f64) -> bool {
    payload["expires_at"]
        .as_f64()
        .is_some_and(|expires| expires <= now + 30.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn business_oauth_access_never_returns_refresh_material() {
        let raw = r#"{"access_token":"test","expires_at":131,"refresh_token":"private","provider_private":{},"client_secret":"private","persistent_code":"private"}"#;
        assert_eq!(
            oauth_business_credential(raw, 100.0).unwrap(),
            r#"{"access_token":"test","expires_at":131}"#
        );
        assert_eq!(
            oauth_business_credential(raw, 101.0),
            Err(AuthFailure::Refusal("plugin_auth_refresh_required"))
        );
    }
}
