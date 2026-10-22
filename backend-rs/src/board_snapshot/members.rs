// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `cloud_project_service.list_members` for the board-snapshot roster.
//!
//! Mirrors `app.services.cloud_projects.members.CloudProjectMemberService:
//! .list_members` under the unified collaboration permission contract:
//!
//! 1. `project_participant_ids(db, project)` — approved direct project members
//!    (every collaboration role), the parent workspace owner, and the
//!    workspace members that inherit into an `inherit` project (or keep
//!    `Maintainer` authority in a `restricted` one), reduced to active users;
//! 2. `db.query(User).filter(User.id.in_(participants)).order_by(User.id)` —
//!    the roster rows;
//! 3. for each member, `collaboration_permission_service.project_sources`:
//!    the inherited workspace role (project owner, or an approved workspace
//!    membership) plus the approved direct project grant, each in source
//!    order (`workspace` before `direct`);
//! 4. `_direct_member` — the direct grant row (any status) that supplies the
//!    response `id`;
//! 5. `CloudProjectService._member_capabilities(project)` — metadata
//!    capability descriptions.
//!
//! The effective role is the highest-privilege source role after the
//! `Owner`→`Maintainer` and `Reporter`→`Viewer` collaboration aliases. The
//! roster exposes member email only to a caller who is a participant
//! themselves.

use std::collections::BTreeSet;

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Serialize;

use super::repository::{
    MEMBER_ROLES, ProjectRow, RESOURCE_MEMBER_COLUMNS, approved_membership, has_permission,
    role_level, workspace_kind,
};

/// `COLLABORATION_ROLE_ALIASES`: retained legacy grants resolve without
/// rewriting the shared database rows.
pub(crate) fn collaboration_role(role: &str) -> &str {
    match role {
        "Owner" => "Maintainer",
        "Reporter" => "Viewer",
        other => other,
    }
}

/// One `permission_sources` entry (`project_sources`).
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum PermissionSource {
    Workspace { workspace_id: String, role: String },
    Direct { role: String },
}

impl PermissionSource {
    fn role(&self) -> &str {
        match self {
            Self::Workspace { role, .. } | Self::Direct { role } => role,
        }
    }
}

/// One `CloudProjectMemberResponse` row.
#[derive(Debug, Serialize)]
pub(crate) struct BoardMember {
    pub id: i32,
    pub user_id: i32,
    pub user_name: String,
    pub email: Option<String>,
    pub role: String,
    pub direct_role: Option<String>,
    pub inherited_role: Option<String>,
    pub permission_sources: Vec<PermissionSource>,
    pub inherited_from_workspace_id: Option<String>,
    pub can_be_assignee: bool,
    pub capability_description: String,
}

/// `_direct_member`: only the grant id feeds the response `id`.
#[derive(Debug, FromMysqlRow)]
struct DirectGrantRow {
    #[mysql(rename = "resource_members_id")]
    id: i32,
}

/// One roster `users` row.
#[derive(Debug, FromMysqlRow)]
struct RosterUserRow {
    #[mysql(rename = "users_id")]
    id: i32,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[mysql(rename = "users_email")]
    email: Option<String>,
}

/// `cloud_project_visibility.explicit_project_member_ids(db, project)` with
/// the default `Viewer` requirement: the approved direct member entity ids.
async fn explicit_member_ids<M: Mysql>(mysql: &M, project_id: i64) -> MysqlResult<BTreeSet<i32>> {
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "resource_members_entity_id")]
        entity_id: Option<String>,
    }
    let sql = format!(
        "SELECT resource_members.entity_id AS resource_members_entity_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id = {project_id} AND resource_members.entity_type = 'user' AND resource_members.status = 'approved' AND resource_members.`role` IN {MEMBER_ROLES}"
    );
    let rows: Vec<Row> = mysql.fetch_all(sql, ()).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.entity_id)
        .filter_map(|entity_id| entity_id.parse::<i32>().ok())
        .collect())
}

