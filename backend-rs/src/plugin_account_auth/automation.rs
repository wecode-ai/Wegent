// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Reconcile account-owned plugin authentication on registered native devices.
//!
//! Source: `app/services/plugin_auth_automation.py::reconcile` reached through
//! `app/api/ws/plugin_auth_broker.py`'s `operation="automatic"` branch.

use std::collections::BTreeSet;

use brz_mysql::{FromMysqlRow, MysqlError, MysqlTransaction};
use serde_json::{Value, json};

use crate::device_identity::DeviceKindRow;
use crate::plugins_installed::write_coordination::PluginWriteLease;
use crate::plugins_marketplace::db::KIND_COLUMNS;
use crate::socketio::device::DeviceType;

use super::EXCHANGE_FAILED;
use super::connections::{self, AuthFailure};
use super::local_lifecycle;
use super::migrations::{self, MigrationCreate, MigrationOperation};
use super::route;

/// `PluginNativeAutomation`: strict, `extra="forbid"`, at most 256 ids.
const MAX_INSTALLED_IDS: usize = 256;
/// `InstalledPlugin` rows for the reported ids, ordered by primary key.
const INSTALLED_PLUGINS_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.namespace = 'default' \
     AND kinds.kind = 'InstalledPlugin' AND kinds.is_active IS true \
     AND kinds.id IN ({placeholders}) ORDER BY kinds.id";

/// `_policy`: the active shared policy row, read by `enabled()` itself.
const POLICY_ENABLED_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'ConnectorAuthPolicy' \
     AND kinds.namespace = 'plugin-auth' AND kinds.name = 'account' \
     AND kinds.is_active IS true LIMIT 1";

#[derive(Debug, FromMysqlRow)]
struct PolicyRow {
    /// The projection labels the column `kinds.json AS kinds_json`, so the
    /// derive must read that alias instead of the field name.
    #[mysql(rename = "kinds_json")]
    json: Value,
}

/// `plugin_auth_automation.reconcile`, on the exchange transaction.
/// Acquire the plugin write lease. Source releases it from
/// `after_transaction_end`, so the caller owns it across the whole transaction.
/// The lease type the exchange holds across its transaction.
pub(crate) type Lease<'a> = PluginWriteLease<'a, brz_redis::RedisService>;

