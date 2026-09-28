// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/remote-workspace/tree` and
//! `GET /api/tasks/{task_id}/remote-workspace/file`.

pub mod auth;
pub mod config;
pub mod error;
pub mod executor_binding;
pub mod file;
pub mod kind_refs;
pub mod kinds;
pub mod py_set_order;
pub mod task_detail;
pub mod task_store;
pub mod user_cache;

mod handler;

pub use handler::{Deps, build_deps};
