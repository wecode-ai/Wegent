// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Negotiate legacy aggregate V2 and independent per-plugin V3 snapshots.
//!
//! Source: `app/services/device/plugin_sync_protocol.py` and
//! `app/services/device/plugin_change_sync.py::validate_ack`.
//!
//! V3 publishers CAS plugin_states independently. V2 retains its legacy
//! activated aggregate stream; normal V3 writes never activate that stream.

use brz_mysql::{Mysql, MysqlIsolationLevel, MysqlResult, MysqlTransactionOptions};
use serde_json::{Map, Value};

use crate::device_identity::plugin_device_id_on;
use crate::json_compat::{python_json_value, python_str};
use crate::plugins_marketplace::query::PluginQuery;
use crate::state::AppState;
use brz_mysql::FromMysqlRow;

use super::desired_capabilities::{BuildError, build_desired_capabilities_for_registration_on};
use super::write_coordination::coordination_error;

/// `PLUGIN_SYNC_VERSION`.
pub(crate) const PLUGIN_SYNC_VERSION: i64 = 2;
pub(super) const SNAPSHOT_WRITE_ATTEMPTS: usize = 8;
pub(super) async fn with_sync_write_budget<T, E>(
    write: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E>
where
    E: From<brz_mysql::MysqlError>,
{
    tokio::time::timeout(std::time::Duration::from_secs(20), write)
        .await
        .unwrap_or_else(|_| Err(coordination_error("plugin_write_busy").into()))
}

/// Replay only optimistic database work, within one shared time budget.
pub(super) async fn retry_sync_write<F, Fut, T>(attempts: usize, mut write: F) -> MysqlResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = MysqlResult<T>>,
{
    with_sync_write_budget(async {
        for attempt in 0..attempts {
            let outcome = write().await;
            if attempt + 1 < attempts
                && matches!(&outcome, Err(error) if super::write_coordination::plugin_write_error_code(error) == Some("plugin_write_conflict"))
            {
                tokio::time::sleep(std::time::Duration::from_millis(
                    50 * (attempt as u64 + 1),
                ))
                .await;
                continue;
            }
            return outcome;
        }
        Err(coordination_error("plugin_write_conflict"))
    })
    .await
}

/// `_sync_state`'s optimistic read over one active account state row.
fn sync_state_statement() -> String {
    "SELECT id,json FROM plugin_states WHERE user_id=? AND plugin_key='@legacy-v2'".into()
}

const UPDATE_SYNC_STATE_QUERY: &str = "UPDATE plugin_states SET json=?,updated_at=NOW() WHERE id=? AND user_id=? AND plugin_key='@legacy-v2' AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.revision')) AS SIGNED),0)=?";

#[derive(FromMysqlRow)]
struct StoredSyncState {
    id: i64,
    json: Value,
}

/// `supports_plugin_sync_v2`: only an explicit integer `protocolVersion = 2`
/// advertisement selects the versioned payload.
#[cfg(test)]
fn supports_plugin_sync_v2(runtime_features: Option<&Value>) -> bool {
    plugin_sync_version(runtime_features).is_some()
}

pub(crate) fn plugin_sync_version(runtime_features: Option<&Value>) -> Option<i64> {
    let features = runtime_features.and_then(Value::as_object)?;
    let advertisement = features.get("pluginSync").and_then(Value::as_object)?;
    // `type(version) is int and version == 2`: floats, booleans and strings do
    // not advertise the protocol.
    if advertisement
        .get("supportedVersions")
        .and_then(Value::as_array)
        .is_some_and(|versions| versions.iter().any(|v| v.as_i64() == Some(3)))
    {
        return Some(3);
    }
    advertisement
        .get("protocolVersion")
        .and_then(Value::as_i64)
        .filter(|v| matches!(v, 2 | 3))
}

pub(crate) fn supports_snapshot(features: Option<&Value>, payload: &Value) -> bool {
    let version = payload["plugin_sync"]["version"].as_i64();
    match (plugin_sync_version(features), version) {
        (Some(selected), Some(requested)) => {
            selected == requested || (selected == 3 && requested == 2)
        }
        _ => false,
    }
}

/// The legacy V2 stream in `plugin_states`, initialized before publication.
pub(crate) struct PluginSyncState {
    pub id: i64,
    /// The stored synchronization document.
    pub json: Value,
}

pub(crate) async fn ensure_sync_state<M: Mysql>(mysql: &M, user_id: i64) -> MysqlResult<()> {
    mysql
        .with_transaction_options(
            MysqlTransactionOptions::default()
                .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
            async |tx| {
                let mut query = &mut *tx;
                super::state_store::ensure(&mut query, user_id, "@legacy-v2", 0).await?;
                Ok(())
            },
        )
        .await
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
    let rows: Vec<StoredSyncState> = query.fetch_all(sync_state_statement(), (user_id,)).await?;
    let mut rows = rows;
    match rows.len() {
        0 => {
            let row = super::state_store::ensure(query, user_id, "@legacy-v2", 0).await?;
            Ok(PluginSyncState {
                id: row.id,
                json: row.json,
            })
        }
        1 => {
            let row = rows.swap_remove(0);
            Ok(PluginSyncState {
                id: row.id,
                json: row.json,
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

/// Update an initialized state; an unchanged document emits no write.
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
    state_id: i64,
    user_id: i64,
    document: &str,
    changed: bool,
) -> MysqlResult<()> {
    let mut payload: Value =
        serde_json::from_str(document).map_err(|_| coordination_error("plugin_write_conflict"))?;
    let revision = super::write_coordination::business_revision(&payload)?;
    payload["spec"]["revision"] = Value::from(revision + 1);
    let serialized = python_json_value(&payload);
    if !changed {
        return Ok(());
    }
    let updated = query
        .execute(
            UPDATE_SYNC_STATE_QUERY,
            (serialized, state_id, user_id, revision),
        )
        .await?;
    if updated.rows_affected != 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    Ok(())
}

pub(crate) async fn touch_desired_state<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    installed_ids: &[i64],
) -> MysqlResult<()> {
    super::state_store::touch_installations(query, user_id, installed_ids).await?;
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
    let fences = super::state_store::snapshot_fences(query, user_id, None).await?;
    let payload =
        build_desired_capabilities_for_registration_on(query, user_id, device_id, include_plugins)
            .await?;
    super::state_store::fence_legacy_snapshot(query, &payload, fences, generation).await?;
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
    protocol_version: i64,
) -> Result<Value, BuildError> {
    with_sync_write_budget(async {
        if protocol_version == 2 { ensure_sync_state(&state.mysql, user_id)
            .await
            .map_err(BuildError::Mysql)?; }
        for attempt in 0..SNAPSHOT_WRITE_ATTEMPTS {
            let mut build_error = None;
            let mut generation = 0;
            let outcome = state
                .mysql
                .with_transaction_options(
                    MysqlTransactionOptions::default()
                        .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
                    async |tx| {
                        let mut query = &mut *tx;
                        let snapshot = if protocol_version == 3 {
                            build_scoped_registration_snapshot(&mut query,user_id,device_id,include_plugins).await
                        } else { build_versioned_snapshot(
                            &mut query,
                            user_id,
                            device_id,
                            include_plugins,
                            None,
                        )
                        .await }
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
            if attempt + 1 < SNAPSHOT_WRITE_ATTEMPTS
                && matches!(&outcome, Err(error) if super::write_coordination::plugin_write_error_code(error) == Some("plugin_write_conflict"))
            {
                continue;
            }
            if let Some(error) = build_error {
                return Err(error);
            }
            let mut payload = outcome.map_err(BuildError::Mysql)?;
            if protocol_version == 2 { payload["plugin_sync"] = plugin_sync_metadata(generation, complete); }
            return Ok(payload);
        }
        Err(BuildError::Mysql(coordination_error(
            "plugin_write_conflict",
        )))
    })
    .await
}

async fn build_scoped_registration_snapshot<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
    include_plugins: bool,
) -> Result<VersionedSnapshot, BuildError> {
    let fences = super::state_store::snapshot_fences(query, user_id, None).await?;
    let capabilities = super::state_store::ensure(query, user_id, "@capabilities", 0).await?;
    let mut payload =
        build_desired_capabilities_for_registration_on(query, user_id, device_id, include_plugins)
            .await?;
    super::state_store::add_tombstones(&mut payload, &fences);
    let generation =
        super::state_store::publish_snapshot(query, &mut payload, fences, Some(capabilities))
            .await?;
    Ok(VersionedSnapshot {
        payload,
        generation,
    })
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
    with_sync_write_budget(async {
        let Some(metadata) = payload.get("plugin_sync") else {
            return Ok(());
        };
        let generation = generation_value(metadata.get("generation"));
        let complete = metadata.get("complete") == Some(&Value::Bool(true));
        let installed_plugin_ids = payload_plugin_ids(payload);
        if metadata["version"].as_i64()==Some(3) {
            return retry_sync_write(SNAPSHOT_WRITE_ATTEMPTS, || async {
                state.mysql.with_transaction_options(MysqlTransactionOptions::default().with_isolation_level(MysqlIsolationLevel::ReadCommitted),async |tx| {
                    let mut query=&mut *tx;
                    let canonical=plugin_device_id_on(&mut query,user_id,device_id).await?;
                    let mut ids=installed_plugin_ids.clone(); ids.sort_unstable(); ids.dedup();
                    for id in ids {
                        let fences=super::state_store::snapshot_fences(&mut query,user_id,Some(id)).await?;
                        let row=&fences[0].state;
                        let mut document=row.json.clone();
                        let generation=metadata["revisions"][id.to_string()].as_i64().filter(|v| *v>0).ok_or_else(||coordination_error("plugin_write_conflict"))?;
                        advance_plugin_snapshot_watermark(&mut document,&canonical,generation,false,&[id]);
                        super::state_store::replace(&mut query,row,document).await?;
                    }
                    Ok(())
                }).await
            }).await;
        }
        ensure_sync_state(&state.mysql, user_id).await?;
        for attempt in 0..SNAPSHOT_WRITE_ATTEMPTS {
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
            if attempt + 1 < SNAPSHOT_WRITE_ATTEMPTS
                && matches!(&outcome, Err(error) if super::write_coordination::plugin_write_error_code(error) == Some("plugin_write_conflict"))
            {
                continue;
            }
            return outcome;
        }
        Err(coordination_error("plugin_write_conflict"))
    })
    .await
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
        let expected_generation = if metadata["version"].as_i64() == Some(3) {
            metadata["revisions"][&identity].as_i64()
        } else {
            Some(generation)
        };
        if !item_generation.is_some_and(is_integer)
            || item_generation.and_then(Value::as_i64) != expected_generation
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
#[path = "plugin_sync_protocol_tests.rs"]
mod tests;
