// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::util::runtime_origin;
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum RuntimeTaskKind {
    Personal,
    StandIn,
    Agent,
}

impl SpawnTurnRequest {
    pub(super) fn task_kind(&self) -> RuntimeTaskKind {
        self.task_kind.unwrap_or_else(|| {
            RuntimeTaskKind::from_origin(self.request.extra.get("origin").unwrap_or(&Value::Null))
        })
    }

    pub(super) fn bind_task_kind(&mut self, store: &RuntimeWorkStore) {
        if self.task_kind.is_some() {
            return;
        }
        let origin = store
            .get_task_summary(&self.local_task_id)
            .and_then(|link| {
                let origin = runtime_origin(&link.runtime_handle).cloned();
                if !link
                    .runtime_handle
                    .get("origin")
                    .is_some_and(Value::is_object)
                {
                    if let Some(origin) = origin.as_ref() {
                        store.update_task(&self.local_task_id, |task| {
                            if let Some(handle) = task.runtime_handle.as_object_mut() {
                                handle.insert("origin".into(), origin.clone());
                            }
                        });
                    }
                }
                restore_origin(&mut self.request, &link.runtime_handle);
                origin
            });
        self.task_kind = Some(
            origin
                .as_ref()
                .map(RuntimeTaskKind::from_origin)
                .unwrap_or_else(|| self.task_kind()),
        );
    }
}

impl RuntimeTaskKind {
    fn from_origin(origin: &Value) -> Self {
        // The execution owner takes precedence over the trigger (Issue, timer, etc.).
        if origin["initiatedBy"] == "stand_in"
            || matches!(
                origin["type"].as_str(),
                Some(
                    "stand_in_identity"
                        | "stand_in_coordinator"
                        | "stand_in_task"
                        | "stand_in_schedule"
                        | "connection_work"
                        | "dingtalk_work"
                )
            )
        {
            RuntimeTaskKind::StandIn
        } else if (matches!(
            origin["type"].as_str(),
            Some("board_task" | "board_comment")
        ) && origin
            .get("executionId")
            .or_else(|| origin.get("execution_id"))
            .is_some_and(|id| !id.is_null()))
            || origin["initiatedBy"] == "project_coordinator"
            || origin
                .get("project_coordination")
                .is_some_and(Value::is_object)
            || matches!(
                origin["type"].as_str(),
                Some("project_coordinator" | "issue_dispatch" | "project_automation")
            )
        {
            RuntimeTaskKind::Agent
        } else {
            RuntimeTaskKind::Personal
        }
    }
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", from = "StoredRuntimeSettings")]
pub(super) struct RuntimeSettings {
    pub(super) max_concurrent_tasks: usize,
    pub(super) max_concurrent_stand_in_tasks: usize,
    pub(super) max_concurrent_agent_tasks: usize,
}

#[derive(Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredRuntimeSettings {
    max_concurrent_tasks: Option<usize>,
    max_concurrent_stand_in_tasks: Option<usize>,
    max_concurrent_agent_tasks: Option<usize>,
}

impl From<StoredRuntimeSettings> for RuntimeSettings {
    fn from(stored: StoredRuntimeSettings) -> Self {
        let initial = stored
            .max_concurrent_tasks
            .unwrap_or(DEFAULT_MAX_CONCURRENT_TASKS);
        Self {
            max_concurrent_tasks: initial,
            max_concurrent_stand_in_tasks: stored.max_concurrent_stand_in_tasks.unwrap_or(initial),
            max_concurrent_agent_tasks: stored.max_concurrent_agent_tasks.unwrap_or(initial),
        }
        .normalized()
    }
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self::uniform(DEFAULT_MAX_CONCURRENT_TASKS)
    }
}

impl RuntimeSettings {
    pub(super) fn uniform(limit: usize) -> Self {
        Self {
            max_concurrent_tasks: limit,
            max_concurrent_stand_in_tasks: limit,
            max_concurrent_agent_tasks: limit,
        }
    }

    pub(super) fn normalized(mut self) -> Self {
        self.max_concurrent_tasks = self
            .max_concurrent_tasks
            .clamp(MIN_MAX_CONCURRENT_TASKS, MAX_MAX_CONCURRENT_TASKS);
        self.max_concurrent_stand_in_tasks = self
            .max_concurrent_stand_in_tasks
            .clamp(MIN_MAX_CONCURRENT_TASKS, MAX_MAX_CONCURRENT_TASKS);
        self.max_concurrent_agent_tasks = self
            .max_concurrent_agent_tasks
            .clamp(MIN_MAX_CONCURRENT_TASKS, MAX_MAX_CONCURRENT_TASKS);
        self
    }

    pub(super) fn limit(&self, kind: RuntimeTaskKind) -> usize {
        match kind {
            RuntimeTaskKind::Personal => self.max_concurrent_tasks,
            RuntimeTaskKind::StandIn => self.max_concurrent_stand_in_tasks,
            RuntimeTaskKind::Agent => self.max_concurrent_agent_tasks,
        }
    }

    pub(super) fn total_limit(&self) -> usize {
        self.max_concurrent_tasks
            + self.max_concurrent_stand_in_tasks
            + self.max_concurrent_agent_tasks
    }
}

#[derive(Clone)]
pub(super) struct RuntimeTurnScheduler {
    pub(super) settings: RuntimeSettings,
    pub(super) active_task_ids: HashMap<String, RuntimeTaskKind>,
    pub(super) queued_turns: VecDeque<SpawnTurnRequest>,
    waiting_automatic_task_ids: HashSet<String>,
}

