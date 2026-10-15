// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/runtime-profiles` — the current user's Wework Runtime
//! profiles.
//!
//! Mirrors `app.api.endpoints.runtime_profiles.list_runtime_profiles`:
//! 1. `device_service.get_all_devices` — the shared provider listing
//!    (every provider runs its own `kinds` query plus its Redis reads), reused
//!    verbatim from [`crate::devices::list_all_devices`];
//! 2. `runtime_profile_service.ensure_device_defaults` — for every device
//!    without a visible active profile, one `runtime_profile` row is inserted;
//!    the source flushes that write through SQLAlchemy's `before_insert`
//!    adapter, which reflects the table once (`SHOW CREATE TABLE`) to learn the
//!    NOT NULL sentinel columns, then commits;
//! 3. `runtime_profile_service.list` — the user's visible active profiles,
//!    newest `updated_at` first.
//!
//! The endpoint reads `current_user.id` after the default-insert commit, which
//! expires the ORM user and reloads it by primary key (`SELECT users ... WHERE
//! users.id = ?`) before the profile listing. Only a case that inserted a
//! default pays that reload, exactly like the source's `expire_on_commit`.
use std::collections::HashSet;

use brz_mysql::{FromMysqlRow, Json, MysqlRow};
use chrono::NaiveDateTime;

use crate::auth::SessionUser;
use crate::cloud_projects::LOOP_ITEMS_COLUMNS;
use crate::devices::{DeviceType, list_all_devices};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_json::OpaqueJson;

/// Source `_numeric_id` (`app/models/delivery.py`): the `LoopNode.id` default
/// `str(secrets.randbelow(9_000_000_000_000_000_000) + 1)` — a fresh
/// positive 64-bit integer allocated per inserted row.
fn numeric_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    let mut value = u64::from_ne_bytes(bytes);
    value %= 9_000_000_000_000_000_000;
    (value + 1).to_string()
}

/// The metadata JSON the source sets when materializing a fresh device default
/// (`ensure_device_defaults`), serialized by SQLAlchemy's `json.dumps` default
/// (`", "` / `": "` separators) in the source dict insertion order.
const CLOUD_METADATA_JSON: &str = "{\"execution_environment\": \"cloud\", \
     \"model\": \"\", \"model_type\": null, \"model_options\": {}, \
     \"workspace_policy\": \"project\"}";
const LOCAL_METADATA_JSON: &str = "{\"execution_environment\": \"local\", \
     \"model\": \"\", \"model_type\": null, \"model_options\": {}, \
     \"workspace_policy\": \"project\"}";

/// One `loop_items` row projected to the columns the listing reads.
///
/// The full labeled [`LOOP_ITEMS_COLUMNS`] projection is selected (like the
/// source's SQLAlchemy query rendering); only these fields are consumed.
#[derive(Debug, FromMysqlRow)]
struct RuntimeProfileRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_name")]
    name: Option<String>,
    #[mysql(rename = "loop_items_title")]
    title: Option<String>,
    #[mysql(rename = "loop_items_device_id")]
    device_id: Option<String>,
    #[mysql(rename = "loop_items_status")]
    status: String,
    #[mysql(rename = "loop_items_version")]
    version: i64,
    #[mysql(rename = "loop_items_created_at")]
    created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<OpaqueJson>>,
}

/// One `loop_items` row projected to the `device_id`/`metadata` columns
/// `ensure_device_defaults` reads when it collects the already-present
/// defaults.
#[derive(Debug, FromMysqlRow)]
struct ExistingDefaultRow {
    #[mysql(rename = "loop_items_device_id")]
    device_id: Option<String>,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<OpaqueJson>>,
}

/// The metadata JSON document (`metadata_json` on the source model).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct RuntimeMetadata {
    #[serde(rename = "catalog_visibility")]
    catalog_visibility: Option<String>,
    #[serde(rename = "execution_environment")]
    execution_environment: Option<String>,
    model: Option<String>,
    #[serde(rename = "model_type")]
    model_type: Option<String>,
    #[serde(rename = "model_options")]
    model_options: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(rename = "workspace_policy")]
    workspace_policy: Option<String>,
}

/// The non-empty value or the fallback, mirroring the source `x or default`.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/// `runtime_profile_service._catalog_visible`: a profile is visible unless its
/// metadata marks it `catalog_visibility == "internal"`.
fn catalog_visible(metadata: Option<&Json<OpaqueJson>>) -> bool {
    let document: RuntimeMetadata = metadata
        .and_then(|value| value.0.project())
        .unwrap_or_default();
    document.catalog_visibility.as_deref() != Some("internal")
}

