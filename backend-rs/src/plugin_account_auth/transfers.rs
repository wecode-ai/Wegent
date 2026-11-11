// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PluginAuthTransferService.resume`: an interrupted escrow transfer may be
//! rebound to a restarted source runtime before a new intent is written.
//!
//! Source: `app/services/plugin_auth_transfers.py::resume` (called from
//! `plugin_auth_migrations.py::create` after the plugin/authorize checks and
//! before the intent spec is built). The reads belong to the same savepoint
//! and transaction as the migration write.

use brz_mysql::{MysqlResult, MysqlTransaction};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wegent_python_compat::py_json::python_dumps_compact_utf8;

use crate::device_identity::DeviceKindRow;
use crate::json_compat::{python_json_compact, python_json_value};
use crate::plugins_installed::write_coordination::PluginWriteLease;
use crate::plugins_marketplace::db::KIND_COLUMNS;

use super::connections::{
    self, AuthFailure, CONNECTION_NAMESPACE, spec_integer_equals, spec_string_equals,
};
use super::credential_cipher::CredentialCipher;
use super::migrations::{MigrationCreate, MigrationOperation, MigrationResponse};
use super::{DEVICE_NOT_FOUND, DEVICE_UPGRADE_REQUIRED, migrations, native_credential, route};

/// `_query(db, user_id).filter(installed_plugin_id == ..., connector_slug == ...)`
/// ordered by primary-key insertion order; SQLAlchemy's `.all()` keeps the
/// database's natural order because the query declares no `ORDER BY`.
fn transfer_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.namespace = \
         '{CONNECTION_NAMESPACE}' AND kinds.kind = 'ConnectorTransfer' AND kinds.is_active IS true \
         AND {} AND {}",
        spec_integer_equals("installed_plugin_id"),
        spec_string_equals("connector_slug"),
    )
}

/// `connections._query(db, user_id)`: every active account connection.
fn connection_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.kind = 'ConnectorConnection' AND \
         kinds.namespace = '{CONNECTION_NAMESPACE}' AND kinds.user_id = ? AND \
         kinds.is_active IS true"
    )
}

/// `PluginAuthSourceSync.target`'s `.first()`: one account connection by the
/// account-level source identity.
fn target_statement() -> String {
    format!(
        "{} AND {} AND {} AND {} LIMIT 1",
        connection_statement(),
        spec_string_equals("sourceIdentity"),
        spec_string_equals("connectorSlug"),
        spec_string_equals("accountId"),
    )
}

/// `row.json = {"spec": spec}` in `_validated`/`resume`'s final flush.
const UPDATE_TRANSFER_JSON_QUERY: &str =
    "UPDATE kinds SET json=?, updated_at=now() WHERE kinds.id = ?";

pub(super) async fn find_on<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    migration_id: &str,
) -> Result<Option<DeviceKindRow>, AuthFailure> {
    transaction
        .fetch_optional(
            format!(
                "SELECT {KIND_COLUMNS} FROM kinds WHERE user_id=? AND namespace='{CONNECTION_NAMESPACE}' \
                 AND kind='ConnectorTransfer' AND name=? LIMIT 1"
            ),
            (user_id, migration_id),
        )
        .await
        .map_err(|_| AuthFailure::Internal)
}

pub(super) async fn prepare_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
    migration_id: &str,
) -> Result<Value, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let row = find_on(transaction, user_id, migration_id)
        .await?
        .ok_or(AuthFailure::Refusal("plugin_auth_transfer_not_found"))?;
    let spec = &row.json["spec"];
    let (plugin, definition) = validated(transaction, user_id, device_id, spec).await?;
    if spec["state"] == "completed" {
        return Ok(json!({"success": true, "state": "completed"}));
    }
    let slug = spec["connector_slug"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let package = connections::package_metadata(&plugin, slug, definition)?;
    let credential = CredentialCipher::from_environment()?.decrypt(
        &spec["credential"],
        &transfer_context(user_id, migration_id, spec),
    )?;
    Ok(json!({
        "success": true,
        "state": "staged",
        "package": package,
        "account_id": spec["account_id"],
        "credential": credential
    }))
}

