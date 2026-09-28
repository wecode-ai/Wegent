// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/teams` (source `app/api/endpoints/adapter/teams.py`) and other
//! team-scoped user endpoints under `/api/users`.

pub mod auth;
pub mod auth_error;
pub mod group_membership;
pub mod http_error;
pub mod quick_access;
pub mod quick_launch;
pub mod recent_teams;
pub mod team_conversion;
pub mod team_skills;
pub mod team_union;
pub mod teams_repository;

mod handler;
