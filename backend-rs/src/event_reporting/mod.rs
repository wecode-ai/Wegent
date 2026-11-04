// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Best-effort knowledge-event reporting for the Rust migration runtime.
//!
//! The business Interface is [`ReporterHandle`]. Kafka, queueing, delivery
//! classification, and lifecycle ownership remain behind this deep Module.

mod config;
mod contract;
mod envelope;
mod fact;
mod generated_contract;
mod kafka;
mod metrics;
mod queue;
mod runtime;
mod transport;

pub use config::ConfigErrorCode;
pub use contract::{EventKind, EventStatus, Field};
pub use fact::{BoundedString, EntityId, FactBuildError, FactDraft, Scalar, WireInteger};
pub use metrics::ReporterCounters;
pub use runtime::{ReporterHandle, ReporterHealth, ReporterRuntime, SenderState};
