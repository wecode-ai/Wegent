// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Native work can outlive the local request that originally admitted it.
#[derive(Default)]
pub(super) struct CodexNativeActivity {
    loaded_threads: HashSet<String>,
    turns: HashMap<String, HashSet<String>>,
    settled_turns: HashMap<String, HashSet<String>>,
    goals: HashMap<String, GoalActivity>,
}

struct GoalResponse {
    request_id: u64,
    active: bool,
}

#[derive(Default)]
struct GoalActivity {
    // Native updates invalidate responses registered against an earlier observation.
    observation: u64,
    response: Option<GoalResponse>,
    // Persisted Goal configuration alone does not establish execution in this process.
    active: bool,
    // Successful turns retain continuation eligibility until a Goal or turn terminal ends it.
    native_work: bool,
}

impl GoalActivity {
    fn is_busy(&self) -> bool {
        self.active && self.native_work
    }

    fn observe_native(&mut self, active: bool, loaded: bool) -> bool {
        let was_busy = self.is_busy();
        self.observation += 1;
        self.response = None;
        self.active = active;
        self.native_work = active && loaded;
        was_busy != self.is_busy()
    }

    fn observe_response(
        &mut self,
        response: GoalResponse,
        observation: u64,
        starts_work: bool,
        turn_running: bool,
    ) -> bool {
        if self.observation != observation {
            return false;
        }
        let active = response.active;
        if let Some(last) = &self.response {
            if response.request_id < last.request_id {
                // A newer active read can confirm a pending set without starting work itself.
                if !(starts_work && response.active && last.active) {
                    return false;
                }
            } else {
                self.response = Some(response);
            }
        } else {
            self.response = Some(response);
        }
        let was_busy = self.is_busy();
        self.active = active;
        self.native_work = active && (self.native_work || starts_work || turn_running);
        was_busy != self.is_busy()
    }
}

impl CodexNativeActivity {
    pub(super) fn observe(&mut self, message: &Value) -> bool {
        let method = message["method"].as_str().unwrap_or_default();
        if method == "codex/app-server/exited" {
            let changed = !self.turns.is_empty() || self.goals.values().any(GoalActivity::is_busy);
            self.turns.clear();
            self.settled_turns.clear();
            self.goals.clear();
            self.loaded_threads.clear();
            return changed;
        }
        let params = message_params(message);
        let Some(thread_id) = stream_thread_id(params) else {
            return false;
        };
        match method {
            "thread/started" => {
                self.loaded_threads.insert(thread_id);
                false
            }
            "thread/status/changed" => {
                match params.pointer("/status/type").and_then(Value::as_str) {
                    Some("notLoaded") => {
                        self.loaded_threads.remove(&thread_id);
                        return self.observe_goal(&thread_id, false);
                    }
                    Some("idle" | "active" | "systemError") => {
                        self.loaded_threads.insert(thread_id);
                    }
                    _ => {}
                }
                false
            }
            "turn/started" => turn_start_response_id(params)
                .is_some_and(|turn_id| self.start_turn(thread_id, turn_id)),
            "turn/completed" => self.complete_turn(&thread_id, params),
            "thread/goal/updated" => match params.pointer("/goal/status").and_then(Value::as_str) {
                Some(status) => {
                    self.observe_goal(&thread_id, status.eq_ignore_ascii_case("active"))
                }
                None => false,
            },
            "thread/goal/cleared" => self.observe_goal(&thread_id, false),
            "thread/closed" => {
                self.loaded_threads.remove(&thread_id);
                let turns = self.turns.remove(&thread_id).is_some();
                self.settled_turns.remove(&thread_id);
                self.observe_goal(&thread_id, false) || turns
            }
            _ => false,
        }
    }

    fn complete_turn(&mut self, thread_id: &str, params: &Value) -> bool {
        let Some(turn_id) = turn_start_response_id(params) else {
            return false;
        };
        let first_terminal = self
            .settled_turns
            .entry(thread_id.to_owned())
            .or_default()
            .insert(turn_id.clone());
        let changed = self
            .turns
            .get_mut(thread_id)
            .is_some_and(|turns| turns.remove(&turn_id));
        let no_live_turns = self.turns.get(thread_id).map_or(true, HashSet::is_empty);
        let mut goal_changed = false;
        if no_live_turns {
            self.turns.remove(thread_id);
            if first_terminal
                && matches!(
                    params.get("turn").unwrap_or(params)["status"].as_str(),
                    Some("failed" | "interrupted" | "cancelled")
                )
            {
                goal_changed = self.observe_goal(thread_id, false);
            }
        }
        changed || goal_changed
    }

    fn start_turn(&mut self, thread_id: String, turn_id: String) -> bool {
        if turn_id.trim().is_empty()
            || self
                .settled_turns
                .get(&thread_id)
                .is_some_and(|turns| turns.contains(&turn_id))
        {
            return false;
        }
        let started = self
            .turns
            .entry(thread_id.clone())
            .or_default()
            .insert(turn_id);
        if started {
            self.loaded_threads.insert(thread_id.clone());
            self.goals.entry(thread_id).or_default().native_work = true;
        }
        started
    }

