//! Atomic edits of delivered artifacts. Initial publication remains Python-owned.

use std::collections::HashSet;

use brz_http_server::{Multipart, StatusCode};
use brz_mysql::{FromMysqlRow, Json, MysqlError, MysqlTransaction};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::board_snapshot::repository::BoardSnapshotRepository;
use crate::delivery_storage;
use crate::loop_item_attachments::{handler::require_item_view_access, repository::get_task_item};
use crate::loop_tasks::{
    auth::FlexibleUser, http_error::HttpError, loop_repository::has_permission,
};
use crate::state::AppState;

#[cfg(test)]
#[path = "delivery_update_tests.rs"]
mod tests;

#[derive(Deserialize)]
struct Update {
    title: String,
    version: i64,
    markdown: String,
    chat: Option<Value>,
    retained_asset_ids: Vec<String>,
    files: Vec<NewFile>,
}

#[derive(Deserialize)]
struct NewFile {
    relative_path: String,
    display_name: String,
    content_type: Option<String>,
}

#[derive(FromMysqlRow)]
struct DeliveryRow {
    id: String,
    loop_item_id: String,
    cloud_project_id: String,
    created_by_user_id: i32,
    source_task_binding_id: Option<String>,
    source_task_snapshot: Option<Json<Value>>,
    status: String,
    version: i64,
    created_at: NaiveDateTime,
    delivered_at: Option<NaiveDateTime>,
    markdown_object_key: String,
    chat_object_key: Option<String>,
    manifest_object_key: Option<String>,
    metadata: Option<Json<Value>>,
}

#[derive(FromMysqlRow, Serialize)]
struct Asset {
    id: String,
    kind: String,
    display_name: String,
    relative_path: String,
    content_type: Option<String>,
    size_bytes: i64,
    sha256: String,
    #[serde(skip)]
    object_key: String,
}

fn invalid(message: &str) -> HttpError {
    HttpError::new(StatusCode::UNPROCESSABLE_ENTITY, message)
}

fn conflict() -> HttpError {
    HttpError::new(
        StatusCode::CONFLICT,
        "Delivery changed; reload before saving",
    )
}

fn storage_error() -> HttpError {
    HttpError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "Delivery object storage is unavailable",
    )
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.chars().count() <= 700
        && !path.contains('\\')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn validate(update: &Update, delivery: &DeliveryRow, assets: &[Asset]) -> Result<(), HttpError> {
    if delivery.status != "delivered" || delivery.version != update.version {
        return Err(conflict());
    }
    if update.title.trim().is_empty() || update.title.chars().count() > 255 {
        return Err(invalid("Delivery title must contain 1 to 255 characters"));
    }
    if update.chat.as_ref().is_some_and(|chat| !chat.is_object()) {
        return Err(invalid("Delivery chat must be an object"));
    }
    if update.markdown.len() > 2 * 1024 * 1024
        || update
            .chat
            .as_ref()
            .is_some_and(|chat| chat.to_string().len() > 10 * 1024 * 1024)
    {
        return Err(HttpError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Delivery text is too large",
        ));
    }
    let retained: HashSet<_> = update
        .retained_asset_ids
        .iter()
        .map(String::as_str)
        .collect();
    if retained.len() != update.retained_asset_ids.len()
        || retained
            .iter()
            .any(|id| !assets.iter().any(|asset| asset.id == *id))
    {
        return Err(invalid("Invalid retained delivery asset"));
    }
    let mut paths: HashSet<_> = assets
        .iter()
        .filter(|a| retained.contains(a.id.as_str()))
        .map(|asset| asset.relative_path.as_str())
        .collect();
    for file in &update.files {
        if !safe_path(&file.relative_path)
            || !paths.insert(&file.relative_path)
            || file.display_name.chars().count() > 255
            || file
                .content_type
                .as_ref()
                .is_some_and(|value| value.len() > 255)
        {
            return Err(invalid("Invalid or duplicate delivery file path"));
        }
    }
    for fulfillment in fulfillment_values(delivery)
        .as_array()
        .into_iter()
        .flatten()
    {
        if fulfillment
            .get("asset_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|id| !retained.contains(id))
            || fulfillment
                .get("asset_id")
                .and_then(Value::as_str)
                .is_some_and(|id| !retained.contains(id))
        {
            return Err(invalid(
                "Cannot remove an asset referenced by a deliverable requirement",
            ));
        }
    }
    Ok(())
}

fn fulfillment_values(delivery: &DeliveryRow) -> Value {
    delivery
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.0.get("fulfillments"))
        .cloned()
        .unwrap_or_else(|| json!([]))
}

