// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/project_automation_completion.py`.
//!
//! `_managed_activity` reads the Task CRD and only proceeds when its
//! `source` label marks it as project-automation traffic; every other completed
//! task returns immediately.
use brz_mysql::{Json, Mysql, MysqlRow};
use brz_redis::Redis;
use serde_json::Value;

use crate::internal_callback::completion::Completion;
use crate::internal_callback::completion::TaskCompletedEvent;
use crate::internal_callback::completion::sql;
use crate::internal_callback::completion::task_column;

/// `handle_project_automation_task_completed`.
pub(crate) async fn handle_project_automation_task_completed<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(event.task_id as u64));
    let task: Option<MysqlRow> = mysql
        .fetch_optional(
            sql::task_by_id_statement(ctx.tables.tasks),
            (event.task_id,),
        )
        .await
        .ok()
        .flatten();
    let Some(task) = task else {
        return;
    };
    let source = task_column::<Json<Value>>(&task, "json").and_then(|json| {
        json.0
            .get("metadata")
            .and_then(|metadata| metadata.get("labels"))
            .and_then(|labels| labels.get("source"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    if source.as_deref() != Some("project_automation") {
        return;
    }
    // The managed-activity lock reads and terminal writes that follow belong to
    // project-automation runs; no callback recording exercises them.
    tracing::debug!(task_id = event.task_id, "project automation activity found");
}
