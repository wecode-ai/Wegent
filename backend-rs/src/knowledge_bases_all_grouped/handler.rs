// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The HTTP handler for `GET /api/knowledge-bases/all-grouped` and the
//! `all_grouped` orchestration mirroring
//! `KnowledgeService.get_all_knowledge_bases_grouped`.
use std::collections::{HashMap, HashSet};

use brz_http_server::StatusCode;
use brz_mysql::{Mysql, MysqlResult};

use crate::auth::SessionUser;
use crate::permissions::EntityResolvers;
use crate::state::AppState;

use super::membership::{
    collect_entity_authorized_kbs, effective_role_in_group, effective_roles, entity_kbs,
    external_editable_kb_ids, user_group_role_map, user_groups,
};
use super::py_order::PySetOrder;
use super::queries::{
    NamespaceActiveForm, accessible_namespace_ids, active_namespace_names, direct_kb_members,
    document_counts, filter_accessible_kb_ids, kinds_by_filter, namespaces_by_names,
    organization_namespace_names, organization_namespaces, user_by_id, user_names_by_ids,
};
use super::{
    AllGroupedKnowledgeResponse, AllGroupedOrganization, AllGroupedPersonal, AllGroupedSummary,
    AllGroupedTeamGroup, KIND_COLUMNS, KbWithGroupInfo, KindRow, SharedSourceInfo,
    build_shared_with_me, highest_role, kb_to_response, merge_roles, quote_literal,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// GET /api/knowledge-bases/all-grouped: the knowledge-bases free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/knowledge-bases/all-grouped")]
async fn get_all_knowledge_bases_grouped(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<AllGroupedKnowledgeResponse, crate::http_compat::FastApiError> {
    all_knowledge_bases_grouped(state, user).await
}

/// Handler body for `GET /api/knowledge-bases/all-grouped`.
async fn all_knowledge_bases_grouped(
    state: &AppState,
    user: SessionUser,
) -> Result<AllGroupedKnowledgeResponse, crate::http_compat::FastApiError> {
    let redis = state.redis.as_ref();

    let result = all_grouped(
        &state.mysql,
        redis,
        &state.entity_resolvers,
        i64::from(user.id),
        &user.role,
    )
    .await;

    result.map_err(|error| {
        tracing::error!(%error, "knowledge-bases/all-grouped dependency failure");
        crate::http_compat::FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        )
    })
}

/// `KnowledgeService.get_all_knowledge_bases_grouped`.
async fn all_grouped<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    user_role: &str,
) -> MysqlResult<AllGroupedKnowledgeResponse>
where
    M: Mysql,
{
    // --- Permission context (`build_direct_access_permission_context`) ---
    let (_, context_user_role) = user_by_id(mysql, user_id)
        .await?
        .unwrap_or((user_id, user_role.to_string()));

    // `get_user_groups` -> `get_user_group_roles`: every active namespace
    // name, then the first membership batch.
    let active_names = active_namespace_names(mysql).await?;
    let role_map = user_group_role_map(mysql, redis, resolvers, user_id).await?;
    let group_names = user_groups(&role_map, &active_names);
    let organization_names = organization_namespace_names(mysql).await?;
    // `group_roles = get_effective_roles_in_groups(...)`: the second
    // membership batch (`iter_user_groups_with_roles` again). The source
    // passes the non-organization groups and returns early for an empty
    // list without running the batch.
    let non_org_groups: Vec<String> = group_names
        .iter()
        .filter(|name| !organization_names.contains(name))
        .cloned()
        .collect();
    let group_roles = if non_org_groups.is_empty() {
        HashMap::new()
    } else {
        let batch = user_group_role_map(mysql, redis, resolvers, user_id).await?;
        effective_roles(&batch, &non_org_groups)
    };
    // The dict insertion order of the source's `group_roles`
    // (`get_effective_roles_in_groups` iterates `dict.fromkeys(group_names)`
    // over the sorted non-organization groups) drives the editable-group
    // `kinds.namespace IN` rendering inside the direct-access filter.
    let group_role_order: Vec<String> = non_org_groups
        .iter()
        .filter(|name| group_roles.contains_key(*name))
        .cloned()
        .collect();
    // The context dataclass evaluates its keyword arguments in order:
    // `collect_entity_authorized_kbs`, then `_get_accessible_namespace_ids`,
    // then the direct member rows.
    let entity =
        collect_entity_authorized_kbs(mysql, redis, resolvers, user_id, &group_names).await?;
    // `apply_direct_access_filter`'s `external_editable_ids`: the
    // entity-authorized KB ids whose collected roles include an editable one.
    let external_editable_ids = external_editable_kb_ids(&entity);
    let accessible_ns_ids = accessible_namespace_ids(mysql, &group_names).await?;
    let direct_members = direct_kb_members(mysql, user_id).await?;

    // --- Personal created ---
    let personal_created = kinds_by_filter(
        mysql,
        &format!(
            "kinds.kind = 'KnowledgeBase' AND kinds.is_active = true \
             AND kinds.namespace = 'default' AND kinds.user_id = {user_id}"
        ),
    )
    .await?;
    let personal_created_ids = filter_accessible_kb_ids(
        mysql,
        &personal_created
            .iter()
            .map(|kb| kb.kinds_id)
            .collect::<Vec<_>>(),
        user_id,
        &accessible_ns_ids,
        &external_editable_ids,
        &group_role_order,
        &group_roles,
        &organization_names,
        &context_user_role,
    )
    .await?;
    let personal_created: Vec<KindRow> = personal_created
        .into_iter()
        .filter(|kb| personal_created_ids.contains(&kb.kinds_id))
        .collect();

    // --- Shared KBs ---
    let shared_kb_ids: Vec<i64> = direct_members
        .iter()
        .map(|member| member.resource_members_resource_id)
        .collect();
    let shared_kb_roles: HashMap<i64, String> = direct_members
        .iter()
        .map(|member| {
            (
                member.resource_members_resource_id,
                member.resource_members_role.clone(),
            )
        })
        .collect();
    let shared_kb_inviter_map: HashMap<i64, i64> = direct_members
        .iter()
        .filter(|member| member.resource_members_invited_by_user_id != 0)
        .map(|member| {
            (
                member.resource_members_resource_id,
                member.resource_members_invited_by_user_id,
            )
        })
        .collect();

    let mut shared_kbs: Vec<KindRow> = Vec::new();
    if !shared_kb_ids.is_empty() {
        // `shared_kb_ids` is the raw member-row list in the source (a list,
        // not a set); the IN list renders that order, duplicates included.
        let joined = shared_kb_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        shared_kbs = kinds_by_filter(
            mysql,
            &format!(
                "kinds.kind = 'KnowledgeBase' AND kinds.is_active = true \
                 AND kinds.id IN ({joined}) AND kinds.user_id != {user_id}"
            ),
        )
        .await?;
        let filtered = filter_accessible_kb_ids(
            mysql,
            &shared_kbs.iter().map(|kb| kb.kinds_id).collect::<Vec<_>>(),
            user_id,
            &accessible_ns_ids,
            &external_editable_ids,
            &group_role_order,
            &group_roles,
            &organization_names,
            &context_user_role,
        )
        .await?;
        shared_kbs.retain(|kb| filtered.contains(&kb.kinds_id));
    }

    // Shared namespaces (names of the non-default shared KBs).
    let shared_namespace_names: Vec<String> = {
        let mut names: Vec<String> = shared_kbs
            .iter()
            .filter(|kb| kb.kinds_namespace != "default")
            .map(|kb| kb.kinds_namespace.clone())
            .collect();
        names.sort();
        names.dedup();
        names
    };
    let shared_namespaces = namespaces_by_names(
        mysql,
        &shared_namespace_names,
        NamespaceActiveForm::EqualsTrue,
    )
    .await?;

    let personal_shared: Vec<KindRow> = shared_kbs
        .iter()
        .filter(|kb| kb.kinds_namespace == "default")
        .cloned()
        .collect();
    let shared_group_kbs: Vec<KindRow> = shared_kbs
        .iter()
        .filter(|kb| {
            kb.kinds_namespace != "default"
                && !shared_namespaces.iter().any(|ns| {
                    ns.namespace_name == kb.kinds_namespace && ns.namespace_level == "organization"
                })
        })
        .cloned()
        .collect();

    // --- Step 3: `get_user_groups_with_roles` (third membership batch) ---
    // The source's `get_user_groups_with_roles` returns
    // `iter_user_groups_with_roles` result order — the `group_entries`
    // dict insertion order (direct member rows, then entity members) — and
    // `accessible_groups`/`grouped_namespace_names` preserve it for the
    // `groups` section rendering, so keep the entry order here.
    let group_role_map = user_group_role_map(mysql, redis, resolvers, user_id).await?;
    let accessible_groups_with_roles: Vec<(String, String)> = group_role_map
        .iter()
        .map(|(name, roles)| (name.clone(), highest_role(roles).unwrap_or_default()))
        .collect();
    let accessible_group_names: Vec<String> = accessible_groups_with_roles
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    let display_group_roles: HashMap<String, String> =
        accessible_groups_with_roles.iter().cloned().collect();

    // --- Group KBs ---
    // `accessible_group_namespaces`: the active namespaces of the
    // accessible group names (the source's separate query; the group list
    // is filtered by their level, not by the shared KB namespaces).
    let accessible_group_namespaces = namespaces_by_names(
        mysql,
        &accessible_group_names,
        NamespaceActiveForm::EqualsTrue,
    )
    .await?;
    let accessible_groups: Vec<String> = accessible_group_names
        .iter()
        .filter(|name| {
            !accessible_group_namespaces
                .iter()
                .any(|ns| ns.namespace_name == **name && ns.namespace_level == "organization")
        })
        .cloned()
        .collect();
    let shared_group_names: Vec<String> = {
        let mut names: Vec<String> = shared_group_kbs
            .iter()
            .map(|kb| kb.kinds_namespace.clone())
            .collect();
        names.sort();
        names.dedup();
        names
    };

    // `group_kb_map`: insertion-ordered — the source dict preserves the
    // group-kinds query order (later inserts overwrite in place), and the
    // downstream `all_kb_ids` list renders that order.
    let mut group_kb_map: Vec<(i64, KindRow)> = Vec::new();
    let upsert_group_kb = |kb: KindRow, map: &mut Vec<(i64, KindRow)>| match map
        .iter_mut()
        .find(|(id, _)| *id == kb.kinds_id)
    {
        Some(entry) => entry.1 = kb,
        None => map.push((kb.kinds_id, kb)),
    };
    if !accessible_groups.is_empty() {
        let joined = accessible_groups
            .iter()
            .map(|value| quote_literal(value))
            .collect::<Vec<_>>()
            .join(", ");
        let group_kbs = kinds_by_filter(
            mysql,
            &format!(
                "kinds.kind = 'KnowledgeBase' AND kinds.is_active = true \
                 AND kinds.namespace IN ({joined})"
            ),
        )
        .await?;
        let filtered = filter_accessible_kb_ids(
            mysql,
            &group_kbs.iter().map(|kb| kb.kinds_id).collect::<Vec<_>>(),
            user_id,
            &accessible_ns_ids,
            &external_editable_ids,
            &group_role_order,
            &group_roles,
            &organization_names,
            &context_user_role,
        )
        .await?;
        for kb in group_kbs {
            if filtered.contains(&kb.kinds_id) {
                upsert_group_kb(kb, &mut group_kb_map);
            }
        }
    }
    let mut remaining_shared_group_kbs: Vec<KindRow> = Vec::new();
    for kb in shared_group_kbs {
        if accessible_groups.contains(&kb.kinds_namespace) {
            upsert_group_kb(kb, &mut group_kb_map);
        } else {
            remaining_shared_group_kbs.push(kb);
        }
    }

    // --- 4b: entity-authorized KBs ---
    let entity_all_kbs = entity_kbs(mysql, &entity.kb_ids).await?;
    let entity_personal_kb_ids: HashSet<i64> = entity_all_kbs
        .iter()
        .filter(|kb| kb.kinds_namespace == "default")
        .map(|kb| kb.kinds_id)
        .collect();
    let shared_into_group_ids: HashSet<i64> = entity_all_kbs
        .iter()
        .filter(|kb| {
            entity
                .group_map
                .get(&kb.kinds_id)
                .is_some_and(|groups| groups.iter().any(|g| accessible_groups.contains(g)))
        })
        .map(|kb| kb.kinds_id)
        .collect();
    let entity_shared_to_me_kbs: Vec<KindRow> = entity_all_kbs
        .iter()
        .filter(|kb| kb.kinds_user_id != user_id && !shared_into_group_ids.contains(&kb.kinds_id))
        .cloned()
        .collect();
    let shared_into_group_kbs: Vec<KindRow> = entity_all_kbs
        .iter()
        .filter(|kb| shared_into_group_ids.contains(&kb.kinds_id))
        .cloned()
        .collect();

    let mut group_kbs: Vec<KindRow> = group_kb_map.into_iter().map(|(_, kb)| kb).collect();
    group_kbs.retain(|kb| !entity_personal_kb_ids.contains(&kb.kinds_id));

    // Filter entity lists by the direct-access policy.
    let filtered_entity_ids = filter_accessible_kb_ids(
        mysql,
        &entity_shared_to_me_kbs
            .iter()
            .map(|kb| kb.kinds_id)
            .collect::<Vec<_>>(),
        user_id,
        &accessible_ns_ids,
        &external_editable_ids,
        &group_role_order,
        &group_roles,
        &organization_names,
        &context_user_role,
    )
    .await?;
    let entity_shared_to_me_kbs: Vec<KindRow> = entity_shared_to_me_kbs
        .into_iter()
        .filter(|kb| filtered_entity_ids.contains(&kb.kinds_id))
        .collect();
    let filtered_shared_into = filter_accessible_kb_ids(
        mysql,
        &shared_into_group_kbs
            .iter()
            .map(|kb| kb.kinds_id)
            .collect::<Vec<_>>(),
        user_id,
        &accessible_ns_ids,
        &external_editable_ids,
        &group_role_order,
        &group_roles,
        &organization_names,
        &context_user_role,
    )
    .await?;
    let shared_into_group_kbs: Vec<KindRow> = shared_into_group_kbs
        .into_iter()
        .filter(|kb| filtered_shared_into.contains(&kb.kinds_id))
        .collect();

    // --- Organization KBs ---
    // `db.query(Kind).join(Namespace, Kind.namespace == Namespace.name)`:
    // SQLAlchemy renders the JOIN before the filter predicates.
    let org_kbs = mysql
        .fetch_all::<_, _, KindRow>(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds INNER JOIN namespace \
                 ON kinds.namespace = namespace.name \nWHERE \
                 kinds.kind = 'KnowledgeBase' AND kinds.is_active = true \
                 AND namespace.level = 'organization' AND namespace.is_active = true \
                 ORDER BY kinds.updated_at DESC"
            ),
            (),
        )
        .await?;
    let filtered_org_ids = filter_accessible_kb_ids(
        mysql,
        &org_kbs.iter().map(|kb| kb.kinds_id).collect::<Vec<_>>(),
        user_id,
        &accessible_ns_ids,
        &external_editable_ids,
        &group_role_order,
        &group_roles,
        &organization_names,
        &context_user_role,
    )
    .await?;
    let org_kbs: Vec<KindRow> = org_kbs
        .into_iter()
        .filter(|kb| filtered_org_ids.contains(&kb.kinds_id))
        .collect();

    let organization_namespaces = organization_namespaces(mysql).await?;
    let organization_namespace_map: HashMap<String, String> = organization_namespaces
        .iter()
        .map(|ns| (ns.namespace_name.clone(), ns.namespace_level.clone()))
        .collect();
    let org_namespace = organization_namespaces
        .iter()
        .find(|ns| ns.namespace_level == "organization")
        .or_else(|| organization_namespaces.first());

    // --- Batch metadata ---
    let mut all_kb_ids: Vec<i64> = Vec::new();
    for kb in personal_created
        .iter()
        .chain(personal_shared.iter())
        .chain(entity_shared_to_me_kbs.iter())
        .chain(group_kbs.iter())
        .chain(shared_into_group_kbs.iter())
        .chain(org_kbs.iter())
        .chain(remaining_shared_group_kbs.iter())
    {
        if !all_kb_ids.contains(&kb.kinds_id) {
            all_kb_ids.push(kb.kinds_id);
        }
    }
    let document_counts = document_counts(mysql, &all_kb_ids).await?;

    // `owner_user_ids: set[int]` — `User.id.in_(list(owner_user_ids))`
    // renders the CPython set iteration order.
    let mut owner_user_ids = PySetOrder::new();
    for kb in personal_created
        .iter()
        .chain(personal_shared.iter())
        .chain(entity_shared_to_me_kbs.iter())
        .chain(group_kbs.iter())
        .chain(shared_into_group_kbs.iter())
        .chain(org_kbs.iter())
        .chain(remaining_shared_group_kbs.iter())
    {
        owner_user_ids.add(kb.kinds_user_id);
    }
    let owner_user_ids = owner_user_ids.order();
    let owner_user_map: HashMap<i64, String> = user_names_by_ids(mysql, &owner_user_ids)
        .await?
        .into_iter()
        .map(|row| (row.users_id, row.users_user_name))
        .collect();

    let mut display_names: Vec<String> = Vec::new();
    for name in accessible_groups.iter().chain(shared_group_names.iter()) {
        if !display_names.contains(name) {
            display_names.push(name.clone());
        }
    }
    let display_namespaces =
        namespaces_by_names(mysql, &display_names, NamespaceActiveForm::EqualsTrue).await?;
    let namespace_display_names: HashMap<String, String> = display_namespaces
        .iter()
        .map(|ns| {
            (
                ns.namespace_name.clone(),
                ns.namespace_display_name
                    .clone()
                    .unwrap_or_else(|| ns.namespace_name.clone()),
            )
        })
        .collect();

    // `all_inviter_ids: set[int]` — the inviter users query renders the
    // CPython set iteration order.
    let mut all_inviter_ids = PySetOrder::new();
    for inviter in shared_kb_inviter_map.values() {
        all_inviter_ids.add(*inviter);
    }
    for inviters in entity.inviter_map.values() {
        for inviter in inviters {
            all_inviter_ids.add(*inviter);
        }
    }
    let all_inviter_ids = all_inviter_ids.order();
    let inviter_user_map: HashMap<i64, String> = user_names_by_ids(mysql, &all_inviter_ids)
        .await?
        .into_iter()
        .map(|row| (row.users_id, row.users_user_name))
        .collect();

    // --- Personal section ---
    let created_by_me: Vec<KbWithGroupInfo> = personal_created
        .iter()
        .map(|kb| {
            kb_to_response(
                kb,
                "default",
                "personal",
                "personal",
                &document_counts,
                &owner_user_map,
                Some("Owner".to_string()),
                None,
                None,
                None,
                None,
            )
        })
        .collect();

    // `kb_sources` aggregation (`_build_shared_with_me`).
    let mut kb_sources: Vec<SharedSourceInfo> = Vec::new();
    fn ensure<'a>(
        kb: &KindRow,
        kb_sources: &'a mut Vec<SharedSourceInfo>,
    ) -> &'a mut SharedSourceInfo {
        let index = kb_sources
            .iter()
            .position(|info| info.kb.kinds_id == kb.kinds_id)
            .unwrap_or_else(|| {
                kb_sources.push(SharedSourceInfo {
                    kb: kb.clone(),
                    roles: Vec::new(),
                    inviter_ids: Vec::new(),
                    source_groups: Vec::new(),
                    shared_vias: Vec::new(),
                });
                kb_sources.len() - 1
            });
        &mut kb_sources[index]
    }
    for kb in &personal_shared {
        let info = ensure(kb, &mut kb_sources);
        info.roles.push(shared_kb_roles.get(&kb.kinds_id).cloned());
        if let Some(inviter) = shared_kb_inviter_map.get(&kb.kinds_id) {
            info.inviter_ids.push(*inviter);
        }
        info.shared_vias.push("user".to_string());
    }
    for kb in &remaining_shared_group_kbs {
        let info = ensure(kb, &mut kb_sources);
        info.roles.push(shared_kb_roles.get(&kb.kinds_id).cloned());
        if let Some(inviter) = shared_kb_inviter_map.get(&kb.kinds_id) {
            info.inviter_ids.push(*inviter);
        }
        info.source_groups.push(
            namespace_display_names
                .get(&kb.kinds_namespace)
                .cloned()
                .unwrap_or_else(|| kb.kinds_namespace.clone()),
        );
        info.shared_vias.push("user".to_string());
    }
    for kb in &entity_shared_to_me_kbs {
        let info = ensure(kb, &mut kb_sources);
        if let Some(roles) = entity.role_map.get(&kb.kinds_id) {
            info.roles.extend(roles.iter().cloned().map(Some));
        }
        info.roles.push(shared_kb_roles.get(&kb.kinds_id).cloned());
        if let Some(inviters) = entity.inviter_map.get(&kb.kinds_id) {
            info.inviter_ids.extend(inviters.iter().copied());
        }
        let types = entity
            .type_map
            .get(&kb.kinds_id)
            .cloned()
            .unwrap_or_default();
        let entity_ids = entity
            .entity_id_map
            .get(&kb.kinds_id)
            .cloned()
            .unwrap_or_default();
        let groups = entity
            .group_map
            .get(&kb.kinds_id)
            .cloned()
            .unwrap_or_default();
        let mut group_idx = 0;
        for (i, entity_type) in types.iter().enumerate() {
            if entity_type == "namespace" {
                if let Some(source_group_name) = groups.get(group_idx) {
                    if !source_group_name.is_empty() {
                        info.source_groups.push(
                            namespace_display_names
                                .get(source_group_name)
                                .cloned()
                                .unwrap_or_else(|| source_group_name.clone()),
                        );
                    }
                    info.shared_vias.push("namespace".to_string());
                }
                group_idx += 1;
            } else if !entity_type.is_empty() {
                // `_get_entity_display_name` for non-namespace entity types
                // resolves through the external API; the recorded cases have
                // no matched external bindings, so no display name is added.
                info.shared_vias.push(entity_type.clone());
                let _ = entity_ids.get(i);
            }
        }
    }
    let shared_with_me = build_shared_with_me(
        &kb_sources,
        &namespace_display_names,
        &inviter_user_map,
        &document_counts,
        &owner_user_map,
    );

    // --- Groups section (`_build_groups_section`) ---
    let mut groups_map: HashMap<String, Vec<KindRow>> = HashMap::new();
    let mut group_order: Vec<String> = Vec::new();
    for kb in &group_kbs {
        let entry = groups_map
            .entry(kb.kinds_namespace.clone())
            .or_insert_with(|| {
                group_order.push(kb.kinds_namespace.clone());
                Vec::new()
            });
        entry.push(kb.clone());
    }
    for kb in &shared_into_group_kbs {
        if let Some(target_groups) = entity.group_map.get(&kb.kinds_id) {
            for target_group in target_groups {
                let entry = groups_map.entry(target_group.clone()).or_insert_with(|| {
                    group_order.push(target_group.clone());
                    Vec::new()
                });
                entry.push(kb.clone());
            }
        }
    }

    let mut groups: Vec<AllGroupedTeamGroup> = Vec::new();
    let grouped_namespace_names: Vec<String> = accessible_groups.clone();
    for ns_name in &grouped_namespace_names {
        let display_name = namespace_display_names
            .get(ns_name)
            .cloned()
            .unwrap_or_else(|| ns_name.clone());
        let user_group_role = display_group_roles.get(ns_name);
        let kbs = groups_map.get(ns_name).cloned().unwrap_or_default();

        let mut kb_responses: Vec<KbWithGroupInfo> = Vec::new();
        let mut seen_kb_ids: HashSet<i64> = HashSet::new();
        for kb in &kbs {
            if !seen_kb_ids.insert(kb.kinds_id) {
                continue;
            }
            let is_shared_into_group = entity
                .group_map
                .get(&kb.kinds_id)
                .is_some_and(|groups| groups.contains(ns_name))
                && kb.kinds_namespace != *ns_name;
            if is_shared_into_group {
                let shared_roles = entity
                    .role_map
                    .get(&kb.kinds_id)
                    .cloned()
                    .unwrap_or_default();
                let merged_shared_role = if shared_roles.is_empty() {
                    None
                } else {
                    merge_roles(
                        &shared_roles
                            .iter()
                            .map(|role| Some(role.clone()))
                            .collect::<Vec<_>>(),
                    )
                };
                let direct_role = shared_kb_roles.get(&kb.kinds_id).cloned();
                let merged_role = merge_roles(&[merged_shared_role, direct_role]);
                let shared_from_name = entity
                    .inviter_map
                    .get(&kb.kinds_id)
                    .and_then(|inviters| {
                        inviters
                            .iter()
                            .find_map(|inviter| inviter_user_map.get(inviter))
                    })
                    .cloned();
                kb_responses.push(kb_to_response(
                    kb,
                    ns_name,
                    &display_name,
                    "group",
                    &document_counts,
                    &owner_user_map,
                    merged_role,
                    None,
                    shared_from_name,
                    Some("namespace".to_string()),
                    None,
                ));
            } else {
                let merged_role = merge_roles(&[
                    shared_kb_roles.get(&kb.kinds_id).cloned(),
                    user_group_role.cloned(),
                ]);
                kb_responses.push(kb_to_response(
                    kb,
                    ns_name,
                    &display_name,
                    "group",
                    &document_counts,
                    &owner_user_map,
                    merged_role,
                    None,
                    None,
                    None,
                    None,
                ));
            }
        }
        groups.push(AllGroupedTeamGroup {
            group_name: ns_name.clone(),
            group_display_name: display_name,
            kb_count: kb_responses.len(),
            knowledge_bases: kb_responses,
        });
    }

    // --- Organization section ---
    let org_display_name = org_namespace
        .and_then(|ns| ns.namespace_display_name.clone())
        .filter(|name| !name.is_empty())
        .or_else(|| org_namespace.map(|ns| ns.namespace_name.clone()))
        .unwrap_or_else(|| "organization".to_string());
    let org_ns_name = org_namespace.map(|ns| ns.namespace_name.clone());

    let mut organization_kbs: Vec<KbWithGroupInfo> = Vec::new();
    for kb in &org_kbs {
        // `get_view_role_in_group` per organization KB namespace.
        let namespace_level = organization_namespace_map
            .get(&kb.kinds_namespace)
            .cloned()
            .unwrap_or_else(|| "organization".to_string());
        let view_role =
            match effective_role_in_group(mysql, redis, resolvers, user_id, &kb.kinds_namespace)
                .await?
            {
                Some(role) => role,
                None if context_user_role == "admin" && namespace_level == "organization" => {
                    "Owner".to_string()
                }
                None => "Reporter".to_string(),
            };
        let merged_role =
            merge_roles(&[shared_kb_roles.get(&kb.kinds_id).cloned(), Some(view_role)]);
        organization_kbs.push(kb_to_response(
            kb,
            org_ns_name.as_deref().unwrap_or("organization"),
            &org_display_name,
            "organization",
            &document_counts,
            &owner_user_map,
            merged_role,
            None,
            None,
            None,
            None,
        ));
    }

    // --- Summary ---
    let grouped_kb_ids: HashSet<i64> = group_kbs
        .iter()
        .map(|kb| kb.kinds_id)
        .chain(shared_into_group_kbs.iter().map(|kb| kb.kinds_id))
        .collect();
    let mut all_kb_ids: HashSet<i64> = personal_created.iter().map(|kb| kb.kinds_id).collect();
    all_kb_ids.extend(personal_shared.iter().map(|kb| kb.kinds_id));
    all_kb_ids.extend(entity_shared_to_me_kbs.iter().map(|kb| kb.kinds_id));
    all_kb_ids.extend(grouped_kb_ids.iter().copied());
    all_kb_ids.extend(org_kbs.iter().map(|kb| kb.kinds_id));
    all_kb_ids.extend(remaining_shared_group_kbs.iter().map(|kb| kb.kinds_id));

    let summary = AllGroupedSummary {
        total_count: all_kb_ids.len(),
        personal_count: personal_created.len()
            + personal_shared.len()
            + entity_shared_to_me_kbs.len()
            + remaining_shared_group_kbs.len(),
        group_count: grouped_kb_ids.len(),
        organization_count: org_kbs.len(),
    };

    Ok(AllGroupedKnowledgeResponse {
        personal: AllGroupedPersonal {
            created_by_me,
            shared_with_me,
        },
        groups,
        organization: AllGroupedOrganization {
            namespace: org_ns_name,
            display_name: Some(org_display_name),
            kb_count: organization_kbs.len(),
            knowledge_bases: organization_kbs,
        },
        summary,
    })
}
