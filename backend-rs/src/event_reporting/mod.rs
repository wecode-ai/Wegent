// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Lightweight, best-effort reporting for Rust-owned knowledge document reads.

mod config;
mod document_read;
mod kafka;
mod runtime;
mod transport;

pub use config::ConfigErrorCode;
pub use document_read::{DocumentReadEvent, DocumentReadOutcome};
pub use runtime::{ReporterHandle, ReporterHealth, ReporterRuntime, SenderState};
