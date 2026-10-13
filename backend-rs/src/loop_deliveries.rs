// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}/deliveries` — immutable deliveries of one
//! loop item.
//!
//! Mirrors `app.api.endpoints.deliveries.list_deliveries`:
//! `delivery_service.list_deliveries(db, item_id, current_user.id)` calls
//! `require_loop_item_access(db, item_id, user_id)` (default `Viewer`), then
//! reads the delivered rows of the item and renders each with
//! `_delivery_response`, returning `DeliveryListResponse { items }`.
//!
//! Source pipeline (`app.services.delivery.access.require_loop_item_access`):
//! 1. `db.query(LoopItem).filter(LoopItem.id == item_id).first()` — the task
//!    row; absent -> 404 "TODO not found".
//! 2. `require_cloud_project_role(db, item.cloud_project_id, user_id, Viewer)`
//!    — the set-based `project_access_query` statement; no grant -> 404
//!    "Cloud project not found", a role below `Viewer` -> 403.
//! 3. `can_view_item(db, access, item, user_id)` — a `Maintainer` or higher
//!    sees any item; otherwise the item is visible only when its effective
//!    security is `open` or the caller is related to it; otherwise 404.
//! 4. `has_permission(access.role, Viewer)` — never fails after step 2.
//!
//! `delivery_service.list_deliveries` then reads the item's `delivery` rows
//! ordered by `delivered_at DESC`. `_delivery_response` renders the row fields,
//! its `delivery_asset` rows ordered by `relative_path`, and the
//! `metadata.fulfillments` list.
use chrono::NaiveDateTime;
use serde::Serialize;

use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectRow, has_permission};
use crate::cloud_projects::LOOP_ITEMS_COLUMNS;
use crate::http_compat::FastApiError;
use crate::loop_tasks::auth::FlexibleUser;
use crate::loop_tasks::loop_repository::{LoopItemRepository, datetime_is_unset};
use crate::state::AppState;
use brz_http_server::StatusCode;
use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};

/// GET /api/v1/loop-items/{item_id}/deliveries: the deliveries free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/loop-items/:item_id/deliveries")]
async fn list_loop_item_deliveries(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<DeliveryListResponse, FastApiError> {
    deliveries(state, item_id, &current_user).await
}

/// Handler body for `GET /api/v1/loop-items/{item_id}/deliveries`.
async fn deliveries(
    state: &AppState,
    item_id: &str,
    current_user: &FlexibleUser,
) -> Result<DeliveryListResponse, FastApiError> {
    let item = require_loop_item_access(&state.mysql, item_id, current_user.id).await?;
    let rows = list_deliveries(&state.mysql, &item.id)
        .await
        .map_err(internal_error)?;

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        items.push(delivery_response(&state.mysql, row).await?);
    }
    Ok(DeliveryListResponse { items })
}

/// `require_loop_item_access(db, item_id, user_id)` with `required_role = Viewer`.
async fn require_loop_item_access<M>(
    mysql: &M,
    item_id: &str,
    user_id: i32,
) -> Result<AccessItemRow, FastApiError>
where
    M: Mysql,
{
    // `db.query(LoopItem).filter(LoopItem.id == item_id).first()`.
    let item = find_access_item(mysql, item_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "TODO not found"))?;

    // `require_cloud_project_role(db, item.cloud_project_id, user_id, Viewer)`:
    // the set-based `project_access_query` resolves the active project row and
    // the caller's effective role in one statement.
    let project_number: i64 = item
        .cloud_project_id
        .as_deref()
        .and_then(|value| value.parse().ok())
        .ok_or_else(internal_message)?;
    let access = BoardSnapshotRepository::new(mysql)
        .require_cloud_project_role(project_number, user_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    if !has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `can_view_item(db, access, item, user_id)`.
    if !can_view_item(mysql, &access.project, &access.role, &item, user_id)
        .await
        .map_err(internal_error)?
    {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "TODO not found",
        ));
    }

    // `has_permission(access.role, required_role)`: the caller already passed
    // the `Viewer` check inside `require_cloud_project_role`.
    if !has_permission(&access.role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    Ok(item)
}

