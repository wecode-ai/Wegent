// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Comment and related-item loop reads for the task-binding path.

use super::*;

impl<'a, M: Mysql> LoopItemRepository<'a, M> {
    /// `LoopItemReadContext._visible_ids` (`app/services/loop_items/
    /// read_context.py:98-115`): one labeled batch read of the items related to
    /// the caller, used to decide `can_view_detail` without a per-item query.
    pub async fn related_item_ids(
        &self,
        item_ids: &[String],
        user_id: i32,
    ) -> MysqlResult<std::collections::HashSet<String>> {
        if item_ids.is_empty() {
            return Ok(std::collections::HashSet::new());
        }
        let quoted = item_ids
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        #[derive(Debug, FromMysqlRow)]
        struct IdRow {
            #[mysql(rename = "loop_items_id")]
            id: String,
        }
        let rows: Vec<IdRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT loop_items.id AS loop_items_id \nFROM loop_items \n\
                 WHERE loop_items.id IN ({quoted}) AND ({}) \
                 AND loop_items.resource_type IN ('task')",
                    related_item_predicate_sql(user_id)
                ),
                (),
            )
            .await?;
        Ok(rows.into_iter().map(|row| row.id).collect())
    }

    /// `issue_assignment_service._active_events` ->
    /// `active_for_issues` -> `_assignment_comments(for_update=False)`: the item's
    /// assignment-event comment rows in activity order, read through the shared
    /// inlined-`IN` form.
    pub async fn list_item_comments(&self, item_id: &str) -> MysqlResult<Vec<CommentRow>> {
        self.mysql
            .fetch_all(
                assignment_comments_query(std::slice::from_ref(&item_id.to_string())),
                (),
            )
            .await
    }

    /// `issue_assignment_service.active_for_issues(db, issue_ids)`
    /// (`app/services/issue_assignments.py:110-122`): one batch read of the
    /// assignment-event comments for every eligible item, keyed by item id and
    /// kept in the recorded `(created_at, id)` order.
    pub async fn list_assignment_comments_for_items(
        &self,
        item_ids: &[String],
    ) -> MysqlResult<std::collections::HashMap<String, Vec<CommentRow>>> {
        if item_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let rows: Vec<CommentRow> = self
            .mysql
            .fetch_all(assignment_comments_query(item_ids), ())
            .await?;
        let mut grouped: std::collections::HashMap<String, Vec<CommentRow>> =
            std::collections::HashMap::new();
        for row in rows {
            if let Some(item_id) = row.loop_item_id.clone() {
                grouped.entry(item_id).or_default().push(row);
            }
        }
        Ok(grouped)
    }

    /// Read assignment history without initializing or locking the active index.
    pub async fn list_assignment_comments(&self, item_id: &str) -> MysqlResult<Vec<CommentRow>> {
        self.mysql
            .fetch_all(ordered_comments_query(true), (item_id,))
            .await
    }

    /// Test oracle for the materialized index still maintained by assignment writes.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn list_active_assignment_comments(
        &self,
        item_id: &str,
    ) -> MysqlResult<Vec<CommentRow>> {
        self.mysql.fetch_all(format!(
        "SELECT {CLOUD_CONTEXT_COLUMNS} FROM loop_items active \
         JOIN loop_items ON loop_items.id = active.loop_item_id \
         WHERE active.parent_id = ? AND active.resource_type = 'assignment_index' \
         AND loop_items.resource_type = 'comment' \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
         ORDER BY active.sort_order, loop_items.id"
    ), (item_id,)).await
    }

    /// `LoopItemService.list_comments`: the item's comment rows ordered by
    /// `created_at ASC` (the source issues no secondary `id` ordering here).
    pub async fn list_comments(&self, item_id: &str) -> MysqlResult<Vec<CommentRow>> {
        self.mysql
            .fetch_all(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.loop_item_id = ? \
                 AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                 AND loop_items.resource_type IN ('comment') \
                 ORDER BY loop_items.created_at ASC",
                ),
                (item_id,),
            )
            .await
    }

    /// `db.query(User).filter(User.id.in_(author_ids)).all()`: the comment
    /// authors' display names, with the source's labeled `users` projection.
    pub async fn list_user_names(&self, ids: &[i32]) -> MysqlResult<Vec<UserNameRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        self.mysql
            .fetch_all(
                format!(
                    "SELECT {} \nFROM users \nWHERE users.id IN ({placeholders})",
                    crate::user_reader::users_projection(),
                ),
                ids.to_vec(),
            )
            .await
    }

    /// Manager activities, newest first, for the current round's human identity.
    pub async fn item_activity_metadata(
        &self,
        project_id: &str,
        item_id: &str,
    ) -> MysqlResult<Vec<ItemActivityMetadataRow>> {
        self.mysql
            .fetch_all(
                "SELECT project_chat_messages.metadata AS activity_metadata \
             FROM project_chat_messages \
             WHERE project_chat_messages.project_id = ? \
             AND project_chat_messages.task_id = ? \
             ORDER BY project_chat_messages.created_at DESC, project_chat_messages.id DESC",
                (project_id, item_id),
            )
            .await
    }

    /// `access.is_related_item`: whether one item is related to the caller
    /// through ownership, assignment, an active runtime-task binding, a
    /// collaborator row, or an owned project agent.
    pub async fn is_related_item(&self, item_id: &str, user_id: i32) -> MysqlResult<bool> {
        let mut query = self.mysql;
        is_related_item_on(&mut query, item_id, user_id).await
    }

    /// `db.get(ProjectChatAgent, id)`: the chat-agent row when it exists. The
    /// source's `Session.get` renders the unlabeled entity projection with no
    /// `LIMIT`, matching the recorded exchange for replay.
    pub async fn chat_agent(&self, agent_id: &str) -> MysqlResult<Option<ChatAgentRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {} \nFROM loop_items \n\
                 WHERE loop_items.id = '{agent_id}' \
                 AND loop_items.resource_type IN ('chat_agent')",
                    crate::cloud_projects::entity_columns(),
                ),
                (),
            )
            .await
    }
}
