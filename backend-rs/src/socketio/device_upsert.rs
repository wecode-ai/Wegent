// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `upsert_device_crd` for non-cloud devices: one owner-locked transaction.
//!
//! Source: `app/services/device_service.py::upsert_device_crd`, which commits
//! the authentication reads, then calls
//! `app/services/device/identity.py::find_registration_device`:
//!
//! 1. `lock_device_owner` takes the `users` row lock (`SELECT users.id ...
//!    FOR UPDATE`), serializing registration against deletion;
//! 2. the owned Device rows with this name are read **without** a Kind lock and
//!    **ordered by primary key** — the source relies on the owner lock and
//!    deliberately avoids an absent-range gap lock;
//! 3. the all-row/duplicate/ambiguity selection runs over every returned row;
//! 4. the create branch counts the user's active local devices for `isDefault`;
//! 5. the row write commits on the same transaction as the owner lock.

use brz_mysql::{MysqlResult, MysqlTransaction};
use serde_json::{Map, Value};

use super::device_error_text::ParamValue;
use crate::device_records::{LOCK_DEVICE_OWNER_QUERY, LockOwnerRow};
use crate::json_compat::python_json_value;

use super::device::{
    DeviceKindRow, DeviceType, RegisterPayload, RuntimeInstanceMismatch, UPDATE_DEVICE_JSON_QUERY,
    UPDATE_REGISTERED_DEVICE_QUERY, UPDATE_REGISTERED_DEVICE_REACTIVATE_QUERY,
    validate_runtime_instance,
};
use crate::state::AppState;

/// `find_registration_device`'s owned-device read: every row with this name,
/// ordered by primary key, with no `FOR UPDATE` (the owner lock serializes).
const DEVICE_BY_NAME_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' AND kinds.namespace = 'default' \
     AND kinds.name = ? ORDER BY kinds.id";

/// `upsert_device_crd`'s create branch: the user's active Device rows used for
/// the `isDefault` decision (no name filter, no lock).
const EXISTING_DEVICES_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' AND kinds.namespace = 'default' \
     AND kinds.is_active = true";

const CLOUD_DEVICES_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' AND kinds.namespace = 'default' \
     AND kinds.is_active IS true AND CASE JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
     '$.\"deviceType\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(\
     kinds.json, '$.\"spec\"'), '$.\"deviceType\"')) END = 'cloud' FOR UPDATE";

/// `db.refresh(device_kind)` after the successful commit: `db.get(Kind, id)`
/// with the full mapped-column projection.
const DEVICE_BY_ID_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.id = ?";

const INSERT_DEVICE_QUERY: &str = "INSERT INTO kinds (user_id, kind, name, namespace, json, \
     is_active, created_at, updated_at) VALUES (?, 'Device', ?, 'default', ?, 1, now(), now())";

/// Matches one cloud device by its server-generated id and pins its Runtime.
///
/// Returns `Ok(Some(row))` with the row read back after the commit, matching
/// the source's expired-instance reload, or `Ok(None)` when nothing matched or
/// the reload failed (the source's generic handler treats both as "no match").
///
/// # Errors
///
/// Returns [`RuntimeInstanceMismatch`] when the persisted device belongs to a
/// different Runtime installation.
pub async fn match_cloud_device(
    state: &AppState,
    user_id: i64,
    payload: &RegisterPayload,
    runtime_transfer_host: Option<&str>,
) -> Result<Option<DeviceKindRow>, RuntimeInstanceMismatch> {
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            match_cloud_registration(&mut *transaction, user_id, payload, runtime_transfer_host)
                .await
        })
        .await;
    match outcome {
        Ok(CloudMatch::Matched(row)) => {
            // `_match_cloud_device_sync` commits the Runtime pin and then reads
            // the expired ORM instance again (`logger.info(... device.name ...)`
            // and `return (device.name, False, None)`), which reloads the row
            // by primary key. The source's `SessionLocal` keeps SQLAlchemy's
            // default `expire_on_commit=True`, so the committed row is always
            // read back before its name is used. A failed reload is the
            // wrapper's `except Exception` branch: it logs and reports no
            // match, so registration falls through to `upsert_device_crd`.
            let row_id = row.id;
            match state
                .mysql
                .fetch_optional(DEVICE_BY_ID_QUERY, (row_id,))
                .await
            {
                Ok(refreshed) => Ok(refreshed),
                Err(error) => {
                    tracing::error!(
                        %error,
                        user_id,
                        row_id,
                        "cloud device post-commit reload failed"
                    );
                    Ok(None)
                }
            }
        }
        Ok(CloudMatch::None) => Ok(None),
        Ok(CloudMatch::Rejected(rejected)) => Err(rejected),
        Err(error) => {
            tracing::error!(%error, user_id, "cloud device runtime update failed");
            Err(RuntimeInstanceMismatch("cloud device update failed".into()))
        }
    }
}