#[brz_http_server::patch("/api/v1/deliveries/:delivery_id")]
async fn update_delivery(
    #[inject(state)] state: &AppState,
    delivery_id: &str,
    #[auth] user: FlexibleUser,
    multipart: Multipart,
) -> Result<Value, HttpError> {
    let metadata = multipart
        .get("metadata")
        .ok_or_else(|| invalid("Missing metadata"))?;
    let input: Update =
        serde_json::from_slice(&metadata.bytes).map_err(|_| invalid("Invalid metadata"))?;
    let delivery: DeliveryRow = state.mysql.fetch_optional(
        "SELECT id, loop_item_id, cloud_project_id, created_by_user_id, source_task_binding_id,
         source_task_snapshot, status, version, created_at, delivered_at, markdown_object_key,
         chat_object_key, manifest_object_key, metadata FROM loop_items
         WHERE id = ? AND resource_type = 'delivery' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))",
        (delivery_id,),
    ).await.map_err(HttpError::internal)?.ok_or_else(HttpError::todo_not_found)?;
    let item = get_task_item(&state.mysql, &delivery.loop_item_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::todo_not_found)?;
    require_item_view_access(state, &item, user.id).await?;
    let project_id = item
        .cloud_project_id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_id, user.id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    if !has_permission(&access.role, "Developer") {
        return Err(HttpError::insufficient_permission());
    }
    let old_assets: Vec<Asset> = state.mysql.fetch_all(
        "SELECT id, kind, display_name, relative_path, content_type, size_bytes, sha256, object_key
         FROM loop_items WHERE delivery_id = ? AND resource_type = 'delivery_asset' ORDER BY relative_path",
        (delivery_id,),
    ).await.map_err(HttpError::internal)?;
    validate(&input, &delivery, &old_assets)?;
    let project_public_id = access
        .project
        .public_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or_else(HttpError::internal_detail)?;
    let prefix = format!(
        "projects/{project_public_id}/loop-items/{}/deliveries/{delivery_id}/edits/{}",
        delivery.loop_item_id,
        crate::wework_auth_tokens::uuid4_hex().map_err(|_| HttpError::internal_detail())?
    );
    let markdown_key = format!("{prefix}/markdown.md");
    let chat_key = input.chat.as_ref().map(|_| format!("{prefix}/chat.json"));
    let manifest_key = format!("{prefix}/manifest.json");
    let mut assets: Vec<_> = old_assets
        .iter()
        .filter(|asset| input.retained_asset_ids.contains(&asset.id))
        .collect();
    let max_file_bytes = crate::config::env_or_dotenv("DELIVERY_MAX_ASSET_SIZE_MB")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(2048)
        .saturating_mul(1024 * 1024);
    let mut new_assets = Vec::new();
    let mut objects = vec![(markdown_key.clone(), input.markdown.as_bytes().to_vec())];
    if let (Some(key), Some(chat)) = (&chat_key, &input.chat) {
        objects.push((key.clone(), chat.to_string().into_bytes()));
    }
    for (index, file) in input.files.iter().enumerate() {
        let part = multipart
            .get(&format!("file_{index}"))
            .ok_or_else(|| invalid("Missing delivery file"))?;
        if part.bytes.len() > max_file_bytes {
            return Err(HttpError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Delivery asset is too large",
            ));
        }
        let id =
            crate::wework_auth_tokens::uuid4_hex().map_err(|_| HttpError::internal_detail())?;
        let object_key = format!("{prefix}/files/{id}");
        new_assets.push(Asset {
            id,
            kind: "file".into(),
            display_name: file.display_name.clone(),
            relative_path: file.relative_path.clone(),
            content_type: file.content_type.clone(),
            size_bytes: part.bytes.len() as i64,
            sha256: format!("{:x}", Sha256::digest(&part.bytes)),
            object_key: object_key.clone(),
        });
        objects.push((object_key, part.bytes.to_vec()));
    }
    assets.extend(new_assets.iter());
    assets.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let manifest = json!({"version": 2, "deliveryId": delivery_id, "loopItemId": delivery.loop_item_id,
        "cloudProjectId": delivery.cloud_project_id, "sourceTask": delivery.source_task_snapshot.as_ref().map(|v| &v.0),
        "title": input.title.trim(), "markdown": "markdown.md", "chat": chat_key.as_ref().map(|_| "chat.json"),
        "files": assets.iter().map(|asset| json!({"path": asset.relative_path, "name": asset.display_name,
            "size": asset.size_bytes, "sha256": asset.sha256, "contentType": asset.content_type, "objectKey": asset.object_key})).collect::<Vec<_>>(),
        "fulfillments": fulfillment_values(&delivery)});
    objects.push((manifest_key.clone(), manifest.to_string().into_bytes()));
    let mut written = Vec::new();
    for (key, bytes) in &objects {
        // Include the attempted key: an interrupted upload may have reached storage.
        written.push(key.as_str());
        if delivery_storage::write_object(&state.attachment_http, key, bytes)
            .await
            .is_err()
        {
            cleanup(state, &written).await;
            return Err(storage_error());
        }
    }
    let result = state
        .mysql
        .with_transaction(async |tx| {
            commit_update(
                tx,
                &delivery,
                &input,
                &new_assets,
                &markdown_key,
                chat_key.as_deref(),
                &manifest_key,
            )
            .await
        })
        .await;
    if let Err(error) = result {
        cleanup(state, &written).await;
        return Err(match &error {
            MysqlError::InvalidQuery { reason } if reason == "delivery_conflict" => conflict(),
            _ => HttpError::internal(error),
        });
    }
    let mut obsolete = vec![delivery.markdown_object_key.as_str()];
    obsolete.extend(delivery.chat_object_key.as_deref());
    obsolete.extend(delivery.manifest_object_key.as_deref());
    obsolete.extend(
        old_assets
            .iter()
            .filter(|a| !input.retained_asset_ids.contains(&a.id))
            .map(|a| a.object_key.as_str()),
    );
    cleanup(state, &obsolete).await;
    Ok(
        json!({"id": delivery.id, "title": input.title.trim(), "version": input.version + 1,
        "loop_item_id": delivery.loop_item_id, "created_by_user_id": delivery.created_by_user_id,
        "source_task_binding_id": delivery.source_task_binding_id.as_deref().and_then(|id| id.parse::<i64>().ok()),
        "source_task_snapshot": delivery.source_task_snapshot.as_ref().map(|v| &v.0),
        "status": "delivered", "created_at": delivery.created_at, "delivered_at": delivery.delivered_at,
        "assets": assets, "fulfillments": fulfillment_values(&delivery), "markdown": input.markdown, "chat": input.chat}),
    )
}

