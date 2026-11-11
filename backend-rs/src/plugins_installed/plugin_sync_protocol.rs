// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Versioned (`protocolVersion = 2`) plugin snapshot negotiation and fencing.
//!
//! Source: `app/services/device/plugin_sync_protocol.py` and
//! `app/services/device/plugin_change_sync.py::validate_ack`.
//!
//! A device that advertises the versioned protocol receives a
//! `plugin_sync` metadata block on every capability snapshot. The account's
//! `PluginSyncState` Kind carries the monotonic generation: a snapshot's
//! desired state is read and committed together with generation + 1, and every
//! dispatch first advances the per-device watermark so older acknowledgements
//! cannot materialize newer state.

use brz_mysql::{Mysql, MysqlIsolationLevel, MysqlResult, MysqlTransactionOptions};
use serde_json::{Map, Value};

use crate::device_identity::plugin_device_id_on;
use crate::json_compat::{python_json_value, python_str};
use crate::plugins_marketplace::db::{InstalledKindRow, KIND_COLUMNS};
use crate::plugins_marketplace::query::PluginQuery;
use crate::state::AppState;

use super::desired_capabilities::{BuildError, build_desired_capabilities_for_registration_on};
use super::write_coordination::{PluginWriteLease, coordination_error};

/// `PLUGIN_SYNC_VERSION`.
pub(crate) const PLUGIN_SYNC_VERSION: i64 = 2;
/// `PLUGIN_SYNC_STATE_KIND`.
const PLUGIN_SYNC_STATE_KIND: &str = "PluginSyncState";
/// `PLUGIN_SYNC_STATE_NAMESPACE`.
const PLUGIN_SYNC_STATE_NAMESPACE: &str = "plugin-sync";
/// `PLUGIN_SYNC_STATE_NAME`.
const PLUGIN_SYNC_STATE_NAME: &str = "account";

/// `_sync_state`'s optimistic read over one active account state row.
fn sync_state_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = \
         'PluginSyncState' AND kinds.namespace = 'plugin-sync' AND kinds.name = 'account' \
         AND kinds.is_active IS true"
    )
}

/// `db.add(Kind(...))` for a missing account state row.
const INSERT_SYNC_STATE_QUERY: &str = "INSERT INTO kinds (user_id, kind, name, namespace, json, \
     is_active, created_at, updated_at) VALUES (?, 'PluginSyncState', 'account', 'plugin-sync', ?, \
     true, now(), now())";

/// `UPDATE kinds SET json=..., updated_at=now() WHERE kinds.id = ...`.
const UPDATE_SYNC_STATE_QUERY: &str = "UPDATE kinds SET json=?, updated_at=now() WHERE kinds.id=? AND user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.revision')) AS SIGNED),0)=?";

/// `supports_plugin_sync_v2`: only an explicit integer `protocolVersion = 2`
/// advertisement selects the versioned payload.
pub(crate) fn supports_plugin_sync_v2(runtime_features: Option<&Value>) -> bool {
    let Some(features) = runtime_features.and_then(Value::as_object) else {
        return false;
    };
    let Some(advertisement) = features.get("pluginSync").and_then(Value::as_object) else {
        return false;
    };
    // `type(version) is int and version == 2`: floats, booleans and strings do
    // not advertise the protocol.
    advertisement.get("protocolVersion").and_then(Value::as_i64) == Some(PLUGIN_SYNC_VERSION)
}

/// One account `PluginSyncState` row (`_sync_state`).
pub(crate) struct PluginSyncState {
    /// The row id; absent when the account has no state row yet.
    pub id: Option<i64>,
    /// The stored Kind document.
    pub json: Value,
}

