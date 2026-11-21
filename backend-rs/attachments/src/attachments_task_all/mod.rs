// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/attachments/task/{task_id}/all` — all attachments for a task
//! (`app/api/endpoints/adapter/attachments.py:get_all_task_attachments`).

pub mod auth;
pub mod auth_error;
pub mod handler;
pub mod repository;
