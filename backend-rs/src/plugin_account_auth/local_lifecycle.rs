// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Local-login policy state for account-owned plugin authentication.
//!
//! Source: `app/services/plugin_auth_local_lifecycle.py:30-52`
//! (`policy_query`, `local_sync_enabled`, `local_login_pending`). The policy is
//! one `ConnectorLocalAuthPolicy` Kind per account source identity and
//! connector slug, named by the source's `sha256("{source}\n{slug}")`.

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

use crate::plugins_marketplace::db::KIND_COLUMNS;

use super::connections::{self, AuthFailure, CONNECTION_NAMESPACE, spec_string_equals};
use crate::device_identity::DeviceKindRow;
use crate::json_compat::python_json_value;

/// `LOCAL_POLICY_KIND`.
const LOCAL_POLICY_KIND: &str = "ConnectorLocalAuthPolicy";

/// `policy_query`: the caller's active local policy for one source + slug.
fn policy_query() -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.namespace = \
         '{CONNECTION_NAMESPACE}' AND kinds.kind = '{LOCAL_POLICY_KIND}' AND kinds.name = ? AND \
         kinds.is_active IS true LIMIT 1"
    )
}

/// The policy row's stored document (`kinds.json`).
#[derive(Debug, FromMysqlRow)]
struct LocalPolicyRow {
    #[mysql(rename = "kinds_json")]
    json: Value,
}

/// `policy_query`'s `name`: `sha256(f"{source}\n{slug}")`, hex encoded.
#[allow(
    dead_code,
    reason = "used by the plugin auth migration create/resume port in the next stage"
)]
pub(crate) fn policy_name(source: &str, slug: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    hasher.update(b"\n");
    hasher.update(slug.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// `local_sync_enabled`: an absent policy row keeps synchronization enabled.
#[allow(
    dead_code,
    reason = "used by the plugin auth migration create/resume port in the next stage"
)]
pub(crate) async fn local_sync_enabled<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    source: &str,
    slug: &str,
) -> MysqlResult<bool> {
    let name = policy_name(source, slug);
    let row: Option<LocalPolicyRow> = transaction
        .fetch_optional(policy_query(), (user_id, name))
        .await?;
    Ok(row.is_none_or(|row| sync_enabled(&row.json)))
}

/// `row.json["spec"]["enabled"] is True`.
#[allow(dead_code, reason = "used by the local policy predicates")]
pub(crate) fn sync_enabled(document: &Value) -> bool {
    document.get("spec").and_then(|spec| spec.get("enabled")) == Some(&Value::Bool(true))
}

/// `local_login_pending`: the policy remembers this device's binding as a
/// pending local login.
#[allow(
    dead_code,
    reason = "used by the plugin auth migration create/resume port in the next stage"
)]
pub(crate) async fn local_login_pending<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    source: &str,
    slug: &str,
    logical: &str,
    binding: &Value,
) -> MysqlResult<bool> {
    let name = policy_name(source, slug);
    let row: Option<LocalPolicyRow> = transaction
        .fetch_optional(policy_query(), (user_id, name))
        .await?;
    Ok(row.is_some_and(|row| login_pending(&row.json, logical, binding)))
}

/// `row.json["spec"].get("pendingLogins", {}).get(logical) == binding`.
#[allow(dead_code, reason = "used by the local policy predicates")]
pub(crate) fn login_pending(document: &Value, logical: &str, binding: &Value) -> bool {
    document
        .get("spec")
        .and_then(|spec| spec.get("pendingLogins"))
        .and_then(|pending| pending.get(logical))
        .is_some_and(|value| value == binding)
}

