// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed `loop_items` reads for the loop-item attachment surface.
//!
//! The `loop_items` table is a single-table polymorphic map
//! (`app.models.delivery.LoopNode`): project (`resource_type='project'`),
//! task (`'task'`), and attachment (`'attachment'`) rows share it. The
//! attachment list reuses the loop-item task repository for the shared
//! `_find_project` / `is_related_item` reads and adds the attachment-specific
//! projections here.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use brz_json::JsonProjection;

/// `LoopItem.metadata_json` fields consumed by the item access check
/// (`app.services.loop_items.access.item_security`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ItemSecurityMetadata {
    pub security_level: Option<String>,
}

/// `_get_item_row` (`loop_item_service.get`): the active `resource_type='task'`
/// row plus the metadata needed by the `item_security` view gate.
#[derive(Debug, FromMysqlRow)]
pub struct AttachmentTaskRow {
    pub id: String,
    pub cloud_project_id: String,
    pub metadata: Option<Json<JsonProjection<ItemSecurityMetadata>>>,
}

impl AttachmentTaskRow {
    /// `LoopItem.metadata_json["security_level"]` when present.
    pub fn security_level(&self) -> Option<&str> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|metadata| metadata.security_level.as_deref())
    }
}

/// `db.query(LoopItemAttachment)` row: the columns consumed by
/// `LoopItemAttachmentResponse`.
#[derive(Debug, FromMysqlRow)]
pub struct AttachmentRow {
    pub id: String,
    pub loop_item_id: Option<String>,
    pub display_name: Option<String>,
    pub content_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub created_by_user_id: Option<i32>,
    pub created_at: Option<NaiveDateTime>,
}

/// `LoopItemService._get_item_row`: the task row must exist and not be deleted
/// (unset-datetime aware). `Ok(None)` maps to the `404 "TODO not found"`.
pub async fn get_task_item<M: Mysql>(
    mysql: &M,
    item_id: &str,
) -> MysqlResult<Option<AttachmentTaskRow>> {
    mysql
        .fetch_optional(
            "SELECT id, cloud_project_id, metadata \
             FROM loop_items \
             WHERE id = ? \
             AND (deleted_at IS NULL OR deleted_at IN \
                 ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND resource_type IN ('task') LIMIT 1",
            (item_id,),
        )
        .await
}

/// `db.get(LoopItemAttachment, attachment_id)` row: the attachment columns
/// consumed by `loop_item_service.attachment_content` (`LoopItemAttachment`
/// is the `resource_type='attachment'` polymorphic child of `loop_items`).
#[derive(Debug, FromMysqlRow)]
pub struct AttachmentContentRow {
    pub loop_item_id: Option<String>,
    pub object_key: Option<String>,
    pub content_type: Option<String>,
    pub display_name: Option<String>,
}

/// `db.get(LoopItemAttachment, attachment_id)` (`LoopItemService._get_attachment`):
/// the attachment row selected by primary key plus the polymorphic
/// discriminator, with no soft-delete filter and no `LIMIT`.
pub async fn get_attachment<M: Mysql>(
    mysql: &M,
    attachment_id: &str,
) -> MysqlResult<Option<AttachmentContentRow>> {
    mysql
        .fetch_optional(
            "SELECT loop_item_id, object_key, content_type, display_name \
             FROM loop_items \
             WHERE id = ? \
             AND resource_type IN ('attachment')",
            (attachment_id,),
        )
        .await
}

/// `LoopItemService.list_attachments`: the item's attachment rows, newest
/// first.
pub async fn list_attachments<M: Mysql>(
    mysql: &M,
    item_id: &str,
) -> MysqlResult<Vec<AttachmentRow>> {
    mysql
        .fetch_all(
            "SELECT id, loop_item_id, display_name, content_type, size_bytes, \
             sha256, created_by_user_id, created_at \
             FROM loop_items \
             WHERE loop_item_id = ? \
             AND resource_type IN ('attachment') \
             ORDER BY created_at DESC",
            (item_id,),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_security_level_from_metadata() {
        let metadata: JsonProjection<ItemSecurityMetadata> =
            JsonProjection::from_json(&json!({"security_level": "related"}));
        let row = AttachmentTaskRow {
            id: "WEWORKC2FA61-507".to_string(),
            cloud_project_id: "6202125112230396586".to_string(),
            metadata: Some(Json(metadata)),
        };
        assert_eq!(row.security_level(), Some("related"));
    }

    #[test]
    fn missing_security_level_is_none() {
        let row = AttachmentTaskRow {
            id: "WEWORKC2FA61-507".to_string(),
            cloud_project_id: "6202125112230396586".to_string(),
            metadata: None,
        };
        assert_eq!(row.security_level(), None);
    }
}
