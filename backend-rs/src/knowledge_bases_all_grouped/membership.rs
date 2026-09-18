// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Membership resolution for `GET /api/knowledge-bases/all-grouped`:
//! `iter_user_groups_with_roles`, the effective-role computation, and the
//! entity-authorized knowledge-base collection.
use std::collections::{HashMap, HashSet};

use brz_mysql::{Mysql, MysqlResult};

use crate::permissions::{EntityResolvers, ResolutionPurpose};

use super::py_order::PySetOrder;
use super::queries::{
    NamespaceActiveForm, direct_namespace_memberships, direct_namespace_resource_ids, group_member,
    kinds_by_filter, namespace_by_name_exact, namespace_entity_kb_members,
    namespace_entity_resource_ids, namespace_entity_roles, namespaces_by_ids, namespaces_by_names,
};
use super::{
    APPROVED_STATUSES, EntityIdRow, EntityMemberRow, IdRow, KB_RESOURCE_TYPES, KindRow,
    MEMBER_COLUMNS, MemberRow, highest_role, quote_literal,
};

#[derive(Debug, brz_mysql::FromMysqlRow)]
struct ExternalBindingRow {
    resource_members_resource_id: i64,
    resource_members_entity_id: String,
}

async fn external_namespace_bindings<M: Mysql>(
    mysql: &M,
    entity_type: &str,
) -> MysqlResult<Vec<(i64, String)>> {
    let rows: Vec<ExternalBindingRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id, \
                 resource_members.entity_id AS resource_members_entity_id \
                 FROM resource_members WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.entity_type = {} AND resource_members.status = 'approved'",
                quote_literal(entity_type)
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.resource_members_resource_id,
                row.resource_members_entity_id,
            )
        })
        .collect())
}

async fn distinct_external_entity_ids<M: Mysql>(
    mysql: &M,
    entity_type: &str,
) -> MysqlResult<Vec<String>> {
    let rows: Vec<EntityIdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT DISTINCT resource_members.entity_id AS resource_members_entity_id \
                 FROM resource_members WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.entity_type = {} AND resource_members.entity_id IS NOT NULL \
                 AND resource_members.status = 'approved'",
                quote_literal(entity_type)
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_entity_id)
        .collect())
}

async fn namespace_ids_for_external_ids<M: Mysql>(
    mysql: &M,
    entity_type: &str,
    entity_ids: &[String],
) -> MysqlResult<Vec<i64>> {
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = entity_ids
        .iter()
        .map(|id| quote_literal(id))
        .collect::<Vec<_>>()
        .join(", ");
    let rows: Vec<IdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id \
                 FROM resource_members WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.entity_type = {} \
                 AND resource_members.entity_id IN ({ids}) AND resource_members.status = 'approved'",
                quote_literal(entity_type),
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

async fn external_members_for_namespaces<M: Mysql>(
    mysql: &M,
    entity_type: &str,
    namespace_ids: &[i64],
) -> MysqlResult<Vec<MemberRow>> {
    if namespace_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = namespace_ids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {MEMBER_COLUMNS} FROM resource_members \
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.entity_type = {} \
                 AND resource_members.resource_id IN ({ids}) \
                 AND resource_members.status = 'approved'",
                quote_literal(entity_type),
            ),
            (),
        )
        .await
}
// ---------------------------------------------------------------------------
// Membership resolution (entity resolvers)
// ---------------------------------------------------------------------------