/// Pydantic renders a naive `datetime` via `isoformat()`: seconds precision,
/// microseconds only when non-zero.
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// `runtime_profile_service.to_view` from one `runtime_profile` row.
fn to_view(row: &RuntimeProfileRow) -> RuntimeProfileView {
    let metadata: RuntimeMetadata = row
        .metadata
        .as_ref()
        .and_then(|value| value.0.project())
        .unwrap_or_default();
    let name = non_empty(row.name.clone())
        .or_else(|| non_empty(row.title.clone()))
        .unwrap_or_else(|| "Runtime".to_string());
    RuntimeProfileView {
        id: row.id.clone(),
        name,
        execution_environment: non_empty(metadata.execution_environment)
            .unwrap_or_else(|| "local".to_string()),
        execution_device_id: row.device_id.clone().unwrap_or_default(),
        model: metadata.model.unwrap_or_default(),
        model_type: metadata.model_type,
        model_options: metadata.model_options.unwrap_or_default(),
        workspace_policy: non_empty(metadata.workspace_policy)
            .unwrap_or_else(|| "project".to_string()),
        status: if row.status.is_empty() {
            "active".to_string()
        } else {
            row.status.clone()
        },
        version: row.version,
        created_at: row.created_at.map(pydantic_datetime),
        updated_at: row.updated_at.map(pydantic_datetime),
    }
}

/// One response item (`RuntimeProfileView`, camelCase via the
/// `ProjectChatSchema` alias generator). Field order follows the source model.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProfileView {
    id: String,
    name: String,
    execution_environment: String,
    execution_device_id: String,
    model: String,
    model_type: Option<String>,
    model_options: serde_json::Map<String, serde_json::Value>,
    workspace_policy: String,
    status: String,
    version: i64,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// A device default the source materializes in `ensure_device_defaults`.
struct NewProfile<'a> {
    name: &'a str,
    device_id: &'a str,
    metadata: &'static str,
}

/// `ensure_device_defaults`'s existing-default scan: active, non-deleted
/// profiles for the user.
fn existing_defaults_sql() -> String {
    format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.user_id = ? AND loop_items.status = 'active' AND \
         (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AND \
         loop_items.resource_type IN ('runtime_profile')"
    )
}

/// `runtime_profile_service.list`: the user's visible active profiles, newest
/// `updated_at` first.
fn list_sql() -> String {
    format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.user_id = ? AND (loop_items.deleted_at IS NULL OR \
         loop_items.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.resource_type IN ('runtime_profile') \
         ORDER BY loop_items.updated_at DESC"
    )
}

/// The source's single-row `INSERT` for a `RuntimeProfile`. Only the generated
/// id, name/title, the owning user, the device id, and the metadata differ
/// between rows; every other value is the model default or the MySQL NOT NULL
/// sentinel (`1970-01-01 00:00:01`) the source's `before_insert` adapter writes.
const INSERT_PROFILE_SQL: &str = "INSERT INTO loop_items (id, resource_type, \
     project_space, cloud_project_id, parent_id, loop_item_id, delivery_id, \
     public_id, project_key, name, title, description, storage_prefix, \
     sequence_number, next_item_number, created_by_user_id, updated_by_user_id, \
     assignee_user_id, user_id, added_by_user_id, source, status, priority, \
     due_at, sort_order, current_delivery_id, local_project_id, device_id, \
     is_default, task_user_id, assignee_agent_id, assignee_team_id, task_id, \
     task_title, backend_task_id, linked_by_user_id, linked_at, unlinked_at, \
     path, kind, display_name, relative_path, object_key, content_type, \
     size_bytes, sha256, source_task_binding_id, source_task_snapshot, \
     markdown_object_key, chat_object_key, manifest_object_key, metadata, \
     version, created_at, updated_at, completed_at, delivered_at, deleted_at) \
     VALUES (?, 'runtime_profile', 'default', '', '', '', '', '', '', ?, ?, '', \
     '', 0, 1, ?, ?, 0, ?, 0, '', 'active', '', '1970-01-01 00:00:01', 0, '', \
     0, ?, 0, 0, '', 0, '', '', 0, 0, '1970-01-01 00:00:01', \
     '1970-01-01 00:00:01', '', '', '', '', '', '', 0, '', '', '{}', '', '', \
     '', ?, 1, now(), now(), '1970-01-01 00:00:01', '1970-01-01 00:00:01', \
     '1970-01-01 00:00:01')";

