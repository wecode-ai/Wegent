// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Device identity and Runtime-route resolution for the device claim.
//!
//! Mirrors `app.services.device.identity` and
//! `app.services.device.runtime_route`: a submitted execution device id is
//! resolved against one user's active `Device` kinds, and the persisted
//! `spec` decides the canonical Runtime route identity.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::{Map, Value};

/// SQLAlchemy's labeled projection of `Kind`, reused by every device read.
pub(crate) const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at";

/// Persisted device transport prefix for a Wework App installation record.
const RECORD_ROUTE_PREFIX: &str = "app-record-";

/// `app.schemas.device.DeviceType`: the persisted device type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeviceType {
    Local,
    App,
    Cloud,
    Remote,
}

impl DeviceType {
    /// `DeviceType(value)`: an unknown or non-string value falls back to
    /// `local` in the source, so `None` here means "use the default".
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "local" => Some(Self::Local),
            "app" => Some(Self::App),
            "cloud" => Some(Self::Cloud),
            "remote" => Some(Self::Remote),
            _ => None,
        }
    }
}

/// One `kinds` `Device` row; `spec` is read from the stored JSON document.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct KindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_json")]
    pub json: Option<Json<Value>>,
}

/// The persisted `spec` object of a device row (`_device_spec`).
fn spec(row: &KindRow) -> Option<&Map<String, Value>> {
    let document = &row.json.as_ref()?.0;
    document.as_object()?.get("spec")?.as_object()
}

/// `str(value or "")` for the JSON forms a device `spec` may carry.
///
/// Every identity field is coerced by the source with `str(... or "")`; scalars
/// keep their Python spelling, while an unexpected collection renders a repr.
pub(crate) fn py_str_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Bool(false)) => String::new(),
        Some(Value::Bool(true)) => "True".to_string(),
        Some(Value::Number(number)) => {
            if number.as_f64() == Some(0.0) {
                String::new()
            } else {
                number.to_string()
            }
        }
        Some(Value::String(text)) => text.clone(),
        Some(other) => {
            if other.as_array().is_some_and(Vec::is_empty)
                || other.as_object().is_some_and(Map::is_empty)
            {
                String::new()
            } else {
                other.to_string()
            }
        }
    }
}

/// `spec.<field>` coerced and trimmed, matching `_device_spec` reads.
fn spec_text(spec: Option<&Map<String, Value>>, field: &str) -> String {
    py_str_or_empty(spec.and_then(|spec| spec.get(field)))
        .trim()
        .to_string()
}

/// `device_kind_type`: `spec.deviceType` when it is a known type, else `local`.
pub(crate) fn device_kind_type(row: &KindRow) -> DeviceType {
    spec(row)
        .and_then(|spec| spec.get("deviceType"))
        .and_then(Value::as_str)
        .and_then(DeviceType::parse)
        .unwrap_or(DeviceType::Local)
}

/// `record_route_id`: App installations use a record-scoped transport id.
pub(crate) fn record_route_id(row: &KindRow) -> String {
    if device_kind_type(row) == DeviceType::App {
        format!("{RECORD_ROUTE_PREFIX}{}", row.id)
    } else {
        row.name.clone()
    }
}

/// `record_id_from_route`: parse the persisted Device id out of an App route.
fn record_id_from_route(device_id: &str) -> Option<i64> {
    let suffix = device_id.strip_prefix(RECORD_ROUTE_PREFIX)?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    suffix.parse::<i64>().ok().filter(|id| *id > 0)
}

/// `device_identity_ids`: every persisted identity that refers to one device.
pub(crate) fn device_identity_ids(row: &KindRow) -> Vec<String> {
    let device_spec = spec(row);
    let mut identities = vec![
        record_route_id(row),
        row.name.trim().to_string(),
        spec_text(device_spec, "deviceId"),
        spec_text(device_spec, "appDeviceId"),
    ];
    identities.retain(|identity| !identity.is_empty());
    let mut unique: Vec<String> = Vec::with_capacity(identities.len());
    for identity in identities {
        if !unique.contains(&identity) {
            unique.push(identity);
        }
    }
    unique
}

