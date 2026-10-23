// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `cloud_project_service.list_members` for the board-snapshot roster.
//!
//! The roster read itself lives in [`crate::cloud_projects::members`], which
//! mirrors `app.services.cloud_projects.members.CloudProjectMemberService:
//! .list_members`. This module adapts the board-snapshot project row to that
//! shared read.
use brz_mysql::{Mysql, MysqlResult};

pub(crate) use crate::cloud_projects::members::MemberResponse as BoardMember;
#[cfg(test)]
pub(crate) use crate::cloud_projects::members::PermissionSource;

use super::repository::ProjectRow;

/// `CloudProjectMemberService.list_members` under the unified permission
/// contract.
pub(crate) async fn list_project_members<M: Mysql>(
    mysql: &M,
    project: &ProjectRow,
    project_id: i64,
    workspace_id: Option<i64>,
    caller_id: i32,
) -> MysqlResult<Vec<BoardMember>> {
    crate::cloud_projects::members::list_project_members(
        mysql,
        project_id,
        workspace_id,
        project.membership_mode(),
        &project.member_capabilities(),
        caller_id,
    )
    .await
}
