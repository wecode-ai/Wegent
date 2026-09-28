// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/lite/personal`
//! (source `app/api/endpoints/adapter/tasks.py:get_personal_tasks_lite`,
//! router prefix `/tasks` under the app prefix `/api`).

pub mod handler;
pub mod lite_repository;
