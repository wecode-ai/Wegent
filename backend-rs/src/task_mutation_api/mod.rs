// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task mutation routes: `DELETE /api/tasks/{task_id}`,
//! `DELETE /api/tasks/bulk`, `PUT /api/tasks/{task_id}`, and
//! `POST /api/tasks/{task_id}/cancel`
//! (`app.api.endpoints.adapter.tasks`).

mod cancel_task;
pub(crate) mod delete_task;
mod models;
mod router;
mod socketio;
mod task_crd;
mod update_task;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
