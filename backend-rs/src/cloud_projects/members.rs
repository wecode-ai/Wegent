// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `cloud_project_service.list_members` and the collaboration-permission
//! reads it shares with the other cloud-project projections.
//!
//! Mirrors `app.services.cloud_projects.members.CloudProjectMemberService`
//! under the unified collaboration permission contract:
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
//! Space administration is protected; otherwise a direct project role overrides
//! ordinary inheritance after the `Owner`→`Maintainer` and `Reporter`→`Viewer`
//! collaboration aliases. The roster exposes member email only to a caller who
//! is a participant themselves.
use std::collections::BTreeSet;
use std::collections::HashMap;

use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde::Serialize;

use super::{CloudMetadataInput, WORKSPACE_ID_COLUMN, entity_columns};

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

/// `COLLABORATION_ROLE_ALIASES`: retained legacy grants resolve without
/// rewriting the shared database rows.
pub(crate) fn collaboration_role(role: &str) -> &str {
    match role {
        "Owner" => "Maintainer",
        "Reporter" => "Viewer",
        other => other,
    }
}

/// Base role hierarchy (`app.schemas.base_role`); lower is more privileged.
pub(crate) fn role_level(role: &str) -> i32 {
    match role {
        "Owner" => 0,
        "Maintainer" => 1,
        "Developer" => 2,
        "Reporter" => 3,
        "Viewer" => 4,
        "RestrictedAnalyst" => 5,
        _ => 999,
    }
}

/// `has_permission`.
pub(crate) fn has_permission(user_role: &str, required_role: &str) -> bool {
    role_level(user_role) <= role_level(required_role)
}

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
    pub name: String,
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

/// `db.get(CloudProject, str(project_id))` entity row (unlabeled projection
/// plus the `workspace_id` column property and the project metadata).
#[derive(Debug, FromMysqlRow)]
pub(crate) struct ProjectEntityRow {
    #[mysql(rename = "id")]
    #[allow(dead_code, reason = "presence-only lookup")]
    pub id: String,
    #[mysql(rename = "anon_1")]
    pub workspace_id: Option<i64>,
    #[mysql(rename = "metadata")]
    pub metadata: Option<Json<JsonProjection<CloudMetadataInput>>>,
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

/// One `permission_sources` entry (`project_sources`).
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum PermissionSource {
    Workspace { workspace_id: String, role: String },
    Direct { role: String },
}

/// `cloud_project_visibility.effective_project_role`: CP05 and CP08 preserve
/// space administration while permitting direct project promotion or demotion.
fn effective_project_role<'a>(
    direct_role: Option<&'a str>,
    inherited_role: Option<&'a str>,
) -> Option<&'a str> {
    if inherited_role == Some("Maintainer") {
        inherited_role
    } else {
        direct_role.or(inherited_role)
    }
}