/// `can_view_item` (`app.services.loop_items.access`): a `Maintainer` or
/// higher sees any item; otherwise the effective item security must be `open`
/// or the caller must be related to the item.
async fn can_view_item<M>(
    mysql: &M,
    project: &ProjectRow,
    role: &str,
    item: &AccessItemRow,
    user_id: i32,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    if has_permission(role, "Maintainer") {
        return Ok(true);
    }
    if item_security(item, project) == "open" {
        return Ok(true);
    }
    LoopItemRepository::new(mysql)
        .is_related_item(&item.id, user_id)
        .await
}

/// `item_security(item, project)`: the item's explicit `security_level` when it
/// is one of the known levels, otherwise the project default.
fn item_security(item: &AccessItemRow, project: &ProjectRow) -> &'static str {
    match item
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.security_level.as_deref())
    {
        Some("open") => "open",
        Some("related") => "related",
        _ => project.default_issue_security(),
    }
}

/// `db.query(LoopItem).filter(LoopItem.id == item_id).first()`: the full
/// `loop_items` task projection with the source's implicit `LIMIT 1`.
async fn find_access_item<M>(mysql: &M, item_id: &str) -> MysqlResult<Option<AccessItemRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.id = ? AND loop_items.resource_type IN ('task') \n LIMIT 1"
            ),
            (item_id,),
        )
        .await
}

/// `db.query(Delivery).filter(loop_item_id == item_id, status == "delivered")
/// .order_by(Delivery.delivered_at.desc())`.
async fn list_deliveries<M>(mysql: &M, item_id: &str) -> MysqlResult<Vec<DeliveryRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.loop_item_id = ? AND loop_items.status = 'delivered' \
                 AND loop_items.resource_type IN ('delivery') \n\
                 ORDER BY loop_items.delivered_at DESC"
            ),
            (item_id,),
        )
        .await
}

/// `delivery_service.list_assets(db, delivery_id)`: the delivery's asset rows
/// ordered by `relative_path`.
async fn list_assets<M>(mysql: &M, delivery_id: &str) -> MysqlResult<Vec<DeliveryAssetRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.delivery_id = ? \
                 AND loop_items.resource_type IN ('delivery_asset') \n\
                 ORDER BY loop_items.relative_path"
            ),
            (delivery_id,),
        )
        .await
}

/// `_delivery_response(db, delivery)`.
async fn delivery_response<M>(
    mysql: &M,
    row: &DeliveryRow,
) -> Result<DeliveryResponse, FastApiError>
where
    M: Mysql,
{
    let assets = list_assets(mysql, &row.id)
        .await
        .map_err(internal_error)?
        .iter()
        .map(asset_response)
        .collect();

    Ok(DeliveryResponse {
        id: row.id.clone(),
        loop_item_id: row.loop_item_id.clone().unwrap_or_default(),
        created_by_user_id: i64::from(row.created_by_user_id.unwrap_or(0)),
        source_task_binding_id: normalize_binding_id(row.source_task_binding_id.as_deref()),
        source_task_snapshot: normalize_snapshot(row),
        status: row.status.clone().unwrap_or_default(),
        created_at: row.created_at.map(isoformat).unwrap_or_default(),
        delivered_at: isoformat_unset(row.delivered_at),
        assets,
        fulfillments: fulfillment_values(row),
    })
}

/// `DeliveryResponse.source_task_binding_id`: `""` becomes `None`.
fn normalize_binding_id(value: Option<&str>) -> Option<i64> {
    match value {
        None | Some("") => None,
        Some(value) => value.parse().ok(),
    }
}

/// `DeliveryResponse.source_task_snapshot`: an empty object (`{}`) or an
/// absent/NULL column becomes `None`.
fn normalize_snapshot(row: &DeliveryRow) -> Option<serde_json::Value> {
    match row.source_task_snapshot.as_ref().map(|json| &json.0) {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(object)) if object.is_empty() => None,
        Some(value) => Some(value.clone()),
    }
}

/// `delivery_service.fulfillment_values(delivery)`: the `fulfillments` metadata
/// entries that are JSON objects.
fn fulfillment_values(row: &DeliveryRow) -> Vec<serde_json::Value> {
    let Some(serde_json::Value::Array(values)) = row
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.fulfillments.as_ref())
    else {
        return Vec::new();
    };
    values
        .iter()
        .filter(|value| value.is_object())
        .cloned()
        .collect()
}

