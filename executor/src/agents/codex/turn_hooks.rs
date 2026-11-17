// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{path::PathBuf, sync::Arc};

use serde_json::Value;
use tokio::sync::Mutex;
use wegent_workspace::turn_file_changes::{GitTurnRange, GitTurnSnapshot};

use crate::{
    hooks::{
        host::HookService,
        model::{HookEventName, HookUser, TurnCompletedInput},
    },
    logging::log_executor_event,
};

#[derive(Clone)]
pub struct TurnDiffHook {
    service: HookService,
    user: HookUser,
    cwd: PathBuf,
    model: Option<String>,
    permission_mode: String,
    state: Arc<Mutex<TurnDiffState>>,
}

#[derive(Default)]
struct TurnDiffState {
    snapshot: Option<GitTurnSnapshot>,
    capture_failed: bool,
    prepared: bool,
    active_turn: Option<(String, String)>,
}

impl TurnDiffState {
    async fn checkpoint(&mut self) -> Result<Option<(GitTurnRange, GitTurnSnapshot)>, String> {
        let Some(mut snapshot) = self.snapshot.take() else {
            return if self.capture_failed {
                Err("initial Git snapshot unavailable".to_owned())
            } else {
                Ok(None)
            };
        };
        let (snapshot, result) = tokio::task::spawn_blocking(move || {
            let result = snapshot.checkpoint();
            (snapshot, result)
        })
        .await
        .map_err(|error| error.to_string())?;
        self.snapshot = Some(snapshot);
        result.map(Some)
    }
}

impl TurnDiffHook {
    pub fn new(
        service: HookService,
        user: HookUser,
        cwd: PathBuf,
        model: Option<String>,
        permission_mode: String,
    ) -> Self {
        Self {
            service,
            user,
            cwd,
            model,
            permission_mode,
            state: Arc::default(),
        }
    }

    pub async fn prepare(&self) {
        let mut state = self.state.lock().await;
        self.capture_start(&mut state).await;
        state.prepared = true;
    }

    async fn capture_start(&self, state: &mut TurnDiffState) {
        let cwd = self.cwd.clone();
        let previous = state.snapshot.take();
        match tokio::task::spawn_blocking(move || {
            drop(previous);
            GitTurnSnapshot::capture(&cwd)
        })
        .await
        {
            Ok(Ok(snapshot)) => {
                state.snapshot = snapshot;
                state.capture_failed = false;
            }
            result => {
                state.snapshot = None;
                state.capture_failed = true;
                log_executor_event(
                    "turn hook initial Git snapshot failed",
                    &[("error", format!("{result:?}"))],
                );
            }
        }
    }

    pub async fn started(&self, session_id: &str, turn_id: &str) {
        let mut state = self.state.lock().await;
        if state.active_turn.is_none() {
            if !state.prepared && state.snapshot.is_none() {
                self.capture_start(&mut state).await;
            }
            state.prepared = false;
        }
        state.active_turn = Some((session_id.to_owned(), turn_id.to_owned()));
    }

    pub async fn observe(&self, root_thread_id: &str, message: &Value) {
        let params = &message["params"];
        if super::run_state::stream_thread_id(params).as_deref() != Some(root_thread_id)
            || !super::run_state::is_root_codex_turn_event(params)
        {
            return;
        }
        let Some(turn_id) = params["turn"]["id"].as_str() else {
            return;
        };
        match message["method"].as_str() {
            Some("turn/started") => self.started(root_thread_id, turn_id).await,
            Some("turn/completed") => {
                let active = self.state.lock().await.active_turn.clone();
                if active.as_ref().is_some_and(|(_, id)| id == turn_id) {
                    self.completed(params["turn"]["status"].as_str().unwrap_or("completed"))
                        .await;
                }
            }
            _ => {}
        }
    }

    pub async fn completed(&self, status: &str) {
        let mut state = self.state.lock().await;
        let Some((session_id, turn_id)) = state.active_turn.take() else {
            return;
        };
        let (range, mut next_snapshot, file_changes) = match state.checkpoint().await {
            Ok(Some((range, next))) => {
                state.capture_failed = false;
                (
                    Some(range),
                    Some(next),
                    serde_json::json!({"version": 2, "status": "pending"}),
                )
            }
            Ok(None) => return,
            Err(error) => {
                state.capture_failed = true;
                log_executor_event("turn hook final Git snapshot failed", &[("error", error)]);
                (None, None, capture_error())
            }
        };
        // Serialize baseline advancement with the durable ownership transfer.
        // Failed captures or enqueues retain the last accepted baseline.
        match self
            .service
            .enqueue_turn_completed(
                TurnCompletedInput {
                    event_id: String::new(),
                    sequence: 0,
                    user: self.user.clone(),
                    session_id,
                    turn_id,
                    cwd: self.cwd.clone(),
                    hook_event_name: HookEventName::TurnCompleted,
                    model: self.model.clone(),
                    permission_mode: self.permission_mode.clone(),
                    status: status.to_owned(),
                    file_changes,
                },
                range,
            )
            .await
        {
            Ok(_) => {
                if let Some(next) = next_snapshot.take() {
                    let previous = state.snapshot.replace(next);
                    tokio::task::spawn_blocking(move || drop(previous));
                }
            }
            Err(error) => {
                tokio::task::spawn_blocking(move || drop(next_snapshot));
                log_executor_event("turn hook durable enqueue failed", &[("error", error)]);
            }
        }
    }
}

fn capture_error() -> Value {
    serde_json::json!({"version": 2, "status": "error", "file_count": 0,
        "additions": 0, "deletions": 0, "error": "Git turn boundary capture failed"})
}

#[cfg(test)]
#[path = "turn_hooks_tests.rs"]
mod tests;
