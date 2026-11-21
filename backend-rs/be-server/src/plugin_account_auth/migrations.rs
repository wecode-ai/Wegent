// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Short-lived, single-use user intent for native credential enrollment.
//!
//! Source: `app/services/plugin_auth_migrations.py::PluginAuthMigrationService`
//! (`create`, `automatic_query`, `_write_intent`, `_reusable`). The intent id is
//! the row name, rotated from 32 random bytes on every new intent
//! (`token_hex(32)`), and the row is reused only while an identical, still
//! unexpired automatic intent exists.

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use serde_json::{Map, Value, json};

use crate::device_identity::DeviceKindRow;
use crate::json_compat::python_json_value;
use crate::plugins_installed::write_coordination::PluginWriteLease;
use crate::plugins_marketplace::db::KIND_COLUMNS;
use crate::socketio::device::DeviceType;

use super::connections::{
    self, AuthFailure, CONNECTION_NAMESPACE, spec_boolean_is_true, spec_string_equals,
};
use super::{DEVICE_NOT_FOUND, DEVICE_UPGRADE_REQUIRED, route};

/// `MIGRATION_TTL_SECONDS`.
pub(crate) const MIGRATION_TTL_SECONDS: i64 = 300;

/// The full automatic query including the device filter.
fn automatic_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = \
         'ConnectorMigration' AND kinds.namespace = '{CONNECTION_NAMESPACE}' AND {} AND {} AND \
         {} AND {} ORDER BY kinds.updated_at DESC, kinds.id DESC LIMIT 1",
        spec_boolean_is_true("automatic"),
        spec_string_equals("source_identity"),
        spec_string_equals("connector_slug"),
        spec_string_equals("device_id"),
    )
}

/// `_write_intent`'s reused row keeps its name and only updates the document.
const UPDATE_JSON_QUERY: &str = "UPDATE kinds SET json=?, updated_at=now() WHERE kinds.id = ?";
/// Rotate the single-use ID and reactivate the row after prior consumption.
const UPDATE_ROTATE_QUERY: &str =
    "UPDATE kinds SET name=?, is_active=true, json=?, updated_at=now() WHERE kinds.id = ?";
/// `db.add(Kind(kind=ConnectorMigration, namespace=plugin-auth, user_id=...))`.
const INSERT_MIGRATION_QUERY: &str = "INSERT INTO kinds (user_id, kind, name, namespace, json, \
     is_active, created_at, updated_at) VALUES (?, 'ConnectorMigration', ?, 'plugin-auth', ?, true, \
     now(), now())";

/// One active automatic intent row (`populate_existing().first()`).
#[derive(Debug, FromMysqlRow)]
struct MigrationRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: Value,
    #[mysql(rename = "kinds_is_active")]
    is_active: bool,
}

/// `PluginMigrationCreate`'s fields, constructed by the caller (the source
/// builds this request internally for the automatic reconcile).
#[derive(Debug, Clone)]
pub(crate) struct MigrationCreate {
    pub installed_plugin_id: i64,
    pub connector_slug: String,
    pub device_id: String,
    pub expected_revision: i64,
    pub expected_account_id: Option<String>,
    pub operation: MigrationOperation,
}

/// `PluginMigrationCreate.operation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationOperation {
    Export,
    Authorize,
}

impl MigrationOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Export => "export",
            Self::Authorize => "authorize",
        }
    }
}

/// `PluginMigrationResponse`.
#[derive(Debug, Clone)]
#[allow(
    dead_code,
    reason = "the migration create response's expiry is consumed by the transfer resume port"
)]
pub(crate) struct MigrationResponse {
    pub id: String,
    pub expires_at: i64,
}

