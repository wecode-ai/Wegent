// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL row loads for `GET /api/tasks/{task_id}/pipeline-stage-info`,
//! mirroring the source SQLAlchemy renderings token for token: the full
//! labeled projections and the configured logical task table.
use crate::json_compat::OpaqueJson;
use crate::task_store::TaskStore;
use brz_mysql::{MysqlResult, MysqlRow};

/// A `tasks` row: `user_id` and the opaque CRD `json` document.
#[derive(Debug)]
pub struct TaskRow {
    pub user_id: i64,
    pub json: OpaqueJson,
}

/// `task_store.get_active_task`: the active `Task` row for `task_id`.
pub async fn get_active_task(
    task_store: &dyn TaskStore,
    task_id: i64,
) -> MysqlResult<Option<TaskRow>> {
    let row = task_store.get_active_task(task_id).await?;
    row.as_ref().map(decode_task_row).transpose()
}

fn decode_task_row(row: &MysqlRow) -> MysqlResult<TaskRow> {
    Ok(TaskRow {
        user_id: row.get_required("user_id")?,
        json: row.get_required::<brz_mysql::Json<OpaqueJson>>("json")?.0,
    })
}