/// One `_match_cloud_device_sync` call: lock the cloud rows, then pin the
/// matched Runtime on the same transaction the source commits once.
async fn match_cloud_registration<T>(
    transaction: &mut T,
    user_id: i64,
    payload: &RegisterPayload,
    runtime_transfer_host: Option<&str>,
) -> MysqlResult<CloudMatch>
where
    T: MysqlTransaction + Send,
{
    let rows: Vec<DeviceKindRow> = transaction
        .fetch_all(CLOUD_DEVICES_QUERY, (user_id,))
        .await?;
    for row in rows {
        let spec = row.json.get("spec").cloned().unwrap_or_default();
        let cloud = spec.get("cloudConfig").cloned().unwrap_or_default();
        let sandbox_id = cloud
            .get("sandboxId")
            .and_then(Value::as_str)
            .unwrap_or(&row.name)
            .to_owned();
        let server_device_id = cloud.get("deviceId").and_then(Value::as_str);
        let matched = match server_device_id.filter(|value| !value.is_empty()) {
            Some(server) if server == payload.device_id => true,
            Some(_) => false,
            // Legacy devices without `cloudConfig.deviceId` match by name.
            None => row.name == sandbox_id,
        };
        if !matched {
            continue;
        }
        if let Err(rejected) = validate_runtime_instance(
            &row.json,
            payload.runtime_instance_id.as_deref(),
            &sandbox_id,
        ) {
            return Ok(CloudMatch::Rejected(rejected));
        }
        let Some(json) = cloud_runtime_spec(&row.json, payload, runtime_transfer_host) else {
            continue;
        };
        let row_id = row.id;
        transaction
            .execute(UPDATE_DEVICE_JSON_QUERY, (json, row_id))
            .await?;
        return Ok(CloudMatch::Matched(row));
    }
    Ok(CloudMatch::None)
}

/// One `_match_cloud_device_sync` outcome inside its single transaction.
enum CloudMatch {
    Matched(DeviceKindRow),
    None,
    Rejected(RuntimeInstanceMismatch),
}

/// The cloud row's `spec` after the Runtime pin, serialized for the update.
fn cloud_runtime_spec(
    json: &Value,
    payload: &RegisterPayload,
    runtime_transfer_host: Option<&str>,
) -> Option<String> {
    let mut updated = json.clone();
    let spec = updated
        .as_object_mut()
        .and_then(|object| object.get_mut("spec"))
        .and_then(Value::as_object_mut)?;
    if let Some(runtime) = payload.runtime_instance_id.as_deref() {
        spec.insert("runtimeInstanceId".into(), Value::String(runtime.into()));
    }
    if let Some(host) = runtime_transfer_host {
        spec.insert("runtimeTransferHost".into(), Value::String(host.into()));
    }
    spec.insert(
        "runtimeTransferPort".into(),
        payload
            .effective_transfer_port()
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    crate::device_presence::mark_registered(&mut updated, chrono::Utc::now());
    Some(serde_json::to_string(&updated).expect("a JSON value serializes"))
}

/// Upserts a non-cloud device CRD (`upsert_device_crd` update/create branch).
pub async fn upsert_device(
    state: &AppState,
    user_id: i64,
    payload: &RegisterPayload,
    runtime_transfer_host: Option<&str>,
    client_ip: Option<&str>,
) -> Result<DeviceKindRow, String> {
    if let Some(rejected) = pre_transaction_rejection(payload) {
        return Err(rejected);
    }
    // A rejected registration raises in the source, so `_db_session` rolls the
    // transaction back. Surface the rejection through the transaction's error
    // path for the same observable end state instead of committing nothing.
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            upsert_registration(
                &mut *transaction,
                user_id,
                payload,
                runtime_transfer_host,
                client_ip,
                state.unique_app_device_names,
            )
            .await
        })
        .await;
    let row_id = match outcome {
        Ok(row_id) => row_id,
        Err(error) => return Err(rejection_message(error)),
    };
    // `device_service.upsert_device_crd`: `db.commit(); db.refresh(device_kind)`
    // then the caller reads the fresh `displayName`/name and route. The refresh
    // is one request-owned read after the commit, never inside it.
    let refreshed: Option<DeviceKindRow> = state
        .mysql
        .fetch_optional(DEVICE_BY_ID_QUERY, (row_id,))
        .await
        .map_err(|error| error.to_string())?;
    refreshed.ok_or_else(|| "device refresh returned no row".to_owned())
}