/// The source `before_insert` adapter's one-shot table reflection
/// (`loop_node_non_nullable_attributes` -> `inspect(connection).get_columns`),
/// which MySQL serves as `SHOW CREATE TABLE`.
const SHOW_CREATE_TABLE_SQL: &str = "SHOW CREATE TABLE `loop_items`";

/// The ORM reload of the committed `current_user` by primary key, rendered like
/// `db.query(User).filter(User.id == user_id)` (full labeled `users_<column>`
/// projection, no `LIMIT`).
const USER_BY_ID_SQL: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \nWHERE users.id = ?";

/// GET /api/v1/runtime-profiles: the free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/v1/runtime-profiles")]
async fn list_runtime_profiles(
    #[inject(state)] state: &AppState,
    #[header("x-request-id")] request_id: Option<String>,
    #[auth] user: SessionUser,
) -> Result<Vec<RuntimeProfileView>, FastApiError> {
    runtime_profiles(state, user.0.id, request_id.as_deref()).await
}

/// Handler body for `GET /api/v1/runtime-profiles`.
async fn runtime_profiles(
    state: &AppState,
    user_id: i32,
    request_id: Option<&str>,
) -> Result<Vec<RuntimeProfileView>, FastApiError> {
    // `device_service.get_all_devices`: every provider lists its devices.
    let devices = list_all_devices(state, user_id, request_id).await?;
    let committed = ensure_device_defaults(state, &devices, user_id).await?;
    if committed {
        // The endpoint evaluates `current_user.id` for `list` after the insert
        // commit, which reloads the expired ORM user by primary key.
        reload_user(state, user_id).await?;
    }

    // `runtime_profile_service.list`: visible active profiles, newest first.
    let rows: Vec<RuntimeProfileRow> = state
        .mysql
        .fetch_all(list_sql(), (user_id,))
        .await
        .map_err(|error| listing_error("runtime-profiles list", error))?;
    Ok(rows
        .iter()
        .filter(|row| catalog_visible(row.metadata.as_ref()))
        .map(to_view)
        .collect())
}

/// `runtime_profile_service.ensure_device_defaults`: insert one active
/// `runtime_profile` row for every device without a visible default, then
/// commit exactly once when any row was added.
async fn ensure_device_defaults(
    state: &AppState,
    devices: &[crate::devices::DeviceItem],
    user_id: i32,
) -> Result<bool, FastApiError> {
    let existing: Vec<ExistingDefaultRow> = state
        .mysql
        .fetch_all(existing_defaults_sql(), (user_id,))
        .await
        .map_err(|error| listing_error("runtime-profiles default scan", error))?;
    let mut existing_device_ids: HashSet<String> = HashSet::new();
    for row in &existing {
        let Some(device_id) = row.device_id.as_deref() else {
            continue;
        };
        if device_id.is_empty() {
            continue;
        }
        if catalog_visible(row.metadata.as_ref()) {
            existing_device_ids.insert(device_id.to_string());
        }
    }

    let mut pending: Vec<NewProfile<'_>> = Vec::new();
    for device in devices {
        let device_id = device.device_id().trim();
        if device_id.is_empty() || existing_device_ids.contains(device_id) {
            continue;
        }
        let name = match device.name().trim() {
            "" => device_id,
            reported => reported,
        };
        let environment = if matches!(device.device_type(), DeviceType::Local) {
            "local"
        } else {
            "cloud"
        };
        let metadata = if environment == "local" {
            LOCAL_METADATA_JSON
        } else {
            CLOUD_METADATA_JSON
        };
        existing_device_ids.insert(device_id.to_string());
        pending.push(NewProfile {
            name,
            device_id,
            metadata,
        });
    }

    if pending.is_empty() {
        return Ok(false);
    }

    // SQLAlchemy flushes the pending inserts: the `before_insert` adapter
    // reflects the table once, then each row is written, then the commit.
    state
        .mysql
        .execute(SHOW_CREATE_TABLE_SQL, ())
        .await
        .map_err(|error| listing_error("runtime-profiles reflection", error))?;
    for profile in &pending {
        let id = numeric_id();
        state
            .mysql
            .execute(
                INSERT_PROFILE_SQL,
                (
                    id.as_str(),
                    profile.name,
                    profile.name,
                    user_id,
                    user_id,
                    user_id,
                    profile.device_id,
                    profile.metadata,
                ),
            )
            .await
            .map_err(|error| listing_error("runtime-profiles default insert", error))?;
    }
    state
        .mysql
        .execute("COMMIT", ())
        .await
        .map_err(|error| listing_error("runtime-profiles default commit", error))?;
    Ok(true)
}

