// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/plugins/installed/report-device` — acknowledge locally present
//! plugins on one device without pushing packages.
//!
//! Source: `app/api/endpoints/installed_plugins.py::report_installed_plugins_on_device`
//! (line 316) -> `plugin_device_installation_service.acknowledge_local_installs`
//! (line 198) -> `app/services/plugin_device_identity.py::reconcile_plugin_device_rows`
//! (line 74) and `PluginDeviceInstallationService._acknowledge_local_install`
//! (line 259).
//!
//! Pipeline, in the source's ordering:
//! 1. `reconcile_plugin_device_rows` converges legacy alias rows inside the
//!    write transaction (a `FOR UPDATE` read, coalescing, DELETE of superseded
//!    aliases, and a `device_id` rewrite for every retained row).
//! 2. `plugin_device_id` resolves the request's device to its canonical id.
//! 3. `_desired_installs` reads the account's active `InstalledPlugin` kinds
//!    rows (no `ORDER BY`); only rows also present in the report are examined.
//! 4. `_acknowledge_local_install` requires an integer `spec.releaseId`, a
//!    non-empty `spec.version`, and an exact release/version match, then upserts
//!    the installation row to `state='installed'`.
//! 5. `db.commit()` runs only when at least one row was acknowledged.
//!
//! The response echoes the request's `device_id` (not the canonical id) with
//! the acknowledged count and ids.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult, MysqlRow, MysqlTransaction};
use chrono::{Local, NaiveDateTime};
use serde::Deserialize;
use serde_json::Value;

use crate::device_identity::{
    PluginDeviceInstallationRow, plugin_device_id, reconcile_plugin_device_rows,
};
use crate::http_compat::FastApiError;

/// One active `InstalledPlugin` kinds row, projected with SQLAlchemy's labeled
/// aliases (`kinds.<column> AS kinds_<column>`) so the prepared statement
/// matches the recorded `_desired_installs` exchange.
#[derive(Debug, FromMysqlRow)]
struct InstalledKindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_json")]
    json: Value,
}

/// `PLUGIN_AUTO_UPDATE_FAILURE_LIMIT` (`app/core/constants.py`).
const AUTO_UPDATE_FAILURE_LIMIT: i64 = 3;

/// One reported package version (`app/schemas/installed_plugin.py:365`).
#[derive(Debug, Deserialize)]
pub struct PluginDeviceReportItem {
    #[serde(rename = "installedPluginId")]
    pub installed_plugin_id: i64,
    #[serde(rename = "releaseId")]
    pub release_id: i64,
    pub version: String,
}

/// `PluginDeviceReportRequest` — the reported plugins for one device.
#[derive(Debug, Default, Deserialize)]
pub struct PluginDeviceReportRequest {
    #[serde(default)]
    pub plugins: Vec<PluginDeviceReportItem>,
}

/// `PluginDeviceReportResponse`, field order as declared.
#[derive(Debug, serde::Serialize)]
pub struct PluginDeviceReportResponse {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "acknowledgedCount")]
    pub acknowledged_count: usize,
    #[serde(rename = "acknowledgedInstalledPluginIds")]
    pub acknowledged_installed_plugin_ids: Vec<i64>,
}

/// `_desired_installs` (`PluginDeviceInstallationService`): the account's
/// active InstalledPlugin kinds. The projection uses SQLAlchemy's labeled
/// aliases; the source applies no `ORDER BY`.
pub(super) const DESIRED_INSTALLS_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, \
     kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.user_id = ? \
     AND kinds.kind = 'InstalledPlugin' AND kinds.namespace = 'default' AND kinds.is_active = 1";

/// `_device_row`: one installation row for the acknowledged `(kind, device)`.
pub(super) const DEVICE_ROW_QUERY: &str = "SELECT plugin_device_installations.id AS plugin_device_installations_id, \
     plugin_device_installations.installed_kind_id AS plugin_device_installations_installed_kind_id, \
     plugin_device_installations.user_id AS plugin_device_installations_user_id, \
     plugin_device_installations.device_id AS plugin_device_installations_device_id, \
     plugin_device_installations.desired_release_id AS plugin_device_installations_desired_release_id, \
     plugin_device_installations.actual_release_id AS plugin_device_installations_actual_release_id, \
     plugin_device_installations.state AS plugin_device_installations_state, \
     plugin_device_installations.error_code AS plugin_device_installations_error_code, \
     plugin_device_installations.error_message AS plugin_device_installations_error_message, \
     plugin_device_installations.attempt_count AS plugin_device_installations_attempt_count, \
     plugin_device_installations.last_sync_at AS plugin_device_installations_last_sync_at, \
     plugin_device_installations.updated_at AS plugin_device_installations_updated_at \n\
     FROM plugin_device_installations \n\
     WHERE plugin_device_installations.installed_kind_id = ? \
     AND plugin_device_installations.device_id = ? \n LIMIT 1";

/// `db.add(row)` for a newly materialized installation row.
pub(super) const INSERT_INSTALLATION_QUERY: &str = "INSERT INTO plugin_device_installations \
     (installed_kind_id, user_id, device_id, desired_release_id, actual_release_id, state, \
     error_code, error_message, attempt_count, last_sync_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/// The expired ORM user reloaded by primary key after the acknowledgement