impl RuntimeTurnScheduler {
    pub(super) fn new(settings: RuntimeSettings, queued_turns: VecDeque<SpawnTurnRequest>) -> Self {
        Self {
            settings,
            active_task_ids: HashMap::new(),
            queued_turns,
            waiting_automatic_task_ids: HashSet::new(),
        }
    }

    pub(super) fn active(&self, kind: RuntimeTaskKind) -> usize {
        self.active_task_ids
            .values()
            .filter(|value| **value == kind)
            .count()
    }

    pub(super) fn queued(&self, kind: RuntimeTaskKind) -> usize {
        self.queued_turns
            .iter()
            .filter(|turn| turn.task_kind() == kind)
            .count()
    }

    pub(super) fn available(&self, kind: RuntimeTaskKind) -> usize {
        self.settings
            .limit(kind)
            .saturating_sub(self.active(kind) + self.ready_queued_turns(kind).count())
    }

    pub(super) fn has_capacity(&self, turn: &SpawnTurnRequest) -> bool {
        super::quota_recovery::is_ready(turn, now_ms())
            && self.active(turn.task_kind()) < self.settings.limit(turn.task_kind())
            && !self.active_task_ids.contains_key(&turn.local_task_id)
    }

    fn ready_queued_turns(&self, kind: RuntimeTaskKind) -> impl Iterator<Item = &SpawnTurnRequest> {
        let now = now_ms();
        self.queued_turns.iter().filter(move |turn| {
            turn.task_kind() == kind && super::quota_recovery::is_ready(turn, now)
        })
    }

    pub(super) fn has_ready_queued_kind(&self, kind: RuntimeTaskKind) -> bool {
        self.ready_queued_turns(kind).next().is_some()
    }

    pub(super) fn refresh_automatic_waits(
        &mut self,
        store: &RuntimeWorkStore,
        incoming: Option<&str>,
    ) {
        self.waiting_automatic_task_ids = self
            .queued_turns
            .iter()
            .map(|turn| turn.local_task_id.as_str())
            .chain(incoming)
            .filter(|id| {
                store.get_task_summary(id).is_some_and(|link| {
                    link.interaction_status
                        .as_deref()
                        .is_some_and(|status| !status.is_empty())
                })
            })
            .map(str::to_owned)
            .collect();
    }

    fn automatic_waits(&self, turn: &SpawnTurnRequest) -> bool {
        turn.request.extra.get("standInAutomatic") == Some(&Value::Bool(true))
            && self
                .waiting_automatic_task_ids
                .contains(&turn.local_task_id)
    }

    pub(super) fn enqueue(&mut self, turn: SpawnTurnRequest) -> Option<SpawnTurnRequest> {
        if !self.has_capacity(&turn)
            || self.automatic_waits(&turn)
            || self.has_ready_queued_kind(turn.task_kind())
        {
            self.queued_turns.push_back(turn);
            return None;
        }
        Some(self.enqueue_forced(turn))
    }

    pub(super) fn enqueue_forced(&mut self, turn: SpawnTurnRequest) -> SpawnTurnRequest {
        self.active_task_ids
            .insert(turn.local_task_id.clone(), turn.task_kind());
        turn
    }

    pub(super) fn enqueue_queued(&mut self, turn: SpawnTurnRequest) {
        self.queued_turns.push_back(turn);
    }

    pub(super) fn queued_position(&self, local_task_id: &str) -> Option<usize> {
        self.queued_turns
            .iter()
            .position(|turn| turn.local_task_id == local_task_id)
    }

    pub(super) fn reordered_queue(
        &self,
        local_task_id: &str,
        target_position: usize,
    ) -> Result<VecDeque<SpawnTurnRequest>, &'static str> {
        let current_position = self
            .queued_position(local_task_id)
            .ok_or("runtime task is not queued")?;
        let mut reordered = self.queued_turns.clone();
        let turn = reordered
            .remove(current_position)
            .ok_or("queued runtime task disappeared")?;
        reordered.insert(target_position.saturating_sub(1).min(reordered.len()), turn);
        Ok(reordered)
    }

    pub(super) fn finish(&mut self, local_task_id: &str) -> Vec<SpawnTurnRequest> {
        self.active_task_ids.remove(local_task_id);
        self.take_available()
    }

    pub(super) fn force_start(&mut self, local_task_id: &str) -> Option<SpawnTurnRequest> {
        let position = self.queued_position(local_task_id)?;
        if self.automatic_waits(&self.queued_turns[position]) {
            return None;
        }
        let turn = self.queued_turns.remove(position)?;
        Some(self.enqueue_forced(turn))
    }

    pub(super) fn update_limits(&mut self, settings: RuntimeSettings) -> Vec<SpawnTurnRequest> {
        self.settings = settings;
        self.take_available()
    }

    pub(super) fn take_available(&mut self) -> Vec<SpawnTurnRequest> {
        let mut turns = Vec::new();
        while let Some(position) = self
            .queued_turns
            .iter()
            .position(|turn| self.has_capacity(turn) && !self.automatic_waits(turn))
        {
            let turn = self
                .queued_turns
                .remove(position)
                .expect("queued turn exists");
            turns.push(self.enqueue_forced(turn));
        }
        turns
    }

    pub(super) fn capacity(&self, kind: RuntimeTaskKind) -> Value {
        let ids = self
            .active_task_ids
            .iter()
            .filter(|(_, value)| **value == kind)
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        json!({"limit": self.settings.limit(kind), "active": ids.len(), "active_task_ids": ids, "queued": self.queued(kind)})
    }
}

#[cfg(test)]
#[path = "concurrency_tests.rs"]
mod tests;