pub(crate) async fn ensure_sync_state<M: Mysql, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    user_id: i64,
) -> MysqlResult<()> {
    let exists = mysql
        .with_transaction(async |tx| {
            let mut query = &mut *tx;
            Ok(lock_plugin_sync_state(&mut query, user_id)
                .await?
                .id
                .is_some())
        })
        .await?;
    if exists {
        return Ok(());
    }
    let lease = PluginWriteLease::acquire_names(redis, user_id, vec!["@sync-init".into()]).await?;
    let result = mysql
        .with_transaction(async |tx| {
            let mut query = &mut *tx;
            let state = lock_plugin_sync_state(&mut query, user_id).await?;
            if state.id.is_none() {
                lease.verify_owned().await?;
                write_sync_state(&mut query, user_id, &state, &state.json).await?;
            }
            Ok(())
        })
        .await;
    if matches!(
        &result,
        Ok(_) | Err(brz_mysql::MysqlError::InvalidQuery { .. })
    ) {
        lease.release().await;
    }
    result
}

impl PluginSyncState {
    /// `_sync_state`'s default document, used when the row is created.
    fn default_document() -> Value {
        let mut metadata = Map::new();
        metadata.insert(
            "name".to_string(),
            Value::String(PLUGIN_SYNC_STATE_NAME.to_string()),
        );
        metadata.insert(
            "namespace".to_string(),
            Value::String(PLUGIN_SYNC_STATE_NAMESPACE.to_string()),
        );
        let mut spec = Map::new();
        spec.insert("generation".to_string(), Value::from(0));
        let mut document = Map::new();
        document.insert(
            "apiVersion".to_string(),
            Value::String("agent.wecode.io/v1".to_string()),
        );
        document.insert(
            "kind".to_string(),
            Value::String(PLUGIN_SYNC_STATE_KIND.to_string()),
        );
        document.insert("metadata".to_string(), Value::Object(metadata));
        document.insert("spec".to_string(), Value::Object(spec));
        Value::Object(document)
    }
}

/// `lock_plugin_sync_state`'s state read.
///
/// Callers compare the metadata revision when publishing their snapshot or
/// watermark. No account-wide plugin lease is held while loading desired state.
/// Duplicate state rows abort the caller's transaction.
pub(crate) async fn lock_plugin_sync_state<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
) -> MysqlResult<PluginSyncState> {
    let rows: Vec<InstalledKindRow> = query.fetch_all(sync_state_statement(), (user_id,)).await?;
    let mut rows = rows;
    match rows.len() {
        0 => Ok(PluginSyncState {
            id: None,
            json: PluginSyncState::default_document(),
        }),
        1 => {
            let row = rows.swap_remove(0);
            Ok(PluginSyncState {
                id: Some(row.id),
                json: row.json.0.to_value(),
            })
        }
        _ => Err(coordination_error("plugin_write_conflict")),
    }
}

/// `_next_generation`: `spec.generation` plus one, over a non-negative integer.
pub(crate) fn next_generation(document: &Value) -> i64 {
    let current = document
        .get("spec")
        .and_then(Value::as_object)
        .and_then(|spec| spec.get("generation"));
    generation_value(current) + 1
}

/// Python `_generation`: only a non-negative integer counts.
fn generation_value(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().filter(|value| *value >= 0).unwrap_or(0),
        _ => 0,
    }
}

/// `plugin_snapshot_watermark`: the highest generation already applied to one
/// device, either through a complete snapshot or one plugin entry.
pub(crate) fn plugin_snapshot_watermark(
    document: &Value,
    device_id: &str,
    installed_id: i64,
) -> i64 {
    let Some(device) = device_entry(document, device_id) else {
        return 0;
    };
    let complete = generation_value(device.get("complete_generation"));
    let plugin = device
        .get("plugins")
        .and_then(Value::as_object)
        .and_then(|plugins| plugins.get(&installed_id.to_string()));
    complete.max(generation_value(plugin))
}

/// One device's state entry, if the document carries one.
fn device_entry<'a>(document: &'a Value, device_id: &str) -> Option<&'a Map<String, Value>> {
    document
        .get("spec")?
        .as_object()?
        .get("devices")?
        .as_object()?
        .get(device_id)?
        .as_object()
}