/// `_unambiguous_device`: aliases resolve only when one device is identified.
fn unambiguous_device(matches: Vec<KindRow>) -> Option<KindRow> {
    if matches.is_empty() {
        return None;
    }
    if matches.len() == 1 {
        return matches.into_iter().next();
    }
    let mut apps: Vec<KindRow> = matches
        .into_iter()
        .filter(|row| device_kind_type(row) == DeviceType::App)
        .collect();
    if apps.len() == 1 {
        return apps.pop();
    }
    None
}

/// `resolve_owned_device_alias` without guessing across legacy duplicates.
pub(crate) async fn resolve_owned_device_alias<M: Mysql>(
    mysql: &M,
    user_id: i32,
    device_id: &str,
) -> MysqlResult<Option<KindRow>> {
    let submitted = device_id.trim();
    if submitted.is_empty() {
        return Ok(None);
    }
    let base = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Device' AND kinds.namespace = 'default' \
         AND kinds.is_active = true"
    );
    if let Some(record_id) = record_id_from_route(submitted) {
        let sql = format!("{base} AND kinds.id = ?");
        let device: Option<KindRow> = mysql.fetch_optional(&sql, (user_id, record_id)).await?;
        return Ok(device.filter(|row| device_kind_type(row) == DeviceType::App));
    }
    let devices: Vec<KindRow> = mysql.fetch_all(&base, (user_id,)).await?;
    let matches = devices
        .into_iter()
        .filter(|row| device_identity_ids(row).iter().any(|id| id == submitted))
        .collect();
    Ok(unambiguous_device(matches))
}

/// `RuntimeRouteIdentity`: the database-owned logical/Runtime mapping.
#[derive(Debug, Clone)]
pub(crate) struct RuntimeRouteIdentity {
    pub runtime_device_id: String,
    pub runtime_instance_id: Option<String>,
}

/// `runtime_device_route_id`: the canonical identity persisted on queue rows.
fn runtime_device_route_id(row: &KindRow) -> String {
    if device_kind_type(row) == DeviceType::App {
        return record_route_id(row);
    }
    let device_spec = spec(row);
    let spec_device_id = spec_text(device_spec, "deviceId");
    if !spec_device_id.is_empty() {
        return spec_device_id;
    }
    let cloud_device_id = spec_text(
        device_spec
            .and_then(|spec| spec.get("cloudConfig"))
            .and_then(Value::as_object),
        "deviceId",
    );
    if !cloud_device_id.is_empty() {
        return cloud_device_id;
    }
    row.name.trim().to_string()
}

/// `_runtime_instance_id`: `spec.runtimeInstanceId` or `None` when unset.
fn runtime_instance_id(row: &KindRow) -> Option<String> {
    let value = spec_text(spec(row), "runtimeInstanceId");
    (!value.is_empty()).then_some(value)
}

/// `_identity_from_device`: `None` when the device has no Runtime route.
fn identity_from_device(row: &KindRow) -> Option<RuntimeRouteIdentity> {
    let runtime_device_id = runtime_device_route_id(row);
    if runtime_device_id.is_empty() {
        return None;
    }
    Some(RuntimeRouteIdentity {
        runtime_device_id,
        runtime_instance_id: runtime_instance_id(row),
    })
}

/// `resolve_runtime_route_identity`: one owned device's Runtime route.
pub(crate) async fn resolve_runtime_route_identity<M: Mysql>(
    mysql: &M,
    user_id: i32,
    submitted_device_id: &str,
) -> MysqlResult<Option<RuntimeRouteIdentity>> {
    let device = resolve_owned_device_alias(mysql, user_id, submitted_device_id).await?;
    Ok(device.as_ref().and_then(identity_from_device))
}

/// `normalize_execution_device_id`: the canonical Runtime route, else `None`.
pub(crate) async fn normalize_execution_device_id<M: Mysql>(
    mysql: &M,
    user_id: i32,
    submitted_device_id: &str,
) -> MysqlResult<Option<String>> {
    Ok(
        resolve_runtime_route_identity(mysql, user_id, submitted_device_id)
            .await?
            .map(|identity| identity.runtime_device_id),
    )
}