/// `find_registration_device` + the Device write on one transaction.
///
/// The owner lock, the owned-device read and the committed write all share this
/// handle, so the lock spans the write it guards. A rejected identity returns
/// the source message so the outer transaction finishes exactly as the source
/// session does (no write).
async fn upsert_registration<T>(
    transaction: &mut T,
    user_id: i64,
    payload: &RegisterPayload,
    runtime_transfer_host: Option<&str>,
    client_ip: Option<&str>,
    unique_app_device_names: bool,
) -> MysqlResult<i64>
where
    T: MysqlTransaction + Send,
{
    // `find_registration_device` → `lock_device_owner`.
    let _owner: Option<LockOwnerRow> = transaction
        .fetch_optional(LOCK_DEVICE_OWNER_QUERY, (user_id,))
        .await?;
    // `db.query(Kind).filter_by(...).populate_existing().order_by(Kind.id)`: no
    // Kind lock; the owner lock already serializes creation and removal.
    let devices: Vec<DeviceKindRow> = transaction
        .fetch_all(DEVICE_BY_NAME_QUERY, (user_id, payload.device_id.as_str()))
        .await?;
    let selected = match select_registration_device(
        &devices,
        &payload.device_id,
        payload.runtime_instance_id.as_deref(),
        payload.app_device_id.as_deref(),
        payload.device_type,
        unique_app_device_names,
    ) {
        Ok(selected) => selected.cloned(),
        Err(conflict) => return Err(rejection(conflict)),
    };
    let Some(row) = selected else {
        return insert_registration(
            transaction,
            user_id,
            payload,
            runtime_transfer_host,
            client_ip,
        )
        .await;
    };
    if let Err(mismatch) = validate_runtime_instance(
        &row.json,
        payload.runtime_instance_id.as_deref(),
        &payload.device_id,
    ) {
        return Err(rejection(mismatch.0));
    }
    let json =
        match updated_device_json(row.json.clone(), payload, runtime_transfer_host, client_ip) {
            Ok(json) => json,
            Err(error) => return Err(rejection(error)),
        };
    let row_id = row.id;
    let reactivates = row.is_active == 0;
    // `device_kind.updated_at = datetime.now()`: the source binds a client-side
    // local timestamp, which overrides the model's `onupdate=func.now()`.
    let updated_at = chrono::Local::now().naive_local();
    transaction
        .execute(device_update_query(reactivates), (json, updated_at, row_id))
        .await?;
    Ok(row_id)
}

/// `upsert_device_crd`'s identity validations, which run before any
/// transaction: an empty id, an App registration without a persistent Runtime
/// ID and the reserved record-route prefix all raise before
/// `find_registration_device` takes the owner lock.
fn pre_transaction_rejection(payload: &RegisterPayload) -> Option<String> {
    if payload.device_id.trim().is_empty() {
        return Some("Device ID is required for registration".to_owned());
    }
    if payload.device_type == DeviceType::App
        && payload
            .runtime_instance_id
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Some("App registration requires a persistent Runtime ID".to_owned());
    }
    if payload.device_id.starts_with(RECORD_ROUTE_PREFIX) {
        return Some("Device ID uses a reserved routing prefix".to_owned());
    }
    None
}

