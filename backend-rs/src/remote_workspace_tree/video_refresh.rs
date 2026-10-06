// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `refresh_extended_video_result_urls` (`get_task_detail`'s last dependency
//! step) for the remote-workspace endpoints: the registered video integration
//! re-signs the temporary playback URLs of the assembled task detail response.
use crate::json_compat::OpaqueJson;

use super::error::ApiError;
use super::task_detail::{SubtaskRow, TaskRow};

/// `refresh_extended_video_result_urls`: the registered video integration
/// re-signs the temporary playback URLs of the task-level result first and
/// then of every subtask result, in subtask order. The remote-workspace
/// responses discard the rewritten payloads, but the signing calls are
/// request-owned.
///
/// The source's `refresh_task_image_download_urls` only rebuilds attachment
/// download URLs from the rows it already holds (no dependency call), so it is
/// not observable here.
///
/// An error from the integration is the source's uncaught refresh failure (the
/// source's `try` covers only the signing call itself, after `_media_uid()`),
/// which fails the request.
pub(crate) async fn refresh_video_result_urls(
    video_refresh: &crate::remote_workspace_status::app_state::VideoRefresh,
    task: &mut TaskRow,
    subtasks: &mut [SubtaskRow],
) -> Result<(), ApiError> {
    let payloads = video_refresh_payloads(task, subtasks);
    let mut results: Vec<_> = payloads.iter().map(OpaqueJson::to_raw_value).collect();
    let mut results: Vec<&mut _> = results.iter_mut().collect();
    video_refresh
        .extension
        .refresh_result_urls(&video_refresh.client, &mut results)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "[remote_workspace] video result URL refresh failed");
            ApiError::internal("Internal server error")
        })
}

/// `_video_blocks`' inputs (`convert_to_task_dict`'s `result` and
/// `convert_subtasks_to_dict`'s per-subtask `result`): the task-level
/// `status.result` document first, then every subtask `result` document in
/// subtask order. A document the row does not carry is JSON `null`, which
/// contributes no video block.
///
/// The documents are moved out of the rows: the refresh rewrites copies the
/// remote-workspace response discards, and nothing reads a result again after
/// this step.
fn video_refresh_payloads(task: &mut TaskRow, subtasks: &mut [SubtaskRow]) -> Vec<OpaqueJson> {
    let mut payloads = Vec::with_capacity(subtasks.len() + 1);
    payloads.push(task.take_status_result());
    for subtask in subtasks {
        payloads.push(subtask.take_result());
    }
    payloads
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_compat::OpaqueJson;
    use crate::remote_workspace_tree::task_detail::{test_subtask_with_result, test_task_row};
    use serde_json::{Value, json};

    /// `_video_blocks` walks `task["result"]["blocks"]` first and then every
    /// `task["subtasks"][i]["result"]["blocks"]`, so the signing request sees
    /// the task-level URL before the subtask URLs. This endpoint's flow must
    /// feed the extension the same payloads the sibling status flow proves.
    #[test]
    fn video_refresh_payloads_follow_task_then_subtask_order() {
        let mut task = test_task_row(json!({
            "blocks": [{"type": "video", "media_id": "1", "video_url": "http://a"}]
        }));
        let mut subtasks = vec![
            test_subtask_with_result(Some(json!({
                "blocks": [{"type": "video", "media_id": "2", "video_url": "http://b"}]
            }))),
            test_subtask_with_result(None),
            test_subtask_with_result(Some(json!({"blocks": []}))),
        ];
        let payloads: Vec<Value> = video_refresh_payloads(&mut task, &mut subtasks)
            .iter()
            .map(OpaqueJson::to_value)
            .collect();
        assert_eq!(
            payloads,
            vec![
                json!({"blocks": [{"type": "video", "media_id": "1", "video_url": "http://a"}]}),
                json!({"blocks": [{"type": "video", "media_id": "2", "video_url": "http://b"}]}),
                Value::Null,
                json!({"blocks": []}),
            ]
        );
    }

    #[test]
    fn video_refresh_payloads_keep_a_missing_task_result_as_null() {
        let mut task = test_task_row(Value::Null);
        let payloads: Vec<Value> = video_refresh_payloads(&mut task, &mut [])
            .iter()
            .map(OpaqueJson::to_value)
            .collect();
        assert_eq!(payloads, vec![Value::Null]);
    }
}