/// Resolve the user's group memberships
/// (`iter_user_groups_with_roles`): direct user memberships plus
/// entity-derived memberships through the registered resolvers
/// (`namespace`, then registered external entity types).
///
/// Returns `(group_name -> highest role)` in first-appearance order of the
/// direct memberships.
/// Returns `(group_name -> roles)` entries in the source
/// `group_entries` dict insertion order: direct memberships first (member
/// row order mapped through the namespace query), then entity-derived
/// memberships (`get_user_groups_with_roles` preserves this order for the
/// `groups` section rendering).
pub(super) async fn user_group_role_map<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
) -> MysqlResult<Vec<(String, Vec<String>)>>
where
    M: Mysql,
{
    // 1) Direct user memberships.
    let direct = direct_namespace_memberships(mysql, user_id).await?;
    let namespace_ids: Vec<i64> = direct
        .iter()
        .map(|member| member.resource_members_resource_id)
        .collect();
    let namespaces = namespaces_by_ids(mysql, &namespace_ids).await?;
    let name_by_id: HashMap<i64, String> = namespaces
        .iter()
        .map(|namespace| (namespace.namespace_id, namespace.namespace_name.clone()))
        .collect();
    let mut role_map: Vec<(String, Vec<String>)> = Vec::new();
    let push_role = |role_map: &mut Vec<(String, Vec<String>)>, name: &str, role: &str| {
        if let Some(entry) = role_map.iter_mut().find(|(key, _)| key == name) {
            entry.1.push(role.to_string());
        } else {
            role_map.push((name.to_string(), vec![role.to_string()]));
        }
    };
    for member in &direct {
        if let Some(name) = name_by_id.get(&member.resource_members_resource_id) {
            push_role(&mut role_map, name, &member.resource_members_role);
        }
    }

    // 2a) NamespaceEntityResolver.get_resource_ids_by_entity.
    let direct_ns_ids = direct_namespace_resource_ids(mysql, user_id).await?;
    let mut entity_ns_ids: Vec<i64> = Vec::new();
    for entity_type in resolvers.external_types() {
        let bindings = external_namespace_bindings(mysql, entity_type).await?;
        if bindings.is_empty() {
            continue;
        }
        // `entity_ids = list(set(eid for _, eid in ns_with_entity))`:
        // the deduplicated department list (deterministic order; the
        // replay matcher compares the HTTP JSON arrays as multisets).
        let mut department_ids: Vec<String> = bindings
            .iter()
            .map(|(_, entity_id)| entity_id.clone())
            .collect();
        department_ids.sort();
        department_ids.dedup();
        let matched = resolvers
            .match_bindings(
                redis,
                user_id,
                entity_type,
                &department_ids,
                ResolutionPurpose::CachedResourceAccess,
            )
            .await?;
        if !matched.is_empty() {
            let matched_set: HashSet<&str> = matched.iter().map(String::as_str).collect();
            entity_ns_ids.extend(
                bindings
                    .iter()
                    .filter(|(_, entity_id)| matched_set.contains(entity_id.as_str()))
                    .map(|(resource_id, _)| *resource_id),
            );
        }
    }
    let mut all_ns_ids: Vec<i64> = direct_ns_ids;
    all_ns_ids.extend(entity_ns_ids);
    all_ns_ids.sort_unstable();
    all_ns_ids.dedup();
    let _grants = namespace_entity_resource_ids(mysql, &all_ns_ids).await?;

    // 2b) Each registered external resolver contributes namespace grants.
    for entity_type in resolvers.external_types() {
        let bindings = distinct_external_entity_ids(mysql, entity_type).await?;
        if bindings.is_empty() {
            continue;
        }
        let matched = resolvers
            .match_bindings(
                redis,
                user_id,
                entity_type,
                &bindings,
                ResolutionPurpose::CachedResourceAccess,
            )
            .await?;
        if !matched.is_empty() {
            let namespace_ids =
                namespace_ids_for_external_ids(mysql, entity_type, &matched).await?;
            if !namespace_ids.is_empty() {
                let members =
                    external_members_for_namespaces(mysql, entity_type, &namespace_ids).await?;
                let member_namespace_ids: Vec<i64> = members
                    .iter()
                    .map(|member| member.resource_members_resource_id)
                    .collect();
                let entity_namespaces = namespaces_by_ids(mysql, &member_namespace_ids).await?;
                for member in &members {
                    if let Some(namespace) = entity_namespaces
                        .iter()
                        .find(|row| row.namespace_id == member.resource_members_resource_id)
                    {
                        push_role(
                            &mut role_map,
                            &namespace.namespace_name,
                            &member.resource_members_role,
                        );
                    }
                }
            }
        }
    }

    Ok(role_map)
}

