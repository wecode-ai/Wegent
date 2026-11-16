// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/project_automation_completion.py`.
//!
//! `_managed_activity` reads the Task CRD and only proceeds when its
//! `source` label marks it as project-automation traffic; every other completed
//! task returns immediately.
use brz_mysql::Mysql;
use brz_redis::Redis;

use crate::internal_callback::completion::Completion;
use crate::internal_callback::completion::TaskCompletedEvent;

/// `handle_project_automation_task_completed`.
pub(crate) async fn handle_project_automation_task_completed<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    if let Err(error) = crate::background_jobs::project::completion::complete(
        ctx.mysql,
        ctx.redis,
        crate::task_store::TableTemplates {
            tasks: ctx.tables.tasks,
            subtasks: ctx.tables.subtasks,
        },
        event.task_id,
        event.user_id,
        event.status,
        None,
    )
    .await
    {
        tracing::error!(task_id = event.task_id, %error, "project automation completion failed");
    }
}
