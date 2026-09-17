// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Group membership resolution for `GET /api/teams`, mirroring
//! `app.services.group_permission.get_user_group_roles` /
//! `get_effective_roles_in_groups` and the entity resolvers they invoke
//! (`NamespaceEntityResolver` plus an optional employee-directory provider).
use std::collections::HashMap;

use brz_mysql::Mysql;

use super::teams_repository as repo;
use crate::erp_provider::ErpProvider;

/// The employee-directory provider and optional cache handle used by entity
/// resolution. Cache keys and upstream transport details belong to the
/// injected provider, so the shared crate has no internal cache format.
#[derive(Clone, Copy)]
pub struct ErpContext<'a, R: brz_redis::Redis = brz_redis::RedisService> {
    pub erp: &'a dyn ErpProvider<R>,
    pub redis: Option<&'a R>,
}

/// Role hierarchy (`app.schemas.base_role.ROLE_HIERARCHY`); lower is more
/// privileged.
fn role_rank(role: &str) -> Option<u8> {
    match role {
        "Owner" => Some(0),
        "Maintainer" => Some(1),
        "Developer" => Some(2),
        "Reporter" => Some(3),
        "RestrictedAnalyst" => Some(4),
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
pub async fn user_group_memberships<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    user_id: i64,
) -> Result<ResolvedMemberships, brz_mysql::MysqlError>
where
    M: Mysql,
{
    // `get_user_group_roles` first loads every active namespace name, then
    // resolves effective roles through `get_effective_roles_in_groups`. The
    // namespace-name query is part of the recorded dependency sequence.
    let group_names = repo::active_namespace_names(mysql).await?;
    let memberships = iter_user_groups_with_roles(mysql, erp, user_id).await?;
    Ok(ResolvedMemberships {
        memberships,
        active_names: group_names,
    })
}

/// `iter_user_groups_with_roles` (`group_member_helper`): the raw direct +
/// entity-derived membership fetch. `get_effective_roles_in_groups` calls
/// this with the caller's group names and no active-namespace listing, so
/// unlike `user_group_memberships` no namespace-name query is issued.
pub async fn iter_user_groups_with_roles<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    user_id: i64,
) -> Result<Vec<GroupMembership>, brz_mysql::MysqlError>
where
    M: Mysql,
{
    // Step 1: direct user memberships of active namespaces. The source keeps
    // the raw membership row order (including duplicates) for the namespace
    // id list.
    let direct = repo::direct_namespace_memberships(mysql, user_id).await?;
    let namespace_ids: Vec<i64> = direct
        .iter()
        .map(|member| member.resource_members_resource_id)
        .collect();
    let namespaces = repo::namespaces_by_ids(mysql, &namespace_ids).await?;
    let name_by_id: HashMap<i64, String> = namespaces
        .iter()
        .map(|namespace| (namespace.namespace_id, namespace.namespace_name.clone()))
        .collect();

    // group_name -> collected roles
    let mut role_map: HashMap<String, Vec<String>> = HashMap::new();
    for member in &direct {
        if let Some(name) = name_by_id.get(&member.resource_members_resource_id) {
            role_map
                .entry(name.clone())
                .or_default()
                .push(member.resource_members_role.clone());
        }
    }

    // Step 2: entity-derived memberships. The source iterates the registered
    // entity resolvers: first `namespace` (NamespaceEntityResolver), then the
    // configured external directory resolver.
    //
    // NamespaceEntityResolver: direct ns ids, then external bindings
    // matched through the ERP resolver, then namespace-entity grants.
    let direct_ns_ids = repo::direct_namespace_resource_ids(mysql, user_id).await?;
    let entity_type = erp.erp.entity_type();
    let org_bindings = if let Some(entity_type) = entity_type {
        repo::external_namespace_bindings(mysql, entity_type).await?
    } else {
        Vec::new()
    };
    let mut entity_ns_ids: Vec<i64> = Vec::new();
    if !org_bindings.is_empty() {
        // ErpEntityResolver.match_entity_bindings: resolve the user's ssn,
        // then check membership through the provider (`entity_ids` is the
        // deduplicated department list).
        let ssn = erp.erp.employee_id(user_id).await?;
        if let Some(ssn) = ssn {
            let mut department_ids: Vec<String> = org_bindings
                .iter()
                .map(|(_, entity_id)| entity_id.clone())
                .collect();
            department_ids.sort();
            department_ids.dedup();
            let matched =
                DirectoryMembership::matched_departments(erp, user_id, &ssn, &department_ids).await;
            if !matched.is_empty() {
                // `NamespaceEntityResolver.get_resource_ids_by_entity`
                // re-uses the already-fetched org-department bindings
                // (`for ns_id, eid in ns_with_entity: if eid in eid_set`)
                // instead of re-querying resource_members by department, so
                // the matched namespace ids come straight from
                // `org_bindings`. The distinct dept→ns-ids query belongs to
                // the ErpEntityResolver pass below.
                let matched_set: std::collections::HashSet<&str> =
                    matched.iter().map(String::as_str).collect();
                entity_ns_ids.extend(
                    org_bindings
                        .iter()
                        .filter(|(_, entity_id)| matched_set.contains(entity_id.as_str()))
                        .map(|(ns_id, _)| *ns_id),
                );
            }
        }
    }
    // `list(set(direct_ns_ids) | entity_ns_ids)`: the IN-list order of the
    // namespace-entity grant query. The engine's MySQL matcher compares
    // IN-list literals as multisets, so the target
    // emits a deterministic deduplicated order without reproducing CPython's
    // set-union table order.
    let mut all_ns_ids: Vec<i64> = direct_ns_ids.clone();
    all_ns_ids.extend(entity_ns_ids.iter().copied());
    all_ns_ids.sort_unstable();
    all_ns_ids.dedup();
    // Namespace-entity grants over the combined ns ids.
    let _grants = repo::namespace_entity_resource_ids(mysql, &all_ns_ids).await?;

    // External resolver get_resource_ids_by_entity:
    // distinct departments, membership check, then namespace ids.
    let distinct_departments = if let Some(entity_type) = entity_type {
        repo::distinct_external_entity_ids(mysql, entity_type).await?
    } else {
        Vec::new()
    };
    let mut erp_ns_ids: Vec<i64> = Vec::new();
    if !distinct_departments.is_empty() {
        let ssn = erp.erp.employee_id(user_id).await?;
        if let Some(ssn) = ssn {
            let matched =
                DirectoryMembership::matched_departments(erp, user_id, &ssn, &distinct_departments)
                    .await;
            if !matched.is_empty() {
                erp_ns_ids = repo::namespace_ids_for_external_entities(
                    mysql,
                    entity_type.unwrap_or("external"),
                    &matched,
                )
                .await?;
            }
        }
    }
    if !erp_ns_ids.is_empty() {
        let members = repo::external_members_for_namespaces(
            mysql,
            entity_type.unwrap_or("external"),
            &erp_ns_ids,
        )
        .await?;
        // The source passes the raw entity-member row ids (duplicates
        // included) to the namespace lookup.
        let entity_namespace_ids: Vec<i64> = members
            .iter()
            .map(|member| member.resource_members_resource_id)
            .collect();
        let entity_namespaces = repo::namespaces_by_ids(mysql, &entity_namespace_ids).await?;
        let entity_name_by_id: HashMap<i64, String> = entity_namespaces
            .iter()
            .map(|namespace| (namespace.namespace_id, namespace.namespace_name.clone()))
            .collect();
        for member in &members {
            if let Some(name) = entity_name_by_id.get(&member.resource_members_resource_id) {
                role_map
                    .entry(name.clone())
                    .or_default()
                    .push(member.resource_members_role.clone());
            }
        }
    }

    // Effective roles: highest role per group (direct entries only; parent
    // inheritance applies to groups without their own entries).
    let mut memberships = Vec::with_capacity(role_map.len());
    for (group_name, roles) in role_map {
        if let Some(role) = highest_role(&roles) {
            memberships.push(GroupMembership { group_name, role });
        }
    }
    Ok(memberships)
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
