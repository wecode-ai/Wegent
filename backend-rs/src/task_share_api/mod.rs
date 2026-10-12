// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task share route: `POST /api/tasks/{task_id}/share`
//! (`app.api.endpoints.adapter.tasks.share_task`).
//!
//! The endpoint authenticates the session, checks task membership, and returns
//! the encrypted share token with its `/shared/task` link. It reuses the shared
//! [`TaskStore`](crate::task_store::TaskStore) so a deployment whose task
//! storage is sharded resolves the same active-task projection.

mod handler;
mod models;
mod router;
mod token;
