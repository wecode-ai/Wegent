// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeSet,
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
    registered_task_ids: BTreeSet<String>,
    pending_task_ids: BTreeSet<String>,
    pending_subtask_ids: BTreeSet<String>,
    cancel_requested_task_ids: BTreeSet<String>,
}

impl LocalCancellationRegistry {
    pub(super) fn register_task(&self, request: &ExecutionRequest) {
        let mut state = self.inner.lock().expect("cancellation state lock");
        state.registered_task_ids.insert(request.task_id.clone());
        let task_cancelled = state.pending_task_ids.remove(&request.task_id);
        let subtask_cancelled = state.pending_subtask_ids.remove(&request.subtask_id);
        if task_cancelled || subtask_cancelled {
            state
                .cancel_requested_task_ids
                .insert(request.task_id.clone());
        }
    }

    pub(super) fn cancel_task(&self, task_id: String, subtask_id: Option<String>) {
        let mut state = self.inner.lock().expect("cancellation state lock");
        if state.registered_task_ids.contains(&task_id) {
            state.cancel_requested_task_ids.insert(task_id);
        } else if let Some(subtask_id) = subtask_id {
            state.pending_subtask_ids.insert(subtask_id);
        } else {
            state.pending_task_ids.insert(task_id);
        }
    }

    pub(super) fn is_cancel_requested(&self, task_id: &str, subtask_id: Option<&str>) -> bool {
        let state = self.inner.lock().expect("cancellation state lock");
        state.cancel_requested_task_ids.contains(task_id)
            || state.pending_task_ids.contains(task_id)
            || subtask_id.is_some_and(|subtask_id| state.pending_subtask_ids.contains(subtask_id))
    }

    pub(super) fn snapshot(&self) -> LocalCancellationSnapshot {
        let state = self.inner.lock().expect("cancellation state lock");
        LocalCancellationSnapshot {
            pending_task_ids: state.pending_task_ids.iter().cloned().collect(),
            pending_subtask_ids: state.pending_subtask_ids.iter().cloned().collect(),
            cancel_requested_task_ids: state.cancel_requested_task_ids.iter().cloned().collect(),
        }
    }
}
