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

pub mod notification;