/// The approved workspace member roles (entity id plus raw stored role).
async fn workspace_member_roles<M: Mysql>(
    mysql: &M,
    workspace_id: i64,
) -> MysqlResult<Vec<(String, String)>> {
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "resource_members_entity_id")]
        entity_id: Option<String>,
        #[mysql(rename = "resource_members_role")]
        role: String,
    }
    let sql = format!(
        "SELECT resource_members.entity_id AS resource_members_entity_id, \
         resource_members.`role` AS resource_members_role \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'Workspace' AND resource_members.resource_id = {workspace_id} AND resource_members.entity_type = 'user' AND resource_members.status = 'approved' AND resource_members.`role` IN {MEMBER_ROLES}"
    );
    let rows: Vec<Row> = mysql.fetch_all(sql, ()).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.entity_id.map(|entity_id| (entity_id, row.role)))
        .collect())
}

/// `CloudProjectMemberService._direct_member`: the direct grant row without a
/// status or role filter, used only for the response `id`.
async fn direct_member<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
) -> MysqlResult<Option<DirectGrantRow>> {
    let sql = format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id = {project_id} AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' \n LIMIT 1"
    );
    mysql.fetch_optional(sql, ()).await
}

/// `db.query(User.id).filter(User.id.in_(ids), User.is_active.is_(True))`.
async fn active_user_ids<M: Mysql>(mysql: &M, ids: &BTreeSet<i32>) -> MysqlResult<BTreeSet<i32>> {
    if ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "users_id")]
        id: i32,
    }
    let values = ids
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT users.id AS users_id \n\
         FROM users \n\
         WHERE users.id IN ({values}) AND users.is_active IS true"
    );
    let rows: Vec<Row> = mysql.fetch_all(sql, ()).await?;
    Ok(rows.into_iter().map(|row| row.id).collect())
}

/// `db.query(User).filter(User.id.in_(participants)).order_by(User.id)`.
async fn roster_users<M: Mysql>(
    mysql: &M,
    participants: &BTreeSet<i32>,
) -> MysqlResult<Vec<RosterUserRow>> {
    if participants.is_empty() {
        return Ok(Vec::new());
    }
    let values = participants
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {} \n\
         FROM users \n\
         WHERE users.id IN ({values}) ORDER BY users.id",
        crate::user_reader::users_projection()
    );
    mysql.fetch_all(sql, ()).await
}

/// `cloud_project_visibility.project_participant_ids(db, project)`: the
/// effective human roster, excluding public visitors. A project without a
/// unique active parent workspace has no participant roster at all.
///
async fn project_participant_ids<M: Mysql>(
    mysql: &M,
    project: &ProjectRow,
    project_id: i64,
    workspace_id: Option<i64>,
) -> MysqlResult<BTreeSet<i32>> {
    let mut ids = explicit_member_ids(mysql, project_id).await?;
    let Some(workspace) = workspace_kind(mysql, workspace_id).await? else {
        return Ok(BTreeSet::new());
    };
    if workspace.kind != "CollaborationWorkspace" || !workspace.is_active {
        return Ok(BTreeSet::new());
    }
    ids.insert(workspace.user_id);
    let inherit = project.membership_mode() == "inherit";
    for (entity_id, role) in workspace_member_roles(mysql, workspace.id).await? {
        let Ok(user_id) = entity_id.parse::<i32>() else {
            continue;
        };
        let role = collaboration_role(&role);
        let eligible =
            role_level(role) <= role_level("Viewer") && (inherit || role == "Maintainer");
        if eligible {
            ids.insert(user_id);
        }
    }
    active_user_ids(mysql, &ids).await
}

