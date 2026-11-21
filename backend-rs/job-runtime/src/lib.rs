// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Job scheduling and lease lifecycle independent of application handlers.

#![forbid(unsafe_code)]

pub mod client;
pub mod config;
mod lock;
mod registry;
mod runtime;
pub use brz_schedule::{Completion, HandlerOptions, JobContext, SubmitResult};
pub use client::BackgroundJobsClient;
pub use lock::with_lock_watchdog;
pub use registry::BackgroundJobRegistry;
pub use runtime::BackgroundJobsRuntime;
