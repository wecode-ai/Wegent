// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use crate::protocol::ExecutionRequest;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCancellationSnapshot {
    pub pending_task_ids: Vec<String>,
    pub pending_subtask_ids: Vec<String>,
    pub cancel_requested_task_ids: Vec<String>,
}

#[derive(Clone, Default)]
pub(super) struct LocalCancellationRegistry {
    inner: Arc<Mutex<LocalCancellationState>>,
}

#[derive(Default)]
struct LocalCancellationState {
    registered_tasks: BTreeMap<String, RegisteredTurn>,
    pending_task_ids: BTreeSet<String>,
    pending_subtask_ids: BTreeSet<String>,
}

#[derive(Default)]
struct RegisteredTurn {
    subtask_id: String,
    cancel_requested: bool,
}

impl LocalCancellationRegistry {
    pub(super) fn register_task(&self, request: &ExecutionRequest) {
        let mut state = self.inner.lock().expect("cancellation state lock");
        let task_cancelled = state.pending_task_ids.remove(&request.task_id);
        let subtask_cancelled = state.pending_subtask_ids.remove(&request.subtask_id);
        let turn = state
            .registered_tasks
            .entry(request.task_id.clone())
            .or_default();
        if turn.subtask_id != request.subtask_id {
            turn.subtask_id.clone_from(&request.subtask_id);
            turn.cancel_requested = false;
        }
        turn.cancel_requested |= task_cancelled || subtask_cancelled;
    }

    pub(super) fn cancel_task(&self, task_id: String, subtask_id: Option<String>) {
        let mut state = self.inner.lock().expect("cancellation state lock");
        let current_turn = state.registered_tasks.get_mut(&task_id).filter(|turn| {
            subtask_id
                .as_deref()
                .map_or(true, |id| id == turn.subtask_id)
        });
        if let Some(turn) = current_turn {
            turn.cancel_requested = true;
        } else if let Some(subtask_id) = subtask_id {
            state.pending_subtask_ids.insert(subtask_id);
        } else {
            state.pending_task_ids.insert(task_id);
        }
    }

    pub(super) fn is_cancel_requested(&self, task_id: &str, subtask_id: Option<&str>) -> bool {
        let state = self.inner.lock().expect("cancellation state lock");
        state.registered_tasks.get(task_id).is_some_and(|turn| {
            turn.cancel_requested && subtask_id.map_or(true, |id| id == turn.subtask_id)
        }) || state.pending_task_ids.contains(task_id)
            || subtask_id.is_some_and(|subtask_id| state.pending_subtask_ids.contains(subtask_id))
    }

    pub(super) fn snapshot(&self) -> LocalCancellationSnapshot {
        let state = self.inner.lock().expect("cancellation state lock");
        LocalCancellationSnapshot {
            pending_task_ids: state.pending_task_ids.iter().cloned().collect(),
            pending_subtask_ids: state.pending_subtask_ids.iter().cloned().collect(),
            cancel_requested_task_ids: state
                .registered_tasks
                .iter()
                .filter(|(_, turn)| turn.cancel_requested)
                .map(|(task_id, _)| task_id.clone())
                .collect(),
        }
    }
}
