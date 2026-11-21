// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/recent-teams` (source
//! `app.api.endpoints.users.get_user_recent_teams`): five recently used teams
//! for code or non-code tasks
//! (`team_kinds_service.get_recent_accessible_teams`).

pub mod handler;
pub mod repository;
