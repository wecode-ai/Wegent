//! Resolve one effective project roster from three bounded database reads.

use std::collections::{BTreeSet, HashMap};

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use super::{
    MemberResponse, PermissionSource, collaboration_role, effective_project_role, has_permission,
    workspace_kind,
};

#[derive(Debug, FromMysqlRow)]
struct Grant {
    id: i32,
    resource_type: String,
    entity_id: String,
    role: String,
    status: String,
}

impl Grant {
    fn approved_role(&self) -> Option<&str> {
        (self.status == "approved"
            && matches!(
                self.role.as_str(),
                "Owner" | "Maintainer" | "Developer" | "Viewer" | "Reporter"
            ))
        .then(|| collaboration_role(&self.role))
    }
}

#[derive(Debug, FromMysqlRow)]
struct User {
    id: i32,
    user_name: String,
    email: Option<String>,
}

#[derive(Default)]
struct Sources {
    direct_id: Option<i32>,
    direct: Option<String>,
    inherited: Option<String>,
}

fn member_sources(owner_id: i32, grants: Vec<Grant>, inherit: bool) -> HashMap<i32, Sources> {
    let mut sources = HashMap::<i32, Sources>::new();
    sources.entry(owner_id).or_default().inherited = Some("Maintainer".to_owned());
    for grant in grants {
        let Ok(user_id) = grant.entity_id.parse::<i32>() else {
            continue;
        };
        // Membership identity is the canonical decimal user id, as in point checks.
        if user_id.is_negative() || grant.entity_id != user_id.to_string() {
            continue;
        }
        let source = sources.entry(user_id).or_default();
        if grant.resource_type == "CloudProject" {
            // Historical pending/invalid direct rows still supply the response id,
            // but never authority. The unique membership identity keeps one row.
            source.direct_id = Some(grant.id);
            source.direct = grant.approved_role().map(str::to_owned);
        } else if user_id != owner_id {
            source.inherited = grant
                .approved_role()
                .filter(|role| inherit || *role == "Maintainer")
                .map(str::to_owned);
        }
    }
    sources.retain(|_, source| source.direct.is_some() || source.inherited.is_some());
    sources
}

async fn grants<M: Mysql>(
    mysql: &M,
    project_id: i64,
    workspace_id: i64,
) -> MysqlResult<Vec<Grant>> {
    mysql
        .fetch_all(
            format!(
                "SELECT id, resource_type, entity_id, `role`, status FROM resource_members
          WHERE entity_type = 'user' AND
            ((resource_type = 'CloudProject' AND resource_id = {project_id}) OR
             (resource_type = 'Workspace' AND resource_id = {workspace_id}))
          ORDER BY id"
            ),
            (),
        )
        .await
}

async fn users<M: Mysql>(mysql: &M, ids: BTreeSet<i32>) -> MysqlResult<Vec<User>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = ids
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
            format!(
                "SELECT id, user_name, email FROM users
        WHERE id IN ({ids}) AND is_active IS true ORDER BY id"
            ),
            (),
        )
        .await
}

pub(crate) async fn list_project_members<M: Mysql>(
    mysql: &M,
    project_id: i64,
    workspace_id: Option<i64>,
    membership_mode: &str,
    capabilities: &HashMap<String, String>,
    caller_id: i32,
) -> MysqlResult<Vec<MemberResponse>> {
    let Some(workspace) = workspace_kind(mysql, workspace_id).await? else {
        return Ok(Vec::new());
    };
    if workspace.kind != "CollaborationWorkspace" || !workspace.is_active {
        return Ok(Vec::new());
    }
    let sources = member_sources(
        workspace.user_id,
        grants(mysql, project_id, workspace.id).await?,
        membership_mode == "inherit",
    );
    let roster = users(mysql, sources.keys().copied().collect()).await?;
    let expose_email = roster.iter().any(|user| user.id == caller_id);
    Ok(roster
        .into_iter()
        .map(|user| {
            let source = &sources[&user.id];
            response(user, source, workspace.id, capabilities, expose_email)
        })
        .collect())
}