/// `_owned_execution_device_ids`: every queue identity for one user device.
pub(crate) async fn owned_execution_device_ids<M: Mysql>(
    mysql: &M,
    user_id: i32,
    submitted_device_id: &str,
) -> MysqlResult<Vec<String>> {
    match resolve_owned_device_alias(mysql, user_id, submitted_device_id).await? {
        Some(device) => Ok(device_identity_ids(&device)),
        None => Ok(vec![submitted_device_id.to_string()]),
    }
}

/// `_canonical_execution_device`: the canonical id, else the submitted id.
pub(crate) async fn canonical_execution_device<M: Mysql>(
    mysql: &M,
    user_id: i32,
    submitted_device_id: &str,
) -> MysqlResult<String> {
    if submitted_device_id.is_empty() {
        return Ok(submitted_device_id.to_string());
    }
    let normalized = normalize_execution_device_id(mysql, user_id, submitted_device_id).await?;
    Ok(normalized.unwrap_or_else(|| submitted_device_id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: i64, name: &str, spec: Value) -> KindRow {
        KindRow {
            id,
            name: name.to_string(),
            json: Some(Json(json!({ "spec": spec }))),
        }
    }

    #[test]
    fn app_records_use_the_record_scoped_route() {
        let device = row(
            267101,
            "local-device",
            json!({
                "deviceType": "app",
                "deviceId": "electron-5b4a6b29-5218-45fe-b306-6a131274b09c",
                "appDeviceId": "",
                "runtimeInstanceId": "runtime-a5cfdcea95b0020028430374"
            }),
        );
        assert_eq!(device_kind_type(&device), DeviceType::App);
        assert_eq!(record_route_id(&device), "app-record-267101");
        assert_eq!(
            device_identity_ids(&device),
            vec![
                "app-record-267101".to_string(),
                "local-device".to_string(),
                "electron-5b4a6b29-5218-45fe-b306-6a131274b09c".to_string(),
            ]
        );
        let identity = identity_from_device(&device).unwrap();
        assert_eq!(identity.runtime_device_id, "app-record-267101");
        assert_eq!(
            identity.runtime_instance_id.as_deref(),
            Some("runtime-a5cfdcea95b0020028430374")
        );
    }

    #[test]
    fn local_devices_prefer_the_spec_device_id() {
        let device = row(
            9,
            "local-device",
            json!({ "deviceType": "local", "deviceId": "desktop-1" }),
        );
        assert_eq!(device_kind_type(&device), DeviceType::Local);
        assert_eq!(record_route_id(&device), "local-device");
        assert_eq!(
            identity_from_device(&device).unwrap().runtime_device_id,
            "desktop-1"
        );
    }

    #[test]
    fn unknown_device_type_defaults_to_local() {
        let device = row(3, "desk", json!({ "deviceType": 7 }));
        assert_eq!(device_kind_type(&device), DeviceType::Local);
    }

    #[test]
    fn record_id_from_route_requires_a_positive_numeric_suffix() {
        assert_eq!(record_id_from_route("app-record-267101"), Some(267101));
        assert_eq!(record_id_from_route("app-record-0"), None);
        assert_eq!(record_id_from_route("app-record-abc"), None);
        assert_eq!(record_id_from_route("local-device"), None);
    }

    #[test]
    fn unambiguous_device_accepts_a_single_app_record() {
        let one = vec![row(1, "a", json!({}))];
        assert_eq!(unambiguous_device(one).unwrap().id, 1);
        let two = vec![
            row(1, "a", json!({ "deviceType": "local" })),
            row(2, "b", json!({ "deviceType": "app" })),
        ];
        assert_eq!(unambiguous_device(two).unwrap().id, 2);
        let ambiguous = vec![
            row(1, "a", json!({ "deviceType": "local" })),
            row(2, "b", json!({ "deviceType": "local" })),
        ];
        assert!(unambiguous_device(ambiguous).is_none());
    }
}