pub(super) async fn stage_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
    request: &Value,
) -> Result<Value, AuthFailure> {
    let migration_id = request["migration_id"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let account = request["account_id"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    connections::coordinate_owner(transaction, lease, user_id).await?;
    if let Some(existing) = find_on(transaction, user_id, migration_id).await? {
        let spec = &existing.json["spec"];
        validated(transaction, user_id, device_id, spec).await?;
        if spec["account_id"] != account {
            return Err(AuthFailure::Refusal("plugin_auth_account_mismatch"));
        }
        return Ok(json!({"success": true, "state": spec["state"]}));
    }
    let (migration, plugin, definition) =
        migrations::validated_on(transaction, user_id, device_id, migration_id).await?;
    let mut spec = json_spec(&migration);
    let slug = spec["connector_slug"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    connections::package_metadata(&plugin, slug, definition.clone())?;
    if definition["exportMode"] != "exclusive" || spec["operation"] != "export" {
        return Err(AuthFailure::Refusal("plugin_auth_operation_unsupported"));
    }
    if !spec["expected_account_id"].is_null() && spec["expected_account_id"] != account {
        return Err(AuthFailure::Refusal("plugin_auth_account_mismatch"));
    }
    let plaintext = request["credential"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let payload = native_credential::oauth_payload(plaintext)?;
    require_no_pending_transfer(transaction, user_id, &spec, account).await?;
    let cipher = CredentialCipher::from_environment()?;
    spec["account_id"] = json!(account);
    if spec["automatic"] == true {
        let target = source_sync_target(transaction, lease, user_id, &spec).await?;
        let logical_device = spec["device_id"].as_str().ok_or(AuthFailure::Internal)?;
        let previous = target
            .as_ref()
            .and_then(|row| row.json["spec"]["localAuthSources"].get(logical_device));
        let observation = source_observation(&cipher, user_id, &spec, payload, previous)?;
        if previous == Some(&observation) {
            return Err(AuthFailure::Refusal("plugin_auth_source_unchanged"));
        }
        spec["source_observation"] = observation;
        spec["expected_revision"] = target
            .as_ref()
            .map_or(json!(0), |row| row.json["spec"]["revision"].clone());
    }
    check_target(transaction, user_id, &spec, Some(account)).await?;
    spec["account_label"] = json!(request["account_label"].as_str().unwrap_or_default());
    spec["state"] = json!("staged");
    spec["credential"] =
        cipher.encrypt(plaintext, &transfer_context(user_id, migration_id, &spec))?;
    let document = python_json_value(&json!({"spec": spec}));
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    claim_intent(transaction, migration.id).await?;
    transaction
        .execute(
            "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
             VALUES (?, 'ConnectorTransfer', ?, 'plugin-auth', ?, true, now(), now())",
            (user_id, migration_id, document.as_str()),
        )
        .await
        .map_err(|_| AuthFailure::Internal)?;
    Ok(json!({"success": true, "state": "staged"}))
}

async fn claim_intent<T: MysqlTransaction>(
    transaction: &mut T,
    intent_id: i64,
) -> Result<(), AuthFailure> {
    let claim = transaction
        .execute(
            "UPDATE kinds SET is_active=false, updated_at=now() WHERE id=? AND is_active IS true",
            (intent_id,),
        )
        .await
        .map_err(|_| AuthFailure::Internal)?;
    if claim.rows_affected != 1 {
        return Err(AuthFailure::Refusal("plugin_auth_migration_expired"));
    }
    Ok(())
}

pub(super) async fn require_no_pending_transfer<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    spec: &Value,
    account: &str,
) -> Result<(), AuthFailure> {
    let source = spec["source_identity"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let slug = spec["connector_slug"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let query = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE user_id=? AND namespace='{CONNECTION_NAMESPACE}'
         AND kind='ConnectorTransfer' AND is_active IS true AND {} AND {} AND {} LIMIT 1",
        spec_string_equals("source_identity"),
        spec_string_equals("connector_slug"),
        spec_string_equals("account_id")
    );
    let pending: Option<DeviceKindRow> = transaction
        .fetch_optional(query, (user_id, source, slug, account))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    if pending.is_some() {
        return Err(AuthFailure::Refusal("plugin_auth_transfer_pending"));
    }
    Ok(())
}

fn source_observation(
    cipher: &CredentialCipher,
    user_id: i64,
    spec: &Value,
    mut payload: Value,
    previous: Option<&Value>,
) -> Result<Value, AuthFailure> {
    let (key_id, key) = cipher.observation_key(previous)?;
    payload.sort_all_objects();
    let canonical = python_dumps_compact_utf8(&payload);
    let message = python_json_compact(&json!([
        "wework-local-auth-observation-v1",
        user_id,
        spec["source_identity"],
        spec["connector_slug"],
        spec["account_id"],
        canonical
    ]));
    let mut derived = Hmac::<Sha256>::new_from_slice(key).map_err(|_| AuthFailure::Internal)?;
    derived.update(b"wework-source-observation-key-v1");
    let mut digest = Hmac::<Sha256>::new_from_slice(&derived.finalize().into_bytes())
        .map_err(|_| AuthFailure::Internal)?;
    digest.update(message.as_bytes());
    let digest = format!("{:x}", digest.finalize().into_bytes());
    Ok(json!({
        "keyId": key_id,
        "digest": digest,
        "deviceRowId": spec["binding"]["deviceRowId"],
        "runtimeDeviceId": spec["binding"]["runtimeDeviceId"]
    }))
}

fn transfer_context(user_id: i64, migration_id: &str, spec: &Value) -> String {
    let mut context = json!([
        "transfer",
        user_id,
        migration_id,
        spec["source_identity"],
        spec["connector_slug"],
        spec["account_id"],
        spec["auth_definition"]
    ]);
    context.sort_all_objects();
    python_json_compact(&context)
}

pub(super) async fn finish_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
    migration_id: &str,
) -> Result<Value, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let row = find_on(transaction, user_id, migration_id)
        .await?
        .ok_or(AuthFailure::Refusal("plugin_auth_transfer_not_found"))?;
    let mut spec = json_spec(&row);
    let (plugin, definition) = validated(transaction, user_id, device_id, &spec).await?;
    if spec["state"] == "completed" {
        let name = spec["connection_id"]
            .as_str()
            .ok_or(AuthFailure::Internal)?;
        let connection = connections::find_connection(transaction, user_id, name)
            .await?
            .ok_or(AuthFailure::Refusal("plugin_auth_connection_not_found"))?;
        return connection_reply(name, &connection.json["spec"]);
    }
    let cipher = CredentialCipher::from_environment()?;
    let credential = cipher.decrypt(
        &spec["credential"],
        &transfer_context(user_id, migration_id, &spec),
    )?;
    let observation = if let Some(observation) = spec
        .as_object_mut()
        .ok_or(AuthFailure::Internal)?
        .remove("source_observation")
    {
        observation
    } else {
        source_observation(
            &cipher,
            user_id,
            &spec,
            native_credential::oauth_payload(&credential)?,
            None,
        )?
    };
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    transaction
        .execute("UPDATE kinds SET is_active=false WHERE id=?", (row.id,))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    let activation = TransferActivation {
        source: &spec,
        plugin: &plugin,
        definition,
        observation,
        credential: &credential,
        cipher: &cipher,
        grant_if_absent: false,
    };
    let (name, connection) = activate_transfer(transaction, lease, user_id, activation).await?;
    super::local_lifecycle::finish_login(transaction, lease, user_id, &spec).await?;
    spec.as_object_mut()
        .ok_or(AuthFailure::Internal)?
        .remove("credential");
    spec["state"] = json!("completed");
    spec["connection_id"] = json!(name);
    let document = python_json_value(&json!({"spec": spec}));
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    transaction
        .execute(UPDATE_TRANSFER_JSON_QUERY, (document.as_str(), row.id))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    connection_reply(&name, &connection)
}

pub(super) async fn enroll_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
    request: &Value,
) -> Result<Value, AuthFailure> {
    let id = request["migration_id"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let account = request["account_id"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let (intent, plugin, definition) =
        migrations::validated_on(transaction, user_id, device_id, id).await?;
    let mut spec = json_spec(&intent);
    if definition["exportMode"] == "exclusive" && spec["operation"] == "export" {
        return Err(AuthFailure::Refusal("plugin_auth_transfer_required"));
    }
    if !spec["expected_account_id"].is_null() && spec["expected_account_id"] != account {
        return Err(AuthFailure::Refusal("plugin_auth_account_mismatch"));
    }
    let credential = request["credential"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let credential_type = definition["credentialType"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let payload = native_credential::validated_payload(credential, credential_type)?;
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    claim_intent(transaction, intent.id).await?;
    let cipher = CredentialCipher::from_environment()?;
    spec["account_id"] = json!(account);
    spec["account_label"] = json!(request["account_label"].as_str().unwrap_or_default());
    let automatic = spec["automatic"] == true;
    let target = if automatic {
        source_sync_target(transaction, lease, user_id, &spec).await?
    } else {
        None
    };
    let device = spec["device_id"].as_str().ok_or(AuthFailure::Internal)?;
    let previous = target
        .as_ref()
        .and_then(|row| row.json["spec"]["localAuthSources"].get(device));
    let observation = source_observation(&cipher, user_id, &spec, payload, previous)?;
    if automatic {
        if let Some(row) = &target
            && previous == Some(&observation)
            && row.json["spec"]["status"] == "connected"
        {
            super::local_lifecycle::finish_login(transaction, lease, user_id, &spec).await?;
            return connection_reply(&row.name, &row.json["spec"]);
        }
        spec["expected_revision"] = target
            .as_ref()
            .map_or(json!(0), |row| row.json["spec"]["revision"].clone());
    }
    let activation = TransferActivation {
        source: &spec,
        plugin: &plugin,
        definition,
        observation,
        credential,
        cipher: &cipher,
        grant_if_absent: automatic,
    };
    let (name, connection) = activate_transfer(transaction, lease, user_id, activation).await?;
    super::local_lifecycle::finish_login(transaction, lease, user_id, &spec).await?;
    connection_reply(&name, &connection)
}

struct TransferActivation<'a> {
    source: &'a Value,
    plugin: &'a DeviceKindRow,
    definition: Value,
    observation: Value,
    credential: &'a str,
    cipher: &'a CredentialCipher,
    grant_if_absent: bool,
}

async fn activate_transfer<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    activation: TransferActivation<'_>,
) -> Result<(String, Value), AuthFailure> {
    let TransferActivation {
        source,
        plugin,
        definition,
        observation,
        credential,
        cipher,
        grant_if_absent,
    } = activation;
    let account = source["account_id"].as_str().ok_or(AuthFailure::Internal)?;
    let device = source["device_id"].as_str().ok_or(AuthFailure::Internal)?;
    let name = format!(
        "{:x}",
        Sha256::digest(python_json_compact(&json!([
            source["source_identity"],
            source["connector_slug"],
            account
        ])))
    );
    require_no_pending_transfer(transaction, user_id, source, account).await?;
    let row = connections::find_connection(transaction, user_id, &name).await?;
    let previous = row
        .as_ref()
        .map(|row| &row.json["spec"])
        .unwrap_or(&Value::Null);
    if matches!(
        previous["oauthRevocation"]["state"].as_str(),
        Some("pending" | "in_flight" | "attention")
    ) {
        return Err(AuthFailure::Refusal("plugin_auth_revocation_pending"));
    }
    let revision = source["expected_revision"]
        .as_i64()
        .ok_or(AuthFailure::Internal)?;
    if previous["revision"].as_i64().unwrap_or(0) != revision {
        return Err(AuthFailure::Refusal("plugin_auth_revision_conflict"));
    }
    let mut grants = if previous["authDefinition"] == definition {
        previous["deviceGrants"]
            .as_object()
            .cloned()
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    let mut revoked = previous["deviceRevocations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let grant = !grant_if_absent || !grants.contains_key(device);
    if grant {
        grants.insert(device.to_owned(), source["binding"].clone());
        revoked.retain(|revocation| revocation != device);
    }
    let mut observations = previous["localAuthSources"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    observations.insert(device.to_owned(), observation);
    let mut connection = json!({
        "installedPluginId": plugin.id,
        "pluginKey": plugin.json["spec"]["source"]["pluginKey"],
        "sourceIdentity": source["source_identity"],
        "connectorSlug": source["connector_slug"],
        "accountId": account,
        "accountLabel": source["account_label"],
        "credentialType": definition["credentialType"],
        "authDefinition": definition,
        "status": "connected",
        // Enrollment, device grant, and local source observation advance the revision.
        "revision": revision.checked_add(2 + i64::from(grant)).ok_or(AuthFailure::Internal)?,
        "deviceRevocations": revoked,
        "deviceGrants": grants,
        "localAuthSources": observations
    });
    let context = connections::credential_context(user_id, &connection);
    connection["credential"] = cipher.encrypt(credential, &context)?;
    let document = python_json_value(&json!({"spec": connection}));
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    let updated = if let Some(row) = row {
        transaction.execute(
            format!("UPDATE kinds SET json=?, updated_at=now() WHERE id=? AND is_active IS true AND {}", spec_integer_equals("revision")),
            (document.as_str(), row.id, revision),
        ).await
    } else {
        transaction.execute(
            "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
             VALUES (?, 'ConnectorConnection', ?, 'plugin-auth', ?, true, now(), now())",
            (user_id, name.as_str(), document.as_str()),
        ).await
    }.map_err(|_| AuthFailure::Internal)?;
    if updated.rows_affected != 1 {
        return Err(AuthFailure::Refusal("plugin_auth_revision_conflict"));
    }
    Ok((name, connection))
}

fn connection_reply(name: &str, spec: &Value) -> Result<Value, AuthFailure> {
    let mut devices: Vec<&String> = spec["deviceGrants"]
        .as_object()
        .ok_or(AuthFailure::Internal)?
        .keys()
        .collect();
    devices.sort_unstable();
    let revocation = match spec["oauthRevocation"]["state"].as_str() {
        Some("in_flight") => Some("pending"),
        state => state,
    };
    Ok(json!({"success": true, "connection": {
        "id": name,
        "installed_plugin_id": spec["installedPluginId"],
        "plugin_key": spec["pluginKey"],
        "connector_slug": spec["connectorSlug"],
        "account_id": spec["accountId"],
        "account_label": spec["accountLabel"],
        "credential_type": spec["credentialType"],
        "status": spec["status"],
        "revision": spec["revision"],
        "device_ids": devices,
        "provider_revocation": revocation
    }}))
}

pub(super) async fn abort_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
    migration_id: &str,
) -> Result<Value, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let row = find_on(transaction, user_id, migration_id)
        .await?
        .ok_or(AuthFailure::Refusal("plugin_auth_transfer_not_found"))?;
    let mut document = row.json;
    let spec = &mut document["spec"];
    validate_binding_and_plugin(transaction, user_id, device_id, spec, true).await?;
    if spec["state"] == "completed" {
        return Err(AuthFailure::Refusal("plugin_auth_transfer_completed"));
    }
    let spec = spec.as_object_mut().ok_or(AuthFailure::Internal)?;
    spec.remove("credential");
    spec.insert("state".to_owned(), json!("aborted"));
    let document = python_json_value(&document);
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    transaction
        .execute(
            "UPDATE kinds SET json=?, is_active=false, updated_at=now() WHERE id=?",
            (document.as_str(), row.id),
        )
        .await
        .map_err(|_| AuthFailure::Internal)?;
    Ok(json!({"success": true, "state": "aborted"}))
}

/// `PluginAuthTransferService.resume`.
///
/// `None` means no pending transfer matches this device/plugin/connector, so
/// `create` continues with the intent spec. `Some` is the resumed transfer's
/// migration response and ends `create` before any new intent is written.
pub(crate) async fn resume<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    request: &MigrationCreate,
) -> Result<Option<MigrationResponse>, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let binding = route::device_binding_on(transaction, user_id, &request.device_id)
        .await
        .map_err(binding_failure)?;
    let rows = transfer_rows(
        transaction,
        user_id,
        request.installed_plugin_id,
        &request.connector_slug,
    )
    .await
    .map_err(|_| AuthFailure::Internal)?;
    let matching: Vec<&DeviceKindRow> = rows
        .iter()
        .filter(|row| {
            row.json
                .get("spec")
                .and_then(|spec| spec.get("device_id"))
                .and_then(Value::as_str)
                == Some(binding.logical_device_id.as_str())
        })
        .collect();
    if matching.is_empty() {
        return Ok(None);
    }
    if matching.len() != 1 || request.operation != MigrationOperation::Export {
        return Err(AuthFailure::Refusal("plugin_auth_transfer_pending"));
    }
    let row = matching[0];
    let Some(mut spec) = row.json.get("spec").cloned() else {
        return Err(AuthFailure::Internal);
    };
    let current_binding = spec.get("binding");
    let device_matches = ["deviceRowId", "runtimeDeviceId"].iter().all(|key| {
        current_binding.and_then(|binding| binding.get(key)) == binding.document.get(key)
    });
    if !device_matches {
        return Err(AuthFailure::Refusal(
            "plugin_auth_migration_device_mismatch",
        ));
    }
    let account = spec
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(expected) = request.expected_account_id.as_deref()
        && Some(expected) != account.as_deref()
    {
        return Err(AuthFailure::Refusal("plugin_auth_account_mismatch"));
    }
    let revision = if spec.get("automatic") == Some(&Value::Bool(true)) {
        match source_sync_target(transaction, lease, user_id, &spec).await? {
            Some(target) => target
                .json
                .get("spec")
                .and_then(|spec| spec.get("revision"))
                .and_then(Value::as_i64)
                .unwrap_or(0),
            None => 0,
        }
    } else {
        request.expected_revision
    };
    if let Some(object) = spec.as_object_mut() {
        object.insert("binding".to_string(), binding.document.clone());
        object.insert("expected_revision".to_string(), Value::from(revision));
    }
    check_target(transaction, user_id, &spec, account.as_deref()).await?;
    let document = python_json_value(&serde_json::json!({"spec": spec}));
    // `row.json = {"spec": spec}; db.flush()`: the source's `before_flush`
    // lease check runs before this UPDATE (`plugin_write_coordination.py:241`).
    lease
        .verify_owned()
        .await
        .map_err(|_| AuthFailure::Internal)?;
    transaction
        .execute(UPDATE_TRANSFER_JSON_QUERY, (document.as_str(), row.id))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    validated(
        transaction,
        user_id,
        &binding.logical_device_id,
        &json_spec(row),
    )
    .await?;
    Ok(Some(MigrationResponse {
        id: row.name.clone(),
        expires_at: spec.get("expires_at").and_then(Value::as_i64).unwrap_or(0),
    }))
}

fn json_spec(row: &DeviceKindRow) -> Value {
    row.json.get("spec").cloned().unwrap_or(Value::Null)
}

fn binding_failure(reason: &'static str) -> AuthFailure {
    if reason == DEVICE_NOT_FOUND || reason == DEVICE_UPGRADE_REQUIRED {
        AuthFailure::Refusal(reason)
    } else {
        AuthFailure::Internal
    }
}

async fn transfer_rows<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    installed_plugin_id: i64,
    connector_slug: &str,
) -> MysqlResult<Vec<DeviceKindRow>> {
    transaction
        .fetch_all(
            transfer_statement(),
            (user_id, installed_plugin_id, connector_slug),
        )
        .await
}

/// `PluginAuthSourceSync.target`: the account connection this transfer was
/// opened against, with the source's disabled/refresh-in-progress refusals.
async fn source_sync_target<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &PluginWriteLease<'_, brz_redis::RedisService>,
    user_id: i64,
    spec: &Value,
) -> Result<Option<DeviceKindRow>, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let source_identity = spec
        .get("source_identity")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let connector_slug = spec
        .get("connector_slug")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let account_id = spec
        .get("account_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let row: Option<DeviceKindRow> = transaction
        .fetch_optional(
            target_statement(),
            (user_id, source_identity, connector_slug, account_id),
        )
        .await
        .map_err(|_| AuthFailure::Internal)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let current = json_spec(&row);
    let disabled = current
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status != "connected")
        && spec.get("local_login") != Some(&Value::Bool(true));
    let revoked = current
        .get("deviceRevocations")
        .and_then(Value::as_array)
        .is_some_and(|revocations| {
            spec.get("device_id")
                .and_then(Value::as_str)
                .is_some_and(|device| {
                    revocations
                        .iter()
                        .any(|revocation| revocation.as_str() == Some(device))
                })
        });
    if disabled || revoked {
        return Err(AuthFailure::Refusal("plugin_auth_connection_disabled"));
    }
    validate_current_plugin(transaction, user_id, &current).await?;
    if current
        .get("oauthRefresh")
        .and_then(|refresh| refresh.get("state"))
        .and_then(Value::as_str)
        == Some("in_flight")
    {
        return Err(AuthFailure::Refusal("plugin_auth_refresh_in_progress"));
    }
    Ok(Some(row))
}

