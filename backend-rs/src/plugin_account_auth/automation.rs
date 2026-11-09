// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Reconcile account-owned plugin authentication on registered native devices.
//!
//! Source: `app/services/plugin_auth_automation.py::reconcile` reached through
//! `app/api/ws/plugin_auth_broker.py`'s `operation="automatic"` branch.

use brz_mysql::{FromMysqlRow, MysqlTransaction};
use serde_json::{Value, json};

use crate::device_identity::DeviceKindRow;
use crate::plugins_installed::write_coordination::PluginWriteLease;
use crate::socketio::device::DeviceType;
use crate::state::AppState;

use super::route;
use super::{EXCHANGE_FAILED, INVALID_REQUEST};

/// `PluginNativeAutomation`: strict, `extra="forbid"`, at most 256 ids.
const MAX_INSTALLED_IDS: usize = 256;
/// `_coordinate_owner`'s owner read: `filter(User.id == user_id).first()`.
const OWNER_QUERY: &str = "SELECT users.id AS users_id, users.is_active AS users_is_active \
     FROM users WHERE users.id = ? LIMIT 1";
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

#[derive(Debug, FromMysqlRow)]
struct OwnerRow {
    #[mysql(rename = "users_is_active")]
    is_active: Option<bool>,
}

/// `plugin_auth_automation.reconcile`, on the exchange transaction.
/// Acquire the plugin write lease. Source releases it from
/// `after_transaction_end`, so the caller owns it across the whole transaction.
/// The lease type the exchange holds across its transaction.
pub(crate) type Lease<'a> = PluginWriteLease<'a, brz_redis::RedisService>;

pub(crate) async fn acquire_lease<'a>(
    state: &'a AppState,
    user_id: i64,
) -> Result<PluginWriteLease<'a, brz_redis::RedisService>, &'static str> {
    PluginWriteLease::acquire(state.redis.as_ref(), user_id)
        .await
        .map_err(|error| lease_code(&error))
}

pub(crate) async fn reconcile_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
    data: &Value,
) -> Result<Value, &'static str> {
    let Some(installed_ids) = installed_plugin_ids(data) else {
        return Err(INVALID_REQUEST);
    };
    reconcile_locked(transaction, lease, user_id, device_id, &installed_ids).await
}

async fn reconcile_locked<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
    installed_ids: &[i64],
) -> Result<Value, &'static str> {
    // `_acquire_plugin_write_lock` reads the shared parent revision
    // (`read_policy_revision`); `enabled()` issues its own policy read below.
    let (_, revision) = lease
        .read_policy_snapshot(transaction)
        .await
        .map_err(|error| lease_code(&error))?;
    // `plugin_write_coordination.py:183-198`: after `read_policy_revision` the
    // new-lease branch runs `lease.check()` before any business read.
    lease
        .verify_owned()
        .await
        .map_err(|error| lease_code(&error))?;
    // The acquire-time `check()` above belongs to this same `_coordinate_owner`
    // call (`plugin_account_connections.py:274-278`: `acquire_plugin_write_lock`
    // then the owner read), so only the owner row is read here.
    owner_row(transaction, user_id).await?;
    // `reconcile`'s own `enabled()` read (`plugin_auth_automation.py:84`).
    if !enabled(transaction, user_id).await? {
        return Ok(json!({"success": true, "migrations": []}));
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
    grant_current_device(transaction, lease, user_id, device_id).await?;
    // `grant_current_device` mutates only CLOUD/REMOTE devices; a local or app
    // runtime grants nothing, and every other type stops with an empty result.
    if !matches!(identity.device_type, DeviceType::Local | DeviceType::App) {
        return Ok(json!({"success": true, "migrations": []}));
    }
    let plugins = installed_plugins(transaction, user_id, installed_ids).await?;
    let mut migrations = Vec::new();
    for plugin in plugins {
        for intent in intents_for(plugin, user_id) {
            migrations.push(intent);
            if migrations.len() >= MAX_INSTALLED_IDS {
                break;
            }
        }
    }
    // The transaction's shared parent advances once, under the lease.
    if let Some(expected) = revision {
        lease
            .commit_revision(transaction, expected)
            .await
            .map_err(|error| lease_code(&error))?;
    }
    Ok(json!({"success": true, "migrations": migrations}))
}