/// `advance_plugin_snapshot_watermark`.
pub(crate) fn advance_plugin_snapshot_watermark(
    document: &mut Value,
    device_id: &str,
    generation: i64,
    complete: bool,
    installed_plugin_ids: &[i64],
) {
    let generation = generation.max(0);
    let Value::Object(root) = document else {
        return;
    };
    let spec = root
        .entry("spec".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(spec) = spec else {
        return;
    };
    let current = generation_value(spec.get("generation"));
    spec.insert(
        "generation".to_string(),
        Value::from(current.max(generation)),
    );
    let devices = spec
        .entry("devices".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(devices) = devices else {
        return;
    };
    let device = devices
        .entry(device_id.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(device) = device else {
        return;
    };
    if complete {
        let current = generation_value(device.get("complete_generation"));
        device.insert(
            "complete_generation".to_string(),
            Value::from(current.max(generation)),
        );
    }
    let plugins = device
        .entry("plugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(plugins) = plugins else {
        return;
    };
    for installed_id in installed_plugin_ids {
        let key = installed_id.to_string();
        let current = generation_value(plugins.get(&key));
        plugins.insert(key, Value::from(current.max(generation)));
    }
}

/// Store one state document: update the existing row, or insert the missing
/// one. SQLAlchemy flushes nothing when the document did not change.
pub(crate) async fn write_sync_state<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    state: &PluginSyncState,
    document: &Value,
) -> MysqlResult<()> {
    let changed = document != &state.json;
    write_sync_state_document(
        query,
        state.id,
        user_id,
        &python_json_value(document),
        changed,
    )
    .await
}

/// Emit one state document write at a flush boundary.
///
/// The caller owns the dirty tracking: an unchanged document still runs the
/// source's `before_flush` lease check but emits no UPDATE.
pub(crate) async fn write_sync_state_document<Q: PluginQuery>(
    query: &mut Q,
    state_id: Option<i64>,
    user_id: i64,
    document: &str,
    changed: bool,
) -> MysqlResult<()> {
    let mut payload: Value =
        serde_json::from_str(document).map_err(|_| coordination_error("plugin_write_conflict"))?;
    let revision = super::write_coordination::business_revision(&payload)?;
    payload["spec"]["revision"] = Value::from(revision + 1);
    let serialized = python_json_value(&payload);
    match state_id {
        Some(id) => {
            if !changed {
                return Ok(());
            }
            let updated = query
                .execute(UPDATE_SYNC_STATE_QUERY, (serialized, id, user_id, revision))
                .await?;
            if updated.rows_affected != 1 {
                return Err(coordination_error("plugin_write_conflict"));
            }
        }
        None => {
            query
                .execute(INSERT_SYNC_STATE_QUERY, (user_id, serialized))
                .await?;
        }
    }
    Ok(())
}

pub(crate) async fn touch_desired_state<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
) -> MysqlResult<()> {
    let updated = query.execute(
        "UPDATE kinds SET json=JSON_SET(json,'$.spec.revision',COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.revision')) AS SIGNED),0)+1),updated_at=NOW() WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND is_active=1", (user_id,),
    ).await?;
    if updated.rows_affected != 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    Ok(())
}

/// One desired-state snapshot built inside a versioned transaction.
pub(crate) struct VersionedSnapshot {
    pub payload: Value,
    pub generation: i64,
}

/// `load_versioned_plugin_payload`'s in-transaction body.
///
/// The account state read, the desired-state build and the generation write
/// share one transaction: a higher generation can then never describe older
/// state, and the `InstalledSkill` read happens after `PluginSyncState`. The
/// guard runs the source's `before_flush` lease check before the write.
pub(crate) async fn build_versioned_snapshot<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
    include_plugins: bool,
    guard: Option<&dyn crate::device_identity::LeaseCheck>,
) -> Result<VersionedSnapshot, BuildError> {
    let snapshot_state = lock_plugin_sync_state(query, user_id).await?;
    let generation = next_generation(&snapshot_state.json);
    let payload =
        build_desired_capabilities_for_registration_on(query, user_id, device_id, include_plugins)
            .await?;
    let mut document = snapshot_state.json.clone();
    set_generation(&mut document, generation);
    if let Some(guard) = guard {
        guard.check().await?;
    }
    write_sync_state(query, user_id, &snapshot_state, &document).await?;
    Ok(VersionedSnapshot {
        payload,
        generation,
    })
}

