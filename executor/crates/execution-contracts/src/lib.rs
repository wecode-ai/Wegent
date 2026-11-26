// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Stable execution and IPC ports independent of transport and runtime assembly.

#![forbid(unsafe_code)]

mod contracts;
pub mod emitter;
pub mod ipc;
pub use contracts::{AgentEngine, EventSink, ExecutionOutcome, RunnerResult, TaskRunner};

pub mod command;

pub mod model_request_headers;
pub mod notification;

/// Platform dispatches carry the Team strategy in mode; persisted device
/// profiles carry it in collaboration_model. Native UI modes are independent.
pub fn is_coordinate_team(request: &wegent_protocol::ExecutionRequest) -> bool {
    ["mode", "collaboration_model"]
        .iter()
        .filter_map(|key| request.extra.get(*key)?.as_str().map(str::trim))
        .find(|mode| !mode.is_empty())
        .is_some_and(|mode| mode.eq_ignore_ascii_case("coordinate"))
}