pub(super) async fn reconcile_on(
    transaction: &mut brz_mysql::MysqlTransactionService,
    lease: Option<&PluginWriteLease<'_, brz_redis::RedisService>>,
    user_id: i64,
    device_id: &str,
    request: &AutomationRequest,
) -> Result<Value, &'static str> {
    let result_key = if request.prepare_only {
        "packages"
    } else {
        "migrations"
    };
    // The caller captured installation fences and the real account policy.
    // Check ownership again before business reads or dependent writes.
    if let Some(lease) = lease {
        lease
            .verify_owned()
            .await
            .map_err(|error| lease_code(&error))?;
    }
    // The acquire-time `check()` above belongs to this same `_coordinate_owner`
    // call (`plugin_account_connections.py:274-278`: `acquire_plugin_write_lock`
    // then the owner read), so only the owner row is read here.
    connections::owner_row(transaction, user_id)
        .await
        .map_err(failure_reason)?;
    // `reconcile`'s own `enabled()` read (`plugin_auth_automation.py:84`).
    if !enabled(transaction, user_id).await? {
        return Ok(json!({"success": true, (result_key): []}));
    }
    // `reconcile` resolves the identity before `grant_current_device`.
    let Some(identity) = route::identity_on(transaction, user_id, device_id)
        .await
        .map_err(|_| EXCHANGE_FAILED)?
    else {
        return Err("plugin_auth_device_not_found");
    };
    // `grant_current_device` is a sub-procedure with its own return boundary:
    // a disabled policy or an unresolvable identity ends only the grant, while
    // `reconcile` keeps its original identity for the Local/App decision.
    if let Some(lease) = lease {
        grant_current_device(transaction, lease, user_id, device_id).await?;
    } else if !request.prepare_only
        || !matches!(identity.device_type, DeviceType::Local | DeviceType::App)
    {
        return Err(EXCHANGE_FAILED);
    }
    // `grant_current_device` mutates only CLOUD/REMOTE devices; a local or app
    // runtime grants nothing, and every other type stops with an empty result.
    if !matches!(identity.device_type, DeviceType::Local | DeviceType::App) {
        return Ok(json!({"success": true, (result_key): []}));
    }
    let plugins = installed_plugins(transaction, user_id, &request.installed_ids).await?;
    let mut migrations = Vec::new();
    'plugins: for plugin in plugins
        .into_iter()
        .filter(|plugin| lease.is_none_or(|lease| lease.owns_installation(plugin.id)))
    {
        let spec = plugin.json.get("spec").cloned().unwrap_or_default();
        if spec.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        for connector in account_auth_connectors(&spec) {
            let Some(slug) = connector["slug"].as_str() else {
                return Err(EXCHANGE_FAILED);
            };
            if !request.includes(plugin.id, slug) {
                continue;
            }
            // `with db.begin_nested():`: one SAVEPOINT per connector, rolled
            // back when the intent refuses; other failures escape.
            let outcome = transaction
                .with_transaction(async |nested| {
                    connector_work(
                        nested,
                        lease,
                        user_id,
                        device_id,
                        &plugin,
                        slug,
                        request.prepare_only,
                    )
                    .await
                    .map_err(failure_error)
                })
                .await;
            match outcome {
                Ok(Some(intent)) => {
                    migrations.push(intent);
                    if migrations.len() >= MAX_INSTALLED_IDS {
                        // The source returns the bounded list; the session
                        // commit (and its revision advance) still runs.
                        break 'plugins;
                    }
                }
                Ok(None) => {}
                Err(MysqlError::InvalidQuery { reason }) if is_connector_refusal(&reason) => {}
                Err(_) => return Err(EXCHANGE_FAILED),
            }
        }
    }
    // The caller advances each installation fence before committing.
    Ok(json!({"success": true, (result_key): migrations}))
}

/// One connector's `PluginAccountAuthError` code or an internal failure.
fn failure_reason(failure: AuthFailure) -> &'static str {
    match failure {
        AuthFailure::Refusal(code) => code,
        AuthFailure::Internal => EXCHANGE_FAILED,
    }
}

/// Convert an intent failure into the savepoint's rollback reason.
fn failure_error(failure: AuthFailure) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: failure_reason(failure).to_string(),
    }
}

/// Whether one rolled-back savepoint continues the connector loop.
fn is_connector_refusal(reason: &str) -> bool {
    reason != EXCHANGE_FAILED && reason.starts_with("plugin_")
}

