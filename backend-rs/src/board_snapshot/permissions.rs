// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Permission-source and resource-authorization reads for the cloud-project
//! read paths.
//!
//! Mirrors `collaboration_permission_service.project_sources`,
//! `require_project_agent`, and `require_project_team`'s membership and
//! binding lookups, plus the `CloudProject.workspace_id` entity column
//! property. These are request-owned reads: the source issues them on every
//! `require_cloud_project_role` and agent authorization check.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use super::repository::AgentRow;
use crate::cloud_projects::LOOP_ITEMS_COLUMNS;

/// Collaboration-permission primitives shared with `cloud_project_service`
/// (`crate::cloud_projects::members`). Re-exported so the board-snapshot
/// call sites keep their existing imports.
pub(crate) use crate::cloud_projects::members::{
    MembershipRow, ProjectEntityRow, RESOURCE_MEMBER_COLUMNS, WorkspaceKindRow, project_entity,
    record_project_sources, workspace_kind,
};

/// `require_project_agent`'s direct `project_agent` grant on the parent
/// workspace (any status, `LIMIT 1`).
pub(crate) async fn project_agent_grant<M: Mysql>(
    mysql: &M,
    workspace_id: i64,
    agent_id: &str,
) -> MysqlResult<Option<MembershipRow>> {
    let sql = format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'Workspace' AND resource_members.resource_id = {workspace_id} AND resource_members.entity_type = 'project_agent' AND resource_members.entity_id = '{agent_id}' \n LIMIT 1"
    );
    mysql.fetch_optional(sql, ()).await
}

/// `require_project_team`'s `Team` grant on the parent workspace (any status,
/// `LIMIT 1`).
pub(crate) async fn team_grant<M: Mysql>(
    mysql: &M,
    team_id: i64,
    workspace_id: i64,
) -> MysqlResult<Option<MembershipRow>> {
    let sql = format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'Team' AND resource_members.resource_id = {team_id} AND resource_members.entity_type = 'workspace' AND resource_members.entity_id = '{workspace_id}' \n LIMIT 1"
    );
    mysql.fetch_optional(sql, ()).await
}

/// The legacy-binding scan in `require_project_team` when no `Team` grant
/// exists: every active chat agent of the project bound to the team.
pub(crate) async fn team_bound_agents<M: Mysql>(
    mysql: &M,
    project_id: &str,
    team_id: i64,
) -> MysqlResult<Vec<AgentRow>> {
    let sql = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \n\
         FROM loop_items \n\
         WHERE loop_items.cloud_project_id = '{project_id}' AND loop_items.status = 'active' AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AND CAST(CASE JSON_EXTRACT(loop_items.metadata, '$.\"wegent_team_id\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.\"wegent_team_id\"')) END AS SIGNED INTEGER) = {team_id} AND loop_items.resource_type IN ('chat_agent')"
    );
    mysql.fetch_all(sql, ()).await
}

/// `require_project_team(require_binding=True)`: the id-only existence read
/// of an active chat agent bound to the team.
pub(crate) async fn team_binding_exists<M: Mysql>(
    mysql: &M,
    project_id: &str,
    team_id: i64,
) -> MysqlResult<bool> {
    #[derive(Debug, FromMysqlRow)]
    struct IdRow {
        #[mysql(rename = "loop_items_id")]
        #[allow(dead_code, reason = "presence-only probe")]
        id: String,
    }
    let sql = format!(
        "SELECT loop_items.id AS loop_items_id \n\
         FROM loop_items \n\
         WHERE loop_items.cloud_project_id = '{project_id}' AND loop_items.status = 'active' AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AND CAST(CASE JSON_EXTRACT(loop_items.metadata, '$.\"wegent_team_id\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.\"wegent_team_id\"')) END AS SIGNED INTEGER) = {team_id} AND loop_items.resource_type IN ('chat_agent') \n LIMIT 1"
    );
    let row: Option<IdRow> = mysql.fetch_optional(sql, ()).await?;
    Ok(row.is_some())
}