/// commit. `SessionLocal` keeps `expire_on_commit=True`, so the route's later
/// `current_user.id` log access re-reads the committed row; the result feeds no
/// business field and only its dependency call is observable.
const USER_BY_ID_RELOAD_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \nWHERE users.id = ?";

/// The acknowledged ids for the report.
pub struct AcknowledgedInstalls {
    pub acknowledged_ids: Vec<i64>,
}

/// Source `acknowledge_local_installs`.
///
/// Runs inside the caller's transaction so the reconcile lock, the alias
/// DELETEs, and the acknowledgement UPDATEs commit atomically.
pub async fn acknowledge_local_installs<T, M>(
    transaction: &mut T,
    mysql: &M,
    user_id: i64,
    device_id: &str,
    reported_plugins: &[PluginDeviceReportItem],
) -> MysqlResult<AcknowledgedInstalls>
where
    T: MysqlTransaction,
    M: Mysql,
{
    reconcile_plugin_device_rows::<_, _, PluginDeviceInstallationRow>(transaction, mysql, user_id)
        .await?;
    let normalized_device_id = plugin_device_id(mysql, user_id, device_id).await?;
    let mut acknowledged_ids: Vec<i64> = Vec::new();
    if normalized_device_id.is_empty() || reported_plugins.is_empty() {
        return Ok(AcknowledgedInstalls { acknowledged_ids });
    }
    let desired: Vec<InstalledKindRow> =
        mysql.fetch_all(DESIRED_INSTALLS_QUERY, (user_id,)).await?;
    for installed in &desired {
        let Some(report) = reported_plugins
            .iter()
            .find(|item| item.installed_plugin_id == installed.id)
        else {
            continue;
        };
        let Some(release_id) = integer_release_id(&installed.json) else {
            continue;
        };
        let desired_version = string_version(&installed.json);
        if report.release_id != release_id
            || desired_version.is_empty()
            || report.version.trim() != desired_version
        {
            continue;
        }
        if acknowledge_local_install(
            transaction,
            user_id,
            &normalized_device_id,
            installed.id,
            release_id,
        )
        .await?
        {
            acknowledged_ids.push(installed.id);
        }
    }
    Ok(AcknowledgedInstalls { acknowledged_ids })
}

/// `spec.releaseId` when it is an integer (`isinstance(release_id, int)`).
fn integer_release_id(json: &Value) -> Option<i64> {
    let spec = json.get("spec")?;
    match spec.get("releaseId") {
        Some(Value::Number(number)) => number.as_i64(),
        _ => None,
    }
}