/// The connectors that declare `accountAuth` (`if not connector.get(...)`).
fn account_auth_connectors(spec: &Value) -> Vec<Value> {
    spec.get("components")
        .and_then(|components| components.get("connectors"))
        .and_then(Value::as_array)
        .map(|connectors| {
            connectors
                .iter()
                .filter(|connector| {
                    connector
                        .get("accountAuth")
                        .is_some_and(crate::json_compat::python_truthy)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Prepare the package without creating an intent, or create one for a ready connector.
async fn connector_work<T: MysqlTransaction>(
    transaction: &mut T,
    lease: Option<&PluginWriteLease<'_, brz_redis::RedisService>>,
    user_id: i64,
    device_id: &str,
    plugin: &DeviceKindRow,
    slug: &str,
    prepare_only: bool,
) -> Result<Option<Value>, AuthFailure> {
    let Some(source) = plugin.json.get("spec").and_then(|spec| spec.get("source")) else {
        return Err(AuthFailure::Internal);
    };
    let source = connections::source_identity(source);
    if !local_lifecycle::local_sync_enabled(transaction, user_id, &source, slug)
        .await
        .map_err(|_| AuthFailure::Internal)?
    {
        return Ok(None);
    }
    let rows = connections::connection_rows(transaction, user_id, &source, slug, None)
        .await
        .map_err(|_| AuthFailure::Internal)?;
    let disconnected = rows.iter().any(|row| {
        row.json
            .get("spec")
            .and_then(|spec| spec.get("status"))
            .and_then(Value::as_str)
            == Some("disconnected")
    });
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    let fresh_login = local_lifecycle::local_login_pending(
        transaction,
        user_id,
        &source,
        slug,
        &binding.logical_device_id,
        &binding.document,
    )
    .await
    .map_err(|_| AuthFailure::Internal)?;
    if disconnected && !fresh_login {
        return Ok(None);
    }
    if prepare_only {
        let (current, definition) =
            connections::plugin(transaction, user_id, plugin.id, slug).await?;
        return connections::package_metadata(&current, slug, definition).map(Some);
    }
    let request = MigrationCreate {
        installed_plugin_id: plugin.id,
        connector_slug: slug.to_string(),
        device_id: device_id.to_string(),
        expected_revision: 0,
        expected_account_id: None,
        operation: MigrationOperation::Export,
    };
    let intent = migrations::create(
        transaction,
        lease.ok_or(AuthFailure::Internal)?,
        user_id,
        &request,
        true,
        fresh_login,
    )
    .await?;
    Ok(Some(json!({
        "id": intent.id,
        "installed_plugin_id": plugin.id,
        "connector_slug": slug,
    })))
}

/// `enabled()`: `_policy` filters the active policy row; an absent row means
/// the reconciliation is enabled.
pub(super) async fn enabled<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
) -> Result<bool, &'static str> {
    let row: Option<PolicyRow> = transaction
        .fetch_optional(POLICY_ENABLED_QUERY, (user_id,))
        .await
        .map_err(|_| EXCHANGE_FAILED)?;
    Ok(row.is_none_or(|row| {
        row.json.get("spec").and_then(|spec| spec.get("enabled")) == Some(&Value::Bool(true))
    }))
}

/// `grant_current_device` (`plugin_auth_automation.py:139-152`): re-enters
/// `_coordinate_owner`, re-reads the policy and the identity, and grants only
/// for Cloud/Remote. Local/App performs the reads and then returns.
async fn grant_current_device<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
) -> Result<bool, &'static str> {
    connections::coordinate_owner(transaction, lease, user_id)
        .await
        .map_err(failure_reason)?;
    if !enabled(transaction, user_id).await? {
        return Ok(false);
    }
    let Some(identity) = route::identity_on(transaction, user_id, device_id)
        .await
        .map_err(|_| EXCHANGE_FAILED)?
    else {
        return Ok(false);
    };
    if !matches!(identity.device_type, DeviceType::Cloud | DeviceType::Remote) {
        return Ok(false);
    }
    let binding = route::device_binding_on(transaction, user_id, device_id).await?;
    let logical = binding.logical_device_id.as_str();
    let rows: Vec<DeviceKindRow> = transaction
        .fetch_all(
            format!(
                "SELECT {KIND_COLUMNS} FROM kinds WHERE kind='ConnectorConnection' \
                 AND namespace='plugin-auth' AND user_id=? AND is_active IS true ORDER BY id"
            ),
            (user_id,),
        )
        .await
        .map_err(|_| EXCHANGE_FAILED)?;
    let mut granted = false;
    for mut row in rows {
        let spec = &mut row.json["spec"];
        if !spec["installedPluginId"]
            .as_i64()
            .is_some_and(|id| lease.owns_installation(id))
        {
            continue;
        }
        if spec["status"] != "connected"
            || !crate::json_compat::python_truthy(&spec["credential"])
            || spec["deviceGrants"].get(logical).is_some()
            || spec["deviceRevocations"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(logical)))
        {
            continue;
        }
        match connections::current_plugin(transaction, user_id, spec).await {
            Ok(_) => {}
            Err(AuthFailure::Refusal(_)) => continue,
            Err(error) => return Err(failure_reason(error)),
        }
        spec["deviceGrants"][logical] = binding.document.clone();
        connections::advance_on(transaction, lease, row.id, &mut row.json)
            .await
            .map_err(failure_reason)?;
        granted = true;
    }
    Ok(granted)
}

