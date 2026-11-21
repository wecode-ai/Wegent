// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Runtime state shared across execution entrypoints.

#![forbid(unsafe_code)]

use wegent_backend_config as config;

#[cfg(test)]
mod block_read_tests;
pub mod delivery;
pub mod dispatch_queue;
pub mod session;
pub mod stream_state;
pub mod task_run_metric_hooks;
pub mod task_run_metrics;
