// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subtask history for the remote-workspace status detail load.
//!
//! `task_fork_history_resolver.resolve_for_task` as `get_task_detail` calls
//! it: the sharded `list_by_task_ordered` lookup plus `_attach_contexts`, then
//! the fork-history window — sort by `(message_id, created_at, id)` and keep
//! the last `limit` (100) items. The window bounds both the bot ids that
//! `get_bots_for_subtasks` resolves and the `task_dict["subtasks"]` list the
//! status handler reads its executor bindings from.
use brz_mysql::{Mysql, MysqlRow};

use super::app_state::AppState;
use super::task_detail::{TaskRoute, migrated_legacy_task_exists, task_lookup_route};
use crate::json_compat::{JsonProjection, OpaqueJson};
use crate::task_routing::{ByTaskId, ByUserId};

/// `get_task_detail` passes `limit=100` to
/// `task_fork_history_resolver.resolve_for_task`.
pub const SUBTASK_HISTORY_LIMIT: usize = 100;

const SUBTASKS_BY_TASK_SQL: &str = "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, \
        executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, \
        created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id \
    FROM {{subtasks}} \
    WHERE task_id = ? \
    ORDER BY message_id ASC, created_at ASC";

/// One `subtasks_{:04}` row; the bot ids, executor binding, `result`
/// document, and the fork-history sort keys are consumed.
#[derive(Debug)]
pub struct SubtaskRow {
    pub id: i64,
    /// First fork-history sort key (`item.subtask.message_id`).
    pub message_id: i32,
    /// Second fork-history sort key (`item.subtask.created_at`).
    pub created_at: chrono::NaiveDateTime,
    pub bot_ids: JsonProjection<Vec<Option<i64>>>,
    /// The stored `result` document, re-signed by
    /// `refresh_extended_video_result_urls`.
    pub result: Option<OpaqueJson>,
    pub executor_namespace: Option<String>,
    pub executor_name: Option<String>,
    pub executor_deleted_at: bool,
}

fn decode_subtask_row(row: &MysqlRow) -> brz_mysql::MysqlResult<SubtaskRow> {
    Ok(SubtaskRow {
        id: row.get_required("id")?,
        message_id: row.get_required("message_id")?,
        created_at: row.get_required("created_at")?,
        bot_ids: row
            .get_required::<brz_mysql::Json<JsonProjection<Vec<Option<i64>>>>>("bot_ids")?
            .0,
        result: row
            .get::<brz_mysql::Json<OpaqueJson>>("result")?
            .map(|json| json.0),
        executor_namespace: row.get("executor_namespace")?,
        executor_name: row.get("executor_name")?,
        executor_deleted_at: row.get_required("executor_deleted_at")?,
    })
}

/// `ShardedSubtaskStore._owner_matches_task_id` guard query: the task table
/// for the task id, then a subtask-owner fallback when the task row is
/// absent. Only reached for new-format task ids; `list_by_task_ordered`
/// skips the guard entirely for legacy ids.
async fn owner_matches_task_id(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: i64,
) -> anyhow::Result<bool> {
    // New-format ids route directly to their shard table; legacy ids use the
    // migrated-owner lookup (`_migrated_legacy_task_model`).
    let task_exists = if (state.task_policy.is_scoped_id)(task_id as u64)
        || !state.task_policy.resolve_migrated_legacy
    {
        let row: Option<MysqlRow> = state
            .mysql
            .route(ByTaskId(task_id as u64))
            .fetch_optional(
                "SELECT id \nFROM {{tasks}} \nWHERE id = ? AND user_id = ? \n LIMIT 1",
                (task_id, owner_user_id),
            )
            .await?;
        row.is_some()
    } else {
        migrated_legacy_task_exists(state, task_id, Some(owner_user_id)).await?
    };
    if task_exists {
        return Ok(true);
    }
    // `subtask_model_for_task_id` distinct-user fallback.
    let route = task_lookup_route(state, task_id, Some(owner_user_id)).await?;
    let users: Vec<MysqlRow> =
        match route {
            TaskRoute::ByTaskId => state
                .mysql
                .route(ByTaskId(task_id as u64))
                .fetch_all(
                    "SELECT DISTINCT user_id \nFROM {{subtasks}} \nWHERE task_id = ? \n LIMIT 2",
                    (task_id,),
                )
                .await?,
            TaskRoute::ByUserId(owner) => state
                .mysql
                .route(ByUserId(owner as u64))
                .fetch_all(
                    "SELECT DISTINCT user_id \nFROM {{subtasks}} \nWHERE task_id = ? \n LIMIT 2",
                    (task_id,),
                )
                .await?,
        };
    if users.len() != 1 {
        return Ok(false);
    }
    Ok(users[0]
        .get_required::<i64>("user_id")
        .map(|user_id| user_id == owner_user_id)
        .unwrap_or(false))
}

