// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Group-membership resolution for the knowledge-base ACL
//! (`app.services.group_permission.get_effective_roles_in_groups` /
//! `get_effective_role_in_group` and
//! `app.services.group_member_helper.iter_user_groups_with_roles`),
//! including the entity resolvers (`NamespaceEntityResolver`,
//! registered external entity resolvers)
//! and parent-group inheritance.
use brz_mysql::{Mysql, MysqlResult};

use super::access::{
    DeptBindingRow, EntityIdRow, EntityRoleRow, IdRow, MEMBER_COLUMNS, MemberRow,
    NAMESPACE_COLUMNS, NamespaceRow, highest_role, namespaces_by_ids, quote_literal,
    resolve_entity_roles,
};

/// `is_restricted_analyst(db, user_id, group_name)` ->
/// `get_restricted_analyst_groups` ->
/// `get_effective_roles_in_groups(db, user_id, [group_name])` ->
/// `iter_user_groups_with_roles(db, user_id)`: the full membership batch.
pub(crate) async fn is_restricted_analyst<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
    group_name: &str,
) -> MysqlResult<bool>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let memberships = user_group_memberships(mysql, redis, resolvers, user_id).await?;
    let effective = effective_roles(&memberships, &[group_name.to_string()]);
    Ok(effective
        .get(group_name)
        .is_some_and(|role| role == "RestrictedAnalyst"))
}

/// One resolved group membership (`iter_user_groups_with_roles` entry).
pub(super) struct GroupMembership {
    pub(super) group_name: String,
    pub(super) role: String,
}

