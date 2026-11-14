// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Preserve summary checkpoints while bounding every lineage payload read.

use super::chat_history::{ForkHistoryItem, resolve_lineage};
use crate::chat_repository::ChatHistoryRepository;
use crate::internal_auth::http_error::HttpError;
use crate::task_store::SubtaskHistoryWindow;
use wegent_task_store::task_store_history::HistorySelection;

type LineageNode = (i64, Option<i64>, Option<i64>);

pub(super) fn history_key(item: &ForkHistoryItem) -> (i32, Option<chrono::NaiveDateTime>, i64) {
    (
        item.subtask.message_id,
        item.subtask.created_at,
        item.subtask.id,
    )
}

pub(super) fn lineage_before(before: Option<i64>, cutoff: Option<i64>) -> Option<i64> {
    match (before, cutoff.and_then(|value| value.checked_add(1))) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    }
}

async fn read_window(
    repository: &ChatHistoryRepository<'_>,
    lineage: &[LineageNode],
    before_message_id: Option<i64>,
    limit: i64,
    summary_checkpoint_only: bool,
) -> Result<Vec<ForkHistoryItem>, HttpError> {
    let mut candidates = Vec::new();
    for (task_id, owner, cutoff) in lineage {
        let rows = repository
            .list_history_candidates(
                *task_id,
                owner.unwrap_or_default(),
                SubtaskHistoryWindow {
                    limit,
                    before_message_id: lineage_before(before_message_id, *cutoff),
                    summary_checkpoint_only,
                    selection: HistorySelection::Ready,
                },
            )
            .await
            .map_err(HttpError::internal)?;
        candidates.extend(rows.into_iter().map(|row| (row, *task_id, *owner)));
    }
    candidates.sort_by_key(|(row, _, _)| row.key());
    let start = candidates.len().saturating_sub(limit as usize);
    let mut selected = std::collections::BTreeMap::new();
    for (row, task, owner) in candidates.into_iter().skip(start) {
        selected
            .entry((task, owner))
            .or_insert_with(Vec::new)
            .push(row.id);
    }
    let mut items = Vec::new();
    for ((task, owner), ids) in selected {
        let rows = repository
            .load_history_payloads(task, owner.unwrap_or_default(), &ids)
            .await
            .map_err(HttpError::internal)?;
        items.extend(rows.into_iter().map(|subtask| ForkHistoryItem { subtask }));
    }
    items.sort_by_key(history_key);
    Ok(items)
}

pub(super) fn keep_checkpoint(
    checkpoint: ForkHistoryItem,
    mut recent: Vec<ForkHistoryItem>,
) -> Vec<ForkHistoryItem> {
    let key = history_key(&checkpoint);
    recent.retain(|item| history_key(item) > key);
    recent.insert(0, checkpoint);
    recent
}

pub(super) async fn resolve_bounded_history(
    repository: &ChatHistoryRepository<'_>,
    task_id: i64,
    user_id: i32,
    before_message_id: Option<i64>,
    limit: i64,
    from_latest_compaction: bool,
) -> Result<Vec<ForkHistoryItem>, HttpError> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let lineage = resolve_lineage(repository, task_id, user_id).await?;
    let checkpoint = if from_latest_compaction {
        read_window(repository, &lineage, before_message_id, 1, true)
            .await?
            .pop()
    } else {
        None
    };
    if let Some(checkpoint) = checkpoint {
        if limit == 1 {
            return Ok(vec![checkpoint]);
        }
        let recent = read_window(repository, &lineage, before_message_id, limit - 1, false).await?;
        Ok(keep_checkpoint(checkpoint, recent))
    } else {
        read_window(repository, &lineage, before_message_id, limit, false).await
    }
}