fn response(
    user: User,
    source: &Sources,
    workspace_id: i64,
    capabilities: &HashMap<String, String>,
    expose_email: bool,
) -> MemberResponse {
    let role = effective_project_role(source.direct.as_deref(), source.inherited.as_deref())
        .expect("only effective participants enter the roster")
        .to_owned();
    let mut permission_sources = Vec::new();
    if let Some(role) = &source.inherited {
        permission_sources.push(PermissionSource::Workspace {
            workspace_id: workspace_id.to_string(),
            role: role.clone(),
        });
    }
    if let Some(role) = &source.direct {
        permission_sources.push(PermissionSource::Direct { role: role.clone() });
    }
    MemberResponse {
        id: source.direct_id.unwrap_or(user.id),
        user_id: user.id,
        user_name: user.user_name,
        email: if expose_email { user.email } else { None },
        can_be_assignee: has_permission(&role, "Developer"),
        role,
        direct_role: source.direct.clone(),
        inherited_role: source.inherited.clone(),
        permission_sources,
        inherited_from_workspace_id: source.inherited.as_ref().map(|_| workspace_id.to_string()),
        capability_description: capabilities
            .get(&user.id.to_string())
            .cloned()
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    fn grant(user: i32, kind: &str, role: &str, status: &str) -> Grant {
        Grant {
            id: user + 100,
            entity_id: user.to_string(),
            resource_type: kind.to_owned(),
            role: role.to_owned(),
            status: status.to_owned(),
        }
    }

    #[test]
    fn cp02_cp03_cp05_cp08_preserve_roles_sources_and_pending_ids() {
        for inherit in [true, false] {
            let sources = member_sources(
                1,
                vec![
                    grant(1, "CloudProject", "Viewer", "approved"),
                    grant(2, "Workspace", "Maintainer", "approved"),
                    grant(2, "CloudProject", "Viewer", "approved"),
                    grant(3, "Workspace", "Developer", "approved"),
                    grant(3, "CloudProject", "Viewer", "approved"),
                    grant(4, "Workspace", "Reporter", "approved"),
                    grant(5, "CloudProject", "Owner", "approved"),
                    grant(6, "CloudProject", "Developer", "pending"),
                    grant(7, "Workspace", "Owner", "approved"),
                    grant(7, "CloudProject", "Unknown", "rejected"),
                    grant(8, "Workspace", "Developer", "rejected"),
                    grant(9, "CloudProject", "Unknown", "approved"),
                ],
                inherit,
            );
            let role = |id| {
                effective_project_role(
                    sources[&id].direct.as_deref(),
                    sources[&id].inherited.as_deref(),
                )
                .unwrap()
            };
            assert_eq!(role(1), "Maintainer");
            assert_eq!(role(2), "Maintainer");
            assert_eq!(role(3), "Viewer");
            assert_eq!(sources[&3].inherited.is_some(), inherit);
            assert_eq!(sources.contains_key(&4), inherit);
            assert_eq!(role(5), "Maintainer");
            assert_eq!(role(7), "Maintainer");
            assert_eq!(sources[&7].direct_id, Some(107));
            assert!(sources[&7].direct.is_none());
            for denied in [6, 8, 9] {
                assert!(!sources.contains_key(&denied));
            }
            let user = User {
                id: 3,
                user_name: "member".into(),
                email: Some("member@example.org".into()),
            };
            let member = response(
                user,
                &sources[&3],
                2001,
                &HashMap::from([("3".into(), "Review".into())]),
                false,
            );
            assert!(member.email.is_none());
            assert!(!member.can_be_assignee);
            assert_eq!(member.capability_description, "Review");
            assert_eq!(member.permission_sources.len(), if inherit { 2 } else { 1 });
        }
    }

    #[tokio::test]
    async fn grant_and_user_queries_are_batched_and_project_only_display_fields() {
        for size in [2, 86] {
            let mysql = KindQueryCapture::default();
            grants(&mysql, 1001, 2001).await.unwrap();
            users(&mysql, (1..=size).collect()).await.unwrap();
            let queries = mysql.queries();
            assert_eq!(queries.len(), 2);
            assert!(
                queries[0]
                    .sql
                    .contains("resource_type = 'CloudProject' AND resource_id = 1001")
            );
            assert!(
                queries[0]
                    .sql
                    .contains("resource_type = 'Workspace' AND resource_id = 2001")
            );
            assert!(queries[0].sql.contains("entity_type = 'user'"));
            assert!(
                queries[1]
                    .sql
                    .starts_with("SELECT id, user_name, email FROM users")
            );
            assert!(queries[1].sql.contains("is_active IS true ORDER BY id"));
            assert!(!queries[1].sql.contains("password"));
        }
    }

    #[test]
    fn malformed_user_identities_never_supply_authority() {
        for entity in ["-2", "+2", "02", "٢", "invalid", ""] {
            let mut row = grant(2, "CloudProject", "Maintainer", "approved");
            row.entity_id = entity.to_owned();
            let sources = member_sources(1, vec![row], true);
            assert_eq!(sources.len(), 1, "identity: {entity}");
            assert!(sources.contains_key(&1));
        }
    }
}