/// `load_versioned_plugin_payload` for the registration follow-up.
///
/// The desired state is read inside one committed transaction that also
/// advances `PluginSyncState.spec.generation`; the payload carries the
/// `plugin_sync` block returned by the source.
pub(crate) async fn load_versioned_registration_payload(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    include_plugins: bool,
    complete: bool,
) -> Result<Value, BuildError> {
    ensure_sync_state(&state.mysql, state.redis.as_ref(), user_id)
        .await
        .map_err(BuildError::Mysql)?;
    for attempt in 0..8 {
        let mut build_error = None;
        let mut generation = 0;
        let outcome = state
            .mysql
            .with_transaction_options(
                MysqlTransactionOptions::default()
                    .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
                async |tx| {
                    let mut query = &mut *tx;
                    let snapshot = build_versioned_snapshot(
                        &mut query,
                        user_id,
                        device_id,
                        include_plugins,
                        None,
                    )
                    .await
                    .map_err(|error| match error {
                        BuildError::Mysql(error) => error,
                        error => {
                            build_error = Some(error);
                            coordination_error("plugin_snapshot_build_failed")
                        }
                    })?;
                    generation = snapshot.generation;
                    Ok(snapshot.payload)
                },
            )
            .await;
        if attempt < 7
            && matches!(&outcome, Err(error) if super::write_coordination::plugin_write_error_code(error) == Some("plugin_write_conflict"))
        {
            continue;
        }
        if let Some(error) = build_error {
            return Err(error);
        }
        let mut payload = outcome.map_err(BuildError::Mysql)?;
        payload["plugin_sync"] = plugin_sync_metadata(generation, complete);
        return Ok(payload);
    }
    Err(BuildError::Mysql(coordination_error(
        "plugin_write_conflict",
    )))
}

/// `document.setdefault("spec", {})["generation"] = generation`.
fn set_generation(document: &mut Value, generation: i64) {
    let Value::Object(root) = document else {
        return;
    };
    let spec = root
        .entry("spec".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Value::Object(spec) = spec {
        spec.insert("generation".to_string(), Value::from(generation));
    }
}

/// `PluginSyncMetadata` for one snapshot.
fn plugin_sync_metadata(generation: i64, complete: bool) -> Value {
    let mut metadata = Map::new();
    metadata.insert("version".to_string(), Value::from(PLUGIN_SYNC_VERSION));
    metadata.insert("generation".to_string(), Value::from(generation));
    metadata.insert("complete".to_string(), Value::Bool(complete));
    Value::Object(metadata)
}

/// `register_plugin_snapshot_intent`: fence older acknowledgements before the
/// snapshot leaves for the device.
pub(crate) async fn register_plugin_snapshot_intent(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    payload: &Value,
) -> MysqlResult<()> {
    let Some(metadata) = payload.get("plugin_sync") else {
        return Ok(());
    };
    let generation = generation_value(metadata.get("generation"));
    let complete = metadata.get("complete") == Some(&Value::Bool(true));
    let installed_plugin_ids = payload_plugin_ids(payload);
    ensure_sync_state(&state.mysql, state.redis.as_ref(), user_id).await?;
    for attempt in 0..8 {
        let outcome = state
            .mysql
            .with_transaction_options(
                MysqlTransactionOptions::default()
                    .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
                async |tx| {
                    let mut query = &mut *tx;
                    let snapshot_state = lock_plugin_sync_state(&mut query, user_id).await?;
                    let canonical_device_id =
                        plugin_device_id_on(&mut query, user_id, device_id).await?;
                    let mut document = snapshot_state.json.clone();
                    advance_plugin_snapshot_watermark(
                        &mut document,
                        &canonical_device_id,
                        generation,
                        complete,
                        &installed_plugin_ids,
                    );
                    write_sync_state(&mut query, user_id, &snapshot_state, &document).await
                },
            )
            .await;
        if attempt < 7
            && matches!(&outcome, Err(error) if super::write_coordination::plugin_write_error_code(error) == Some("plugin_write_conflict"))
        {
            continue;
        }
        return outcome;
    }
    Err(coordination_error("plugin_write_conflict"))
}

/// The `installed_plugin_id` values of both payload plugin fields.
fn payload_plugin_ids(payload: &Value) -> Vec<i64> {
    let mut ids = Vec::new();
    for field in ["plugins", "removed_plugins"] {
        let Some(items) = payload.get(field).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(id) = item.get("installed_plugin_id").and_then(Value::as_i64) {
                ids.push(id);
            }
        }
    }
    ids
}