/// `get_effective_roles_in_groups`: direct/entity roles plus parent-group
/// inheritance for groups without their own roles.
pub(super) fn effective_roles(
    role_map: &[(String, Vec<String>)],
    group_names: &[String],
) -> HashMap<String, String> {
    let lookup = |name: &str| -> Option<Vec<String>> {
        role_map
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, roles)| roles.clone())
    };
    let mut effective: HashMap<String, String> = HashMap::new();
    for group_name in group_names {
        let mut roles: Vec<String> = lookup(group_name).unwrap_or_default();
        if roles.is_empty() && group_name.contains('/') {
            let parts: Vec<&str> = group_name.split('/').collect();
            for index in (1..parts.len()).rev() {
                let parent = parts[..index].join("/");
                if let Some(parent_roles) = lookup(&parent) {
                    roles = parent_roles;
                    break;
                }
            }
        }
        if let Some(role) = highest_role(&roles) {
            effective.insert(group_name.clone(), role);
        }
    }
    effective
}

/// `get_effective_role_in_group` (used by `get_view_role_in_group`):
/// direct role, entity-derived roles, then parent inheritance.
pub(super) async fn effective_role_in_group<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    group_name: &str,
) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    let mut candidates: Vec<String> = Vec::new();

    // 1) `get_user_role_in_group` -> `get_group_member` ->
    //    `get_namespace_id_by_name` (the first name lookup).
    let namespace = namespace_by_name_exact(mysql, group_name).await?;
    if let Some(namespace) = &namespace
        && let Some(member) = group_member(mysql, namespace.namespace_id, user_id).await?
        && !member.resource_members_role.is_empty()
    {
        candidates.push(member.resource_members_role);
    }

    // 2) `_resolve_entity_roles_in_namespace`: the source resolves the
    // namespace id again at the top of `get_effective_role_in_group`
    // (`namespace_id = get_namespace_id_by_name(db, group_name)`), issuing a
    // second identical name lookup per call.
    if let Some(namespace) = namespace_by_name_exact(mysql, group_name).await? {
        let rows = namespace_entity_roles(mysql, namespace.namespace_id).await?;
        candidates.extend(
            resolve_entity_roles(mysql, redis, resolvers, user_id, &rows)
                .await?
                .into_iter()
                .map(|(_, _, role)| role),
        );
    }

    // 3) Parent-group inheritance.
    if candidates.is_empty() && group_name.contains('/') {
        let parts: Vec<&str> = group_name.split('/').collect();
        for index in (1..parts.len()).rev() {
            let parent = parts[..index].join("/");
            if let Some(role) = Box::pin(effective_role_in_group(
                mysql, redis, resolvers, user_id, &parent,
            ))
            .await?
            {
                candidates.push(role);
                break;
            }
        }
    }

    Ok(highest_role(&candidates))
}

/// `resolve_entity_roles_for_resource` tail: match the entity rows through
/// the registered resolvers and return `(entity_type, entity_id, role)` of
/// the matched rows.
pub(super) async fn resolve_entity_roles<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    rows: &[(String, String, String)],
) -> MysqlResult<Vec<(String, String, String)>>
where
    M: Mysql,
{
    let mut matched_rows = Vec::new();
    // Group by entity type preserving first-appearance order.
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&(String, String, String)>> = HashMap::new();
    for row in rows {
        if !row.0.is_empty() && !row.1.is_empty() {
            groups
                .entry(row.0.clone())
                .or_insert_with(|| {
                    order.push(row.0.clone());
                    Vec::new()
                })
                .push(row);
        }
    }
    for entity_type in order {
        let entries = &groups[&entity_type];
        let matched: Vec<String> = match entity_type.as_str() {
            // NamespaceEntityResolver.match_entity_bindings.
            "namespace" => {
                let ns_ids: Vec<i64> = entries
                    .iter()
                    .filter_map(|row| row.1.parse().ok())
                    .collect();
                namespace_entity_matches(mysql, redis, resolvers, user_id, &ns_ids)
                    .await?
                    .into_iter()
                    .map(|id| id.to_string())
                    .collect()
            }
            _ => {
                let ids: Vec<String> = entries.iter().map(|row| row.1.clone()).collect();
                resolvers
                    .match_bindings(
                        redis,
                        user_id,
                        &entity_type,
                        &ids,
                        ResolutionPurpose::ResourceAccess,
                    )
                    .await?
            }
        };
        let matched_set: HashSet<&str> = matched.iter().map(String::as_str).collect();
        for (entity_type, entity_id, role) in entries {
            if matched_set.contains(entity_id.as_str()) && !role.is_empty() {
                matched_rows.push((entity_type.clone(), entity_id.clone(), role.clone()));
            }
        }
    }
    Ok(matched_rows)
}