/// `collaboration_permission_service.project_sources(db, project, user_id)`.
async fn project_sources<M: Mysql>(
    mysql: &M,
    project: &ProjectRow,
    project_id: i64,
    workspace_id: Option<i64>,
    user_id: i32,
) -> MysqlResult<Vec<PermissionSource>> {
    let mut sources = Vec::new();
    let inherited = workspace_role(mysql, workspace_id, user_id).await?;
    if let Some(role) = inherited
        && (project.membership_mode() == "inherit" || has_permission(&role, "Maintainer"))
    {
        let role = if role == "Owner" {
            "Maintainer".to_string()
        } else {
            role
        };
        let workspace_id = workspace_id.expect("a workspace role implies a parent");
        sources.push(PermissionSource::Workspace {
            workspace_id: workspace_id.to_string(),
            role,
        });
    }
    if let Some(direct) = approved_membership(mysql, "CloudProject", project_id, user_id).await? {
        sources.push(PermissionSource::Direct {
            role: collaboration_role(&direct.role).to_string(),
        });
    }
    Ok(sources)
}

/// `collaboration_permission_service.workspace_role(db, workspace_id,
/// user_id)`. The caller's `users` row activity is already guaranteed by the
/// participant filter. The source issues `db.get(Kind, workspace_id)` on
/// every call, so the parent row is read per member.
async fn workspace_role<M: Mysql>(
    mysql: &M,
    workspace_id: Option<i64>,
    user_id: i32,
) -> MysqlResult<Option<String>> {
    let Some(workspace) = workspace_kind(mysql, workspace_id).await? else {
        return Ok(None);
    };
    if workspace.kind != "CollaborationWorkspace" || !workspace.is_active {
        return Ok(None);
    }
    if workspace.user_id == user_id {
        return Ok(Some("Owner".to_string()));
    }
    Ok(
        approved_membership(mysql, "Workspace", workspace.id, user_id)
            .await?
            .map(|member| collaboration_role(&member.role).to_string()),
    )
}

