// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Full Issue entity reads, including primary reads after shadow creation.

use super::{
    CLOUD_CONTEXT_COLUMNS, LoopItemRepository, Mysql, MysqlResult, RawLoopItemRow, TaskItemFullRow,
};
use brz_mysql::MysqlTransaction as _;

impl<M: Mysql> LoopItemRepository<'_, M> {
    /// `db.get(LoopItem, item_id)` (`find_cloud_context`'s item lookup and
    /// `response_values`'s task row): the active `resource_type='task'` row
    /// with the source's full labeled projection.
    pub async fn get_task_item_full(&self, item_id: &str) -> MysqlResult<Option<TaskItemFullRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.id = '{item_id}' \
                     AND loop_items.resource_type IN ('task')",
                ),
                (),
            )
            .await
    }

    /// The same labeled `loop_items` point read as
    /// [`Self::get_task_item_full`], kept for the execution authority checks:
    /// they read the raw `metadata` document (which the typed task row only
    /// decodes into known fields) and can address any resource type.
    pub async fn get_loop_item_raw(
        &self,
        item_id: &str,
        resource_type: &str,
    ) -> MysqlResult<Option<RawLoopItemRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT id, cloud_project_id, created_by_user_id, assignee_user_id, metadata \nFROM loop_items \n\
                     WHERE loop_items.id = '{item_id}' \
                     AND loop_items.resource_type IN ('{resource_type}')",
                ),
                (),
            )
            .await
    }

    /// `LoopItemService._get_item_row`: the full entity projection for one
    /// non-deleted task row. `Ok(None)` maps to the source's 404.
    pub async fn get_task_item_entity(
        &self,
        item_id: &str,
    ) -> MysqlResult<Option<TaskItemFullRow>> {
        self.mysql
            .with_transaction(async |transaction| {
                transaction
                    .fetch_optional(
                        &format!(
                            "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.id = ? AND (loop_items.deleted_at IS NULL OR \
                     loop_items.deleted_at IN ('1970-01-01 00:00:00', \
                     '1970-01-01 00:00:01')) AND loop_items.resource_type IN ('task') \
                     \n LIMIT 1",
                        ),
                        (item_id,),
                    )
                    .await
            })
            .await
    }
}
