// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task mutation routes: `DELETE /api/tasks/{task_id}`,
//! `DELETE /api/tasks/bulk`, and `PUT /api/tasks/{task_id}`
//! (`app.api.endpoints.adapter.tasks`).

mod delete_task;
mod models;
mod router;
mod socketio;
mod task_crd;
mod update_task;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