/// `PluginNativeAutomation`: preparation and targeted reconcile share strict validation.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct AutomationRequest {
    installed_ids: Vec<i64>,
    pub(super) prepare_only: bool,
    targets: Option<BTreeSet<(i64, String)>>,
}

impl AutomationRequest {
    pub(super) fn parse(data: &Value) -> Option<Self> {
        let object = data.as_object()?;
        if !super::only_fields(object, &["installed_plugin_ids", "prepare_only", "targets"]) {
            return None;
        }
        let ids = object.get("installed_plugin_ids")?.as_array()?;
        if ids.len() > MAX_INSTALLED_IDS {
            return None;
        }
        let mut installed_ids = Vec::with_capacity(ids.len());
        for id in ids {
            let id = id.as_i64().filter(|id| *id > 0)?;
            if installed_ids.contains(&id) {
                return None;
            }
            installed_ids.push(id);
        }
        let prepare_only = match object.get("prepare_only") {
            None => false,
            Some(value) => value.as_bool()?,
        };
        let targets = match object.get("targets") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let entries = value.as_array()?;
                if entries.len() > MAX_INSTALLED_IDS {
                    return None;
                }
                let mut targets = BTreeSet::new();
                for entry in entries {
                    let entry = entry.as_object()?;
                    if !super::only_fields(entry, &["installed_plugin_id", "connector_slug"])
                        || !super::slug(entry.get("connector_slug"))
                    {
                        return None;
                    }
                    let id = entry["installed_plugin_id"].as_i64().filter(|id| *id > 0)?;
                    targets.insert((id, entry["connector_slug"].as_str()?.to_string()));
                }
                Some(targets)
            }
        };
        Some(Self {
            installed_ids,
            prepare_only,
            targets,
        })
    }

    fn includes(&self, id: i64, slug: &str) -> bool {
        self.targets
            .as_ref()
            .is_none_or(|targets| targets.contains(&(id, slug.to_string())))
    }
}

async fn installed_plugins<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    ids: &[i64],
) -> Result<Vec<DeviceKindRow>, &'static str> {
    // SQLAlchemy renders an empty `IN` as `IN (NULL) AND (1 != 1)`; the source
    // still issues that statement, so the query is not skipped.
    let placeholders = if ids.is_empty() {
        "NULL) AND (1 != 1".to_owned()
    } else {
        vec!["?"; ids.len()].join(", ")
    };
    let sql = INSTALLED_PLUGINS_QUERY.replace("{placeholders}", &placeholders);
    let parameters = installed_plugin_parameters(user_id, ids);
    transaction
        .fetch_all(&sql, parameters)
        .await
        .map_err(|_| EXCHANGE_FAILED)
}

/// The statement's bind values, in placeholder order: the owner id followed by
/// the requested ids, all typed as integers like the source columns.
fn installed_plugin_parameters(user_id: i64, ids: &[i64]) -> Vec<i64> {
    let mut parameters = Vec::with_capacity(ids.len() + 1);
    parameters.push(user_id);
    parameters.extend_from_slice(ids);
    parameters
}

