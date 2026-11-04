// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Native work can outlive the local request that originally admitted it.
#[derive(Default)]
pub(super) struct CodexNativeActivity {
    turns: HashMap<String, HashSet<String>>,
    settled_turns: HashMap<String, HashSet<String>>,
    active_goals: HashSet<String>,
    goal_observations: HashMap<String, u64>,
    goal_responses: HashMap<String, u64>,
}

impl CodexNativeActivity {
    pub(super) fn observe(&mut self, message: &Value) -> bool {
        let method = message["method"].as_str().unwrap_or_default();
        if method == "codex/app-server/exited" {
            let changed = !self.turns.is_empty() || !self.active_goals.is_empty();
            self.turns.clear();
            self.settled_turns.clear();
            self.active_goals.clear();
            self.goal_observations.clear();
            self.goal_responses.clear();
            return changed;
        }
        let params = message_params(message);
        let Some(thread_id) = stream_thread_id(params) else {
            return false;
        };
        match method {
            "turn/started" => turn_start_response_id(params)
                .is_some_and(|turn_id| self.start_turn(thread_id, turn_id)),
            "turn/completed" => self.complete_turn(&thread_id, params),
            "thread/goal/updated" => match params.pointer("/goal/status").and_then(Value::as_str) {
                Some(status) => {
                    self.advance_goal_observation(&thread_id);
                    if status.eq_ignore_ascii_case("active") {
                        self.active_goals.insert(thread_id)
                    } else {
                        self.active_goals.remove(&thread_id)
                    }
                }
                None => false,
            },
            "thread/goal/cleared" => {
                self.advance_goal_observation(&thread_id);
                self.active_goals.remove(&thread_id)
            }
            "thread/closed" => {
                let turns = self.turns.remove(&thread_id).is_some();
                self.settled_turns.remove(&thread_id);
                self.advance_goal_observation(&thread_id);
                self.active_goals.remove(&thread_id) || turns
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
                self.advance_goal_observation(thread_id);
                goal_changed = self.active_goals.remove(thread_id);
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
        self.turns.entry(thread_id).or_default().insert(turn_id)
    }

    pub(super) fn observe_response(
        &mut self,
        request: &CodexNativeRequest,
        response: &Value,
    ) -> bool {
        match request {
            CodexNativeRequest::Turn(thread_id) => turn_start_response_id(response)
                .is_some_and(|turn_id| self.start_turn(thread_id.clone(), turn_id)),
            CodexNativeRequest::Goal {
                thread_id,
                observation,
                request_id,
            } => {
                let status = response.pointer("/goal/status").and_then(Value::as_str);
                if (status.is_none() && !response.get("goal").is_some_and(Value::is_null))
                    || !self.accept_goal_response(thread_id, *observation, *request_id)
                {
                    return false;
                }
                if status.is_some_and(|status| status.eq_ignore_ascii_case("active")) {
                    self.active_goals.insert(thread_id.clone())
                } else {
                    self.active_goals.remove(thread_id)
                }
            }
            CodexNativeRequest::ClearGoal {
                thread_id,
                observation,
                request_id,
            } => {
                self.accept_goal_response(thread_id, *observation, *request_id)
                    && self.active_goals.remove(thread_id)
            }
        }
    }

    fn accept_goal_response(&mut self, thread_id: &str, observation: u64, request_id: u64) -> bool {
        if self.goal_observation(thread_id) != observation
            || self
                .goal_responses
                .get(thread_id)
                .is_some_and(|last| request_id < *last)
        {
            return false;
        }
        self.goal_responses.insert(thread_id.to_owned(), request_id);
        true
    }

    fn advance_goal_observation(&mut self, thread_id: &str) {
        *self
            .goal_observations
            .entry(thread_id.to_owned())
            .or_default() += 1;
    }

    fn goal_observation(&self, thread_id: &str) -> u64 {
        self.goal_observations
            .get(thread_id)
            .copied()
            .unwrap_or_default()
    }

    pub(super) fn request_context(
        &self,
        request_id: u64,
        method: &str,
        params: &Value,
    ) -> Option<CodexNativeRequest> {
        let thread_id = stream_thread_id(params)?;
        let observation = self.goal_observation(&thread_id);
        match method {
            "turn/start" => Some(CodexNativeRequest::Turn(thread_id)),
            "thread/goal/set" | "thread/goal/get" => Some(CodexNativeRequest::Goal {
                thread_id,
                observation,
                request_id,
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
        for thread_id in &self.active_goals {
            active.entry(thread_id.clone()).or_insert(1);
        }
        active
    }
}

pub(super) enum CodexNativeRequest {
    Turn(String),
    Goal {
        thread_id: String,
        observation: u64,
        request_id: u64,
    },
    ClearGoal {
        thread_id: String,
        observation: u64,
        request_id: u64,
    },
}

impl CodexAppServerSharedState {
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