async fn commit_update<T: MysqlTransaction>(
    tx: &mut T,
    delivery: &DeliveryRow,
    input: &Update,
    assets: &[Asset],
    markdown_key: &str,
    chat_key: Option<&str>,
    manifest_key: &str,
) -> brz_mysql::MysqlResult<()> {
    let changed = tx.execute(
        "UPDATE loop_items SET title = ?, markdown_object_key = ?, chat_object_key = ?, manifest_object_key = ?,
         version = version + 1, updated_at = UTC_TIMESTAMP() WHERE id = ? AND resource_type = 'delivery'
         AND status = 'delivered' AND version = ? AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))",
        (input.title.trim(), markdown_key, chat_key.unwrap_or(""), manifest_key, delivery.id.as_str(), input.version),
    ).await?;
    if changed.rows_affected != 1 {
        return Err(MysqlError::InvalidQuery {
            reason: "delivery_conflict".into(),
        });
    }
    // Existing Python readers query all asset rows, so removed rows are deleted.
    let rows: Vec<Asset> = tx.fetch_all("SELECT id, kind, display_name, relative_path, content_type, size_bytes, sha256, object_key FROM loop_items WHERE delivery_id = ? AND resource_type = 'delivery_asset'", (delivery.id.as_str(),)).await?;
    for asset in rows
        .iter()
        .filter(|asset| !input.retained_asset_ids.contains(&asset.id))
    {
        tx.execute("DELETE FROM loop_items WHERE id = ? AND delivery_id = ? AND resource_type = 'delivery_asset'", (asset.id.as_str(), delivery.id.as_str())).await?;
    }
    for asset in assets {
        tx.execute(
            "INSERT INTO loop_items (id, resource_type, project_space, cloud_project_id, parent_id,
             loop_item_id, delivery_id, public_id, project_key, name, title, description, storage_prefix,
             sequence_number, next_item_number, created_by_user_id, updated_by_user_id, assignee_user_id,
             user_id, added_by_user_id, source, status, priority, start_at, due_at, sort_order,
             current_delivery_id, local_project_id, device_id, is_default, task_user_id, assignee_agent_id,
             assignee_team_id, task_id, task_title, backend_task_id, linked_by_user_id, linked_at, unlinked_at,
             path, kind, display_name, relative_path, object_key, content_type, size_bytes, sha256,
             source_task_binding_id, source_task_snapshot, markdown_object_key, chat_object_key,
             manifest_object_key, metadata, version, created_at, updated_at, completed_at, delivered_at, deleted_at)
             VALUES (?, 'delivery_asset', 'default', ?, '', ?, ?, '', '', '', '', '', '', 0, 1,
             0, 0, 0, 0, 0, '', 'delivered', '', '1970-01-01 00:00:01', '1970-01-01 00:00:01', 0,
             '', 0, '', 0, 0, '', 0, '', '', 0, 0, '1970-01-01 00:00:01', '1970-01-01 00:00:01',
             '', 'file', ?, ?, ?, ?, ?, ?, '', '{}', '', '', '', '{}', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP(),
             '1970-01-01 00:00:01', '1970-01-01 00:00:01', '1970-01-01 00:00:01')",
            (asset.id.as_str(), delivery.cloud_project_id.as_str(), delivery.loop_item_id.as_str(), delivery.id.as_str(),
                asset.display_name.as_str(), asset.relative_path.as_str(), asset.object_key.as_str(), asset.content_type.as_deref().unwrap_or(""), asset.size_bytes, asset.sha256.as_str()),
        ).await?;
    }
    Ok(())
}

async fn cleanup(state: &AppState, keys: &[&str]) {
    for key in keys.iter().filter(|key| !key.is_empty()) {
        if delivery_storage::delete_object(&state.attachment_http, key)
            .await
            .is_err()
        {
            tracing::warn!("Could not remove obsolete delivery object");
        }
    }
}
