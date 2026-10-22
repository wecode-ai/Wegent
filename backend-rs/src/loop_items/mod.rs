// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/loop-items` — the project board's
//! loop-item list.
//!
//! The handler lives in [`handler`]; [`local`] projects local (`resource_type
//! ='task'`) rows and [`response`] defines the shared `LoopItemResponse` body.

mod handler;
mod local;
pub(crate) mod response;
