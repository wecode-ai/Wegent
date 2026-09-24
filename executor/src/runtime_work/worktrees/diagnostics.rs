// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::Instant;

use crate::logging::log_executor_event;

pub(super) fn measure_stage<T, E>(
    task_id: &str,
    stage: &str,
    operation: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let started = Instant::now();
    log_executor_event(
        "runtime worktree stage started",
        &[("task_id", task_id.to_owned()), ("stage", stage.to_owned())],
    );
    let result = operation();
    log_executor_event(
        "runtime worktree stage finished",
        &[
            ("task_id", task_id.to_owned()),
            ("stage", stage.to_owned()),
            ("elapsed_ms", started.elapsed().as_millis().to_string()),
            ("ok", result.is_ok().to_string()),
        ],
    );
    result
}