pub(super) async fn finish_login<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    source: &Value,
) -> Result<(), super::connections::AuthFailure> {
    use super::connections::AuthFailure;
    use crate::device_identity::DeviceKindRow;

    let identity = source["source_identity"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let slug = source["connector_slug"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let device = source["device_id"].as_str().ok_or(AuthFailure::Internal)?;
    let row: Option<DeviceKindRow> = transaction
        .fetch_optional(policy_query(), (user_id, policy_name(identity, slug)))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    if let Some(mut row) = row
        && login_pending(&row.json, device, &source["binding"])
    {
        row.json["spec"]["pendingLogins"]
            .as_object_mut()
            .ok_or(AuthFailure::Internal)?
            .remove(device);
        let document = crate::json_compat::python_json_value(&row.json);
        lease
            .verify_owned()
            .await
            .map_err(|_| AuthFailure::Internal)?;
        transaction
            .execute(
                "UPDATE kinds SET json=?, updated_at=now() WHERE id=?",
                (document.as_str(), row.id),
            )
            .await
            .map_err(|_| AuthFailure::Internal)?;
    }
    Ok(())
}

pub(super) async fn exchange_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    device_id: &str,
    plugin_id: i64,
    slug: &str,
    action: &str,
) -> Result<Value, AuthFailure> {
    use crate::socketio::device::DeviceType;

    connections::coordinate_owner(transaction, lease, user_id).await?;
    let local = super::route::identity_on(transaction, user_id, device_id)
        .await
        .map_err(|_| AuthFailure::Internal)?
        .is_some_and(|identity| {
            matches!(identity.device_type, DeviceType::Local | DeviceType::App)
        });
    if !local {
        return Err(AuthFailure::Refusal("plugin_auth_local_device_required"));
    }
    let plugin = if action == "logout" {
        connections::installed_plugin(transaction, user_id, plugin_id).await?
    } else {
        connections::plugin(transaction, user_id, plugin_id, slug)
            .await?
            .0
    };
    let spec = &plugin.json["spec"];
    let supports_local = spec["components"]["connectors"]
        .as_array()
        .is_some_and(|connectors| {
            connectors.iter().any(|connector| {
                connector["slug"] == slug
                    && crate::json_compat::python_truthy(&connector["localAuth"])
            })
        });
    if action != "logout" && !supports_local {
        return Err(AuthFailure::Refusal("plugin_auth_not_supported"));
    }
    let source = connections::source_identity(&spec["source"]);
    if action == "login" {
        let binding = super::route::device_binding_on(transaction, user_id, device_id)
            .await
            .map_err(AuthFailure::from_reason)?;
        set_policy(transaction, lease, user_id, &source, slug, Some(&binding)).await?;
        super::migrations::create(
            transaction,
            lease,
            user_id,
            &super::migrations::MigrationCreate {
                installed_plugin_id: plugin_id,
                connector_slug: slug.to_owned(),
                device_id: device_id.to_owned(),
                expected_revision: 0,
                expected_account_id: None,
                operation: super::migrations::MigrationOperation::Export,
            },
            true,
            true,
        )
        .await?;
        return Ok(json!({"success": true, "status": "ok"}));
    }
    let rows = connections::connection_rows(transaction, user_id, &source, slug, None)
        .await
        .map_err(|_| AuthFailure::Internal)?;
    if action == "logout" {
        logout(transaction, lease, user_id, device_id, &source, slug, rows).await?;
        return Ok(json!({"success": true, "status": "ok"}));
    }
    if !local_sync_enabled(transaction, user_id, &source, slug)
        .await
        .map_err(|_| AuthFailure::Internal)?
    {
        return Ok(json!({"success": true, "status": "need_login"}));
    }
    let binding = super::route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    for row in &rows {
        let spec = &row.json["spec"];
        if spec["status"] == "connected"
            && spec["deviceGrants"].get(&binding.logical_device_id) == Some(&binding.document)
        {
            connections::current_plugin(transaction, user_id, spec).await?;
            let status = if spec["oauthRefresh"]["state"] == "uncertain" {
                "need_login"
            } else {
                "ok"
            };
            return Ok(json!({"success": true, "status": status}));
        }
    }
    Ok(json!({"success": true, "status": (!rows.is_empty()).then_some("need_login")}))
}

async fn set_policy<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    source: &str,
    slug: &str,
    binding: Option<&super::route::DeviceBinding>,
) -> Result<(), AuthFailure> {
    let name = policy_name(source, slug);
    let row: Option<DeviceKindRow> = transaction
        .fetch_optional(policy_query(), (user_id, name.as_str()))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    let mut pending = serde_json::Map::new();
    if let Some(binding) = binding {
        pending = row
            .as_ref()
            .and_then(|row| row.json["spec"]["pendingLogins"].as_object())
            .cloned()
            .unwrap_or_default();
        pending.insert(binding.logical_device_id.clone(), binding.document.clone());
    }
    let document =
        python_json_value(&json!({"spec":{"enabled":binding.is_some(),"pendingLogins":pending}}));
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    if let Some(row) = row {
        transaction
            .execute(
                "UPDATE kinds SET json=?,updated_at=now() WHERE id=?",
                (document.as_str(), row.id),
            )
            .await
    } else {
        transaction.execute(
            "INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at)
             VALUES (?,'ConnectorLocalAuthPolicy',?,'plugin-auth',?,true,now(),now())",
            (user_id,name.as_str(),document.as_str()),
        ).await
    }
    .map_err(|_| AuthFailure::Internal)?;
    Ok(())
}

