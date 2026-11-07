// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Group membership resolution for `GET /api/teams`, mirroring
//! `app.services.group_permission.get_user_group_roles` /
//! `get_effective_roles_in_groups` and the entity resolvers they invoke
//! (`NamespaceEntityResolver` plus an optional employee-directory provider).
use std::collections::HashMap;

use brz_mysql::Mysql;

use crate::group_queries as repo;
use wegent_directory::erp_provider::ErpProvider;

/// The employee-directory provider and optional cache handle used by entity
/// resolution. Cache keys and upstream transport details belong to the
/// injected provider, so the shared crate has no internal cache format.
#[derive(Clone, Copy)]
pub struct ErpContext<'a, R: brz_redis::Redis = brz_redis::RedisService> {
    pub erp: &'a dyn ErpProvider<R>,
    pub redis: Option<&'a R>,
}

/// Role hierarchy (`app.schemas.base_role.ROLE_HIERARCHY`); lower is more
/// privileged. `Viewer` sits between `Reporter` and `RestrictedAnalyst`.
fn role_rank(role: &str) -> Option<u8> {
    match role {
        "Owner" => Some(0),
        "Maintainer" => Some(1),
        "Developer" => Some(2),
        "Reporter" => Some(3),
        "Viewer" => Some(4),
        "RestrictedAnalyst" => Some(5),
        _ => None,
    }
}

/// `has_permission`: the user role must be at least as privileged as the
/// required role.
pub fn has_permission(user_role: &str, required_role: &str) -> bool {
    match (role_rank(user_role), role_rank(required_role)) {
        (Some(user), Some(required)) => user <= required,
        _ => false,
    }
}

/// `TEAM_USE_ROLE` (`app.services.team_access_policy`): the least privileged
/// role that may use a team through a group namespace, so every recognised
/// group role qualifies.
pub const TEAM_USE_ROLE: &str = "RestrictedAnalyst";

/// `_get_accessible_authorization_namespace_ids`: the group namespaces whose
/// effective role grants team use, in the caller's order.
pub fn accessible_authorization_namespaces(
    group_namespaces: &[String],
    effective: &HashMap<String, String>,
) -> Vec<String> {
    group_namespaces
        .iter()
        .filter(|name| {
            effective
                .get(*name)
                .is_some_and(|role| has_permission(role, TEAM_USE_ROLE))
        })
        .cloned()
        .collect()
}

/// `get_highest_role`: the most privileged role among the candidates.
fn highest_role(roles: &[String]) -> Option<String> {
    roles
        .iter()
        .filter(|role| role_rank(role).is_some())
        .min_by_key(|role| role_rank(role).unwrap())
        .cloned()
}

/// One resolved group membership (`iter_user_groups_with_roles` entry).
pub struct GroupMembership {
    pub group_name: String,
    pub role: String,
}

/// Adapter for the provider's cached department membership operation.
pub struct DirectoryMembership;

impl DirectoryMembership {
    /// Delegate to the injected provider. A private provider may use Redis
    /// or an upstream directory; the public Noop provider returns no hits.
    pub async fn matched_departments(
        erp: &ErpContext<'_, impl brz_redis::Redis>,
        user_id: i64,
        ssn: &str,
        dept_ids: &[String],
    ) -> Vec<String> {
        erp.erp
            .membership_with_cache(
                erp.redis,
                i32::try_from(user_id).unwrap_or(0),
                ssn,
                dept_ids,
            )
            .await
    }
}

/// Result of `user_group_memberships`: the user's direct/entity memberships
/// plus every active namespace name (needed by the caller to expand
/// parent-group inheritance over the full active-name list, like the source's
/// `get_user_group_roles` -> `get_effective_roles_in_groups`).
pub struct ResolvedMemberships {
    /// Direct + entity-derived memberships (highest role per group).
    pub memberships: Vec<GroupMembership>,
    /// Every active namespace name, in query row order.
    pub active_names: Vec<String>,
}

/// Resolve the user's effective group memberships
/// (`get_user_group_roles` -> `get_effective_roles_in_groups` ->
/// `iter_user_groups_with_roles`), including entity-derived (org department)
/// memberships and parent-group inheritance.
///
/// `redis` may be absent; the source degrades the same way when
/// `get_redis_client` returns None (the ERP cache read becomes a miss).
pub async fn user_group_memberships<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &ErpContext<'_, R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
) -> Result<ResolvedMemberships, brz_mysql::MysqlError>
where
    M: Mysql,
{
    // `get_user_group_roles` first loads every active namespace name, then
    // resolves effective roles through `get_effective_roles_in_groups`. The
    // namespace-name query is part of the recorded dependency sequence.
    let group_names = repo::active_namespace_names(mysql).await?;
    // `get_effective_roles_in_groups` returns immediately for an empty
    // group-name list and issues no membership batch.
    if group_names.is_empty() {
        return Ok(ResolvedMemberships {
            memberships: Vec::new(),
            active_names: group_names,
        });
    }
    let memberships = iter_user_groups_with_roles(mysql, erp, resolvers, user_id).await?;
    Ok(ResolvedMemberships {
        memberships,
        active_names: group_names,
    })
}