/// `identity.RECORD_ROUTE_PREFIX`: ids reserved for record-scoped App routes.
const RECORD_ROUTE_PREFIX: &str = "app-record-";

/// A registration the source rejects by raising. Carried as a transaction error
/// so the wrapper rolls back instead of committing an empty transaction.
fn rejection(message: String) -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery { reason: message }
}

/// The source message for a rolled-back registration, or the database error.
fn rejection_message(error: brz_mysql::MysqlError) -> String {
    match error {
        brz_mysql::MysqlError::InvalidQuery { reason } => reason,
        error => error.to_string(),
    }
}

/// The UPDATE that also reactivates an inactive row. SQLAlchemy only emits
/// `is_active` when the assignment changes the value, so an already-active row
/// keeps the plain `json`/`updated_at` profile. Both profiles bind the
/// `upsert_device_crd` client-side `updated_at`, never the `onupdate` clock.
fn device_update_query(reactivates: bool) -> &'static str {
    if reactivates {
        UPDATE_REGISTERED_DEVICE_REACTIVATE_QUERY
    } else {
        UPDATE_REGISTERED_DEVICE_QUERY
    }
}

/// `SQLAlchemy`'s compiled create-branch INSERT: named placeholders, with
/// `kind`/`namespace` bound like every other column.
const INSERT_DEVICE_ORM_SQL: &str = "INSERT INTO kinds (user_id, kind, name, namespace, json, \
     is_active, created_at, updated_at) VALUES (%(user_id)s, %(kind)s, %(name)s, %(namespace)s, \
     %(json)s, %(is_active)s, now(), now())";

/// `str(SQLAlchemy IntegrityError)` for the create branch's INSERT.
fn device_insert_error(
    error: &brz_mysql::MysqlError,
    user_id: i64,
    device_id: &str,
    json: &str,
) -> String {
    let brz_mysql::MysqlError::Database {
        code: Some(code),
        message,
        ..
    } = error
    else {
        return error.to_string();
    };
    let code = i64::from(*code);
    super::device_error_text::sqlalchemy_dbapi_error(
        code,
        message,
        INSERT_DEVICE_ORM_SQL,
        &[
            ("user_id", ParamValue::Int(user_id)),
            ("kind", ParamValue::Text("Device".into())),
            ("name", ParamValue::Text(device_id.to_owned())),
            ("namespace", ParamValue::Text("default".into())),
            ("json", ParamValue::Text(json.to_owned())),
            ("is_active", ParamValue::Int(1)),
        ],
    )
}

