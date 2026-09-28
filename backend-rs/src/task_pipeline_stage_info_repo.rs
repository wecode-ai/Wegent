// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL row loads for `GET /api/tasks/{task_id}/pipeline-stage-info`,
//! mirroring the source SQLAlchemy renderings token for token: the full
//! labeled projections and the configured logical task table.
use crate::json_compat::OpaqueJson;
use crate::task_routing::ByTaskId;
use brz_mysql::{Mysql, MysqlResult};

/// A `tasks_{:04}` row: `user_id` and the opaque CRD `json` document.
#[derive(Debug)]
pub struct TaskRow {
    pub user_id: i64,
    pub json: OpaqueJson,
}

/// `task_store.get_active_task` on the sharded table (new-format ids route
/// by their embedded uid; the deployment runs 1024 shards).
pub async fn get_active_task<M>(mysql: &M, task_id: i64) -> MysqlResult<Option<TaskRow>>
where
    M: Mysql,
{
    let sql = "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         \nFROM {{tasks}} \nWHERE id = ? \
         AND kind = 'Task' AND is_active IN (1, 2) \n LIMIT 1";
    let row: Option<brz_mysql::MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(sql, (task_id,))
        .await?;
    row.as_ref().map(decode_task_row).transpose()
}

fn decode_task_row(row: &brz_mysql::MysqlRow) -> MysqlResult<TaskRow> {
    Ok(TaskRow {
        user_id: row.get_required("user_id")?,
        json: row.get_required::<brz_mysql::Json<OpaqueJson>>("json")?.0,
    })
}