async fn logout<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    device_id: &str,
    source: &str,
    slug: &str,
    rows: Vec<DeviceKindRow>,
) -> Result<(), AuthFailure> {
    let filter = format!(
        "user_id=? AND namespace='{CONNECTION_NAMESPACE}' AND is_active IS true AND {} AND {}",
        spec_string_equals("source_identity"),
        spec_string_equals("connector_slug")
    );
    let pending: Option<(i64,)> = transaction
        .fetch_optional(
            format!("SELECT id FROM kinds WHERE kind='ConnectorTransfer' AND {filter} LIMIT 1"),
            (user_id, source, slug),
        )
        .await
        .map_err(|_| AuthFailure::Internal)?;
    if pending.is_some() {
        return Err(AuthFailure::Refusal("plugin_auth_transfer_pending"));
    }
    set_policy(transaction, lease, user_id, source, slug, None).await?;
    transaction.execute(
        format!("UPDATE kinds SET is_active=false,updated_at=now() WHERE kind='ConnectorMigration' AND {filter}"),
        (user_id, source, slug),
    ).await.map_err(|_| AuthFailure::Internal)?;
    for row in rows
        .into_iter()
        .filter(|row| row.json["spec"]["status"] == "connected")
    {
        let mut document = row.json;
        let spec = &mut document["spec"];
        if spec["credentialType"] == "oauth2" {
            let binding = super::route::device_binding_on(transaction, user_id, device_id)
                .await
                .map_err(AuthFailure::from_reason)?;
            let supports_revoke = spec["authDefinition"]["oauth2"]
                .as_array()
                .is_some_and(|operations| operations.iter().any(|operation| operation == "revoke"));
            spec["oauthRevocation"] = if supports_revoke {
                let mut devices = spec["deviceGrants"]
                    .as_object()
                    .cloned()
                    .ok_or(AuthFailure::Internal)?;
                devices.insert(binding.logical_device_id, binding.document);
                let refresh = &spec["oauthRefresh"];
                let state = refresh["state"].as_str();
                json!({
                    "state": if state == Some("uncertain") { "attention" } else { "pending" },
                    "credential": spec["credential"], "devices": devices, "attempts":0,
                    "nextAttemptAt": super::revocations::unix_seconds() as i64,
                    "refreshOperation": if matches!(state, Some("in_flight" | "uncertain")) { refresh["id"].clone() } else { Value::Null },
                    "waitUntil": if state == Some("in_flight") { refresh["expiresAt"].as_i64().unwrap_or(0) } else { 0 }
                })
            } else {
                json!({"state":"unsupported"})
            };
        }
        spec["status"] = json!("disconnected");
        spec["credential"] = Value::Null;
        spec["deviceGrants"] = json!({});
        connections::advance_on(transaction, lease, row.id, &mut document).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_policy_name_hashes_the_source_and_slug_with_a_newline() {
        // Recording 20261105200002 (case d7eae0ca), ledger 40718/40724.
        let source = "{\"catalogItemId\":\"2\",\"marketplace\":\"wework\",\"pluginKey\":\"dingtalk\",\
                      \"providerKey\":\"wegent-market\",\"type\":\"marketplace\"}";
        assert_eq!(
            policy_name(source, "dingtalk-access"),
            "12087f8308265afd8aa3d7d1d61fb25e58da5388ae5ad564d290336863420d62"
        );
    }

    #[test]
    fn synchronization_stays_enabled_without_a_policy_row() {
        assert!(sync_enabled(&json!({"spec": {"enabled": true}})));
        assert!(!sync_enabled(&json!({"spec": {"enabled": false}})));
        // Python's `is True` rejects truthy non-booleans.
        assert!(!sync_enabled(&json!({"spec": {"enabled": 1}})));
        assert!(!sync_enabled(&json!({"spec": {}})));
    }

    #[test]
    fn pending_logins_compare_the_whole_binding_document() {
        let document = json!({
            "spec": {
                "pendingLogins": {
                    "app-record-413598": {
                        "deviceRowId": 413598,
                        "runtimeDeviceId": "app-record-413598",
                        "runtimeInstanceId": "runtime-fdadf46bb2fca3961821c6ff",
                    }
                }
            }
        });
        // Python dict equality ignores key order.
        let binding = json!({
            "runtimeInstanceId": "runtime-fdadf46bb2fca3961821c6ff",
            "deviceRowId": 413598,
            "runtimeDeviceId": "app-record-413598",
        });
        assert!(login_pending(&document, "app-record-413598", &binding));
        assert!(!login_pending(
            &document,
            "app-record-413598",
            &json!({"deviceRowId": 413598})
        ));
        assert!(!login_pending(&document, "app-record-1", &binding));
        assert!(!login_pending(
            &json!({"spec": {}}),
            "app-record-413598",
            &binding
        ));
    }

    #[test]
    fn the_policy_query_keeps_the_recorded_predicates() {
        let sql = policy_query();
        assert!(sql.contains("SELECT kinds.id AS kinds_id"));
        assert!(sql.contains(
            "kinds.user_id = ? AND kinds.namespace = 'plugin-auth' AND kinds.kind = \
             'ConnectorLocalAuthPolicy' AND kinds.name = ? AND kinds.is_active IS true LIMIT 1"
        ));
    }
}