/// `find_registration_device`'s selection over every owned row with this name.
///
/// The source reads all rows (ordered by primary key) and then:
/// 1. prefers an exact `(runtimeInstanceId, appDeviceId)` match, active first;
/// 2. allocates a separate App route where the store permits the name, or
///    returns an actionable conflict when the store enforces unique names;
/// 3. rejects >1 active row as ambiguous;
/// 4. otherwise falls back to the single active row;
/// 5. for inactive duplicates, keeps the one whose Runtime installation matches
///    and rejects anything not reducible to one row.
fn select_registration_device<'a>(
    devices: &'a [DeviceKindRow],
    device_id: &str,
    runtime_instance_id: Option<&str>,
    app_device_id: Option<&str>,
    device_type: DeviceType,
    unique_app_device_names: bool,
) -> Result<Option<&'a DeviceKindRow>, String> {
    let app_name_is_unique = unique_app_device_names && device_type == DeviceType::App;
    let runtime = runtime_instance_id.filter(|value| !value.is_empty());
    if let Some(runtime) = runtime {
        let exact: Vec<&DeviceKindRow> = devices
            .iter()
            .filter(|device| {
                (!app_name_is_unique || can_restore_as_app(&device.json))
                    && spec_string(&device.json, "runtimeInstanceId") == Some(runtime)
                    && spec_string(&device.json, "appDeviceId") == app_device_id
            })
            .collect();
        if let Some(first) = exact.first() {
            let active = exact.iter().copied().find(|device| device.is_active != 0);
            return Ok(active.or(Some(*first)));
        }
    }
    if device_type == DeviceType::App {
        if app_name_is_unique && !devices.is_empty() {
            let same_runtime = runtime.is_some()
                && devices.iter().any(|device| {
                    can_restore_as_app(&device.json)
                        && spec_string(&device.json, "runtimeInstanceId") == runtime
                });
            return Err(if same_runtime {
                "App device identity changed; reconnect using the original installation identity"
                    .into()
            } else {
                "Device name is already registered; configure a unique persistent device ID for this installation".into()
            });
        }
        return Ok(None);
    }
    let active: Vec<&DeviceKindRow> = devices
        .iter()
        .filter(|device| device.is_active != 0)
        .collect();
    if active.len() > 1 {
        return Err(format!(
            "Ambiguous device identity {device_id}; \
             select or reconnect the original installation"
        ));
    }
    if let Some(first) = active.first() {
        return Ok(Some(first));
    }
    if devices.len() > 1 {
        let by_runtime: Vec<&DeviceKindRow> = devices
            .iter()
            .filter(|device| spec_string(&device.json, "runtimeInstanceId") == runtime_instance_id)
            .collect();
        if by_runtime.len() != 1 {
            return Err(format!(
                "Ambiguous inactive device identity {device_id}; \
                 reconnect using the original installation identity"
            ));
        }
        return Ok(Some(by_runtime[0]));
    }
    Ok(devices.first())
}

fn can_restore_as_app(json: &Value) -> bool {
    is_local_device(json) || matches!(spec_string(json, "deviceType"), Some("app" | "remote"))
}

/// `upsert_device_crd`'s create branch.
async fn insert_registration<T>(
    transaction: &mut T,
    user_id: i64,
    payload: &RegisterPayload,
    runtime_transfer_host: Option<&str>,
    client_ip: Option<&str>,
) -> MysqlResult<i64>
where
    T: MysqlTransaction + Send,
{
    // `existing_devices`: every active owned Device row; only rows whose
    // `spec.deviceType` is absent (default `local`) or literally `local` count.
    let existing: Vec<DeviceKindRow> = transaction
        .fetch_all(EXISTING_DEVICES_QUERY, (user_id,))
        .await?;
    let local_count = existing
        .iter()
        .filter(|device| is_local_device(&device.json))
        .count();
    let is_first_device = payload.device_type == DeviceType::Local && local_count == 0;
    let json = create_device_json(payload, runtime_transfer_host, client_ip, is_first_device);
    let device_id = payload.device_id.clone();
    let inserted = match transaction
        .execute(
            INSERT_DEVICE_QUERY,
            (user_id, device_id.clone(), json.clone()),
        )
        .await
    {
        Ok(inserted) => inserted,
        // `_register_device` returns `str(exc)`; SQLAlchemy renders the DB-API
        // error with the compiled statement and bound parameters.
        Err(error) => {
            return Err(rejection(device_insert_error(
                &error, user_id, &device_id, &json,
            )));
        }
    };
    let inserted_id = i64::try_from(inserted.last_insert_id).map_err(|_| {
        brz_mysql::MysqlError::InvalidQuery {
            reason: "device insert id overflow".into(),
        }
    })?;
    if inserted_id == 0 {
        return Err(brz_mysql::MysqlError::InvalidQuery {
            reason: "device insert returned no id".into(),
        });
    }
    Ok(inserted_id)
}

/// `device.json.get("spec", {}).get("deviceType", "local") == "local"`.
fn is_local_device(json: &Value) -> bool {
    match json.get("spec").and_then(|spec| spec.get("deviceType")) {
        None => true,
        Some(Value::String(value)) => value == "local",
        Some(_) => false,
    }
}

