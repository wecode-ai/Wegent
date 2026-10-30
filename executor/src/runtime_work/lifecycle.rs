// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::{events::next_runtime_event_sequence, response::RuntimeTaskLink, util::now_ms};
use serde_json::json;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeExecutionPhase {
    Queued,
    Starting,
    Running,
    Continuing,
    Recovering,
    Stopping,
    Idle,
}

impl NativeExecutionPhase {
    pub(crate) fn awaits_admission(self) -> bool {
        matches!(self, Self::Queued | Self::Recovering)
    }
}

/// Native thread notifications own execution state, independently of RPC lifetimes.
/// The version is a decimal string because the event sequence exceeds JS integer precision.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeExecutionState {
    pub revision: String,
    pub epoch: String,
    pub updated_at: i64,
    pub native_sequence: u64,
    pub phase: NativeExecutionPhase,
    pub turn_id: Option<String>,
    pub latest_turn_id: Option<String>,
    pub outcome: Option<String>,
    pub execution_outcome: Option<String>,
    pub request_turn_id: Option<String>,
    pub continuation: bool,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
}

pub(crate) fn native_execution_state(link: &RuntimeTaskLink) -> Option<NativeExecutionState> {
    let state = link.execution_state.clone()?;
    (state.epoch == native_execution_epoch()).then_some(state)
}

pub(crate) fn native_execution_epoch() -> &'static str {
    static EPOCH: OnceLock<String> = OnceLock::new();
    EPOCH.get_or_init(|| next_runtime_event_sequence().to_string())
}

pub(crate) fn settle_native_execution(link: &mut RuntimeTaskLink, outcome: &str) {
    let Some(mut state) = native_execution_state(link) else {
        return;
    };
    state.revision = next_runtime_event_sequence().to_string();
    state.phase = NativeExecutionPhase::Idle;
    if state.turn_id.is_some() {
        state.outcome = Some(outcome.into());
    }
    state.turn_id = None;
    state.execution_outcome = Some(outcome.into());
    state.updated_at = now_ms();
    state.completed_at = Some(state.updated_at);
    project_native_execution(link, &state);
}

pub(crate) fn begin_native_request(link: &mut RuntimeTaskLink) {
    if link.runtime != "codex" {
        return;
    }
    let previous = native_execution_state(link);
    if previous.as_ref().is_some_and(|state| {
        state.phase != NativeExecutionPhase::Idle && !state.phase.awaits_admission()
    }) {
        return;
    }
    let state = NativeExecutionState {
        revision: next_runtime_event_sequence().to_string(),
        epoch: native_execution_epoch().into(),
        updated_at: now_ms(),
        native_sequence: previous.as_ref().map_or(0, |state| state.native_sequence),
        phase: NativeExecutionPhase::Starting,
        turn_id: None,
        latest_turn_id: previous.and_then(|state| state.latest_turn_id),
        outcome: None,
        execution_outcome: None,
        request_turn_id: None,
        continuation: false,
        started_at: None,
        completed_at: None,
        duration_ms: None,
        error: None,
    };
    project_native_execution(link, &state);
}

pub(crate) fn queue_native_execution(
    link: &mut RuntimeTaskLink,
    position: usize,
    recovering: bool,
) {
    let phase = if recovering {
        NativeExecutionPhase::Recovering
    } else {
        NativeExecutionPhase::Queued
    };
    if native_execution_state(link).is_some_and(|state| {
        state.phase != NativeExecutionPhase::Idle && !state.phase.awaits_admission()
    }) {
        return;
    }
    if link
        .execution_state
        .as_ref()
        .is_some_and(|state| state.phase == phase)
        && link.runtime_handle["queuePosition"].as_u64() == Some(position as u64 + 1)
    {
        return;
    }
    if native_execution_state(link).is_none() {
        begin_native_request(link);
    }
    let Some(mut state) = native_execution_state(link) else {
        return;
    };
    state.revision = next_runtime_event_sequence().to_string();
    state.phase = phase;
    state.execution_outcome = None;
    state.request_turn_id = None;
    state.continuation = false;
    state.updated_at = now_ms();
    link.runtime_handle["queuePosition"] = json!(position + 1);
    project_native_execution(link, &state);
}

pub(crate) fn project_native_execution(link: &mut RuntimeTaskLink, state: &NativeExecutionState) {
    if link.status == "archived" {
        return;
    }
    link.execution_state = Some(state.clone());
    if let Some(turn_id) = &state.latest_turn_id {
        link.runtime_handle["lastTurnId"] = json!(turn_id);
    }
    let queued = state.phase.awaits_admission();
    if !queued {
        if let Some(handle) = link.runtime_handle.as_object_mut() {
            handle.remove("queuePosition");
        }
    }
    link.running = state.phase != NativeExecutionPhase::Idle && !queued;
    link.status = if queued {
        "queued"
    } else if link.running {
        "running"
    } else {
        match state
            .execution_outcome
            .as_deref()
            .or(state.outcome.as_deref())
        {
            Some("failed") => "failed",
            Some("cancelled") => "cancelled",
            _ => "done",
        }
    }
    .to_owned();
    link.thread_status = if link.running { "active" } else { "idle" }.into();
    link.turn_status = Some(
        if state.turn_id.is_some() {
            "inProgress"
        } else {
            match state.outcome.as_deref() {
                Some("failed") => "failed",
                Some("cancelled") => "interrupted",
                _ => "completed",
            }
        }
        .into(),
    );
    link.updated_at = link.updated_at.max(state.updated_at);
    link.completed_at = (state.phase == NativeExecutionPhase::Idle).then_some(state.updated_at);
}