/// `connections._validate_current_plugin`.
async fn validate_current_plugin<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    current: &Value,
) -> Result<(), AuthFailure> {
    let plugin_id = current
        .get("installedPluginId")
        .and_then(Value::as_i64)
        .ok_or(AuthFailure::Internal)?;
    let connector_slug = current
        .get("connectorSlug")
        .and_then(Value::as_str)
        .ok_or(AuthFailure::Internal)?;
    let (plugin, definition) =
        connections::plugin(transaction, user_id, plugin_id, connector_slug).await?;
    let source = plugin
        .json
        .get("spec")
        .and_then(|spec| spec.get("source"))
        .ok_or(AuthFailure::Internal)?;
    let identity_matches = Value::String(connections::source_identity(source))
        == *current.get("sourceIdentity").unwrap_or(&Value::Null);
    if !identity_matches || definition != *current.get("authDefinition").unwrap_or(&Value::Null) {
        return Err(AuthFailure::Refusal("plugin_auth_definition_changed"));
    }
    Ok(())
}

/// `_check_target`: validate the target revision and the pending revocation
/// before the transfer can be rebound.
async fn check_target<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    spec: &Value,
    account: Option<&str>,
) -> Result<(), AuthFailure> {
    let rows: Vec<DeviceKindRow> = transaction
        .fetch_all(connection_statement(), (user_id,))
        .await
        .map_err(|_| AuthFailure::Internal)?;
    let source_identity = spec.get("source_identity").and_then(Value::as_str);
    let connector_slug = spec.get("connector_slug").and_then(Value::as_str);
    let previous = rows.iter().find_map(|row| {
        let current = row.json.get("spec")?;
        let matches = current.get("sourceIdentity").and_then(Value::as_str) == source_identity
            && current.get("connectorSlug").and_then(Value::as_str) == connector_slug
            && current.get("accountId").and_then(Value::as_str) == account;
        matches.then_some(current)
    });
    let revision = previous
        .and_then(|current| current.get("revision"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let expected = spec
        .get("expected_revision")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if revision != expected {
        return Err(AuthFailure::Refusal("plugin_auth_revision_conflict"));
    }
    let connected = previous
        .and_then(|current| current.get("status"))
        .and_then(Value::as_str)
        == Some("connected");
    if connected && spec.get("automatic") != Some(&Value::Bool(true)) {
        return Err(AuthFailure::Refusal("plugin_auth_disconnect_required"));
    }
    let revocation = previous
        .and_then(|current| current.get("oauthRevocation"))
        .and_then(|revocation| revocation.get("state"))
        .and_then(Value::as_str);
    if matches!(revocation, Some("pending" | "in_flight" | "attention")) {
        return Err(AuthFailure::Refusal("plugin_auth_revocation_pending"));
    }
    Ok(())
}

/// `PluginAuthTransferService._validated` (without `allow_aborted`).
pub(super) async fn validated<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    spec: &Value,
) -> Result<(DeviceKindRow, Value), AuthFailure> {
    validate_binding_and_plugin(transaction, user_id, device_id, spec, false).await
}

async fn validate_binding_and_plugin<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    spec: &Value,
    allow_aborted: bool,
) -> Result<(DeviceKindRow, Value), AuthFailure> {
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(binding_failure)?;
    if spec["device_id"] != binding.logical_device_id
        || Some(&binding.document) != spec.get("binding")
    {
        return Err(AuthFailure::Refusal(
            "plugin_auth_migration_device_mismatch",
        ));
    }
    if !allow_aborted && spec["state"] == "aborted" {
        return Err(AuthFailure::Refusal("plugin_auth_source_changed"));
    }
    let plugin_id = spec
        .get("installed_plugin_id")
        .and_then(Value::as_i64)
        .ok_or(AuthFailure::Internal)?;
    let connector_slug = spec
        .get("connector_slug")
        .and_then(Value::as_str)
        .ok_or(AuthFailure::Internal)?;
    let (plugin, definition) =
        connections::plugin(transaction, user_id, plugin_id, connector_slug).await?;
    let source = plugin
        .json
        .get("spec")
        .and_then(|spec| spec.get("source"))
        .ok_or(AuthFailure::Internal)?;
    if Value::String(connections::source_identity(source))
        != *spec.get("source_identity").unwrap_or(&Value::Null)
        || definition != *spec.get("auth_definition").unwrap_or(&Value::Null)
    {
        return Err(AuthFailure::Refusal("plugin_auth_plugin_mismatch"));
    }
    Ok((plugin, definition))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_transfer_query_keeps_the_recorded_predicates() {
        let sql = transfer_statement();
        assert!(sql.contains("kinds.kind = 'ConnectorTransfer'"));
        assert!(sql.contains("kinds.namespace = 'plugin-auth'"));
        assert!(sql.contains(
            "CASE JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
             '$.\"installed_plugin_id\"') WHEN 'null' THEN NULL ELSE \
             CAST(JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
             '$.\"installed_plugin_id\"') AS SIGNED INTEGER) END = ?"
        ));
        assert!(sql.contains(
            "CASE JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
             '$.\"connector_slug\"') WHEN 'null' THEN NULL ELSE \
             JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
             '$.\"connector_slug\"')) END = ?"
        ));
        assert!(!sql.contains("ORDER BY"));
    }

    #[test]
    fn the_target_query_filters_the_account_identity_with_limit_one() {
        let sql = target_statement();
        assert!(sql.contains("'$.\"sourceIdentity\"'"));
        assert!(sql.contains("'$.\"connectorSlug\"'"));
        assert!(sql.contains("'$.\"accountId\"'"));
        assert!(sql.ends_with("LIMIT 1"));
    }
}