/// `iter_user_groups_with_roles(db, user_id)`: direct user memberships of
/// active namespaces plus entity-derived memberships through the
/// registered resolvers (`namespace` then `external entity`).
async fn user_group_memberships<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
) -> MysqlResult<Vec<GroupMembership>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    // Step 1: direct user memberships of active namespaces.
    let direct: Vec<MemberRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{}' \
                 AND resource_members.status = 'approved'",
                user_id
            ),
            (),
        )
        .await?;
    let namespace_ids: Vec<i64> = direct
        .iter()
        .map(|member| member.resource_members_resource_id)
        .collect();
    let namespaces = namespaces_by_ids(mysql, &namespace_ids).await?;
    let mut role_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for member in &direct {
        if let Some(name) = namespaces
            .iter()
            .find(|row| row.namespace_id == member.resource_members_resource_id)
        {
            role_map
                .entry(name.namespace_name.clone())
                .or_default()
                .push(member.resource_members_role.clone());
        }
    }

    // Step 2a: `NamespaceEntityResolver.get_resource_ids_by_entity` —
    // direct namespace resource ids, external entity bindings, resolver
    // matched departments, then the namespace-entity grant query.
    let direct_ns_ids: Vec<IdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{}' \
                 AND resource_members.status = 'approved'",
                user_id
            ),
            (),
        )
        .await?;
    let mut entity_ns_ids: Vec<i64> = Vec::new();
    for entity_type in resolvers.external_types() {
        let entity_type_sql = quote_literal(entity_type);
        // `db.query(ResourceMember.resource_id, ResourceMember.entity_id)`
        // for `external entity` bindings — a two-column result set.
        let org_bindings: Vec<DeptBindingRow> = mysql
            .fetch_all(
                &format!(
                    "SELECT resource_members.resource_id AS resource_members_resource_id, \
             resource_members.entity_id AS resource_members_entity_id \nFROM resource_members \n\
             WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.entity_type = {entity_type_sql} \
             AND resource_members.status = 'approved'"
                ),
                (),
            )
            .await?;
        if !org_bindings.is_empty() {
            let department_ids: Vec<String> = org_bindings
                .iter()
                .map(|row| row.resource_members_entity_id.clone())
                .collect();
            let matched = resolvers
                .match_bindings(
                    redis,
                    user_id,
                    entity_type,
                    &department_ids,
                    crate::permissions::ResolutionPurpose::CachedResourceAccess,
                )
                .await?;
            if !matched.is_empty() {
                let matched_set: std::collections::HashSet<&str> =
                    matched.iter().map(String::as_str).collect();
                entity_ns_ids.extend(
                    org_bindings
                        .iter()
                        .filter(|row| matched_set.contains(row.resource_members_entity_id.as_str()))
                        .map(|row| row.resource_members_resource_id),
                );
            }
        }
    }
    let mut all_ns_ids: Vec<i64> = direct_ns_ids
        .iter()
        .map(|row| row.resource_members_resource_id)
        .collect();
    all_ns_ids.extend(entity_ns_ids.iter().copied());
    all_ns_ids.sort_unstable();
    all_ns_ids.dedup();
    if !all_ns_ids.is_empty() {
        let quoted = all_ns_ids
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let _grants: Vec<IdRow> = mysql
            .fetch_all(
                &format!(
                    "SELECT resource_members.resource_id AS resource_members_resource_id \n\
                     FROM resource_members \n\
                     WHERE resource_members.resource_type IN ('Namespace') \
                     AND resource_members.entity_type = 'namespace' \
                     AND resource_members.entity_id IN ({quoted}) \
                     AND resource_members.status = 'approved'"
                ),
                (),
            )
            .await?;
    }

    let mut erp_ns_ids: Vec<i64> = Vec::new();
    for entity_type in resolvers.external_types() {
        let entity_type_sql = quote_literal(entity_type);
        // Step 2b: `EntityResolver.get_resource_ids_by_entity` for
        // `external entity` — distinct departments, membership check, then
        // namespace ids and entity member rows.
        let distinct_departments: Vec<EntityIdRow> = mysql
            .fetch_all(
                &format!(
                    "SELECT DISTINCT resource_members.entity_id AS resource_members_entity_id \n\
             FROM resource_members \n\
             WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.entity_type = {entity_type_sql} \
             AND resource_members.entity_id IS NOT NULL \
             AND resource_members.status = 'approved'"
                ),
                (),
            )
            .await?;
        if !distinct_departments.is_empty() {
            let department_ids: Vec<String> = distinct_departments
                .into_iter()
                .map(|row| row.resource_members_entity_id)
                .collect();
            let matched = resolvers
                .match_bindings(
                    redis,
                    user_id,
                    entity_type,
                    &department_ids,
                    crate::permissions::ResolutionPurpose::CachedResourceAccess,
                )
                .await?;
            if !matched.is_empty() {
                let quoted = matched
                    .iter()
                    .map(|id| quote_literal(id))
                    .collect::<Vec<_>>()
                    .join(", ");
                let resolved_ids = mysql
                    .fetch_all(
                        &format!(
                            "SELECT resource_members.resource_id AS resource_members_resource_id \n\
                             FROM resource_members \n\
                             WHERE resource_members.resource_type IN ('Namespace') \
                             AND resource_members.entity_type = 'namespace' \
                             AND resource_members.entity_id IN ({quoted}) \
                             AND resource_members.status = 'approved'"
                        ),
                        (),
                    )
                    .await?
                    .into_iter()
                    .map(|row: IdRow| row.resource_members_resource_id)
                    .collect::<Vec<_>>();
                erp_ns_ids.extend(resolved_ids);
            }
        }
    }
    if !erp_ns_ids.is_empty() {
        let members: Vec<MemberRow> = mysql
            .fetch_all(
                &format!(
                    "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                     WHERE resource_members.resource_type IN ('Namespace') \
                     AND resource_members.entity_type = 'namespace' \
                     AND resource_members.resource_id IN ({}) \
                     AND resource_members.status = 'approved'",
                    erp_ns_ids
                        .iter()
                        .map(|id| id.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                (),
            )
            .await?;
        let member_namespace_ids: Vec<i64> = members
            .iter()
            .map(|member| member.resource_members_resource_id)
            .collect();
        let entity_namespaces = namespaces_by_ids(mysql, &member_namespace_ids).await?;
        for member in &members {
            if let Some(name) = entity_namespaces
                .iter()
                .find(|row| row.namespace_id == member.resource_members_resource_id)
            {
                role_map
                    .entry(name.namespace_name.clone())
                    .or_default()
                    .push(member.resource_members_role.clone());
            }
        }
    }

    let mut memberships = Vec::with_capacity(role_map.len());
    for (group_name, roles) in role_map {
        if let Some(role) = highest_role(&roles) {
            memberships.push(GroupMembership { group_name, role });
        }
    }
    Ok(memberships)
}

/// `get_effective_roles_in_groups`: direct/entity roles plus parent-group
/// inheritance for groups without their own entries.
pub(super) fn effective_roles(
    memberships: &[GroupMembership],
    group_names: &[String],
) -> std::collections::HashMap<String, String> {
    let mut role_map: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for membership in memberships {
        role_map
            .entry(membership.group_name.as_str())
            .or_default()
            .push(membership.role.as_str());
    }
    let mut effective = std::collections::HashMap::new();
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

/// `get_effective_role_in_group(db, user_id, group_name)` (the ACL group
/// source): direct role, entity-derived roles, then parent inheritance.
pub(crate) async fn effective_role_in_group<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
    group_name: &str,
) -> MysqlResult<Option<String>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let mut candidates: Vec<String> = Vec::new();

    // 1) Direct user membership
    // (`get_user_role_in_group` -> `get_group_member`).
    let namespace = active_namespace_by_name_exact(mysql, group_name).await?;
    if let Some(namespace) = &namespace {
        let member: Option<MemberRow> = mysql
            .fetch_optional(
                &format!(
                    "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                     WHERE resource_members.resource_type = 'Namespace' \
                     AND resource_members.resource_id = {} \
                     AND resource_members.entity_type = 'user' \
                     AND resource_members.entity_id = '{}' \
                     AND resource_members.status = 'approved' \n LIMIT 1",
                    namespace.namespace_id, user_id
                ),
                (),
            )
            .await?;
        if let Some(member) = member
            && !member.resource_members_role.is_empty()
        {
            candidates.push(member.resource_members_role);
        }
    }

    // 2) Entity-derived roles in the namespace
    // (`_resolve_entity_roles_in_namespace` -> `resolve_entity_roles_for_resource`).
    // The source resolves the namespace id a second time here
    // (`get_effective_role_in_group` re-reads it after
    // `get_user_role_in_group`'s own lookup), so the exact-name query
    // repeats before the entity scan.
    let namespace = match namespace {
        Some(namespace) => {
            let recheck = active_namespace_by_name_exact(mysql, group_name).await?;
            if recheck.is_none() {
                None
            } else {
                Some(namespace)
            }
        }
        None => None,
    };
    if let Some(namespace) = &namespace {
        let rows: Vec<EntityRoleRow> = mysql
            .fetch_all(
                &format!(
                    "SELECT resource_members.entity_type AS resource_members_entity_type, \
                     resource_members.entity_id AS resource_members_entity_id, \
                     resource_members.`role` AS resource_members_role \nFROM resource_members \n\
                     WHERE resource_members.resource_type IN ('Namespace') \
                     AND resource_members.resource_id = {} \
                     AND (resource_members.entity_type NOT IN ('', 'namespace', 'user')) \
                     AND resource_members.entity_id IS NOT NULL \
                     AND resource_members.status IN ('approved')",
                    namespace.namespace_id
                ),
                (),
            )
            .await?;
        candidates.extend(resolve_entity_roles(mysql, redis, resolvers, user_id, &rows).await?);
    }

    // 3) Parent-group inheritance (only without a direct/entity hit): walk
    // from the nearest parent upward; the first parent with its own
    // direct/entity role contributes its highest role.
    if candidates.is_empty() && group_name.contains('/') {
        let parts: Vec<&str> = group_name.split('/').collect();
        for index in (1..parts.len()).rev() {
            let parent = parts[..index].join("/");
            let parent_namespace = active_namespace_by_name_exact(mysql, &parent).await?;
            let Some(parent_namespace) = parent_namespace else {
                continue;
            };
            let mut parent_candidates: Vec<String> = Vec::new();
            let member: Option<MemberRow> = mysql
                .fetch_optional(
                    &format!(
                        "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                         WHERE resource_members.resource_type = 'Namespace' \
                         AND resource_members.resource_id = {} \
                         AND resource_members.entity_type = 'user' \
                         AND resource_members.entity_id = '{}' \
                         AND resource_members.status = 'approved' \n LIMIT 1",
                        parent_namespace.namespace_id, user_id
                    ),
                    (),
                )
                .await?;
            if let Some(member) = member
                && !member.resource_members_role.is_empty()
            {
                parent_candidates.push(member.resource_members_role);
            }
            let rows: Vec<EntityRoleRow> = mysql
                .fetch_all(
                    &format!(
                        "SELECT resource_members.entity_type AS resource_members_entity_type, \
                         resource_members.entity_id AS resource_members_entity_id, \
                         resource_members.`role` AS resource_members_role \nFROM resource_members \n\
                         WHERE resource_members.resource_type IN ('Namespace') \
                         AND resource_members.resource_id = {} \
                         AND (resource_members.entity_type NOT IN ('', 'namespace', 'user')) \
                         AND resource_members.entity_id IS NOT NULL \
                         AND resource_members.status IN ('approved')",
                        parent_namespace.namespace_id
                    ),
                    (),
                )
                .await?;
            parent_candidates
                .extend(resolve_entity_roles(mysql, redis, resolvers, user_id, &rows).await?);
            if let Some(role) = highest_role(&parent_candidates) {
                candidates.push(role);
                break;
            }
        }
    }

    Ok(highest_role(&candidates))
}

/// `get_namespace_id_by_name`: the exact-name active namespace lookup
/// (`name = ? AND is_active = 1 LIMIT 1`).
async fn active_namespace_by_name_exact<M>(
    mysql: &M,
    name: &str,
) -> MysqlResult<Option<NamespaceRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \n\
                 WHERE namespace.name = {} AND namespace.is_active = 1 \n LIMIT 1",
                quote_literal(name)
            ),
            (),
        )
        .await
}
