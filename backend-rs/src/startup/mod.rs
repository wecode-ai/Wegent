// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application-owned client construction and concrete HTTP dependency types.
//!
//! Feature modules receive clients through `M: Mysql` and `R: Redis`. Options and
//! independent cache connections live here, alongside routing configuration.

pub mod app;
pub mod database;
mod entry_routes;
pub mod models_unified;
pub use wegent_backend_persistence::connection as mysql;
pub mod prometheus;
pub mod redis;
pub mod remote_workspace_status;
pub mod remote_workspace_tree;
pub mod routes;
pub mod runtime_check;
