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

use crate::cloud_projects::LOOP_ITEMS_COLUMNS;

/// `LoopItem.metadata_json` fields consumed by the item access check
/// (`app.services.loop_items.access.item_security`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ItemSecurityMetadata {
    pub security_level: Option<String>,
}

/// `_get_item_row` (`loop_item_service.get`): the active `resource_type='task'`
/// row plus the metadata needed by the `item_security` view gate. The full
/// labeled `loop_items` projection matches the source ORM's `db.query(LoopItem)`
/// rendering.
#[derive(Debug, FromMysqlRow)]
pub struct AttachmentTaskRow {
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_cloud_project_id")]
    pub cloud_project_id: String,
    #[mysql(rename = "loop_items_metadata")]
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
    #[mysql(rename = "loop_items_id")]
    pub id: String,
    #[mysql(rename = "loop_items_loop_item_id")]
    pub loop_item_id: Option<String>,
    #[mysql(rename = "loop_items_display_name")]
    pub display_name: Option<String>,
    #[mysql(rename = "loop_items_content_type")]
    pub content_type: Option<String>,
    #[mysql(rename = "loop_items_size_bytes")]
    pub size_bytes: Option<i64>,
    #[mysql(rename = "loop_items_sha256")]
    pub sha256: Option<String>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    pub created_by_user_id: Option<i32>,
    #[mysql(rename = "loop_items_created_at")]
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
            format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.id = ? \n\
                 AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \n\
                 AND loop_items.resource_type IN ('task') \n LIMIT 1"
            ),
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
/// first, selected with the source ORM's full labeled `loop_items` projection.
pub async fn list_attachments<M: Mysql>(
    mysql: &M,
    item_id: &str,
) -> MysqlResult<Vec<AttachmentRow>> {
    mysql
        .fetch_all(
            format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.loop_item_id = ? \n\
                 AND loop_items.resource_type IN ('attachment') \n\
                 ORDER BY loop_items.created_at DESC"
            ),
            (item_id,),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Whitespace-insensitive SQL comparison: Replay matches the statement
    /// structure, not the source's line breaks.
    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

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

    /// `_get_item_row` (`loop_item_service.get`) keeps the active task row,
    /// the polymorphic `task` discriminator, the unset-datetime filter, and the
    /// source ORM's full labeled `loop_items` projection.
    #[tokio::test]
    async fn get_task_item_matches_the_recorded_task_lookup() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let item = get_task_item(&mysql, "WEWORK2D8526-22")
            .await
            .expect("task lookup is captured");
        assert!(item.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 1);
        assert_eq!(
            normalize(&queries[0].sql),
            normalize(&format!(
                "SELECT {LOOP_ITEMS_COLUMNS} FROM loop_items \
                 WHERE loop_items.id = ? \
                 AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                 AND loop_items.resource_type IN ('task') LIMIT 1"
            ))
        );
    }

    /// `LoopItemService.list_attachments` selects the item's attachment rows
    /// newest first, matching the recorded exchange.
    #[tokio::test]
    async fn list_attachments_matches_the_recorded_query() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let rows = list_attachments(&mysql, "WEWORK2D8526-22")
            .await
            .expect("attachment query is captured");
        assert!(rows.is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 1);
        assert_eq!(
            normalize(&queries[0].sql),
            normalize(&format!(
                "SELECT {LOOP_ITEMS_COLUMNS} FROM loop_items \
                 WHERE loop_items.loop_item_id = ? \
                 AND loop_items.resource_type IN ('attachment') \
                 ORDER BY loop_items.created_at DESC"
            ))
        );
    }
}
