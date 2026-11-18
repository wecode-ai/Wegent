// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[derive(Default)]
pub(super) struct GoalStatusRevision {
    generation: u64,
    mutating: bool,
}

pub(super) struct GoalStatusRead {
    revision: Arc<Mutex<GoalStatusRevision>>,
    generation: u64,
}

impl GoalStatusRead {
    pub(super) fn apply_if_current(self, update: impl FnOnce()) -> bool {
        let mut revision = self.revision.lock().expect("Goal status revision poisoned");
        if revision.mutating || revision.generation != self.generation {
            return false;
        }
        update();
        revision.generation = revision.generation.wrapping_add(1);
        true
    }
}

pub(super) struct GoalStatusMutation(Arc<Mutex<GoalStatusRevision>>);

impl Drop for GoalStatusMutation {
    fn drop(&mut self) {
        let mut revision = self.0.lock().expect("Goal status revision poisoned");
        revision.mutating = false;
        revision.generation = revision.generation.wrapping_add(1);
    }
}

impl RuntimeWorkRpcHandler {
    fn goal_status_revision(&self, task: &str) -> Arc<Mutex<GoalStatusRevision>> {
        let task = self.canonical_local_task_id(task);
        let mut revisions = self
            .goal_status_revisions
            .lock()
            .expect("Goal revision map poisoned");
        // A revision is needed only while a reader or mutation can still overlap.
        revisions.retain(|_, revision| revision.strong_count() > 0);
        if let Some(revision) = revisions.get(&task).and_then(Weak::upgrade) {
            return revision;
        }
        let revision = Arc::new(Mutex::new(GoalStatusRevision::default()));
        revisions.insert(task, Arc::downgrade(&revision));
        revision
    }

    pub(super) fn begin_goal_status_read(&self, task: &str) -> GoalStatusRead {
        let revision = self.goal_status_revision(task);
        let generation = revision
            .lock()
            .expect("Goal status revision poisoned")
            .generation;
        GoalStatusRead {
            revision,
            generation,
        }
    }

    /// The caller serializes mutations with the existing Goal status gate.
    pub(super) fn begin_goal_status_mutation(&self, task: &str) -> GoalStatusMutation {
        let revision = self.goal_status_revision(task);
        {
            let mut state = revision.lock().expect("Goal status revision poisoned");
            state.generation = state.generation.wrapping_add(1);
            state.mutating = true;
        }
        GoalStatusMutation(revision)
    }

    pub(super) fn with_goal_status_change(&self, task: &str, update: impl FnOnce(bool)) {
        let revision = self.goal_status_revision(task);
        let mut revision = revision.lock().expect("Goal status revision poisoned");
        revision.generation = revision.generation.wrapping_add(1);
        update(revision.mutating);
    }
}