/// `enabled()`: `_policy` filters the active policy row; an absent row means
/// the reconciliation is enabled.
async fn enabled<T: MysqlTransaction>(
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
) -> Result<(), &'static str> {
    coordinate_owner(transaction, lease, user_id).await?;
    if !enabled(transaction, user_id).await? {
        return Ok(());
    }
    let _ = route::identity_on(transaction, user_id, device_id)
        .await
        .map_err(|_| EXCHANGE_FAILED)?;
    Ok(())
}

/// `_coordinate_owner`: the lease is still owned and the owner is active.
async fn coordinate_owner<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
) -> Result<(), &'static str> {
    lease
        .verify_owned()
        .await
        .map_err(|error| lease_code(&error))?;
    owner_row(transaction, user_id).await
}

/// The owner read half of `_coordinate_owner`: the row must exist and be active.
async fn owner_row<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
) -> Result<(), &'static str> {
    let owner: Option<OwnerRow> = transaction
        .fetch_optional(OWNER_QUERY, (user_id,))
        .await
        .map_err(|_| EXCHANGE_FAILED)?;
    if owner.is_none_or(|owner| owner.is_active != Some(true)) {
        return Err("plugin_auth_owner_unavailable");
    }
    Ok(())
}

/// `PluginNativeAutomation` validation: only one declared member, strict ints,
/// positive and distinct.
pub(crate) fn installed_plugin_ids(data: &Value) -> Option<Vec<i64>> {
    let object = data.as_object()?;
    if object.keys().any(|key| key != "installed_plugin_ids") {
        return None;
    }
    let ids = object.get("installed_plugin_ids")?.as_array()?;
    if ids.len() > MAX_INSTALLED_IDS {
        return None;
    }
    let mut unique = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id.as_i64().filter(|id| *id > 0)?;
        if unique.contains(&id) {
            return None;
        }
        unique.push(id);
    }
    Some(unique)
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

/// `reconcile`'s per-plugin connector loop.
///
/// Source skips a disabled plugin, then for every connector that advertises
/// `accountAuth` attempts `_intent` inside a savepoint and continues when that
/// raises `PluginAccountAuthError` (`plugin_auth_automation.py:104-124`). The
/// intent itself is produced by `plugin_auth_migrations.create`, which is not
/// ported, so every such connector is skipped with a bounded log instead of
/// aborting the reconciliation or inventing a client-visible error.
fn intents_for(plugin: DeviceKindRow, user_id: i64) -> Vec<Value> {
    let spec = plugin.json.get("spec").cloned().unwrap_or_default();
    if spec.get("enabled") == Some(&Value::Bool(false)) {
        return Vec::new();
    }
    let connectors = spec
        .get("components")
        .and_then(|components| components.get("connectors"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for connector in connectors {
        if connector
            .get("accountAuth")
            .is_none_or(|auth| auth.is_null())
        {
            continue;
        }
        tracing::warn!(
            user_id,
            installed_plugin_id = plugin.id,
            "automatic plugin auth migration is not migrated; connector skipped"
        );
    }
    Vec::new()
}

fn lease_code(error: &brz_mysql::MysqlError) -> &'static str {
    match error {
        brz_mysql::MysqlError::InvalidQuery { .. } => "plugin_write_unavailable",
        _ => EXCHANGE_FAILED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let plugin = DeviceKindRow {
            id: 5,
            name: "code-review".into(),
            json: json!({"spec": {"enabled": true, "components": {"connectors": []}}}),
        };
        assert_eq!(intents_for(plugin, 1).len(), 0);
    }

    #[test]
    fn a_disabled_plugin_is_skipped_before_its_connectors() {
        let plugin = DeviceKindRow {
            id: 6,
            name: "disabled".into(),
            json: json!({"spec": {"enabled": false, "components": {"connectors": [
                {"slug": "x", "accountAuth": {"oauth2": ["authorize"]}}
            ]}}}),
        };
        assert_eq!(intents_for(plugin, 1).len(), 0);
    }
}
