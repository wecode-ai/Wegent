// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `db.get(...)` reads for the loop-item assignment path.
//!
//! The source resolves the item, its project and each assignment creator with
//! SQLAlchemy's `Session.get`, which renders the mapped table's *unlabeled*
//! projection (`SELECT loop_items.id, ...`) plus an inline primary key and no
//! `LIMIT`, unlike the labeled `db.query(...)` statements the shared loop-item
//! repository mostly issues.
use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};

use crate::cloud_projects::WORKSPACE_ID_COLUMN;

use super::loop_repository::{ItemMetadata, ProjectMetadata};

/// The source's unlabeled `loop_items` projection (`db.get(LoopItem, id)` /
/// `db.get(CloudProject, id)`): SQLAlchemy renders the primary-key lookup with
/// plain column expressions, without the `AS` aliases of the labeled
/// `db.query(...)` form. Column order follows the mapped table.
pub(crate) const LOOP_ITEMS_UNLABELED: &str = "\
     loop_items.id, loop_items.resource_type, loop_items.project_space, loop_items.cloud_project_id, loop_items.parent_id, loop_items.loop_item_id, loop_items.delivery_id, loop_items.public_id, loop_items.project_key, loop_items.name, loop_items.title, loop_items.description, loop_items.storage_prefix, loop_items.sequence_number, loop_items.next_item_number, loop_items.created_by_user_id, loop_items.updated_by_user_id, loop_items.assignee_user_id, loop_items.user_id, loop_items.added_by_user_id, loop_items.source, loop_items.status, loop_items.priority, loop_items.start_at, loop_items.due_at, loop_items.sort_order, loop_items.current_delivery_id, loop_items.local_project_id, loop_items.device_id, loop_items.is_default, loop_items.task_user_id, loop_items.assignee_agent_id, loop_items.assignee_team_id, loop_items.task_id, loop_items.task_title, loop_items.backend_task_id, loop_items.linked_by_user_id, loop_items.linked_at, loop_items.unlinked_at, loop_items.path, loop_items.kind, loop_items.display_name, loop_items.relative_path, loop_items.object_key, loop_items.content_type, loop_items.size_bytes, loop_items.sha256, loop_items.source_task_binding_id, loop_items.source_task_snapshot, loop_items.markdown_object_key, loop_items.chat_object_key, loop_items.manifest_object_key, loop_items.metadata, loop_items.version, loop_items.created_at, loop_items.updated_at, loop_items.completed_at, loop_items.delivered_at, loop_items.deleted_at";

/// One `db.get(LoopItem, id)` row: the unlabeled `loop_items` projection whose
/// `resource_type` is the model's polymorphic `task` identity.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code, reason = "mirrors the source db.get projection")]
pub struct LoopItemGetRow {
    pub id: String,
    #[mysql(rename = "cloud_project_id")]
    pub cloud_project_id: String,
    #[mysql(rename = "created_by_user_id")]
    pub created_by_user_id: i32,
    #[mysql(rename = "status")]
    pub status: Option<String>,
    #[mysql(rename = "metadata")]
    pub metadata: Option<Json<JsonProjection<ItemMetadata>>>,
}

/// One `db.get(CloudProject, id)` row: the unlabeled `loop_items` projection
/// with the project polymorphic identity.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code, reason = "mirrors the source db.get projection")]
pub struct ProjectGetRow {
    pub id: String,
    #[mysql(rename = "created_by_user_id")]
    pub created_by_user_id: i32,
    #[mysql(rename = "metadata")]
    pub metadata: Option<Json<JsonProjection<ProjectMetadata>>>,
}

/// One `db.get(User, user_id)` row: the source's unlabeled `users` projection.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code, reason = "mirrors the source db.get projection")]
pub struct UserGetRow {
    pub id: i32,
    pub user_name: String,
    pub password_hash: String,
    pub email: Option<String>,
    pub git_info: Json<brz_json::OpaqueJson>,
    pub is_active: i8,
    #[mysql(rename = "role")]
    pub role: String,
    pub auth_source: String,
    pub preferences: String,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
}

/// `db.get(LoopItem, item_id)`: the polymorphic task row selected with the
/// source's unlabeled projection and no `deleted_at` filter.
pub async fn loop_item<M: Mysql>(mysql: &M, item_id: &str) -> MysqlResult<Option<LoopItemGetRow>> {
    mysql
        .fetch_optional(
            &format!(
                "SELECT {LOOP_ITEMS_UNLABELED} \nFROM loop_items \n\
                 WHERE loop_items.id = ? \n\
                 AND loop_items.resource_type IN ('task')",
            ),
            (item_id,),
        )
        .await
}