/// `PluginAuthMigrationService.create`: owner/identity/binding/plugin checks,
/// the transfer-resume branch, and the intent write, all in the caller's
/// savepoint and transaction.
pub(crate) async fn create<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    request: &MigrationCreate,
    automatic: bool,
    local_login: bool,
) -> Result<MigrationResponse, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let identity = route::identity_on(transaction, user_id, &request.device_id)
        .await
        .map_err(|_| AuthFailure::Internal)?;
    let Some(identity) = identity else {
        return Err(AuthFailure::Refusal("plugin_auth_local_device_required"));
    };
    if !matches!(identity.device_type, DeviceType::Local | DeviceType::App) {
        return Err(AuthFailure::Refusal("plugin_auth_local_device_required"));
    }
    let binding = route::device_binding_on(transaction, user_id, &request.device_id)
        .await
        .map_err(|reason| {
            if reason == DEVICE_NOT_FOUND || reason == DEVICE_UPGRADE_REQUIRED {
                AuthFailure::Refusal(reason)
            } else {
                AuthFailure::Internal
            }
        })?;
    let (plugin, definition) = connections::plugin(
        transaction,
        user_id,
        request.installed_plugin_id,
        &request.connector_slug,
    )
    .await?;
    if request.operation == MigrationOperation::Authorize
        && !definition
            .get("oauth2")
            .and_then(Value::as_array)
            .is_some_and(|operations| {
                operations
                    .iter()
                    .any(|operation| operation.as_str() == Some("authorize"))
            })
    {
        return Err(AuthFailure::Refusal("plugin_auth_operation_unsupported"));
    }
    // `PluginAuthTransferService(self.connections).resume(...)`: an interrupted
    // escrow transfer is rebound before a new intent is written
    // (`plugin_auth_migrations.py:68`, `plugin_auth_transfers.py:64`).
    if let Some(resumed) = super::transfers::resume(transaction, lease, user_id, request).await? {
        return Ok(resumed);
    }
    let source = plugin
        .json
        .get("spec")
        .and_then(|spec| spec.get("source"))
        .ok_or(AuthFailure::Internal)?;
    let spec = migration_spec(
        request,
        &binding,
        &connections::source_identity(source),
        &definition,
        unix_seconds() + MIGRATION_TTL_SECONDS,
        automatic,
        local_login,
    );
    write_intent(transaction, lease, user_id, &spec)
        .await
        .map_err(|_| AuthFailure::Internal)
}

/// `_write_intent`'s document: `{**request.model_dump(), device_id, binding,
/// source_identity, auth_definition, expires_at}` plus the automatic flags.
pub(crate) fn migration_spec(
    request: &MigrationCreate,
    binding: &route::DeviceBinding,
    source_identity: &str,
    definition: &Value,
    expires_at: i64,
    automatic: bool,
    local_login: bool,
) -> Value {
    let mut spec = Map::new();
    spec.insert(
        "installed_plugin_id".to_string(),
        Value::from(request.installed_plugin_id),
    );
    spec.insert(
        "connector_slug".to_string(),
        Value::String(request.connector_slug.clone()),
    );
    spec.insert(
        "device_id".to_string(),
        Value::String(binding.logical_device_id.clone()),
    );
    spec.insert(
        "expected_revision".to_string(),
        Value::from(request.expected_revision),
    );
    spec.insert(
        "expected_account_id".to_string(),
        request
            .expected_account_id
            .clone()
            .map_or(Value::Null, Value::String),
    );
    spec.insert(
        "operation".to_string(),
        Value::String(request.operation.as_str().to_string()),
    );
    spec.insert("binding".to_string(), binding.document.clone());
    spec.insert(
        "source_identity".to_string(),
        Value::String(source_identity.to_string()),
    );
    spec.insert("auth_definition".to_string(), definition.clone());
    spec.insert("expires_at".to_string(), Value::from(expires_at));
    if automatic {
        spec.insert("automatic".to_string(), Value::Bool(true));
        spec.insert("local_login".to_string(), Value::Bool(local_login));
    }
    Value::Object(spec)
}