/// `validate_ack`: only an explicit, generation-matching acknowledgement can
/// materialize a versioned snapshot. Returns the source's error text.
pub(crate) fn validate_plugin_ack(payload: &Value, response: &Value) -> Option<&'static str> {
    let metadata = payload.get("plugin_sync")?;
    if !response.get("success").is_some_and(Value::is_boolean) {
        return Some("Device returned invalid plugin acknowledgement success");
    }
    let Some(acknowledgement) = response.get("plugin_sync").and_then(Value::as_object) else {
        return Some("Device returned a mismatched plugin snapshot acknowledgement");
    };
    if !acknowledgement.get("version").is_some_and(is_integer)
        || !acknowledgement.get("generation").is_some_and(is_integer)
        || !acknowledgement
            .get("complete")
            .is_some_and(Value::is_boolean)
        || response.get("plugin_sync") != Some(metadata)
    {
        return Some("Device returned a mismatched plugin snapshot acknowledgement");
    }
    let expected_scope = payload
        .get("scope")
        .filter(|value| crate::json_compat::python_truthy(value))
        .cloned()
        .unwrap_or_else(|| Value::String("all".to_string()));
    if response.get("scope") != Some(&expected_scope) {
        return Some("Device returned a mismatched plugin snapshot acknowledgement");
    }
    let Some(items) = response.get("plugins").and_then(Value::as_array) else {
        return Some("Device returned invalid plugin acknowledgement items");
    };
    if items.iter().any(|item| !item.is_object()) {
        return Some("Device returned invalid plugin acknowledgement items");
    }
    let Some(generation) = metadata.get("generation").and_then(Value::as_i64) else {
        return Some("Device returned a mismatched plugin snapshot acknowledgement");
    };
    let complete = metadata.get("complete") == Some(&Value::Bool(true));
    let mut expected: Vec<(String, (&'static str, &Value))> = Vec::new();
    for (field, operation) in [("plugins", "upsert"), ("removed_plugins", "remove")] {
        let Some(items) = payload.get(field).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let Some(id) = item.get("installed_plugin_id") else {
                return Some("Device returned unexpected plugin acknowledgement items");
            };
            expected.push((python_str(id), (operation, item)));
        }
    }
    let mut seen: Vec<String> = Vec::new();
    for item in items {
        let identity = python_str(item.get("id").unwrap_or(&Value::Null));
        let inferred_removal = complete
            && !expected.iter().any(|(key, _)| key == &identity)
            && item.get("operation").and_then(Value::as_str) == Some("remove")
            && matches!(
                item.get("status").and_then(Value::as_str),
                Some("removed" | "failed" | "superseded")
            );
        if (!expected.iter().any(|(key, _)| key == &identity) && !inferred_removal)
            || seen.contains(&identity)
        {
            return Some("Device returned unexpected plugin acknowledgement items");
        }
        seen.push(identity.clone());
        let item_generation = item.get("generation");
        if !item_generation.is_some_and(is_integer)
            || item_generation.and_then(Value::as_i64) != Some(generation)
        {
            return Some("Device returned an obsolete plugin acknowledgement");
        }
        if inferred_removal {
            continue;
        }
        let (operation, expected_spec) = expected
            .iter()
            .find(|(key, _)| key == &identity)
            .map(|(_, value)| *value)
            .expect("the identity was found above");
        let status = item.get("status").and_then(Value::as_str);
        if !matches!(status, Some("synced" | "removed" | "failed" | "superseded")) {
            return Some("Device returned an invalid plugin acknowledgement status");
        }
        if item.get("operation").and_then(Value::as_str) != Some(operation) {
            return Some("Device returned a mismatched plugin operation");
        }
        if status == Some("synced")
            && (operation != "upsert"
                || item.get("version") != expected_spec.get("version")
                || item.get("checksum") != expected_spec.get("checksum"))
        {
            return Some("Device returned a mismatched plugin package acknowledgement");
        }
        if status == Some("removed") && operation != "remove" {
            return Some("Device returned a mismatched plugin removal acknowledgement");
        }
    }
    if !expected.iter().all(|(key, _)| seen.contains(key)) {
        return Some("Device did not acknowledge every requested plugin");
    }
    None
}