    pub(super) fn observe_response(
        &mut self,
        request: &CodexNativeRequest,
        response: &Value,
    ) -> bool {
        match request {
            CodexNativeRequest::LoadThread => {
                if let Some(thread_id) = stream_thread_id(response) {
                    self.loaded_threads.insert(thread_id);
                }
                false
            }
            CodexNativeRequest::Turn(thread_id) => turn_start_response_id(response)
                .is_some_and(|turn_id| self.start_turn(thread_id.clone(), turn_id)),
            CodexNativeRequest::Goal {
                thread_id,
                observation,
                request_id,
                starts_work,
            } => {
                let status = response.pointer("/goal/status").and_then(Value::as_str);
                let active = status.is_some_and(|status| status.eq_ignore_ascii_case("active"));
                if status.is_none() && !response.get("goal").is_some_and(Value::is_null) {
                    return false;
                }
                self.observe_goal_response(
                    thread_id,
                    GoalResponse {
                        request_id: *request_id,
                        active,
                    },
                    *observation,
                    *starts_work,
                )
            }
            CodexNativeRequest::ClearGoal {
                thread_id,
                observation,
                request_id,
            } => self.observe_goal_response(
                thread_id,
                GoalResponse {
                    request_id: *request_id,
                    active: false,
                },
                *observation,
                false,
            ),
        }
    }

    fn observe_goal_response(
        &mut self,
        thread_id: &str,
        response: GoalResponse,
        observation: u64,
        starts_work: bool,
    ) -> bool {
        let turn_running = self.has_active_turn(thread_id);
        self.goals
            .entry(thread_id.to_owned())
            .or_default()
            .observe_response(response, observation, starts_work, turn_running)
    }

    fn observe_goal(&mut self, thread_id: &str, active: bool) -> bool {
        let loaded = self.loaded_threads.contains(thread_id);
        self.goals
            .entry(thread_id.to_owned())
            .or_default()
            .observe_native(active, loaded)
    }

    fn goal_observation(&self, thread_id: &str) -> u64 {
        self.goals
            .get(thread_id)
            .map(|goal| goal.observation)
            .unwrap_or_default()
    }

    pub(super) fn request_context(
        &self,
        request_id: u64,
        method: &str,
        params: &Value,
    ) -> Option<CodexNativeRequest> {
        if matches!(method, "thread/start" | "thread/resume" | "thread/fork") {
            return Some(CodexNativeRequest::LoadThread);
        }
        let thread_id = stream_thread_id(params)?;
        let observation = self.goal_observation(&thread_id);
        match method {
            "turn/start" => Some(CodexNativeRequest::Turn(thread_id)),
            "thread/goal/set" | "thread/goal/get" => Some(CodexNativeRequest::Goal {
                observation,
                request_id,
                // A cold Goal mutation persists metadata without loading the session.
                starts_work: method == "thread/goal/set"
                    && self.loaded_threads.contains(&thread_id),
                thread_id,
            }),
            "thread/goal/clear" => Some(CodexNativeRequest::ClearGoal {
                thread_id,
                observation,
                request_id,
            }),
            _ => None,
        }
    }

    pub(super) fn active_threads(&self) -> HashMap<String, usize> {
        let mut active: HashMap<_, _> = self
            .turns
            .iter()
            .map(|(thread_id, turns)| (thread_id.clone(), turns.len()))
            .collect();
        for (thread_id, goal) in &self.goals {
            if goal.is_busy() {
                active.entry(thread_id.clone()).or_insert(1);
            }
        }
        active
    }

    fn has_active_turn(&self, thread_id: &str) -> bool {
        self.turns
            .get(thread_id)
            .is_some_and(|turns| !turns.is_empty())
    }
}

pub(super) enum CodexNativeRequest {
    LoadThread,
    Turn(String),
    Goal {
        thread_id: String,
        observation: u64,
        request_id: u64,
        starts_work: bool,
    },
    ClearGoal {
        thread_id: String,
        observation: u64,
        request_id: u64,
    },
}

impl CodexAppServerSharedState {
    pub(super) fn renew_thread_generation(&mut self, thread_id: &str) {
        let generation = self.next_thread_generation;
        self.next_thread_generation += 1;
        self.thread_generations
            .insert(thread_id.to_owned(), generation);
        self.idle_thread_generations.remove(thread_id);
    }

    pub(super) fn thread_has_active_turn(&self, thread_id: &str) -> bool {
        self.active_threads.get(thread_id).copied().unwrap_or(0) > 0
            || self.thread_has_native_turn(thread_id)
    }

    pub(super) fn thread_has_native_turn(&self, thread_id: &str) -> bool {
        self.process.as_ref().is_some_and(|process| {
            process
                .notifications
                .native_activity
                .lock()
                .expect("Codex native activity registry should not be poisoned")
                .has_active_turn(thread_id)
        })
    }

    pub(super) fn protected_turn_count(&self) -> usize {
        // Preparation owns the shared process before a native thread can be tracked.
        self.active_threads_snapshot().values().sum::<usize>() + self.preparing_turns.count()
    }

    pub(super) fn active_threads_snapshot(&self) -> HashMap<String, usize> {
        let mut active = self.active_threads.clone();
        if let Some(process) = &self.process {
            let native = process
                .notifications
                .native_activity
                .lock()
                .expect("Codex native activity registry should not be poisoned")
                .active_threads();
            for (thread_id, count) in native {
                let entry = active.entry(thread_id).or_default();
                *entry = (*entry).max(count);
            }
        }
        active
    }
}

#[cfg(test)]
#[path = "native_activity_tests.rs"]
mod tests;
