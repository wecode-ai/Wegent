// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}` — task detail
//! (`app.api.endpoints.adapter.tasks.get_task` -> `task_kinds_service
//! .get_task_detail`).
//!
//! The module reuses the logical task-table helpers and the public
//! `KindStore` from the remote-workspace endpoints; the dependency sequence
//! is the same `get_task_detail` chain the status endpoint reproduces, with
//! this endpoint additionally serializing the loaded rows into the
//! `TaskDetail` response.

pub mod assembly;
pub mod handler;
pub mod repository;

pub mod router;
pub mod views;

mod models;
