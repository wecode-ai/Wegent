// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/teams/{team_id}/skills`
//! (`app.api.endpoints.adapter.teams.get_team_skills` ->
//! `team_kinds_service.get_team_skills`).
//!
//! Returns every skill attached to a team through the chain
//! `team -> bots -> ghosts -> skills`, deduplicated and sorted, with the
//! team's namespace. The source loads the Team by id through the public kind
//! reader, checks the caller's access (owner, public, group
//! membership, or direct share), then walks the team members' bot refs and
//! ghost refs through the same direct reader to collect `skills` and
//! `preload_skills`.

pub mod handler;
pub mod repository;