/// `iter_user_groups_with_roles` (`group_member_helper`): the raw direct +
/// entity-derived membership fetch. `get_effective_roles_in_groups` calls
/// this with the caller's group names and no active-namespace listing, so
/// unlike `user_group_memberships` no namespace-name query is issued.
///
/// The Source has one implementation of this batch and the create flow already
/// uses it ([`crate::permissions::iter_user_groups_with_roles`]): per entity
/// type it reads every approved `Namespace` member row, calls
/// `match_entity_bindings`, and keeps the matched rows in memory. It never runs
/// `get_resource_ids_by_entity`'s resource-visibility chain.
pub async fn iter_user_groups_with_roles<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &ErpContext<'_, R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
) -> Result<Vec<GroupMembership>, brz_mysql::MysqlError>
where
    M: Mysql,
{
    let entries =
        crate::permissions::iter_user_groups_with_roles(mysql, resolvers, erp.redis, user_id)
            .await?;
    Ok(entries
        .into_iter()
        .map(|entry| GroupMembership {
            group_name: entry.group_name,
            role: entry.role,
        })
        .collect())
}

/// Effective roles for the requested group names
/// (`get_effective_roles_in_groups`): direct/entity roles, plus parent-group
/// inheritance for groups without their own roles.
pub fn effective_roles(
    memberships: &[GroupMembership],
    group_names: &[String],
) -> HashMap<String, String> {
    let mut role_map: HashMap<&str, Vec<&str>> = HashMap::new();
    for membership in memberships {
        role_map
            .entry(membership.group_name.as_str())
            .or_default()
            .push(membership.role.as_str());
    }
    let mut effective: HashMap<String, String> = HashMap::new();
    for group_name in group_names {
        let mut roles: Vec<&str> = role_map
            .get(group_name.as_str())
            .cloned()
            .unwrap_or_default();
        if roles.is_empty() && group_name.contains('/') {
            let parts: Vec<&str> = group_name.split('/').collect();
            for index in (1..parts.len()).rev() {
                let parent = parts[..index].join("/");
                if let Some(parent_roles) = role_map.get(parent.as_str()) {
                    roles = parent_roles.clone();
                    break;
                }
            }
        }
        if let Some(role) = highest_role(
            &roles
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<String>>(),
        ) {
            effective.insert(group_name.clone(), role);
        }
    }
    effective
}

/// `app.services.team_access_policy.should_redact_team_for_user`: whether a
/// team response must hide its private agent configuration from the
/// requesting user.
///
/// Every API whose response renders a team shares this check
/// (`get_task_detail` and the remote-workspace endpoints), so it lives with
/// the membership resolution it builds on rather than inside one of those
/// callers.
///
/// Short-circuits for the team owner or a `default`-namespace team; otherwise
/// it resolves the user's effective group roles (`get_user_group_roles`) and
/// then the restricted-analyst namespace checks. The caller maps the
/// dependency error into its own response error.
pub async fn should_redact_team_for_user<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &ErpContext<'_, R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
    team_id: i64,
    team_user_id: i64,
    team_namespace: &str,
) -> Result<bool, brz_mysql::MysqlError>
where
    M: Mysql,
{
    if team_user_id == user_id || team_namespace == "default" {
        return Ok(false);
    }
    // `get_user_group_roles`: active namespace names, then
    // `get_effective_roles_in_groups` (direct + entity memberships).
    let resolved = user_group_memberships(mysql, erp, resolvers, user_id).await?;
    let roles = effective_roles(&resolved.memberships, &resolved.active_names);
    let restricted: Vec<&str> = roles
        .iter()
        .filter(|(_, role)| role.as_str() == "RestrictedAnalyst")
        .map(|(name, _)| name.as_str())
        .collect();
    if restricted.contains(&team_namespace) {
        return Ok(true);
    }
    if restricted.is_empty() {
        return Ok(false);
    }
    // Restricted namespaces' active ids (`Namespace.id.in_(names)`).
    let mut sorted: Vec<String> = restricted.iter().map(|name| name.to_string()).collect();
    sorted.sort();
    let namespace_ids = repo::namespace_ids_by_names(mysql, &sorted).await?;
    if namespace_ids.is_empty() {
        return Ok(false);
    }
    // Approved team member rows bound to those namespaces.
    Ok(
        team_member_bound_to_namespaces(mysql, team_id, &namespace_ids)
            .await?
            .is_some(),
    )
}

