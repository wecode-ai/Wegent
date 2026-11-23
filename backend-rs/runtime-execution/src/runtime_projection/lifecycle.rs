// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use brz_mysql::{MysqlResult, MysqlTransaction};

use super::ExecutionRow;

pub async fn item_version(
    tx: &mut impl MysqlTransaction,
    execution: Option<&ExecutionRow>,
) -> MysqlResult<Option<i64>> {
    let Some(id) = execution
        .and_then(|row| row.loop_item_id.as_deref())
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let row: Option<brz_mysql::MysqlRow> = tx
        .fetch_optional(
            "SELECT version FROM loop_items WHERE id=? AND resource_type='task'",
            (id,),
        )
        .await?;
    row.map(|row| row.get_required("version")).transpose()
}

pub struct Effects {
    pub matched: Option<ExecutionRow>,
    pub changed: bool,
    pub detail: String,
    pub messages: Vec<super::Message>,
    pub settled_reply: Option<(String, i64)>,
}