/// Python `type(value) is int`.
fn is_integer(value: &Value) -> bool {
    matches!(value, Value::Number(number) if number.is_i64() || number.is_u64())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};
    use serde_json::json;

    use super::*;

    /// Record one transaction's statements in call order.
    #[derive(Clone, Default)]
    struct RecordingTransaction {
        statements: Arc<Mutex<Vec<String>>>,
    }

    impl RecordingTransaction {
        fn statements(&self) -> Vec<String> {
            self.statements.lock().unwrap().clone()
        }

        fn record(&self, sql: &str) {
            self.statements
                .lock()
                .unwrap()
                .push(sql.split_whitespace().collect::<Vec<_>>().join(" "));
        }
    }

    impl MysqlTransaction for RecordingTransaction {
        async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
        {
            self.record(sql.as_ref());
            Ok(MysqlExecution {
                rows_affected: 1,
                last_insert_id: 2460258,
            })
        }

        async fn fetch_optional<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Option<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            self.record(sql.as_ref());
            Ok(None)
        }

        async fn fetch_one<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<T>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            self.record(sql.as_ref());
            panic!("the versioned build reads no single row")
        }

        fn fetch<'transaction, S, A, T>(
            &'transaction mut self,
            _: S,
            _: A,
        ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'transaction
        where
            S: AsRef<str> + Send + 'transaction,
            A: MysqlArgs + Send + 'transaction,
            T: FromMysqlRow + Send + 'transaction,
        {
            futures_util::stream::empty()
        }

        async fn fetch_all<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Vec<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            self.record(sql.as_ref());
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn the_versioned_build_reads_plugin_sync_state_before_the_installed_skill() {
        let mut transaction = RecordingTransaction::default();
        let mut query = &mut transaction;
        let snapshot = build_versioned_snapshot(&mut query, 203, "app-record-273921", true, None)
            .await
            .expect("the versioned snapshot builds");
        assert_eq!(snapshot.generation, 1);
        assert!(snapshot.payload.get("plugin_sync").is_none());
        let statements = transaction.statements();
        assert_eq!(statements.len(), 5, "{statements:#?}");
        assert!(
            statements[0].contains("kinds.kind = 'PluginSyncState'"),
            "{statements:#?}"
        );
        assert!(
            statements[1].contains("kinds.kind = 'InstalledSkill'"),
            "{statements:#?}"
        );
        assert!(
            statements[2].contains("kinds.kind = 'InstalledPlugin'"),
            "{statements:#?}"
        );
        assert!(
            statements[3].contains("kinds.kind = 'InstalledMCP'"),
            "{statements:#?}"
        );
        assert!(
            statements[4].starts_with("INSERT INTO kinds"),
            "{statements:#?}"
        );
    }

    #[test]
    fn only_an_integer_protocol_version_selects_the_versioned_protocol() {
        assert!(supports_plugin_sync_v2(Some(
            &json!({"pluginSync": {"protocolVersion": 2}})
        )));
        assert!(!supports_plugin_sync_v2(Some(
            &json!({"pluginSync": {"protocolVersion": 1}})
        )));
        assert!(!supports_plugin_sync_v2(Some(
            &json!({"pluginSync": {"protocolVersion": 2.0}})
        )));
        assert!(!supports_plugin_sync_v2(Some(
            &json!({"pluginSync": {"protocolVersion": "2"}})
        )));
        assert!(!supports_plugin_sync_v2(Some(&json!({}))));
        assert!(!supports_plugin_sync_v2(None));
    }

    #[test]
    fn generations_follow_the_source_integer_rules() {
        assert_eq!(next_generation(&json!({"spec": {"generation": 162}})), 163);
        assert_eq!(next_generation(&json!({"spec": {}})), 1);
        assert_eq!(next_generation(&json!({})), 1);
        assert_eq!(next_generation(&json!({"spec": {"generation": -4}})), 1);
        assert_eq!(next_generation(&json!({"spec": {"generation": 2.0}})), 1);
    }

    #[test]
    fn the_watermark_keeps_the_highest_complete_or_per_plugin_generation() {
        let mut document = json!({"spec": {"generation": 163}});
        advance_plugin_snapshot_watermark(&mut document, "app-record-1", 163, true, &[]);
        assert_eq!(document["spec"]["generation"], json!(163));
        assert_eq!(
            document["spec"]["devices"]["app-record-1"]["complete_generation"],
            json!(163)
        );
        assert_eq!(plugin_snapshot_watermark(&document, "app-record-1", 7), 163);
        advance_plugin_snapshot_watermark(&mut document, "app-record-1", 164, false, &[7]);
        assert_eq!(document["spec"]["generation"], json!(164));
        assert_eq!(
            document["spec"]["devices"]["app-record-1"]["plugins"]["7"],
            json!(164)
        );
        assert_eq!(plugin_snapshot_watermark(&document, "app-record-1", 7), 164);
        assert_eq!(plugin_snapshot_watermark(&document, "app-record-2", 7), 0);
    }

    #[test]
    fn the_sync_metadata_matches_the_source_shape() {
        assert_eq!(
            plugin_sync_metadata(163, true),
            json!({"version": 2, "generation": 163, "complete": true})
        );
    }

    #[test]
    fn ack_validation_accepts_the_recorded_generation() {
        let payload = json!({
            "mode": "replace",
            "skills": [],
            "mcps": [],
            "plugins": [],
            "plugin_sync": {"version": 2, "generation": 163, "complete": true},
        });
        let ack = json!({
            "success": true,
            "changed": false,
            "requires_restart": false,
            "scope": "all",
            "skills": [],
            "plugins": [],
            "plugin_sync": {"version": 2, "generation": 163, "complete": true},
        });
        assert_eq!(validate_plugin_ack(&payload, &ack), None);
    }

    #[test]
    fn ack_validation_rejects_mismatched_or_obsolete_acknowledgements() {
        let payload = json!({
            "plugin_sync": {"version": 2, "generation": 163, "complete": true},
            "plugins": [{"installed_plugin_id": 7, "version": "1.0.0", "checksum": "sha256:a"}],
        });
        let base = json!({
            "success": true,
            "scope": "all",
            "plugin_sync": {"version": 2, "generation": 163, "complete": true},
            "plugins": [{"id": 7, "operation": "upsert", "status": "synced", "generation": 163,
                         "version": "1.0.0", "checksum": "sha256:a"}],
        });
        assert_eq!(validate_plugin_ack(&payload, &base), None);

        let mut obsolete = base.clone();
        obsolete["plugins"][0]["generation"] = json!(162);
        assert_eq!(
            validate_plugin_ack(&payload, &obsolete),
            Some("Device returned an obsolete plugin acknowledgement")
        );

        let mut missing = base.clone();
        missing["plugins"] = json!([]);
        assert_eq!(
            validate_plugin_ack(&payload, &missing),
            Some("Device did not acknowledge every requested plugin")
        );

        let mut mismatched = base.clone();
        mismatched["plugin_sync"]["generation"] = json!(164);
        assert_eq!(
            validate_plugin_ack(&payload, &mismatched),
            Some("Device returned a mismatched plugin snapshot acknowledgement")
        );

        let mut bad_operation = base;
        bad_operation["plugins"][0]["operation"] = json!("remove");
        assert_eq!(
            validate_plugin_ack(&payload, &bad_operation),
            Some("Device returned a mismatched plugin operation")
        );
    }
}