/// The `should_redact_team_for_user` tail query: one approved
/// `resource_members` row of the team bound to a restricted namespace.
async fn team_member_bound_to_namespaces<M>(
    mysql: &M,
    team_id: i64,
    namespace_ids: &[i64],
) -> Result<Option<i64>, brz_mysql::MysqlError>
where
    M: Mysql,
{
    if namespace_ids.is_empty() {
        return Ok(None);
    }
    let placeholders = vec!["?"; namespace_ids.len()].join(", ");
    #[derive(brz_mysql::FromMysqlRow)]
    struct Row {
        resource_members_id: i64,
    }
    let mut args: Vec<repo::BindingArg> = Vec::with_capacity(namespace_ids.len() + 3);
    args.push(repo::BindingArg::Int(team_id));
    args.push(repo::BindingArg::Str("Team".to_owned()));
    args.push(repo::BindingArg::Str("TEAM".to_owned()));
    args.push(repo::BindingArg::Str("namespace".to_owned()));
    args.extend(
        namespace_ids
            .iter()
            .map(|id| repo::BindingArg::Str(id.to_string())),
    );
    args.push(repo::BindingArg::Str("approved".to_owned()));
    args.push(repo::BindingArg::Str("APPROVED".to_owned()));
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT resource_members.id AS resource_members_id \
                 FROM resource_members \
                 WHERE resource_members.resource_id = ? \
                 AND resource_members.resource_type IN (?, ?) \
                 AND resource_members.entity_type = ? \
                 AND resource_members.entity_id IN ({placeholders}) \
                 AND resource_members.status IN (?, ?) \
                 LIMIT 1"
            ),
            args,
        )
        .await?;
    Ok(row.map(|row| row.resource_members_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn membership(name: &str, role: &str) -> GroupMembership {
        GroupMembership {
            group_name: name.to_string(),
            role: role.to_string(),
        }
    }

    #[test]
    fn permission_hierarchy() {
        assert!(has_permission("Owner", "Reporter"));
        assert!(has_permission("Developer", "Developer"));
        assert!(!has_permission("Reporter", "Developer"));
        assert!(has_permission("Reporter", "RestrictedAnalyst"));
        assert!(!has_permission("Unknown", "Reporter"));
    }

    #[test]
    fn viewer_ranks_between_reporter_and_restricted_analyst() {
        // `app.schemas.base_role.ROLE_HIERARCHY`: Viewer=4 sits below
        // Reporter=3 and above RestrictedAnalyst=5.
        assert!(has_permission("Viewer", "Viewer"));
        assert!(!has_permission("Viewer", "Reporter"));
        assert!(has_permission("Reporter", "Viewer"));
        assert!(!has_permission("RestrictedAnalyst", "Viewer"));
        assert_eq!(
            highest_role(&["RestrictedAnalyst".into(), "Viewer".into()]),
            Some("Viewer".to_string())
        );
    }

    #[test]
    fn team_use_role_admits_every_recognised_group_role() {
        // `TEAM_USE_ROLE` is the least privileged role, so a
        // `RestrictedAnalyst` group namespace still authorises team access
        // (`_get_accessible_authorization_namespace_ids`).
        let groups = vec![
            "open".to_string(),
            "restricted".to_string(),
            "foreign".to_string(),
        ];
        let effective = HashMap::from([
            ("open".to_string(), "Reporter".to_string()),
            ("restricted".to_string(), "RestrictedAnalyst".to_string()),
        ]);
        assert_eq!(
            accessible_authorization_namespaces(&groups, &effective),
            vec!["open".to_string(), "restricted".to_string()]
        );
        assert_eq!(TEAM_USE_ROLE, "RestrictedAnalyst");
    }

    #[test]
    fn inherits_parent_group_roles() {
        let memberships = vec![membership("aaa", "Developer")];
        let roles = effective_roles(&memberships, &["aaa/bbb".to_string(), "ccc".to_string()]);
        assert_eq!(roles.get("aaa/bbb").map(String::as_str), Some("Developer"));
        assert!(!roles.contains_key("ccc"));
    }

    #[test]
    fn direct_roles_win_over_inherited() {
        let memberships = vec![
            membership("aaa", "Reporter"),
            membership("aaa/bbb", "Owner"),
        ];
        let roles = effective_roles(&memberships, &["aaa/bbb".to_string()]);
        assert_eq!(roles.get("aaa/bbb").map(String::as_str), Some("Owner"));
    }

    #[test]
    fn highest_role_wins() {
        let memberships = vec![
            membership("grp", "Reporter"),
            membership("grp", "Maintainer"),
        ];
        let roles = effective_roles(&memberships, &["grp".to_string()]);
        assert_eq!(roles.get("grp").map(String::as_str), Some("Maintainer"));
    }
}