/// `NamespaceEntityResolver.match_entity_bindings`: direct user memberships
/// plus entity-derived matches of the listed namespaces.
pub(super) async fn namespace_entity_matches<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    ns_ids: &[i64],
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if ns_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = ns_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut matched: Vec<i64> = Vec::new();

    // 1) Direct user memberships.
    let rows: Vec<IdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id IN ({ids}) \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{user_id}' \
                 AND resource_members.status = 'approved'"
            ),
            (),
        )
        .await?;
    matched.extend(rows.into_iter().map(|row| row.resource_members_resource_id));

    // 2) Non-user entity members of those namespaces, delegated per type.
    let entity_members: Vec<EntityMemberRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id, \
                 resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.entity_type AS resource_members_entity_type \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id IN ({ids}) \
                 AND resource_members.entity_type != 'user' \
                 AND resource_members.status = 'approved'"
            ),
            (),
        )
        .await?;
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for row in &entity_members {
        groups
            .entry(row.resource_members_entity_type.clone())
            .or_default()
            .push(row.resource_members_entity_id.clone());
    }
    for (entity_type, entity_ids) in groups {
        let matched_ids = resolvers
            .match_bindings(
                redis,
                user_id,
                &entity_type,
                &entity_ids,
                ResolutionPurpose::ResourceAccess,
            )
            .await?;
        let matched_set: HashSet<&str> = matched_ids.iter().map(String::as_str).collect();
        matched.extend(
            entity_members
                .iter()
                .filter(|row| {
                    row.resource_members_entity_type == entity_type
                        && matched_set.contains(row.resource_members_entity_id.as_str())
                })
                .map(|row| row.resource_members_resource_id),
        );
    }
    Ok(matched)
}

// ---------------------------------------------------------------------------
// Entity-authorized KB collection
// ---------------------------------------------------------------------------

/// `_append_entity_member_metadata` per-KB accumulator.
#[derive(Default)]
pub(super) struct EntityKbMetadata {
    pub(super) kb_ids: Vec<i64>,
    pub(super) group_map: HashMap<i64, Vec<String>>,
    pub(super) role_map: HashMap<i64, Vec<String>>,
    pub(super) inviter_map: HashMap<i64, Vec<i64>>,
    pub(super) type_map: HashMap<i64, Vec<String>>,
    pub(super) entity_id_map: HashMap<i64, Vec<String>>,
}

impl EntityKbMetadata {
    pub(super) fn append(
        &mut self,
        resource_id: i64,
        entity_type: &str,
        entity_id: &str,
        role: &str,
        inviter: Option<i64>,
        group_name: Option<&str>,
    ) {
        if !self.kb_ids.contains(&resource_id) {
            self.kb_ids.push(resource_id);
        }
        if let Some(group_name) = group_name {
            self.group_map
                .entry(resource_id)
                .or_default()
                .push(group_name.to_string());
        }
        let effective_role = if role.is_empty() {
            "Reporter".to_string()
        } else {
            role.to_string()
        };
        self.role_map
            .entry(resource_id)
            .or_default()
            .push(effective_role);
        self.type_map
            .entry(resource_id)
            .or_default()
            .push(entity_type.to_string());
        self.entity_id_map
            .entry(resource_id)
            .or_default()
            .push(entity_id.to_string());
        if let Some(inviter) = inviter {
            let inviters = self.inviter_map.entry(resource_id).or_default();
            if !inviters.contains(&inviter) {
                inviters.push(inviter);
            }
        }
    }
}

async fn distinct_kb_external_entities<M: Mysql>(
    mysql: &M,
    entity_type: &str,
) -> MysqlResult<Vec<String>> {
    let rows: Vec<EntityIdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT DISTINCT resource_members.entity_id AS resource_members_entity_id \
                 FROM resource_members WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
                 AND resource_members.entity_type = {} AND resource_members.entity_id IS NOT NULL \
                 AND resource_members.status IN {APPROVED_STATUSES}",
                quote_literal(entity_type),
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_entity_id)
        .collect())
}

