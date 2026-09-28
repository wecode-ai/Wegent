// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/quick-launch` (source
//! `app.api.endpoints.users.get_user_quick_launch`): homepage launchers split
//! into system functions (from the `quick_launch_functions` system config)
//! and user favorite agents (from `preferences.quick_access.teams`).

pub mod handler;
pub mod repository;