/// `CloudProjectMemberService.list_members` under the unified permission
/// contract.
pub(crate) async fn list_project_members<M: Mysql>(
    mysql: &M,
    project: &ProjectRow,
    project_id: i64,
    workspace_id: Option<i64>,
    caller_id: i32,
) -> MysqlResult<Vec<BoardMember>> {
    let participants = project_participant_ids(mysql, project, project_id, workspace_id).await?;
    let capabilities = project.member_capabilities();
    let expose_email = participants.contains(&caller_id);
    let mut members = Vec::new();
    for user in roster_users(mysql, &participants).await? {
        let sources = project_sources(mysql, project, project_id, workspace_id, user.id).await?;
        let mut role: Option<String> = None;
        for source in &sources {
            if role
                .as_deref()
                .is_none_or(|current| role_level(source.role()) < role_level(current))
            {
                role = Some(source.role().to_string());
            }
        }
        let role = role.expect("participants always carry a permission source");
        let direct_role = sources.iter().find_map(|source| match source {
            PermissionSource::Direct { role } => Some(role.clone()),
            PermissionSource::Workspace { .. } => None,
        });
        let inherited_role = sources.iter().find_map(|source| match source {
            PermissionSource::Workspace { role, .. } => Some(role.clone()),
            PermissionSource::Direct { .. } => None,
        });
        let grant = direct_member(mysql, project_id, user.id).await?;
        members.push(BoardMember {
            id: grant.map(|grant| grant.id).unwrap_or(user.id),
            user_id: user.id,
            user_name: user.user_name,
            email: if expose_email { user.email } else { None },
            role: role.clone(),
            direct_role,
            inherited_role: inherited_role.clone(),
            permission_sources: sources,
            inherited_from_workspace_id: inherited_role
                .and(workspace_id.map(|workspace_id| workspace_id.to_string())),
            can_be_assignee: has_permission(&role, "Developer"),
            capability_description: capabilities
                .get(&user.id.to_string())
                .cloned()
                .unwrap_or_default(),
        });
    }
    Ok(members)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    /// Whitespace-insensitive SQL comparison: Replay matches the statement
    /// structure, not the source's line breaks.
    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn collaboration_aliases_are_retained() {
        assert_eq!(collaboration_role("Owner"), "Maintainer");
        assert_eq!(collaboration_role("Reporter"), "Viewer");
        assert_eq!(collaboration_role("Developer"), "Developer");
        assert_eq!(
            collaboration_role("Viewer"),
            "Viewer",
            "unaliased roles pass through"
        );
    }

    #[tokio::test]
    async fn explicit_member_ids_matches_the_recorded_query() {
        let mysql = KindQueryCapture::default();
        let ids = explicit_member_ids(&mysql, 4712514671486395195)
            .await
            .expect("member id query is captured");
        assert!(ids.is_empty());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 0);
        assert_eq!(
            queries[0].sql,
            normalize(
                "SELECT resource_members.entity_id AS resource_members_entity_id \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'CloudProject' \
                 AND resource_members.resource_id = 4712514671486395195 \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.status = 'approved' \
                 AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')",
            )
        );
    }

    #[tokio::test]
    async fn workspace_kind_matches_the_entity_lookup() {
        let mysql = KindQueryCapture::default();
        let kind = workspace_kind(&mysql, Some(353932))
            .await
            .expect("kind query is captured");
        assert!(kind.is_none());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].sql,
            normalize(
                "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, \
                 kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \n\
                 FROM kinds \n\
                 WHERE kinds.id = 353932",
            )
        );
    }

    #[tokio::test]
    async fn workspace_member_roles_match_the_recorded_query() {
        let mysql = KindQueryCapture::default();
        let roles = workspace_member_roles(&mysql, 353932)
            .await
            .expect("workspace member query is captured");
        assert!(roles.is_empty());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].sql,
            normalize(
                "SELECT resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.`role` AS resource_members_role \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'Workspace' \
                 AND resource_members.resource_id = 353932 \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.status = 'approved' \
                 AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')",
            )
        );
    }

    #[tokio::test]
    async fn approved_membership_matches_the_recorded_query() {
        let mysql = KindQueryCapture::default();
        let member = approved_membership(&mysql, "CloudProject", 4712514671486395195, 2)
            .await
            .expect("membership query is captured");
        assert!(member.is_none());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        let sql = normalize(&queries[0].sql);
        assert!(sql.starts_with(
            "SELECT resource_members.id AS resource_members_id, \
             resource_members.resource_type AS resource_members_resource_type"
        ));
        assert!(sql.contains(
            "WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = 4712514671486395195 \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = '2' \
             AND resource_members.status = 'approved' \
             AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')"
        ));
        assert!(sql.ends_with("LIMIT 1"));
    }

    #[tokio::test]
    async fn direct_member_skips_the_status_and_role_filters() {
        let mysql = KindQueryCapture::default();
        let grant = direct_member(&mysql, 4712514671486395195, 2)
            .await
            .expect("direct grant query is captured");
        assert!(grant.is_none());

        let sql = normalize(&mysql.queries()[0].sql);
        assert!(sql.contains(
            "WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = 4712514671486395195 \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = '2' \
             LIMIT 1"
        ));
        assert!(!sql.contains("resource_members.status = 'approved'"));
        assert!(!sql.contains("resource_members.`role` IN"));
    }

    #[tokio::test]
    async fn active_user_ids_matches_the_recorded_query() {
        let mysql = KindQueryCapture::default();
        let ids = BTreeSet::from([2, 3, 17]);
        let active = active_user_ids(&mysql, &ids)
            .await
            .expect("active user query is captured");
        assert!(active.is_empty());

        assert_eq!(
            mysql.queries()[0].sql,
            normalize(
                "SELECT users.id AS users_id \n\
                 FROM users \n\
                 WHERE users.id IN (2, 3, 17) AND users.is_active IS true",
            )
        );
    }

    #[tokio::test]
    async fn roster_users_matches_the_recorded_query() {
        let mysql = KindQueryCapture::default();
        let ids = BTreeSet::from([2, 3]);
        let users = roster_users(&mysql, &ids)
            .await
            .expect("roster query is captured");
        assert!(users.is_empty());

        let sql = normalize(&mysql.queries()[0].sql);
        assert!(sql.ends_with("FROM users WHERE users.id IN (2, 3) ORDER BY users.id"));
        assert!(sql.contains("users.email AS users_email"));
    }
}
