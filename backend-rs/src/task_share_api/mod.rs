// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task share routes.
//!
//! `POST /api/tasks/{task_id}/share`
//! (`app.api.endpoints.adapter.tasks.share_task`): the endpoint authenticates
//! through the executor-flexible dependency
//! (`app.core.security.get_current_user_flexible_for_executor`: personal API
//! key or user-session JWT), checks task membership, and returns the encrypted
//! share token with its `/shared/task` link. It reuses the shared
//! [`TaskStore`](crate::task_store::TaskStore) so a deployment whose task
//! storage is sharded resolves the same active-task projection.
//!
//! `GET /api/tasks/share/public`
//! (`app.api.endpoints.adapter.tasks.get_public_shared_task`, see [`public`]):
//! the unauthenticated read-only projection of a shared task.

mod auth;
mod handler;
mod models;
mod public;
mod router;
mod token;
