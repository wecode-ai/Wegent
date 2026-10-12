// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/resources`: the user's owned agents and execution environments.
//!
//! Mirrors `app.api.endpoints.workspaces.list_personal_resources` -> the
//! `WorkspacePersonalResourceService.list_personal_resources` call chain.
//! Ownership: source lives under `app/services/workspaces/` (non-`wecode`), so
//! this implementation belongs to the open-source `backend-rs` crate.

pub mod environment;
pub mod handler;
pub mod model_resolution;
pub mod readiness;
pub mod repository;
pub mod response;
pub mod service;
pub mod shell_resolution;