/// Permission checks need only identity and security, never the Issue's history or body.
pub async fn loop_item_access<M: Mysql>(
    mysql: &M,
    item_id: &str,
) -> MysqlResult<Option<LoopItemGetRow>> {
    mysql
        .fetch_optional(
            "SELECT id, cloud_project_id, created_by_user_id, status, \
         JSON_OBJECT('security_level', JSON_EXTRACT(metadata, '$.security_level')) AS metadata \
         FROM loop_items WHERE id = ? AND resource_type = 'task'",
            (item_id,),
        )
        .await
}

/// `db.get(CloudProject, item.cloud_project_id)`: the project row selected with
/// the source's unlabeled projection.
pub async fn project<M: Mysql>(mysql: &M, project_id: &str) -> MysqlResult<Option<ProjectGetRow>> {
    mysql
        .fetch_optional(
            &format!(
                "SELECT {WORKSPACE_ID_COLUMN}, {LOOP_ITEMS_UNLABELED} \nFROM loop_items \n\
                 WHERE loop_items.id = ? \n\
                 AND loop_items.resource_type IN ('project')",
            ),
            (project_id,),
        )
        .await
}

/// `db.get(User, user_id)`: the unlabeled `users` projection with the snowflake
/// id inlined and no `LIMIT`.
pub async fn user_by_id<M: Mysql>(mysql: &M, user_id: i64) -> MysqlResult<Option<UserGetRow>> {
    mysql
        .fetch_optional(
            &format!(
                "SELECT users.id, users.user_name, users.password_hash, users.email, \
                 users.git_info, users.is_active, users.`role`, users.auth_source, \
                 users.preferences, users.created_at, users.updated_at \nFROM users \n\
                 WHERE users.id = {user_id}"
            ),
            (),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn receipt_permission_probe_projects_only_security_metadata() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let _ = loop_item_access(&mysql, "EXAMPLE-5")
            .await
            .expect("captured");
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("WHERE id = ?"));
        assert!(queries[0].sql.contains("JSON_OBJECT('security_level'"));
        assert!(!queries[0].sql.contains("description"));
        assert!(!queries[0].sql.contains("assignment_history"));
    }

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// `db.get(LoopItem, id)` renders plain column expressions and no `LIMIT`,
    /// unlike the labeled `db.query(...)` form.
    #[tokio::test]
    async fn loop_item_uses_the_unlabeled_projection() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let _ = loop_item(&mysql, "WEWORKBU7D045F-5")
            .await
            .expect("captured");
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(!queries[0].sql.contains(" AS loop_items_"));
        assert_eq!(
            queries[0].sql,
            normalize(&format!(
                "SELECT {LOOP_ITEMS_UNLABELED} FROM loop_items \
                 WHERE loop_items.id = ? \
                 AND loop_items.resource_type IN ('task')"
            ))
        );
    }

    /// The unlabeled projection is the source's complete mapped column list
    /// (`db.get` renders every column), so `start_at`, which sits between
    /// `priority` and `due_at`, must be present to match the recorded
    /// primary-key lookup.
    #[test]
    fn unlabeled_projection_carries_start_at() {
        assert!(LOOP_ITEMS_UNLABELED.contains(
            "loop_items.status, loop_items.priority, loop_items.start_at, loop_items.due_at, loop_items.sort_order"
        ));
    }

    #[tokio::test]
    async fn project_uses_the_unlabeled_projection() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let _ = project(&mysql, "6202125112230396586")
            .await
            .expect("captured");
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].sql,
            normalize(&format!(
                "SELECT {WORKSPACE_ID_COLUMN}, {LOOP_ITEMS_UNLABELED} FROM loop_items \
                 WHERE loop_items.id = ? \
                 AND loop_items.resource_type IN ('project')"
            ))
        );
    }

    /// `db.get(User, id)` renders the unlabeled `users` projection with the
    /// snowflake id inlined and no `LIMIT`.
    #[tokio::test]
    async fn user_by_id_uses_the_unlabeled_projection() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let _ = user_by_id(&mysql, 101).await.expect("captured");
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(!queries[0].sql.contains(" AS users_"));
        assert_eq!(
            queries[0].sql,
            normalize(
                "SELECT users.id, users.user_name, users.password_hash, users.email, \
                 users.git_info, users.is_active, users.`role`, users.auth_source, \
                 users.preferences, users.created_at, users.updated_at \
                 FROM users WHERE users.id = 101"
            )
        );
    }
}
