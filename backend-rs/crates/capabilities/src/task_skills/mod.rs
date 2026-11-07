// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/skills` — task skill resolution
//! (`app.api.endpoints.adapter.tasks.get_task_skills`).

pub mod auth;
pub mod auth_error;
pub mod handler;
pub mod kinds;
pub mod repository;
pub mod resolver;
