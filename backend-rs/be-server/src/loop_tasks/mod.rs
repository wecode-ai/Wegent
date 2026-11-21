// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}` and
//! `GET /api/v1/loop-items/{item_id}/tasks`.

pub(crate) mod assignment_index;
mod assignment_receipts;
pub mod assignments;
pub use wegent_identity::flexible_auth as auth;
pub mod cloud_context;
pub mod collaborators;
pub mod comments;
mod external_shadow;
mod human_requests;
mod item;
pub(crate) mod item_access;

mod assistant_participation;
mod handler;
pub(crate) mod issue_invitation;
pub(crate) use wegent_project_coordination::loop_tasks::{
    assignment_repository, loop_columns, loop_repository,
};
pub(crate) use wegent_project_coordination::loop_tasks::{
    http_error, human_task_binding, item_response,
};
