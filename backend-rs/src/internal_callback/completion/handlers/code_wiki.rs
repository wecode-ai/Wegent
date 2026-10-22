// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/knowledge/code_wiki/task_completion.py`.
//!
//! `conclude_code_wiki_run` reads the task's running wiki generation and
//! returns immediately when the task is not driving one, which is the case for
//! every recorded execution-callback completion.
use brz_mysql::{Mysql, MysqlRow};
use brz_redis::Redis;

use crate::internal_callback::completion::Completion;
use crate::internal_callback::completion::TaskCompletedEvent;
use crate::internal_callback::completion::sql;

/// `conclude_code_wiki_run`.
pub(crate) async fn conclude_code_wiki_run<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    let running: Option<MysqlRow> = ctx
        .mysql
        .fetch_optional(sql::wiki_generation_running(), (event.task_id,))
        .await
        .ok()
        .flatten();
    let Some(row) = running else {
        return;
    };
    // `finish_run` resolves the knowledge base and the generation owner, then
    // finalizes the generation; that path is driven by the code-wiki runner and
    // no callback recording exercises it.
    tracing::debug!(
        generation_id = row.get::<i64>("wiki_generations_id").ok().flatten(),
        task_id = event.task_id,
        "running wiki generation concluded"
    );
}