/// The ORM reload of the committed user row. The result feeds no business
/// field; only its dependency call is observable.
async fn reload_user(state: &AppState, user_id: i32) -> Result<(), FastApiError> {
    let _row: Option<MysqlRow> = state
        .mysql
        .fetch_optional(USER_BY_ID_SQL, (user_id,))
        .await
        .map_err(|error| listing_error("runtime-profiles user reload", error))?;
    Ok(())
}

/// The application's `python_exception_handler` 500 body for an unexpected
/// dependency failure.
fn listing_error(operation: &'static str, error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "{operation} dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(metadata: &str, name: Option<&str>, status: &str) -> RuntimeProfileRow {
        RuntimeProfileRow {
            id: "2707156430929082554".to_string(),
            name: name.map(str::to_string),
            title: None,
            device_id: Some("9562a3b4-61a3-4217-9655-0341b231eb06".to_string()),
            status: status.to_string(),
            version: 1,
            created_at: Some(
                NaiveDateTime::parse_from_str("2026-10-07 15:36:09", "%Y-%m-%d %H:%M:%S").unwrap(),
            ),
            updated_at: Some(
                NaiveDateTime::parse_from_str("2026-10-07 15:36:09", "%Y-%m-%d %H:%M:%S").unwrap(),
            ),
            metadata: Some(Json(OpaqueJson::from(
                serde_json::from_str::<serde_json::Value>(metadata).unwrap(),
            ))),
        }
    }

    #[test]
    fn view_matches_recorded_shape() {
        let value = serde_json::to_value(to_view(&row(
            r#"{"execution_environment": "cloud", "model": "", "model_type": null, "model_options": {}, "workspace_policy": "project"}"#,
            Some("Cloud"),
            "active",
        )))
        .unwrap();
        assert_eq!(value["id"], "2707156430929082554");
        assert_eq!(value["name"], "Cloud");
        assert_eq!(value["executionEnvironment"], "cloud");
        assert_eq!(
            value["executionDeviceId"],
            "9562a3b4-61a3-4217-9655-0341b231eb06"
        );
        assert_eq!(value["model"], "");
        assert!(value["modelType"].is_null());
        assert_eq!(value["modelOptions"], serde_json::json!({}));
        assert_eq!(value["workspacePolicy"], "project");
        assert_eq!(value["status"], "active");
        assert_eq!(value["version"], 1);
        assert_eq!(value["createdAt"], "2026-10-07T15:36:09");
        assert_eq!(value["updatedAt"], "2026-10-07T15:36:09");
    }

    #[test]
    fn view_applies_source_defaults() {
        let mut source = row("{}", Some(""), "active");
        source.title = Option::None;
        let value = serde_json::to_value(to_view(&source)).unwrap();
        assert_eq!(value["name"], "Runtime");
        assert_eq!(value["executionEnvironment"], "local");
        assert_eq!(value["workspacePolicy"], "project");
    }

    #[test]
    fn internal_profiles_are_hidden() {
        let metadata = Some(Json(OpaqueJson::from(
            serde_json::json!({"catalog_visibility": "internal"}),
        )));
        assert!(!catalog_visible(metadata.as_ref()));
        let visible = Some(Json(OpaqueJson::from(
            serde_json::json!({"catalog_visibility": "public"}),
        )));
        assert!(catalog_visible(visible.as_ref()));
        assert!(catalog_visible(None));
    }

    #[test]
    fn numeric_id_is_positive_and_in_range() {
        for _ in 0..64 {
            let value: u64 = numeric_id().parse().unwrap();
            assert!((1..=9_000_000_000_000_000_000).contains(&value));
        }
    }

    #[test]
    fn insert_sql_matches_recorded_template() {
        assert_eq!(INSERT_PROFILE_SQL.matches('?').count(), 8);
        assert!(INSERT_PROFILE_SQL.starts_with("INSERT INTO loop_items (id, "));
        assert!(INSERT_PROFILE_SQL.contains("'runtime_profile'"));
        assert!(INSERT_PROFILE_SQL.contains("now(), now()"));
    }

    #[test]
    fn list_sql_filters_active_visible_profiles_newest_first() {
        let sql = list_sql();
        assert!(sql.contains("loop_items.resource_type IN ('runtime_profile')"));
        assert!(sql.contains("ORDER BY loop_items.updated_at DESC"));
        assert!(!sql.contains("loop_items.status = 'active'"));
    }
}