/// One `spec.<key>` string value, matching Python's `.get(key)`.
fn spec_string<'a>(json: &'a Value, key: &str) -> Option<&'a str> {
    json.get("spec")
        .and_then(|spec| spec.get(key))
        .and_then(Value::as_str)
}

/// `upsert_device_crd`'s create-branch document.
///
/// `_register_device` calls the service with `update_runtime_transfer_port=True`
/// and never forwards `capabilities`, so those keys are always present (the
/// latter as the source's explicit `null`).
fn create_device_json(
    payload: &RegisterPayload,
    runtime_transfer_host: Option<&str>,
    client_ip: Option<&str>,
    is_first_device: bool,
) -> String {
    let optional =
        |value: Option<&str>| value.map_or(Value::Null, |value| Value::String(value.to_owned()));
    let mut spec = Map::new();
    spec.insert("deviceId".into(), Value::String(payload.device_id.clone()));
    spec.insert(
        "deviceType".into(),
        Value::String(payload.device_type.value().to_owned()),
    );
    spec.insert("connectionMode".into(), Value::String("websocket".into()));
    spec.insert(
        "bindShell".into(),
        Value::String(payload.bind_shell.value().to_owned()),
    );
    spec.insert("isDefault".into(), Value::Bool(is_first_device));
    spec.insert("capabilities".into(), Value::Null);
    // `_register_device` forwards the connection peer (`REMOTE_ADDR`), not the
    // executor-reported `payload.client_ip`.
    spec.insert("clientIp".into(), optional(client_ip));
    spec.insert(
        "runtimeTransferHost".into(),
        optional(runtime_transfer_host),
    );
    spec.insert(
        "runtimeInstanceId".into(),
        optional(payload.runtime_instance_id.as_deref()),
    );
    spec.insert(
        "appDeviceId".into(),
        optional(payload.app_device_id.as_deref()),
    );
    spec.insert(
        "runtimeTransferPort".into(),
        payload
            .effective_transfer_port()
            .map_or(Value::Null, Value::from),
    );
    let mut metadata = Map::new();
    metadata.insert("name".into(), Value::String(payload.device_id.clone()));
    metadata.insert("namespace".into(), Value::String("default".into()));
    let mut document = Map::new();
    document.insert(
        "apiVersion".into(),
        Value::String("agent.wecode.io/v1".into()),
    );
    document.insert("kind".into(), Value::String("Device".into()));
    document.insert("metadata".into(), Value::Object(metadata));
    document.insert("spec".into(), Value::Object(spec));
    document.insert("status".into(), serde_json::json!({"state": "Available"}));
    let mut json = Value::Object(document);
    set_device_display_name(&mut json, &payload.name);
    crate::device_presence::mark_registered(&mut json, chrono::Utc::now());
    python_json_value(&json)
}

