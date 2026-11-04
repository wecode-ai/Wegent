// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, path::PathBuf};

use crate::{
    config::paths::executor_home,
    emitter::ResponsesEventBuilder,
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
    runner::ExecutionOutcome,
    services::turn_file_changes::{failed_file_change_summary, TurnFileChangeTracker},
};

/// Capture the prepared current directory for the web task workbench.
/// Public task dispatch selects one repository; this summary does not aggregate
/// auxiliary runtime roots or replace native runtime file-change events.
pub(super) async fn capture_completed_file_changes<F, Fut>(
    request: &ExecutionRequest,
    workspace: Option<PathBuf>,
    builder: &ResponsesEventBuilder,
    run: F,
) -> ExecutionOutcome
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ExecutionOutcome>,
{
    let capture = start_file_change_capture(request, workspace).await;
    let outcome = run().await;
    if !matches!(outcome, ExecutionOutcome::Completed { .. }) {
        return outcome;
    }
    finish_file_change_capture(capture, request, builder).await;
    outcome
}

pub(crate) enum FileChangeCapture {
    Unavailable,
    Started(TurnFileChangeTracker),
    Failed,
}

pub(crate) async fn start_file_change_capture(
    request: &ExecutionRequest,
    workspace: Option<PathBuf>,
) -> FileChangeCapture {
    let tracker = tracker_for(request, workspace);
    match tokio::task::spawn_blocking(move || {
        let mut tracker = tracker?;
        tracker.start();
        Some(tracker)
    })
    .await
    {
        Ok(Some(tracker)) => FileChangeCapture::Started(tracker),
        Ok(None) => FileChangeCapture::Unavailable,
        Err(_) => FileChangeCapture::Failed,
    }
}

pub(crate) async fn finish_file_change_capture(
    capture: FileChangeCapture,
    request: &ExecutionRequest,
    builder: &ResponsesEventBuilder,
) {
    let fields = task_fields(&request.task_id, &request.subtask_id);
    let failed = || {
        log_executor_event("file change snapshot worker failed", &fields);
        builder.record_completed_file_change_fields(serde_json::json!({
            "file_changes": failed_file_change_summary(),
            "task_file_changes": failed_file_change_summary(),
        }));
    };
    let mut tracker = match capture {
        FileChangeCapture::Started(tracker) => tracker,
        FileChangeCapture::Unavailable => return,
        FileChangeCapture::Failed => return failed(),
    };
    match tokio::task::spawn_blocking(move || tracker.finalize()).await {
        Ok(result) => builder.record_completed_file_change_fields(result),
        Err(_) => failed(),
    }
}

fn tracker_for(
    request: &ExecutionRequest,
    workspace: Option<PathBuf>,
) -> Option<TurnFileChangeTracker> {
    Some(
        TurnFileChangeTracker::new(
            workspace?,
            request.task_id.parse().ok()?,
            request.subtask_id.parse().ok()?,
            executor_home(),
            request.device_id.as_deref(),
        )
        .with_task_baseline(),
    )
}