/// One `CloudProjectMemberResponse` row.
#[derive(Debug, Serialize)]
pub(crate) struct MemberResponse {
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

/// `entity_id.isdecimal()`: the source keeps only all-decimal entity ids.
fn decimal_entity_id(entity_id: &str) -> bool {
    !entity_id.is_empty() && entity_id.bytes().all(|byte| byte.is_ascii_digit())
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
        .filter(|entity_id| decimal_entity_id(entity_id))
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
async fn project_participant_ids<M: Mysql>(
    mysql: &M,
    project_id: i64,
    workspace_id: Option<i64>,
    membership_mode: &str,
) -> MysqlResult<BTreeSet<i32>> {
    let mut ids = explicit_member_ids(mysql, project_id).await?;
    let Some(workspace) = workspace_kind(mysql, workspace_id).await? else {
        return Ok(BTreeSet::new());
    };
    if workspace.kind != "CollaborationWorkspace" || !workspace.is_active {
        return Ok(BTreeSet::new());
    }
    ids.insert(workspace.user_id);
    let inherit = membership_mode == "inherit";
    for (entity_id, role) in workspace_member_roles(mysql, workspace.id).await? {
        if !decimal_entity_id(&entity_id) {
            continue;
        }
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
    project_id: i64,
    workspace_id: Option<i64>,
    membership_mode: &str,
    user_id: i32,
) -> MysqlResult<Vec<PermissionSource>> {
    let mut sources = Vec::new();
    let inherited = workspace_role(mysql, workspace_id, user_id).await?;
    if let Some(role) = inherited
        && (membership_mode == "inherit" || has_permission(&role, "Maintainer"))
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
    workspace_role_for_kind(mysql, &workspace, user_id).await
}

pub(super) async fn workspace_role_for_kind<M: Mysql>(
    mysql: &M,
    workspace: &WorkspaceKindRow,
    user_id: i32,
) -> MysqlResult<Option<String>> {
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
/// contract. `membership_mode` and `capabilities` come from the
/// `db.get(CloudProject, ...)` entity the source keeps on the access result.
pub(crate) async fn list_project_members<M: Mysql>(
    mysql: &M,
    project_id: i64,
    workspace_id: Option<i64>,
    membership_mode: &str,
    capabilities: &HashMap<String, String>,
    caller_id: i32,
) -> MysqlResult<Vec<MemberResponse>> {
    let participants =
        project_participant_ids(mysql, project_id, workspace_id, membership_mode).await?;
    let expose_email = participants.contains(&caller_id);
    let mut members = Vec::new();
    for user in roster_users(mysql, &participants).await? {
        let sources =
            project_sources(mysql, project_id, workspace_id, membership_mode, user.id).await?;
        let direct_role = sources.iter().find_map(|source| match source {
            PermissionSource::Direct { role } => Some(role.clone()),
            PermissionSource::Workspace { .. } => None,
        });
        let inherited_role = sources.iter().find_map(|source| match source {
            PermissionSource::Workspace { role, .. } => Some(role.clone()),
            PermissionSource::Direct { .. } => None,
        });
        let role = effective_project_role(direct_role.as_deref(), inherited_role.as_deref())
            .expect("participants always carry a permission source")
            .to_string();
        let grant = direct_member(mysql, project_id, user.id).await?;
        members.push(MemberResponse {
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

    #[test]
    fn role_hierarchy_allows_equal_and_higher() {
        assert!(has_permission("Owner", "Developer"));
        assert!(has_permission("Developer", "Developer"));
        assert!(!has_permission("Viewer", "Developer"));
        assert!(!has_permission("Unknown", "Viewer"));
    }

    #[test]
    fn effective_member_role_honors_project_overrides_and_space_administration() {
        for (direct, inherited, expected, can_be_assignee) in [
            (Some("Viewer"), Some("Developer"), "Viewer", false),
            (Some("Viewer"), Some("Maintainer"), "Maintainer", true),
            (Some("Maintainer"), Some("Viewer"), "Maintainer", true),
            (None, Some("Developer"), "Developer", true),
            (Some("Viewer"), None, "Viewer", false),
        ] {
            let role = effective_project_role(direct, inherited).unwrap();
            assert_eq!(role, expected, "direct={direct:?}, inherited={inherited:?}");
            assert_eq!(has_permission(role, "Developer"), can_be_assignee);
        }
        assert_eq!(effective_project_role(None, None), None);
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

    #[tokio::test]
    async fn project_entity_matches_the_recorded_query() {
        let mysql = KindQueryCapture::default();
        let entity = project_entity(&mysql, 4712514671486395195)
            .await
            .expect("project entity is captured");
        assert!(entity.is_none());

        let sql = normalize(&mysql.queries()[0].sql);
        assert!(sql.starts_with(
            "SELECT (SELECT CASE WHEN (count(distinct(resource_members.entity_id)) = 1)"
        ));
        assert!(sql.contains(
            "WHERE loop_items.id = '4712514671486395195' AND loop_items.resource_type IN ('project')"
        ));
        assert!(!sql.ends_with("LIMIT 1"));
    }

    #[tokio::test]
    async fn caller_sources_read_the_workspace_and_direct_grant() {
        let mysql = KindQueryCapture::default();
        record_project_sources(&mysql, 4712514671486395195, 86, Some(353932), 86)
            .await
            .expect("caller source reads are captured");

        let queries = mysql.queries();
        assert_eq!(queries.len(), 2);
        assert!(normalize(&queries[0].sql).starts_with("SELECT kinds.id, kinds.user_id"));
        assert!(
            normalize(&queries[1].sql).contains("resource_members.resource_type = 'CloudProject'")
        );
    }

    #[test]
    fn member_response_serializes_the_source_shape() {
        let member = MemberResponse {
            id: 13245,
            user_id: 86,
            user_name: "example-user".to_string(),
            email: Some("example-user@example.org".to_string()),
            role: "Maintainer".to_string(),
            direct_role: Some("Maintainer".to_string()),
            inherited_role: Some("Maintainer".to_string()),
            permission_sources: vec![
                PermissionSource::Workspace {
                    workspace_id: "353932".to_string(),
                    role: "Maintainer".to_string(),
                },
                PermissionSource::Direct {
                    role: "Maintainer".to_string(),
                },
            ],
            inherited_from_workspace_id: Some("353932".to_string()),
            can_be_assignee: true,
            capability_description: String::new(),
        };
        let value = serde_json::to_value(&member).unwrap();
        assert_eq!(value["id"], 13245);
        assert_eq!(value["user_id"], 86);
        assert_eq!(value["role"], "Maintainer");
        assert_eq!(value["direct_role"], "Maintainer");
        assert_eq!(value["inherited_role"], "Maintainer");
        assert_eq!(value["inherited_from_workspace_id"], "353932");
        assert_eq!(value["can_be_assignee"], true);
        assert_eq!(value["capability_description"], "");
        assert_eq!(value["permission_sources"][0]["type"], "workspace");
        assert_eq!(value["permission_sources"][0]["workspace_id"], "353932");
        assert_eq!(value["permission_sources"][1]["type"], "direct");
    }
}