/// `upsert_device_crd`'s update branch.
fn updated_device_json(
    mut json: Value,
    payload: &RegisterPayload,
    runtime_transfer_host: Option<&str>,
    client_ip: Option<&str>,
) -> Result<String, String> {
    // `persisted_app_id and app_device_id != persisted_app_id`.
    let persisted_app_id = spec_string(&json, "appDeviceId").filter(|value| !value.is_empty());
    if let Some(persisted) = persisted_app_id
        && payload.app_device_id.as_deref() != Some(persisted)
    {
        return Err(format!(
            "App device ID mismatch for device {}",
            payload.device_id
        ));
    }
    // `resolve_device_display_name` keeps an existing alias, then rewrites it.
    let display_name = resolve_device_display_name(&json, &payload.name);
    set_device_display_name(&mut json, &display_name);
    let spec = json
        .as_object_mut()
        .and_then(|object| object.get_mut("spec"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "device json has no spec".to_owned())?;
    spec.insert(
        "deviceType".into(),
        Value::String(payload.device_type.value().to_owned()),
    );
    spec.entry("connectionMode")
        .or_insert_with(|| Value::String("websocket".into()));
    // The source reads `client_ip` from the session and only writes it when
    // the connection peer is known.
    if let Some(client_ip) = client_ip {
        spec.insert("clientIp".into(), Value::String(client_ip.into()));
    }
    if let Some(host) = runtime_transfer_host {
        spec.insert("runtimeTransferHost".into(), Value::String(host.into()));
    }
    // The registration caller always passes `update_runtime_transfer_port=True`.
    spec.insert(
        "runtimeTransferPort".into(),
        payload
            .effective_transfer_port()
            .map_or(Value::Null, Value::from),
    );
    if let Some(runtime) = payload.runtime_instance_id.as_deref() {
        spec.insert("runtimeInstanceId".into(), Value::String(runtime.into()));
    }
    if let Some(app) = payload.app_device_id.as_deref() {
        spec.insert("appDeviceId".into(), Value::String(app.into()));
    }
    // `_register_device` never forwards `capabilities`, so this path keeps the
    // persisted caps (the create branch always persists the source's null).
    // The caller always provides `bind_shell`; a provided value overrides the
    // persisted binding.
    spec.insert(
        "bindShell".into(),
        Value::String(payload.bind_shell.value().to_owned()),
    );
    crate::device_presence::mark_registered(&mut json, chrono::Utc::now());
    Ok(python_json_value(&json))
}

/// `app/services/device/display_name.py::resolve_device_display_name`.
fn resolve_device_display_name(json: &Value, fallback: &str) -> String {
    spec_string(json, "displayName")
        .filter(|value| !value.is_empty())
        .or_else(|| {
            json.get("metadata")
                .and_then(|metadata| metadata.get("displayName"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(fallback)
        .to_owned()
}

/// `app/services/device/display_name.py::set_device_display_name`.
fn set_device_display_name(json: &mut Value, display_name: &str) {
    let Some(object) = json.as_object_mut() else {
        return;
    };
    for key in ["spec", "metadata"] {
        let entry = object
            .entry(key.to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(map) = entry.as_object_mut() {
            map.insert("displayName".into(), Value::String(display_name.to_owned()));
        }
    }
}

pub(super) const PERSIST_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

pub(super) async fn persist_observation(
    state: &crate::state::AppState,
    user_id: i64,
    route_id: &str,
    instance_id: Option<&str>,
    observed_at: chrono::DateTime<chrono::Utc>,
    force: bool,
) {
    let record_id = crate::device_identity::record_id_from_route(route_id);
    let timestamp = observed_at.to_rfc3339_opts(chrono::SecondsFormat::Micros, false);
    let cutoff = if force {
        observed_at - chrono::TimeDelta::microseconds(1)
    } else {
        observed_at - chrono::TimeDelta::seconds(PERSIST_INTERVAL.as_secs() as i64)
    }
    .to_rfc3339_opts(chrono::SecondsFormat::Micros, false);
    let sql = "UPDATE kinds SET json=JSON_SET(
                   IF(JSON_TYPE(JSON_EXTRACT(json, '$.status')) = 'OBJECT', json,
                      JSON_SET(json, '$.status', JSON_OBJECT())),
                   '$.status.lastSeenAt', ?)
               WHERE user_id=? AND kind='Device' AND namespace='default' AND is_active IS true
                 AND (id=? OR (? IS NULL AND name=?))
                 AND (CASE WHEN JSON_TYPE(JSON_EXTRACT(json, '$.spec.runtimeInstanceId')) = 'STRING'
                           THEN JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.runtimeInstanceId'))
                      END) <=> ?
                 AND (JSON_TYPE(JSON_EXTRACT(json, '$.status.lastSeenAt')) IS NULL
                      OR JSON_TYPE(JSON_EXTRACT(json, '$.status.lastSeenAt')) <> 'STRING'
                      OR JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.lastSeenAt')) <= ?)";
    if let Err(error) = state
        .mysql
        .execute(
            sql,
            (
                timestamp.as_str(),
                user_id,
                record_id,
                record_id,
                route_id,
                instance_id,
                cutoff.as_str(),
            ),
        )
        .await
    {
        tracing::warn!(%error, user_id, route_id, "failed to persist device presence");
    }
}

#[cfg(test)]
#[path = "device_upsert_tests.rs"]
mod tests;
