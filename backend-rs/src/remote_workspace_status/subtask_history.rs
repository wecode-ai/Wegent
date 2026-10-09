// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subtask history for the remote-workspace status detail load.
//!
//! `task_fork_history_resolver.resolve_for_task` as `get_task_detail` calls
//! it: the store's `list_by_task_ordered` lookup plus its context load, then
//! the fork-history window — sort by `(message_id, created_at, id)` and keep
//! the last `limit` (100) items. The window bounds both the bot ids that
//! `get_bots_for_subtasks` resolves and the `task_dict["subtasks"]` list the
//! status handler reads its executor bindings from.
use brz_mysql::{Mysql, MysqlRow};

use super::app_state::AppState;
use crate::json_compat::{JsonProjection, OpaqueJson};

/// `get_task_detail` passes `limit=100` to
/// `task_fork_history_resolver.resolve_for_task`.
pub const SUBTASK_HISTORY_LIMIT: usize = 100;

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
    // `list_by_task_ordered` runs the new-format owner guard and the attached
    // context load itself; only the rows feed the window.
    let listing = state
        .task_store
        .list_subtasks_by_task_ordered(task_id, owner_user_id)
        .await?;
    let subtasks = listing
        .rows
        .iter()
        .map(decode_subtask_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
    Ok(history_window(subtasks))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