/// `_write_intent`: reuse an identical unexpired automatic intent, or rotate
/// the row's name to a fresh single-use identifier.
///
/// Every branch that writes performs the source's `before_flush` lease check
/// first (`plugin_write_coordination.py:241-244`); the read-only reuse path
/// flushes nothing and therefore checks nothing.
async fn write_intent<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    spec: &Value,
) -> MysqlResult<MigrationResponse> {
    let automatic = spec.get("automatic") == Some(&Value::Bool(true));
    let mut row: Option<MigrationRow> = None;
    if automatic {
        let source = spec
            .get("source_identity")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let slug = spec
            .get("connector_slug")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let device = spec
            .get("device_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        row = transaction
            .fetch_optional(automatic_statement(), (user_id, source, slug, device))
            .await?;
    }
    if let Some(row) = &row
        && reusable(row, spec)
    {
        if spec.get("local_login") == Some(&Value::Bool(true))
            && row
                .json
                .get("spec")
                .and_then(|current| current.get("local_login"))
                != Some(&Value::Bool(true))
        {
            let mut document = row.json.clone();
            if let Value::Object(root) = &mut document
                && let Some(Value::Object(current)) = root.get_mut("spec")
            {
                current.insert("local_login".to_string(), Value::Bool(true));
            }
            lease.verify_owned().await?;
            transaction
                .execute(UPDATE_JSON_QUERY, (python_json_value(&document), row.id))
                .await?;
        }
        let expires_at = row
            .json
            .get("spec")
            .and_then(|current| current.get("expires_at"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        return Ok(MigrationResponse {
            id: row.name.clone(),
            expires_at,
        });
    }
    let token = random_token_hex();
    let document = python_json_value(&json!({"spec": spec}));
    lease.verify_owned().await?;
    match row {
        Some(row) => {
            transaction
                .execute(
                    UPDATE_ROTATE_QUERY,
                    (token.as_str(), document.as_str(), row.id),
                )
                .await?;
        }
        None => {
            transaction
                .execute(
                    INSERT_MIGRATION_QUERY,
                    (user_id, token.as_str(), document.as_str()),
                )
                .await?;
        }
    }
    Ok(MigrationResponse {
        id: token,
        expires_at: spec.get("expires_at").and_then(Value::as_i64).unwrap_or(0),
    })
}

/// `_reusable`: the row is active, unexpired, and every compared spec field
/// already matches.
fn reusable(row: &MigrationRow, spec: &Value) -> bool {
    let Some(current) = row.json.get("spec").and_then(Value::as_object) else {
        return false;
    };
    let Some(expires_at) = current.get("expires_at").and_then(Value::as_i64) else {
        return false;
    };
    if !row.is_active || expires_at <= unix_seconds() {
        return false;
    }
    let Some(spec) = spec.as_object() else {
        return false;
    };
    spec.iter().all(|(key, value)| {
        key == "expires_at" || key == "local_login" || current.get(key) == Some(value)
    })
}

/// `token_hex(32)`: 32 random bytes as 64 lowercase hex characters.
pub(super) fn random_token_hex() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `int(time.time())`.
/// Open an intent for the registered device. Preparing leaves the single-use
/// row intact while the executor loads its adapter.
pub(super) async fn prepare_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
    migration_id: &str,
) -> Result<Value, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let transfer = super::transfers::find_on(transaction, user_id, migration_id).await?;
    if let Some(transfer) = transfer {
        let spec = &transfer.json["spec"];
        let (plugin, definition) =
            super::transfers::validated(transaction, user_id, device_id, spec).await?;
        let slug = spec["connector_slug"]
            .as_str()
            .ok_or(AuthFailure::Internal)?;
        return Ok(json!({
            "success": true, "package": connections::package_metadata(&plugin, slug, definition)?,
            "operation": "transfer",
        }));
    }
    let (intent, plugin, definition) =
        validated_on(transaction, user_id, device_id, migration_id).await?;
    let spec = &intent.json["spec"];
    let slug = spec["connector_slug"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    Ok(json!({
        "success": true, "package": connections::package_metadata(&plugin, slug, definition)?,
        "operation": spec["operation"],
    }))
}

pub(super) async fn validated_on<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    migration_id: &str,
) -> Result<(DeviceKindRow, DeviceKindRow, Value), AuthFailure> {
    let intent: Option<DeviceKindRow> = transaction.fetch_optional(
        format!("SELECT {KIND_COLUMNS} FROM kinds WHERE user_id=? AND namespace='{CONNECTION_NAMESPACE}' \
                 AND kind='ConnectorMigration' AND name=? AND is_active IS true LIMIT 1"),
        (user_id, migration_id),
    ).await.map_err(|_| AuthFailure::Internal)?;
    let intent = intent.ok_or(AuthFailure::Refusal("plugin_auth_migration_expired"))?;
    let spec = &intent.json["spec"];
    if spec["expires_at"].as_i64().ok_or(AuthFailure::Internal)? <= unix_seconds() {
        return Err(AuthFailure::Refusal("plugin_auth_migration_expired"));
    }
    if spec["automatic"] == true
        && !super::automation::enabled(transaction, user_id)
            .await
            .map_err(AuthFailure::from_reason)?
    {
        return Err(AuthFailure::Refusal("plugin_auth_automation_disabled"));
    }
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    if spec["device_id"] != binding.logical_device_id || spec["binding"] != binding.document {
        return Err(AuthFailure::Refusal(
            "plugin_auth_migration_device_mismatch",
        ));
    }
    let id = spec["installed_plugin_id"]
        .as_i64()
        .ok_or(AuthFailure::Internal)?;
    let slug = spec["connector_slug"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let (plugin, definition) = connections::plugin(transaction, user_id, id, slug).await?;
    if spec["source_identity"] != connections::source_identity(&plugin.json["spec"]["source"])
        || spec["auth_definition"] != definition
    {
        return Err(AuthFailure::Refusal("plugin_auth_plugin_mismatch"));
    }
    Ok((intent, plugin, definition))
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(json: Value, is_active: bool) -> MigrationRow {
        MigrationRow {
            id: 1782351,
            name: "314e817efc6fc4b41c930cd8eeae40220166a7a9b2140632514b20d3c1b94cb5".into(),
            json,
            is_active,
        }
    }

    fn spec() -> Value {
        json!({
            "installed_plugin_id": 662001,
            "connector_slug": "dingtalk-access",
            "device_id": "app-record-413598",
            "expected_revision": 0,
            "expected_account_id": null,
            "operation": "export",
            "binding": {"deviceRowId": 413598, "runtimeDeviceId": "app-record-413598",
                        "runtimeInstanceId": "runtime-fdadf46bb2fca3961821c6ff"},
            "source_identity": "{\"catalogItemId\":\"2\",\"marketplace\":\"wework\",\"pluginKey\":\"dingtalk\",\"providerKey\":\"wegent-market\",\"type\":\"marketplace\"}",
            "auth_definition": {"protocolVersion": 1, "credentialType": "bearer",
                                "adapter": "scripts/account-auth.py"},
            "expires_at": unix_seconds() + MIGRATION_TTL_SECONDS,
            "automatic": true,
            "local_login": false
        })
    }

    #[test]
    fn an_identical_unexpired_intent_is_reusable() {
        let current = spec();
        assert!(reusable(
            &row(json!({"spec": current.clone()}), true),
            &current
        ));
        // `expires_at` and `local_login` never participate in the comparison.
        let mut next = current.clone();
        next["expires_at"] = json!(1793909999);
        next["local_login"] = json!(true);
        assert!(reusable(
            &row(json!({"spec": current.clone()}), true),
            &next
        ));
    }

    #[test]
    fn a_changed_or_expired_intent_is_not_reusable() {
        let current = spec();
        let mut changed = current.clone();
        changed["connector_slug"] = json!("other");
        assert!(!reusable(
            &row(json!({"spec": current.clone()}), true),
            &changed
        ));
        let mut expired = current.clone();
        expired["expires_at"] = json!(1);
        assert!(!reusable(
            &row(json!({"spec": expired.clone()}), true),
            &current
        ));
        assert!(!reusable(
            &row(json!({"spec": current.clone()}), false),
            &current
        ));
    }

    #[test]
    fn the_automatic_query_keeps_the_recorded_predicates() {
        // Recording 20261105200002 (case d7eae0ca), ledger 40742.
        let sql = automatic_statement();
        assert!(sql.contains("kinds.kind = 'ConnectorMigration'"));
        assert!(sql.contains("kinds.namespace = 'plugin-auth'"));
        assert!(sql.contains(
            "CASE JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), '$.\"automatic\"') \
             WHEN 'null' THEN NULL WHEN true THEN true ELSE false END IS true"
        ));
        assert!(sql.contains(
            "CASE JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), '$.\"source_identity\"') \
             WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(kinds.json, \
             '$.\"spec\"'), '$.\"source_identity\"')) END = ?"
        ));
        assert!(sql.contains("ORDER BY kinds.updated_at DESC, kinds.id DESC LIMIT 1"));
    }

    #[test]
    fn the_token_is_64_lowercase_hex_characters() {
        let token = random_token_hex();
        assert_eq!(token.len(), 64);
        assert!(
            token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
        assert_ne!(token, random_token_hex());
    }

    #[test]
    fn the_spec_matches_the_recorded_rotation_document() {
        // Recording 20261105200002, ledger 40744 (the rotated `kinds.json`).
        let request = MigrationCreate {
            installed_plugin_id: 662001,
            connector_slug: "dingtalk-access".into(),
            device_id: "app-record-413598".into(),
            expected_revision: 0,
            expected_account_id: None,
            operation: MigrationOperation::Export,
        };
        let binding = route::DeviceBinding {
            logical_device_id: "app-record-413598".into(),
            document: json!({
                "deviceRowId": 413598,
                "runtimeDeviceId": "app-record-413598",
                "runtimeInstanceId": "runtime-fdadf46bb2fca3961821c6ff",
            }),
        };
        let source = "{\"catalogItemId\":\"2\",\"marketplace\":\"wework\",\"pluginKey\":\
                      \"dingtalk\",\"providerKey\":\"wegent-market\",\"type\":\"marketplace\"}";
        let definition = json!({
            "protocolVersion": 1,
            "credentialType": "bearer",
            "adapter": "scripts/account-auth.py",
            "localEnvironment": {
                "DWS_CONFIG_DIR": {"type": "directory"},
                "DWS_KEYCHAIN_DIR": {"type": "directory"},
                "DWS_DISABLE_KEYCHAIN": {"type": "enum", "values": ["1"]},
            },
        });
        let spec = migration_spec(
            &request,
            &binding,
            source,
            &definition,
            1793909343,
            true,
            false,
        );
        assert_eq!(
            python_json_value(&spec),
            "{\"installed_plugin_id\": 662001, \"connector_slug\": \"dingtalk-access\", \
             \"device_id\": \"app-record-413598\", \"expected_revision\": 0, \
             \"expected_account_id\": null, \"operation\": \"export\", \"binding\": \
             {\"deviceRowId\": 413598, \"runtimeDeviceId\": \"app-record-413598\", \
             \"runtimeInstanceId\": \"runtime-fdadf46bb2fca3961821c6ff\"}, \
             \"source_identity\": \"{\\\"catalogItemId\\\":\\\"2\\\",\\\"marketplace\\\":\
             \\\"wework\\\",\\\"pluginKey\\\":\\\"dingtalk\\\",\\\"providerKey\\\":\
             \\\"wegent-market\\\",\\\"type\\\":\\\"marketplace\\\"}\", \"auth_definition\": \
             {\"protocolVersion\": 1, \"credentialType\": \"bearer\", \"adapter\": \
             \"scripts/account-auth.py\", \"localEnvironment\": {\"DWS_CONFIG_DIR\": \
             {\"type\": \"directory\"}, \"DWS_KEYCHAIN_DIR\": {\"type\": \"directory\"}, \
             \"DWS_DISABLE_KEYCHAIN\": {\"type\": \"enum\", \"values\": [\"1\"]}}}, \
             \"expires_at\": 1793909343, \"automatic\": true, \"local_login\": false}"
        );
    }
}