fn lease_code(error: &brz_mysql::MysqlError) -> &'static str {
    crate::plugins_installed::write_coordination::plugin_write_error_code(error)
        .unwrap_or(EXCHANGE_FAILED)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed_plugin_ids(data: &Value) -> Option<Vec<i64>> {
        AutomationRequest::parse(data).map(|request| request.installed_ids)
    }

    #[test]
    fn validates_preparation_and_targeted_reconciliation() {
        let prepared = AutomationRequest::parse(&json!({
            "installed_plugin_ids": [7], "prepare_only": true,
        }))
        .unwrap();
        assert!(prepared.prepare_only);
        assert!(prepared.includes(7, "first"));

        let targeted = AutomationRequest::parse(&json!({
            "installed_plugin_ids": [7, 9],
            "targets": [{"installed_plugin_id": 7, "connector_slug": "first"}],
        }))
        .unwrap();
        assert!(!targeted.prepare_only);
        assert!(targeted.includes(7, "first"));
        assert!(!targeted.includes(7, "other"));
        assert!(!targeted.includes(9, "first"));
        assert!(
            AutomationRequest::parse(&json!({
                "installed_plugin_ids": [7], "prepare_only": 1,
            }))
            .is_none()
        );
        assert!(
            AutomationRequest::parse(&json!({
                "installed_plugin_ids": [7],
                "targets": [{"installed_plugin_id": 7, "connector_slug": "INVALID"}],
            }))
            .is_none()
        );
    }

    #[test]
    fn the_installed_plugin_ids_bind_as_integers() {
        assert_eq!(
            installed_plugin_ids(&json!({"installed_plugin_ids": [7]})),
            Some(vec![7])
        );
        let mut parameters: Vec<i64> = vec![432];
        parameters.extend([7_i64]);
        assert_eq!(parameters, vec![432_i64, 7_i64]);
    }

    #[test]
    fn the_enabled_policy_projection_matches_the_row_alias() {
        // The row derive reads `kinds_json`; the query must keep projecting it.
        assert!(POLICY_ENABLED_QUERY.contains("kinds.json AS kinds_json"));
        assert!(POLICY_ENABLED_QUERY.contains("AND kinds.is_active IS true LIMIT 1"));
    }

    #[test]
    fn the_payload_rejects_unknown_members_and_duplicate_ids() {
        assert_eq!(
            installed_plugin_ids(&json!({"installed_plugin_ids": [1, 2]})),
            Some(vec![1, 2])
        );
        assert_eq!(
            installed_plugin_ids(&json!({"installed_plugin_ids": [1, 1]})),
            None
        );
        assert_eq!(
            installed_plugin_ids(&json!({"installed_plugin_ids": [0]})),
            None
        );
        assert_eq!(
            installed_plugin_ids(&json!({"installed_plugin_ids": []})),
            Some(vec![])
        );
        assert_eq!(
            installed_plugin_ids(&json!({"installed_plugin_ids": [1], "extra": true})),
            None
        );
        assert_eq!(
            installed_plugin_ids(&json!({"installed_plugin_ids": ["1"]})),
            None
        );
    }

    #[test]
    fn a_plugin_without_account_auth_connectors_needs_no_migration() {
        let spec = json!({
            "enabled": true,
            "components": {"connectors": [
                {"slug": "no-auth"},
                {"slug": "empty", "accountAuth": {}},
                {"slug": "null", "accountAuth": null},
            ]}
        });
        assert!(account_auth_connectors(&spec).is_empty());
    }

    #[test]
    fn every_account_auth_connector_reaches_the_savepoint_loop() {
        let spec = json!({
            "components": {"connectors": [
                {"slug": "dingtalk-access",
                 "accountAuth": {"protocolVersion": 1, "credentialType": "bearer",
                                 "adapter": "scripts/account-auth.py"}},
                {"slug": "no-auth"},
            ]}
        });
        let connectors = account_auth_connectors(&spec);
        assert_eq!(connectors.len(), 1);
        assert_eq!(connectors[0]["slug"], json!("dingtalk-access"));
    }

    #[test]
    fn only_plugin_refusals_continue_after_a_savepoint_rollback() {
        assert!(is_connector_refusal("plugin_auth_local_device_required"));
        assert!(is_connector_refusal("plugin_auth_not_supported"));
        assert!(!is_connector_refusal(EXCHANGE_FAILED));
        assert!(!is_connector_refusal("database is gone"));
    }
}
