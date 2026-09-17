// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/quick-access` (source
//! `app.api.endpoints.users.get_user_quick_access`): user-favorite teams
//! merged with system-recommended teams from the `system_configs` table.

pub mod handler;
pub mod repository;