/// `DeliveryAssetResponse`.
fn asset_response(row: &DeliveryAssetRow) -> DeliveryAssetResponse {
    DeliveryAssetResponse {
        id: row.id.clone(),
        kind: row.kind.clone().unwrap_or_default(),
        display_name: row.display_name.clone().unwrap_or_default(),
        relative_path: row.relative_path.clone().unwrap_or_default(),
        content_type: row.content_type.clone().filter(|value| !value.is_empty()),
        size_bytes: row.size_bytes.unwrap_or(0),
        sha256: row.sha256.clone().unwrap_or_default(),
    }
}

/// `DeliveryListResponse` (`app.schemas.delivery`).
#[derive(Debug, Serialize)]
struct DeliveryListResponse {
    items: Vec<DeliveryResponse>,
}

/// `DeliveryResponse` (`app.schemas.delivery`): the delivery row fields, its
/// assets, and its fulfillments.
#[derive(Debug, Serialize)]
struct DeliveryResponse {
    id: String,
    loop_item_id: String,
    created_by_user_id: i64,
    source_task_binding_id: Option<i64>,
    source_task_snapshot: Option<serde_json::Value>,
    status: String,
    created_at: String,
    delivered_at: Option<String>,
    assets: Vec<DeliveryAssetResponse>,
    fulfillments: Vec<serde_json::Value>,
}

/// `DeliveryAssetResponse` (`app.schemas.delivery`).
#[derive(Debug, Serialize)]
struct DeliveryAssetResponse {
    id: String,
    kind: String,
    display_name: String,
    relative_path: String,
    content_type: Option<String>,
    size_bytes: i64,
    sha256: String,
}

/// `LoopItem` task row fields used by `require_loop_item_access` and
/// `can_view_item`: the row id, its project, and the metadata
/// `security_level`.
#[derive(Debug, FromMysqlRow)]
struct AccessItemRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_cloud_project_id")]
    cloud_project_id: Option<String>,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<JsonProjection<AccessMetadata>>>,
}

/// `LoopItem.metadata_json` fields read by `item_security`.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct AccessMetadata {
    security_level: Option<String>,
}

/// `Delivery` row (`resource_type='delivery'`) selected with the shared
/// `loop_items` projection.
#[derive(Debug, FromMysqlRow)]
struct DeliveryRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_loop_item_id")]
    loop_item_id: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    created_by_user_id: Option<i32>,
    #[mysql(rename = "loop_items_source_task_binding_id")]
    source_task_binding_id: Option<String>,
    #[mysql(rename = "loop_items_source_task_snapshot")]
    source_task_snapshot: Option<Json<serde_json::Value>>,
    #[mysql(rename = "loop_items_status")]
    status: Option<String>,
    #[mysql(rename = "loop_items_created_at")]
    created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_delivered_at")]
    delivered_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<JsonProjection<DeliveryMetadata>>>,
}

/// `Delivery.metadata_json` fields read by `fulfillment_values`.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct DeliveryMetadata {
    fulfillments: Option<serde_json::Value>,
}

/// `DeliveryAsset` row (`resource_type='delivery_asset'`).
#[derive(Debug, FromMysqlRow)]
struct DeliveryAssetRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_kind")]
    kind: Option<String>,
    #[mysql(rename = "loop_items_display_name")]
    display_name: Option<String>,
    #[mysql(rename = "loop_items_relative_path")]
    relative_path: Option<String>,
    #[mysql(rename = "loop_items_content_type")]
    content_type: Option<String>,
    #[mysql(rename = "loop_items_size_bytes")]
    size_bytes: Option<i64>,
    #[mysql(rename = "loop_items_sha256")]
    sha256: Option<String>,
}

/// Pydantic naive-`datetime` serialization: `isoformat()` without an offset,
/// with microseconds only when nonzero.
fn isoformat(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    let micros = value.and_utc().timestamp_subsec_micros();
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

/// `normalize_unset_datetime`: the `1970-01-01 00:00:01` sentinel and NULL
/// become `None`.
fn isoformat_unset(value: Option<NaiveDateTime>) -> Option<String> {
    if datetime_is_unset(value) {
        None
    } else {
        value.map(isoformat)
    }
}

/// `FastApiError::detail(500, "Internal server error")` for a dependency
/// failure, matching the source's unhandled-exception body.
fn internal_error<E>(_error: E) -> FastApiError {
    internal_message()
}

fn internal_message() -> FastApiError {
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
#[path = "loop_deliveries_tests.rs"]
mod tests;
