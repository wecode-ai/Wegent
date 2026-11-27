// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}` and
//! `GET /api/v1/loop-items/{item_id}/tasks`.

pub(crate) mod assignment_index;
mod assignment_receipts;
pub mod assignments;
pub use wegent_identity::flexible_auth as auth;
pub(crate) use wegent_project_coordination::loop_tasks::{issue_invitation, item_access};
mod external_shadow;

mod assistant_participation;
pub(crate) mod handler;
pub(crate) use wegent_project_coordination::loop_tasks::{assignment_repository, loop_repository};
pub(crate) use wegent_project_coordination::loop_tasks::{http_error, item_response};
