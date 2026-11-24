// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Secondary loop-item repository reads: team names and cached chat messages.

use super::*;

impl<'a, M: Mysql> LoopItemRepository<'a, M> {
    /// `db.get(Kind, id)`: the team's `name` when the row exists.
    pub async fn kind_name(&self, team_id: i64) -> MysqlResult<Option<String>> {
        #[derive(Debug, FromMysqlRow)]
        struct NameRow {
            #[mysql(rename = "kinds_name")]
            name: Option<String>,
        }
        let row: Option<NameRow> = self
            .mysql
            .fetch_optional(
                &format!(
                    "SELECT kinds.name AS kinds_name \nFROM kinds \n\
                 WHERE kinds.id = {team_id} \n LIMIT 1",
                ),
                (),
            )
            .await?;
        Ok(row.and_then(|row| row.name))
    }

    /// `_present_cached_ai_state`'s `ProjectChatMessage` lookup: the message's
    /// terminal state for a cached task AI projection.
    pub async fn project_chat_message(
        &self,
        message_id: &str,
        item_id: &str,
    ) -> MysqlResult<Option<ProjectChatMessageRow>> {
        self.mysql
            .fetch_optional(
                "SELECT project_chat_messages.status AS project_chat_messages_status, \
             project_chat_messages.content AS project_chat_messages_content, \
             project_chat_messages.updated_at AS project_chat_messages_updated_at \n\
             FROM project_chat_messages \n\
             WHERE project_chat_messages.message_id = ? \
             AND project_chat_messages.task_id = ? \
             AND (project_chat_messages.deleted_at IS NULL OR project_chat_messages.deleted_at IN \
                 ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \n LIMIT 1",
                (message_id, item_id),
            )
            .await
    }
}