async fn kb_ids_for_external_entities<M: Mysql>(
    mysql: &M,
    entity_type: &str,
    entity_ids: &[String],
) -> MysqlResult<Vec<i64>> {
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = entity_ids
        .iter()
        .map(|id| quote_literal(id))
        .collect::<Vec<_>>()
        .join(", ");
    let rows: Vec<IdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id \
                 FROM resource_members WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
                 AND resource_members.entity_type = {} AND resource_members.entity_id IN ({ids}) \
                 AND resource_members.status IN {APPROVED_STATUSES}",
                quote_literal(entity_type),
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// `collect_entity_authorized_kbs`.
pub(super) async fn collect_entity_authorized_kbs<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    accessible_groups: &[String],
) -> MysqlResult<EntityKbMetadata>
where
    M: Mysql,
{
    let mut metadata = EntityKbMetadata::default();

    // namespace-entity members over the accessible groups.
    if !accessible_groups.is_empty() {
        let namespaces =
            namespaces_by_names(mysql, accessible_groups, NamespaceActiveForm::IsTrue).await?;
        let names_by_id: HashMap<i64, String> = namespaces
            .iter()
            .map(|ns| (ns.namespace_id, ns.namespace_name.clone()))
            .collect();
        if !names_by_id.is_empty() {
            let ns_ids: Vec<i64> = names_by_id.keys().copied().collect();
            let members = namespace_entity_kb_members(mysql, &ns_ids).await?;
            for member in &members {
                let group_name = member
                    .resource_members_entity_id
                    .parse::<i64>()
                    .ok()
                    .and_then(|id| names_by_id.get(&id));
                metadata.append(
                    member.resource_members_resource_id,
                    "namespace",
                    &member.resource_members_entity_id,
                    &member.resource_members_role,
                    (member.resource_members_invited_by_user_id != 0)
                        .then_some(member.resource_members_invited_by_user_id),
                    group_name.map(String::as_str),
                );
            }
        }
    }

    // External entity members over KnowledgeBase resources. The default
    // registry has no external resolvers; a deployment can register its
    // provider (for example a directory resolver) explicitly.
    for entity_type in resolvers.external_types() {
        let departments = distinct_kb_external_entities(mysql, entity_type).await?;
        if departments.is_empty() {
            continue;
        }
        let matched = resolvers
            .match_bindings(
                redis,
                user_id,
                entity_type,
                &departments,
                ResolutionPurpose::ResourceAccess,
            )
            .await?;
        if !matched.is_empty() {
            let kb_ids = kb_ids_for_external_entities(mysql, entity_type, &matched).await?;
            if !kb_ids.is_empty() {
                let joined = kb_ids
                    .iter()
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                let members: Vec<MemberRow> = mysql
                    .fetch_all(
                        &format!(
                            "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                                 WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
                                 AND resource_members.entity_type = {} \
                                 AND resource_members.resource_id IN ({joined}) \
                                 AND resource_members.status IN {APPROVED_STATUSES}",
                            quote_literal(entity_type),
                        ),
                        (),
                    )
                    .await?;
                for member in &members {
                    metadata.append(
                        member.resource_members_resource_id,
                        entity_type,
                        &member.resource_members_entity_id,
                        &member.resource_members_role,
                        (member.resource_members_invited_by_user_id != 0)
                            .then_some(member.resource_members_invited_by_user_id),
                        None,
                    );
                }
            }
        }
    }

    Ok(metadata)
}

/// The `entity_kbs` batch: active KnowledgeBase kinds of the entity ids.
pub(super) async fn entity_kbs<M>(mysql: &M, kb_ids: &[i64]) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if kb_ids.is_empty() {
        return Ok(Vec::new());
    }
    // `kb_ids` is a Python set of ints; the IN list renders the CPython set
    // iteration order.
    let mut set_order = PySetOrder::new();
    for id in kb_ids {
        set_order.add(*id);
    }
    let joined = set_order
        .order()
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    kinds_by_filter(
        mysql,
        &format!(
            "kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true AND kinds.id IN ({joined})"
        ),
    )
    .await
}
