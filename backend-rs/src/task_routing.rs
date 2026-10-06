// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task/subtask routing keys (open-source contract).
//!
//! These key types name the intent of a task or subtask lookup — "route by
//! task id" versus "route by owner user id" — without carrying any resolution
//! logic. A deployment that resolves task storage differently binds its own
//! routing policy to the handle it builds, so the keys stay a contract both
//! sides share. `brz_mysql::MysqlRouteKey` is auto-implemented for any
//! `Any + Send + Sync` type, so these newtypes need no manual trait impl.

/// Route a task or subtask lookup by its task identifier.
pub struct ByTaskId(pub u64);

/// Route an owner-scoped task or subtask lookup.
pub struct ByUserId(pub u64);

/// Maximum number of ancestors visited while resolving fork history.
pub(crate) const MAX_FORK_DEPTH: u32 = 50;
