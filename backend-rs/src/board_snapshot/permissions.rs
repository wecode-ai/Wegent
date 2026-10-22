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
use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, WORKSPACE_ID_COLUMN, entity_columns};

/// The `resource_members` projection SQLAlchemy renders for the source
/// `db.query(ResourceMember)` lookups (`resource_members_<column>` labels).
pub(crate) const RESOURCE_MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
     resource_members.resource_type AS resource_members_resource_type, \
     resource_members.resource_id AS resource_members_resource_id, \
     resource_members.entity_type AS resource_members_entity_type, \
     resource_members.entity_id AS resource_members_entity_id, \
     resource_members.entity_display_name AS resource_members_entity_display_name, \
     resource_members.user_id AS resource_members_user_id, \
     resource_members.`role` AS resource_members_role, \
     resource_members.status AS resource_members_status, \
     resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
     resource_members.share_link_id AS resource_members_share_link_id, \
     resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
     resource_members.reviewed_at AS resource_members_reviewed_at, \
     resource_members.copied_resource_id AS resource_members_copied_resource_id, \
     resource_members.requested_at AS resource_members_requested_at, \
     resource_members.created_at AS resource_members_created_at, \
     resource_members.updated_at AS resource_members_updated_at";

/// `VALID_CLOUD_PROJECT_MEMBER_ROLES` in source declaration order.
pub(crate) const MEMBER_ROLES: &str = "('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')";

/// `db.get(Kind, workspace_id)`: the bare entity projection (no labels, no
/// `LIMIT`) the source's `Session.get` renders.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct WorkspaceKindRow {
    #[mysql(rename = "id")]
    pub id: i64,
    #[mysql(rename = "user_id")]
    pub user_id: i32,
    #[mysql(rename = "kind")]
    pub kind: String,
    #[mysql(rename = "namespace")]
    pub namespace: String,
    #[mysql(rename = "is_active")]
    pub is_active: bool,
}

/// One approved `resource_members` grant; only `role` feeds the source's
/// permission sources.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct MembershipRow {
    #[mysql(rename = "resource_members_role")]
    pub role: String,
    #[mysql(rename = "resource_members_status")]
    pub status: String,
}

/// `db.get(Kind, workspace_id)` (`CloudProject.workspace_id`). The source
/// skips the lookup when the project has no unique parent workspace.
pub(crate) async fn workspace_kind<M: Mysql>(
    mysql: &M,
    workspace_id: Option<i64>,
) -> MysqlResult<Option<WorkspaceKindRow>> {
    let Some(workspace_id) = workspace_id else {
        return Ok(None);
    };
    let sql = format!(
        "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, kinds.json, \
         kinds.is_active, kinds.created_at, kinds.updated_at \n\
         FROM kinds \n\
         WHERE kinds.id = {workspace_id}"
    );
    mysql.fetch_optional(sql, ()).await
}

/// `_membership(db, kind, resource_id, user_id)`: the approved grant with a
/// collaboration role; the source renders `LIMIT 1`.
pub(crate) async fn approved_membership<M: Mysql>(
    mysql: &M,
    resource_type: &str,
    resource_id: i64,
    user_id: i32,
) -> MysqlResult<Option<MembershipRow>> {
    let sql = format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = '{resource_type}' AND resource_members.resource_id = {resource_id} AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND resource_members.`role` IN {MEMBER_ROLES} \n LIMIT 1"
    );
    mysql.fetch_optional(sql, ()).await
}

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

/// `db.get(CloudProject, str(project_id))` entity row (unlabeled projection
/// plus the `workspace_id` column property).
#[derive(Debug, FromMysqlRow)]
pub(crate) struct ProjectEntityRow {
    #[mysql(rename = "id")]
    #[allow(dead_code, reason = "presence-only lookup")]
    pub id: String,
    #[mysql(rename = "anon_1")]
    #[allow(dead_code, reason = "column-property projection")]
    pub workspace_id: Option<i64>,
}

/// `db.get(User, user_id)`'s activity outcome: `None` when the row is
/// missing, otherwise `users.is_active != 0`.
pub(crate) async fn user_entity_is_active<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> MysqlResult<Option<bool>> {
    #[derive(Debug, FromMysqlRow)]
    struct UserActivityRow {
        #[mysql(rename = "id")]
        #[allow(dead_code, reason = "presence-only lookup")]
        id: i32,
        #[mysql(rename = "is_active")]
        is_active: i8,
    }
    let row: Option<UserActivityRow> = mysql
        .fetch_optional(
            crate::user_reader::USER_ENTITY_BY_ID_QUERY,
            (i64::from(user_id),),
        )
        .await?;
    Ok(row.map(|row| row.is_active != 0))
}

/// `db.get(CloudProject, str(project_id))` inside
/// `require_cloud_project_role`: the unlabeled entity projection with the
/// `workspace_id` column property, one request-owned read per ORM session.
pub(crate) async fn project_entity<M: Mysql>(
    mysql: &M,
    project_id: i64,
) -> MysqlResult<Option<ProjectEntityRow>> {
    let sql = format!(
        "SELECT {WORKSPACE_ID_COLUMN}, {} \nFROM loop_items \n\
         WHERE loop_items.id = '{project_id}' \n\
         AND loop_items.resource_type IN ('project')",
        entity_columns()
    );
    mysql.fetch_optional(sql, ()).await
}

/// `collaboration_permission_service.check`'s `project_sources` reads. The
/// source computes provenance on every `require_cloud_project_role` call even
/// when the caller ignores it, so the parent workspace role and the approved
/// direct grant remain request-owned reads.
pub(crate) async fn record_project_sources<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
    workspace_id: Option<i64>,
    authenticated_user_id: i32,
) -> MysqlResult<()> {
    // `workspace_role` starts with `db.get(User, user_id)`. The authenticated
    // caller is already in the ORM identity map; every other subject issues
    // the entity read, and a missing/inactive subject skips the workspace
    // branch entirely.
    let active = if user_id == authenticated_user_id {
        true
    } else {
        user_entity_is_active(mysql, user_id)
            .await?
            .unwrap_or(false)
    };
    if active
        && let Some(workspace) = workspace_kind(mysql, workspace_id).await?
        && workspace.kind == "CollaborationWorkspace"
        && workspace.is_active
        && workspace.user_id != user_id
    {
        let _ = approved_membership(mysql, "Workspace", workspace.id, user_id).await?;
    }
    let _ = approved_membership(mysql, "CloudProject", project_id, user_id).await?;
    Ok(())
}