/// `ShardedSubtaskStore.list_by_task_ordered` plus `_attach_contexts`.
async fn list_subtasks_by_task(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: Option<i64>,
) -> anyhow::Result<Vec<SubtaskRow>> {
    let sql = SUBTASKS_BY_TASK_SQL;
    let route = task_lookup_route(state, task_id, owner_user_id).await?;
    let rows: Vec<MysqlRow> = match route {
        TaskRoute::ByTaskId => {
            state
                .mysql
                .route(ByTaskId(task_id as u64))
                .fetch_all(sql, (task_id,))
                .await?
        }
        TaskRoute::ByUserId(owner) => {
            state
                .mysql
                .route(ByUserId(owner as u64))
                .fetch_all(sql, (task_id,))
                .await?
        }
    };
    let subtasks = rows
        .iter()
        .map(decode_subtask_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
    if !subtasks.is_empty() {
        let ids = subtasks
            .iter()
            .map(|subtask| subtask.id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let _contexts: Vec<MysqlRow> = Mysql::fetch_all(
            &state.mysql,
            &format!(
                "SELECT subtask_contexts.id AS subtask_contexts_id, \
                 subtask_contexts.subtask_id AS subtask_contexts_subtask_id, \
                 subtask_contexts.user_id AS subtask_contexts_user_id, \
                 subtask_contexts.context_type AS subtask_contexts_context_type, \
                 subtask_contexts.name AS subtask_contexts_name, \
                 subtask_contexts.status AS subtask_contexts_status, \
                 subtask_contexts.error_message AS subtask_contexts_error_message, \
                 subtask_contexts.binary_data AS subtask_contexts_binary_data, \
                 subtask_contexts.image_base64 AS subtask_contexts_image_base64, \
                 subtask_contexts.extracted_text AS subtask_contexts_extracted_text, \
                 subtask_contexts.text_length AS subtask_contexts_text_length, \
                 subtask_contexts.type_data AS subtask_contexts_type_data, \
                 subtask_contexts.created_at AS subtask_contexts_created_at, \
                 subtask_contexts.updated_at AS subtask_contexts_updated_at \n\
                 FROM subtask_contexts \nWHERE subtask_contexts.subtask_id IN ({ids}) \
                 ORDER BY subtask_contexts.id ASC"
            ),
            (),
        )
        .await?;
    }
    Ok(subtasks)
}

/// `resolve_for_task`'s window: order the lineage's items by
/// `(message_id, created_at, id)` and keep the last [`SUBTASK_HISTORY_LIMIT`]
/// of them.
fn history_window(mut subtasks: Vec<SubtaskRow>) -> Vec<SubtaskRow> {
    subtasks.sort_by_key(|subtask| (subtask.message_id, subtask.created_at, subtask.id));
    if subtasks.len() > SUBTASK_HISTORY_LIMIT {
        subtasks.drain(..subtasks.len() - SUBTASK_HISTORY_LIMIT);
    }
    subtasks
}

/// The subtask list `get_task_detail` consumes: `resolve_for_task`'s
/// `list_by_task_ordered` lookup (owner guard, subtasks, contexts) inside the
/// fork-history window. The bot ids and executor bindings therefore come from
/// the newest [`SUBTASK_HISTORY_LIMIT`] subtasks only — a longer history drops
/// its oldest subtasks before `get_bots_for_subtasks` runs.
pub async fn list_subtask_history(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: i64,
) -> anyhow::Result<Vec<SubtaskRow>> {
    // `list_by_task_ordered` guards with `_owner_matches_task_id` only for
    // new-format ids (`if is_new_task_id(task_id) and not ...`); legacy ids
    // list subtasks directly through `_subtask_model_for_task_lookup`.
    if state.task_policy.resolve_migrated_legacy
        && (state.task_policy.is_scoped_id)(task_id as u64)
        && !owner_matches_task_id(state, task_id, owner_user_id).await?
    {
        return Ok(Vec::new());
    }
    Ok(history_window(
        list_subtasks_by_task(state, task_id, Some(owner_user_id)).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::assert_routed_sql;

    fn subtask(message_id: i32, id: i64) -> SubtaskRow {
        SubtaskRow {
            id,
            message_id,
            created_at: chrono::NaiveDateTime::default(),
            bot_ids: JsonProjection { value: None },
            result: None,
            executor_namespace: None,
            executor_name: None,
            executor_deleted_at: false,
        }
    }

    fn window_message_ids(subtasks: Vec<SubtaskRow>) -> Vec<i32> {
        history_window(subtasks)
            .iter()
            .map(|subtask| subtask.message_id)
            .collect()
    }

    #[test]
    fn history_window_keeps_the_newest_hundred_by_message_order() {
        // The recorded 138-row history: the first 38 subtasks (message ids
        // 1..=38) belong to the older bot 110593 and fall outside the
        // window, so `get_bots_for_subtasks` only resolves the bot of the
        // retained subtasks.
        let mut subtasks: Vec<SubtaskRow> = (1..=138)
            .map(|message_id| subtask(message_id, i64::from(message_id)))
            .collect();
        subtasks.reverse();
        assert_eq!(
            window_message_ids(subtasks),
            (39..=138).collect::<Vec<i32>>()
        );
    }

    #[test]
    fn history_window_keeps_a_history_at_or_below_the_limit() {
        let subtasks: Vec<SubtaskRow> = (1..=SUBTASK_HISTORY_LIMIT as i32)
            .map(|message_id| subtask(message_id, i64::from(message_id)))
            .collect();
        let ids = window_message_ids(subtasks);
        assert_eq!(ids.len(), SUBTASK_HISTORY_LIMIT);
        assert_eq!(ids.first(), Some(&1));
    }

    #[test]
    fn history_window_orders_equal_message_ids_by_created_at_then_id() {
        let later =
            chrono::NaiveDateTime::parse_from_str("2026-09-21 06:41:39", "%Y-%m-%d %H:%M:%S")
                .expect("timestamp");
        let mut first = subtask(1, 30);
        first.created_at = later;
        let mut second = subtask(1, 10);
        second.created_at = later;
        let third = subtask(1, 20);
        assert_eq!(
            history_window(vec![first, second, third])
                .iter()
                .map(|subtask| subtask.id)
                .collect::<Vec<i64>>(),
            vec![20, 10, 30]
        );
    }

    #[test]
    fn subtask_projection_includes_every_labeled_column() {
        let columns = SUBTASKS_BY_TASK_SQL;
        assert!(columns.starts_with("SELECT id, user_id, task_id, team_id, title, bot_ids"));
        assert!(columns.contains("`role`"));
        assert!(columns.contains("executor_deleted_at"));
        assert!(columns.contains("reply_to_subtask_id"));
        assert!(columns.contains("ORDER BY message_id ASC, created_at ASC"));
        assert_routed_sql(columns, 1);
    }
}