/// `str(spec.get("version") or "").strip()`.
fn string_version(json: &Value) -> String {
    json.get("spec")
        .and_then(|spec| spec.get("version"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Source `_acknowledge_local_install`. Returns whether the installation row
/// was acknowledged (and therefore appended to the response ids).
async fn acknowledge_local_install<T>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    installed_kind_id: i64,
    release_id: i64,
) -> MysqlResult<bool>
where
    T: MysqlTransaction,
{
    let row: Option<PluginDeviceInstallationRow> = transaction
        .fetch_optional(DEVICE_ROW_QUERY, (installed_kind_id, device_id))
        .await?;
    if let Some(row) = &row
        && (row.state == "uninstalling" || auto_update_blocked(row, release_id))
    {
        return Ok(false);
    }
    let now = Local::now().naive_local();
    match row {
        Some(row) => write_existing(transaction, &row, release_id, now).await?,
        None => {
            transaction
                .execute(
                    INSERT_INSTALLATION_QUERY,
                    (
                        installed_kind_id,
                        user_id,
                        device_id,
                        release_id,
                        release_id,
                        "installed",
                        "",
                        "",
                        0_i64,
                        now,
                        now,
                    ),
                )
                .await?;
        }
    }
    Ok(true)
}

/// Flush the acknowledgement onto an existing row.
///
/// SQLAlchemy's `get_history` marks a column dirty only when the assigned
/// value differs from the loaded one, so the `SET` list contains only the
/// changed columns in mapper order. The recorded case (an already-installed
/// row) therefore renders `SET last_sync_at='...', updated_at='...'`. The
/// assignments are internal constants and the two release ids, so the values
/// are rendered inline exactly like the source's literal-bound flush.
async fn write_existing<T>(
    transaction: &mut T,
    row: &PluginDeviceInstallationRow,
    release_id: i64,
    now: NaiveDateTime,
) -> MysqlResult<()>
where
    T: MysqlTransaction,
{
    let mut assigns: Vec<String> = Vec::new();
    if row.desired_release_id != release_id {
        assigns.push(format!("desired_release_id={release_id}"));
    }
    if row.actual_release_id != release_id {
        assigns.push(format!("actual_release_id={release_id}"));
    }
    if row.state != "installed" {
        assigns.push("state='installed'".to_string());
    }
    if !row.error_code.is_empty() {
        assigns.push("error_code=''".to_string());
    }
    if !row.error_message.is_empty() {
        assigns.push("error_message=''".to_string());
    }
    if row.attempt_count != 0 {
        assigns.push("attempt_count=0".to_string());
    }
    assigns.push(format!("last_sync_at='{}'", format_datetime(now)));
    assigns.push(format!("updated_at='{}'", format_datetime(now)));
    let statement = format!(
        "UPDATE plugin_device_installations SET {} WHERE plugin_device_installations.id = {}",
        assigns.join(", "),
        row.id
    );
    transaction.execute(statement, ()).await?;
    Ok(())
}

/// The MySQL `DATETIME` literal shape (`YYYY-MM-DD HH:MM:SS.ffffff`).
fn format_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// Source `_auto_update_blocked`.
fn auto_update_blocked(row: &PluginDeviceInstallationRow, desired_release_id: i64) -> bool {
    row.state == "failed"
        && row.attempt_count >= AUTO_UPDATE_FAILURE_LIMIT
        && row.actual_release_id != 0
        && row.actual_release_id != desired_release_id
        && row.desired_release_id == desired_release_id
}

/// The endpoint's body: acknowledge the reported plugins for one device.
///
/// `device_id` is the required query parameter; a blank one is `400
/// {"detail":"device_id is required"}` and the response echoes the stripped
/// request value, not the canonical id.
pub async fn report_device<M>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
    reported_plugins: &[PluginDeviceReportItem],
) -> Result<PluginDeviceReportResponse, FastApiError>
where
    M: Mysql,
{
    let normalized_device_id = device_id.trim();
    if normalized_device_id.is_empty() {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "device_id is required",
        ));
    }
    let outcome = mysql
        .with_transaction(async |transaction| {
            acknowledge_local_installs(
                transaction,
                mysql,
                user_id,
                normalized_device_id,
                reported_plugins,
            )
            .await
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "report device plugins failed");
            FastApiError::internal()
        })?;
    if !outcome.acknowledged_ids.is_empty() {
        // `acknowledge_local_installs` commits only when it acknowledged a row;
        // that commit expires `current_user`, and the route's subsequent
        // `current_user.id` log access reloads it by primary key.
        reload_current_user(mysql, user_id).await?;
    }
    Ok(PluginDeviceReportResponse {
        device_id: normalized_device_id.to_string(),
        acknowledged_count: outcome.acknowledged_ids.len(),
        acknowledged_installed_plugin_ids: outcome.acknowledged_ids,
    })
}

/// The ORM reload of the committed user row (see `USER_BY_ID_RELOAD_QUERY`).
/// The result feeds no business field; only its dependency call is observable.
async fn reload_current_user<M>(mysql: &M, user_id: i64) -> Result<(), FastApiError>
where
    M: Mysql,
{
    let _row: Option<MysqlRow> = mysql
        .fetch_optional(USER_BY_ID_RELOAD_QUERY, (user_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, user_id, "report device user reload failed");
            FastApiError::internal()
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn release_id_requires_integer() {
        assert_eq!(
            integer_release_id(&json!({"spec": {"releaseId": 129}})),
            Some(129)
        );
        assert_eq!(
            integer_release_id(&json!({"spec": {"releaseId": "129"}})),
            None
        );
        assert_eq!(integer_release_id(&json!({"spec": {}})), None);
    }

    #[test]
    fn version_is_trimmed_string() {
        assert_eq!(
            string_version(&json!({"spec": {"version": " 2.3.0 "}})),
            "2.3.0"
        );
        assert_eq!(string_version(&json!({"spec": {}})), "");
    }

    #[test]
    fn auto_update_blocked_matches_source_rules() {
        let mut row = PluginDeviceInstallationRow {
            id: 1,
            installed_kind_id: 2,
            user_id: 3,
            device_id: "d".to_string(),
            desired_release_id: 5,
            actual_release_id: 4,
            state: "failed".to_string(),
            error_code: String::new(),
            error_message: String::new(),
            attempt_count: AUTO_UPDATE_FAILURE_LIMIT,
            last_sync_at: NaiveDateTime::default(),
            updated_at: NaiveDateTime::default(),
        };
        assert!(auto_update_blocked(&row, 5));
        row.attempt_count -= 1;
        assert!(!auto_update_blocked(&row, 5));
        row.attempt_count = AUTO_UPDATE_FAILURE_LIMIT;
        row.state = "installed".to_string();
        assert!(!auto_update_blocked(&row, 5));
    }

    #[test]
    fn datetime_literal_shape_has_microseconds() {
        let value =
            NaiveDateTime::parse_from_str("2026-10-07 15:33:33.271398", "%Y-%m-%d %H:%M:%S%.6f")
                .unwrap();
        assert_eq!(format_datetime(value), "2026-10-07 15:33:33.271398");
    }

    #[tokio::test]
    async fn reload_current_user_selects_by_primary_key() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        reload_current_user(&mysql, 157).await.unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 1);
        assert_eq!(queries[0].first_integer, Some(157));
        assert!(queries[0].sql.contains("FROM users WHERE users.id = ?"));
    }
}
