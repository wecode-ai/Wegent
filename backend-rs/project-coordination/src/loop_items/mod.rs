// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/loop-items` — the project board's
//! loop-item list.
//!
//! The handler lives in [`handler`]; [`response`] re-exports the shared
//! `LoopItemResponse` body used by every loop-item read.

mod handler;
pub mod response;
