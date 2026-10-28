// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge-base resolution for the create flow
//! (`app/services/chat/task_default_knowledge_bases.py` +
//! `app/services/chat/selected_knowledge.py` +
//! `app/services/knowledge/knowledge_visibility_query.py`).
//!
//! Evidence, corrected against the **authoritative** recording for this route
//! (`20261010055652`, the run the workflow verifies against): the eight recorded
//! `queued` cases DO reach the knowledge path. Each case's team-member Ghost
//! carries `defaultKnowledgeBaseRefs: [{"id": 239607, "name":
//! "<namespace>-Group"}]`, so `_iter_team_member_default_knowledge_base_ids`
//! yields `[239607]`, `get_acl_accessible_knowledge_base_ids` issues its
//! `kinds.kind = 'KnowledgeBase'` query (`_build_all_query` +
//! `apply_acl_deny_filter`), and the dispatch `metadata` carries
//! `knowledge_base_ids: [239607]`, `provider_native_knowledge: true`,
//! `is_user_selected_kb: false`, and a non-empty `selected_knowledge_prompt`
//! (`<selected_knowledge_sources>` with a `routing_summary` built from the
//! `knowledge_documents` counts).
//!
//! An earlier revision of this note said the opposite. That reading came from
//! the *other* recording (`20261010083223`), whose cases happen to carry
//! `defaultKnowledgeBaseRefs: []`; it is not the run this route is verified
//! against. The original `knowledge_base_ids = [239607]` claim was correct for
//! the queued cases.
//!
//! Consequence: the selected-knowledge steps 3-5
//! (`selected_knowledge.build_inherited_selected_knowledge_refs` →
//! `resolve_selected_knowledge_context` → the `selected_knowledge_prompt`
//! renderer + `provider_native_knowledge`/`is_user_selected_kb`/`kb_tool_access_
//! mode` derivation) are **on the `queued` class's critical path**, not
//! unexercised. They are not yet ported.
//!
//! Known follow-up (not acted on): the [`AclQueryContext`] builder needs
//! `group_permission.iter_user_groups_with_roles` and
//! `external_entity_resolver.get_resource_ids_by_entity`. The shared
//! `crate::permissions::EntityResolver` trait exposes only `match_bindings`, so
//! wiring the entity half requires widening a shared `backend-rs` trait — a
//! separate migration step, flagged rather than silently omitted. The recorded
//! `_build_all_query` also shows the `organization_names` term
//! (`kinds.namespace IN (…)` over organization namespaces), so the context's
//! group/org reads are reached too.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult, MysqlRow, MysqlService};
use brz_redis::Redis;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

use super::knowledge_access::KnowledgeAccessError;
use super::resolution::{KIND_COLUMNS, KindRow};
use crate::permissions::{
    EntityResolvers, ResolutionPurpose, accessible_namespace_ids, effective_roles_in_groups,
    iter_user_groups_with_roles, organization_names, user_groups,
};
use crate::teams::teams_repository::{BindingArg, placeholders};

/// `_iter_team_member_default_knowledge_base_ids` for one resolved Ghost: its
/// `spec.defaultKnowledgeBaseRefs[].id`, in order.
pub fn ghost_default_knowledge_base_ids(ghost_spec: &Value) -> Vec<i64> {
    ghost_spec
        .get("defaultKnowledgeBaseRefs")
        .and_then(Value::as_array)
        .map(|refs| {
            refs.iter()
                .filter_map(|reference| reference.get("id").and_then(Value::as_i64))
                .collect()
        })
        .unwrap_or_default()
}

/// `_iter_team_member_default_knowledge_base_ids` over resolved Ghost specs, in
/// member order (duplicates preserved; the caller dedupes with
/// `dict.fromkeys`).
pub fn team_member_default_knowledge_base_ids_from_specs(ghost_specs: &[Value]) -> Vec<i64> {
    ghost_specs
        .iter()
        .flat_map(ghost_default_knowledge_base_ids)
        .collect()
}

/// `dict.fromkeys([...])`: deduplicate while preserving first-seen order.
pub fn deduplicate(ids: &[i64]) -> Vec<i64> {
    let mut seen = Vec::with_capacity(ids.len());
    for id in ids {
        if !seen.contains(id) {
            seen.push(*id);
        }
    }
    seen
}

/// `_resolve_task_default_knowledge_bases`'s tail:
/// `dict.fromkeys(candidate_ids)` then
/// `[kb_id for kb_id in candidate_ids if kb_id in allowed_ids]`, preserving the
/// candidate order. `allowed_ids` comes from
/// [`get_acl_accessible_knowledge_base_ids`].
pub fn resolve_default_knowledge_base_ids(candidate_ids: &[i64], allowed_ids: &[i64]) -> Vec<i64> {
    deduplicate(candidate_ids)
        .into_iter()
        .filter(|id| allowed_ids.contains(id))
        .collect()
}

/// `KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES`: the resource-type filter shared by
/// every `resource_members` read in `knowledge_visibility_query.py`.
pub const KB_RESOURCE_TYPES: &str = "('KnowledgeBase', 'KNOWLEDGE_BASE')";

/// `APPROVED_MEMBER_STATUS_VALUES`: the approved-status filter shared by every
/// `resource_members` read in `knowledge_visibility_query.py`.
pub const APPROVED_STATUSES: &str = "('approved', 'APPROVED')";

/// The non-relational permission inputs `build_direct_access_query_context`
/// derives for the ACL query (`DirectAccessPermissionContext`).
///
/// `user_id`, `authorized_groups` (`accessible_groups`), and
/// `organization_names` come from plain reads; `accessible_namespace_ids` and
/// `external_kb_ids` are the entity-membership half and
/// `restricted_group_names` is the deny half. Built by
/// [`build_acl_query_context`].
#[derive(Debug, Default, Clone)]
pub struct AclQueryContext {
    pub user_id: i64,
    pub authorized_groups: Vec<String>,
    pub organization_names: Vec<String>,
    pub accessible_namespace_ids: Vec<String>,
    pub external_kb_ids: Vec<i64>,
    pub restricted_group_names: Vec<String>,
}

/// `_approved_member_query(...)` rendered as an `EXISTS` over `resource_members`
/// correlated to `kinds.id`, with the caller's entity predicate appended.
fn approved_member_exists(entity_predicate: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM resource_members \
         WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
         AND resource_members.resource_id = kinds.id \
         AND resource_members.status IN {APPROVED_STATUSES} \
         AND {entity_predicate})"
    )
}

/// `get_acl_accessible_knowledge_base_ids`'s `user_id == 0` read: the
/// organization-level knowledge bases among the candidates.
pub fn acl_organization_knowledge_base_ids_statement(candidate_count: usize) -> String {
    format!(
        "SELECT kinds.id AS kinds_id \nFROM kinds \nINNER JOIN namespace \
         ON kinds.namespace = namespace.name \nWHERE kinds.id IN ({}) \
         AND kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true \
         AND namespace.level = 'organization' AND namespace.is_active IS true",
        placeholders(candidate_count)
    )
}

/// `get_acl_accessible_knowledge_base_ids`'s `user_id != 0` read:
/// `build_knowledge_base_visibility_query(scope=ALL)` (`_build_all_query` +
/// `_shared_access_condition`) filtered to the candidates, then
/// `apply_acl_deny_filter`.
///
/// Renders the recorded statement (`2834ba9c`), e.g.
/// `... WHERE kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true AND
/// (kinds.user_id = ? AND kinds.namespace = 'default' OR kinds.namespace IN (?)
/// OR kinds.namespace IN (?) OR (EXISTS (...)) OR (EXISTS (...))) AND kinds.id IN
/// (?) AND NOT (EXISTS (...))`.
///
/// Returns the statement and its bound parameters in placeholder order.
pub fn acl_visible_knowledge_base_ids_query(
    context: &AclQueryContext,
    candidate_ids: &[i64],
) -> (String, Vec<BindingArg>) {
    let mut params: Vec<BindingArg> = Vec::new();
    let mut visibility: Vec<String> = Vec::new();

    // `(Kind.user_id == user_id) & (Kind.namespace == "default")`: the recorded
    // owner literal is an integer, so that slot binds as an integer.
    visibility.push("kinds.user_id = ? AND kinds.namespace = 'default'".to_string());
    params.push(BindingArg::Int(context.user_id));

    if !context.authorized_groups.is_empty() {
        visibility.push(format!(
            "kinds.namespace IN ({})",
            placeholders(context.authorized_groups.len())
        ));
        params.extend(
            context
                .authorized_groups
                .iter()
                .cloned()
                .map(BindingArg::Str),
        );
    }
    if !context.organization_names.is_empty() {
        visibility.push(format!(
            "kinds.namespace IN ({})",
            placeholders(context.organization_names.len())
        ));
        params.extend(
            context
                .organization_names
                .iter()
                .cloned()
                .map(BindingArg::Str),
        );
    }

    // `_shared_access_condition`: each `.exists()` renders wrapped in parens.
    let mut shared = vec![format!(
        "({})",
        approved_member_exists(
            "resource_members.entity_type = 'user' AND resource_members.entity_id = ?"
        )
    )];
    // `resource_members.entity_id`: the text column keeps the id as text.
    params.push(BindingArg::Str(context.user_id.to_string()));
    if !context.accessible_namespace_ids.is_empty() {
        shared.push(format!(
            "({})",
            approved_member_exists(&format!(
                "resource_members.entity_type = 'namespace' \
                 AND resource_members.entity_id IN ({})",
                placeholders(context.accessible_namespace_ids.len())
            ))
        ));
        params.extend(
            context
                .accessible_namespace_ids
                .iter()
                .cloned()
                .map(BindingArg::Str),
        );
    }
    if !context.external_kb_ids.is_empty() {
        shared.push(format!(
            "kinds.id IN ({})",
            placeholders(context.external_kb_ids.len())
        ));
        params.extend(context.external_kb_ids.iter().copied().map(BindingArg::Int));
    }
    visibility.extend(shared);

    let mut sql = format!(
        "SELECT kinds.id AS kinds_id \nFROM kinds \nWHERE kinds.kind = 'KnowledgeBase' \
         AND kinds.is_active IS true \nAND ({}) \nAND kinds.id IN ({})",
        visibility.join(" OR "),
        placeholders(candidate_ids.len())
    );
    params.extend(candidate_ids.iter().copied().map(BindingArg::Int));

    // `apply_acl_deny_filter`
    sql.push_str(&format!(
        " \nAND NOT ({})",
        approved_member_exists(
            "resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.`role` = 'RestrictedAnalyst'"
        )
    ));
    params.push(BindingArg::Str(context.user_id.to_string()));
    if !context.restricted_group_names.is_empty() {
        sql.push_str(&format!(
            " \nAND kinds.namespace NOT IN ({})",
            placeholders(context.restricted_group_names.len())
        ));
        params.extend(
            context
                .restricted_group_names
                .iter()
                .cloned()
                .map(BindingArg::Str),
        );
    }
    (sql, params)
}

/// The inputs `build_direct_access_query_context` reads, held so the context is
/// built where the source builds it.
///
/// `knowledge_visibility_query.get_acl_accessible_knowledge_base_ids` returns
/// before `build_direct_access_query_context` when `candidate_ids` is empty, so
/// the source never reads `organization_names` or the caller's group roles for
/// a task whose team has no default knowledge base. Holding the inputs instead
/// of a prebuilt [`AclQueryContext`] keeps that laziness and the source's
/// `user_id = team.user_id` / `candidate_ids` arguments.
pub struct AclContextSource<'a, R: Redis> {
    mysql: &'a MysqlService,
    resolvers: &'a EntityResolvers<R>,
    redis: Option<&'a R>,
}

impl<'a, R: Redis> AclContextSource<'a, R> {
    pub fn new(
        mysql: &'a MysqlService,
        resolvers: &'a EntityResolvers<R>,
        redis: Option<&'a R>,
    ) -> Self {
        Self {
            mysql,
            resolvers,
            redis,
        }
    }

    /// `build_direct_access_query_context(db, user_id, candidate_ids=...)`.
    pub async fn build(
        &self,
        user_id: i64,
        candidate_ids: &[i64],
    ) -> Result<AclQueryContext, KnowledgeAccessError> {
        build_acl_query_context(
            self.mysql,
            self.resolvers,
            self.redis,
            user_id,
            candidate_ids,
        )
        .await
    }

    /// The shared MySQL client every read of this context runs on.
    pub fn mysql(&self) -> &MysqlService {
        self.mysql
    }

    /// The deployment's cache client (`_check_kb_access` consults it).
    pub fn redis(&self) -> Option<&'a R> {
        self.redis
    }

    /// The registered entity resolvers (`_check_kb_access`'s ACL chain).
    pub fn resolvers(&self) -> &'a EntityResolvers<R> {
        self.resolvers
    }

    /// `get_effective_role_in_group(db, user_id, group_name)`: the caller's
    /// effective role in one group.
    pub async fn group_role(&self, user_id: i64, group_name: &str) -> MysqlResult<Option<String>> {
        crate::knowledge_bases_all_grouped::membership::effective_role_in_group(
            self.mysql,
            self.redis,
            self.resolvers,
            user_id,
            group_name,
        )
        .await
    }
}

/// `build_direct_access_query_context`: the [`AclQueryContext`] the recorded
/// `_build_all_query` consumes. Produces the recorded `authorized_groups`,
/// `organization_names`, `accessible_namespace_ids`, the external-entity half,
/// and the `RestrictedAnalyst` deny groups.
pub async fn build_acl_query_context<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    candidate_ids: &[i64],
) -> Result<AclQueryContext, KnowledgeAccessError> {
    // `build_direct_access_query_context` starts with `_get_user_or_raise`
    // (`knowledge_visibility_query.py:96` -> `:645`): the full `users` row is
    // read (`db.query(User).filter(User.id == user_id).first()`) before any
    // group read, and a missing row raises `ValueError("User not found")`.
    // The create endpoint renders that `ValueError` as a `400` with the
    // message as its detail.
    let user: Option<crate::auth::UserRow> = mysql
        .fetch_optional(crate::user_reader::USER_BY_ID_QUERY, (user_id,))
        .await?;
    if user.is_none() {
        return Err(KnowledgeAccessError::UserNotFound);
    }
    let groups = user_groups(mysql, resolvers, redis, user_id).await?;
    let orgs = organization_names(mysql).await?;
    let org_set: HashSet<&str> = orgs.iter().map(String::as_str).collect();

    // `get_effective_roles_in_groups(db, user_id, [name for name in groups if
    // name not in organization_names])`: only the restricted-group deny reads
    // these roles, and the source returns before its membership fetch when the
    // filtered list is empty.
    let non_org: Vec<String> = groups
        .iter()
        .filter(|name| !org_set.contains(name.as_str()))
        .cloned()
        .collect();
    let restricted_group_names: Vec<String> = if non_org.is_empty() {
        Vec::new()
    } else {
        let entries = iter_user_groups_with_roles(mysql, resolvers, redis, user_id).await?;
        effective_roles_in_groups(&entries, &non_org)
            .into_iter()
            .filter(|(_, role)| role == "RestrictedAnalyst")
            .map(|(name, _)| name)
            .collect()
    };

    let accessible = accessible_namespace_ids(mysql, &groups).await?;
    let external =
        collect_external_entity_member_roles(mysql, resolvers, redis, user_id, candidate_ids)
            .await?;

    Ok(AclQueryContext {
        user_id,
        authorized_groups: groups,
        organization_names: orgs,
        accessible_namespace_ids: accessible,
        external_kb_ids: external.keys().copied().collect(),
        restricted_group_names,
    })
}

/// `collect_external_entity_member_roles`: the candidate knowledge bases each
/// external entity type grants the user, with the granting roles. Returns
/// `kb_id -> roles`.
async fn collect_external_entity_member_roles<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    candidate_ids: &[i64],
) -> MysqlResult<BTreeMap<i64, Vec<String>>> {
    let candidates: HashSet<i64> = candidate_ids.iter().copied().collect();
    let mut role_map: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for entity_type in resolvers.external_types() {
        let resource_ids: Vec<i64> = resolvers
            .resource_ids_by_entity(mysql, redis, user_id, entity_type, "KnowledgeBase")
            .await?
            .into_iter()
            .filter(|id| candidates.contains(id))
            .collect();
        if resource_ids.is_empty() {
            continue;
        }
        let placeholders = placeholders(resource_ids.len());
        let rows: Vec<ExternalMemberRow> = mysql
            .fetch_all(
                &format!(
                    "SELECT resource_members.resource_id AS resource_id, \
                     resource_members.entity_id AS entity_id, \
                     resource_members.`role` AS role \n\
                     FROM resource_members \n\
                     WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
                     AND resource_members.resource_id IN ({placeholders}) \
                     AND resource_members.entity_type = ? \
                     AND resource_members.status IN {APPROVED_STATUSES}"
                ),
                external_member_args(entity_type, &resource_ids),
            )
            .await?;
        let entity_ids: Vec<String> = rows.iter().map(|row| row.entity_id.clone()).collect();
        if entity_ids.is_empty() {
            continue;
        }
        let matched = resolvers
            .match_bindings(
                redis,
                user_id,
                entity_type,
                &entity_ids,
                ResolutionPurpose::ResourceAccess,
            )
            .await?;
        for row in rows {
            if matched.contains(&row.entity_id) {
                role_map.entry(row.resource_id).or_default().push(
                    row.role
                        .clone()
                        .filter(|role| !role.is_empty())
                        .unwrap_or_else(|| "Reporter".to_string()),
                );
            }
        }
    }
    Ok(role_map)
}

#[derive(FromMysqlRow)]
struct ExternalMemberRow {
    resource_id: i64,
    entity_id: String,
    role: Option<String>,
}

/// The external-member read's bound values: the integer `resource_id`s in the
/// caller's order, then the string `entity_type`. `resource_id` is a bigint
/// column, so stringified ids never match the recorded read.
fn external_member_args(entity_type: &str, resource_ids: &[i64]) -> Vec<BindingArg> {
    let mut args: Vec<BindingArg> = resource_ids.iter().copied().map(BindingArg::Int).collect();
    args.push(BindingArg::Str(entity_type.to_owned()));
    args
}

/// `_iter_team_member_default_knowledge_base_ids`: the team members' Bots'
/// Ghosts' `spec.defaultKnowledgeBaseRefs[].id`, in member order. The bots and
/// ghosts are resolved through the ref-resolver's personal-to-public fallback
/// (`batch_load_kinds_by_refs`); a missing Ghost contributes nothing.
pub async fn team_member_default_knowledge_base_ids<M: Mysql>(
    mysql: &M,
    team: &KindRow,
) -> MysqlResult<Vec<i64>> {
    use super::bot_config::team_members;

    let members = team_members(&team.json.0);
    if members.is_empty() {
        return Ok(Vec::new());
    }
    let team_owner = team.user_id;
    let bot_refs: Vec<(String, String)> = members
        .iter()
        .map(|member| (member.bot_namespace.clone(), member.bot_name.clone()))
        .collect();
    let bots = load_kinds_by_refs(
        mysql,
        "Bot",
        team_owner,
        bot_refs
            .iter()
            .map(|(namespace, name)| (namespace.as_str(), name.as_str()))
            .collect::<Vec<_>>()
            .as_slice(),
    )
    .await?;

    let mut ghost_refs: Vec<(String, String)> = Vec::new();
    for (namespace, name) in &bot_refs {
        if let Some(bot) = bots.get(&(namespace.clone(), name.clone()))
            && let Some(ghost) = bot.json.0.get("spec").and_then(|spec| spec.get("ghostRef"))
            && let (Some(ghost_namespace), Some(ghost_name)) = (
                ghost.get("namespace").and_then(Value::as_str),
                ghost.get("name").and_then(Value::as_str),
            )
        {
            ghost_refs.push((ghost_namespace.to_string(), ghost_name.to_string()));
        }
    }
    let ghosts = load_kinds_by_refs(
        mysql,
        "Ghost",
        team_owner,
        ghost_refs
            .iter()
            .map(|(namespace, name)| (namespace.as_str(), name.as_str()))
            .collect::<Vec<_>>()
            .as_slice(),
    )
    .await?;

    let mut ids = Vec::new();
    for (namespace, name) in &ghost_refs {
        if let Some(ghost) = ghosts.get(&(namespace.clone(), name.clone())) {
            ids.extend(ghost_default_knowledge_base_ids(
                ghost.json.0.get("spec").unwrap_or(&Value::Null),
            ));
        }
    }
    Ok(ids)
}

/// `batch_load_kinds_by_refs` (`kind_ref_resolver.py`): personal-to-public
/// fallback for `default` refs (personal read keyed by the owner, then the
/// `user_id = 0` public read), and the group read keyed by
/// `(namespace, name)`.
async fn load_kinds_by_refs<M: Mysql>(
    mysql: &M,
    kind: &str,
    user_id: i64,
    refs: &[(&str, &str)],
) -> MysqlResult<BTreeMap<(String, String), KindRow>> {
    if refs.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut result: BTreeMap<(String, String), KindRow> = BTreeMap::new();

    let default_refs: Vec<&(&str, &str)> = refs.iter().filter(|(ns, _)| *ns == "default").collect();
    if !default_refs.is_empty() {
        let names: Vec<String> = default_refs
            .iter()
            .map(|(_, name)| name.to_string())
            .collect();
        if user_id != 0 {
            // `Kind.user_id == user_id` renders the owner as an integer
            // literal, so the owner slot binds as an integer.
            let mut args = vec![BindingArg::Int(user_id)];
            args.extend(names.iter().cloned().map(BindingArg::Str));
            let personal: Vec<KindRow> = mysql
                .fetch_all(&kind_by_owner_names_statement(kind, names.len()), args)
                .await?;
            for row in personal {
                result.insert((row.namespace.clone(), row.name.clone()), row);
            }
        }
        let missing: Vec<String> = default_refs
            .iter()
            .filter(|(ns, name)| !result.contains_key(&(ns.to_string(), name.to_string())))
            .map(|(_, name)| name.to_string())
            .collect();
        if !missing.is_empty() {
            let mut args = vec![BindingArg::Int(0)];
            args.extend(missing.iter().cloned().map(BindingArg::Str));
            let public: Vec<KindRow> = mysql
                .fetch_all(&kind_by_public_names_statement(kind, missing.len()), args)
                .await?;
            for row in public {
                result.insert((row.namespace.clone(), row.name.clone()), row);
            }
        }
    }

    let group_refs: Vec<&(&str, &str)> = refs.iter().filter(|(ns, _)| *ns != "default").collect();
    if !group_refs.is_empty() {
        let namespaces: Vec<String> = group_refs.iter().map(|(ns, _)| ns.to_string()).collect();
        let names: Vec<String> = group_refs
            .iter()
            .map(|(_, name)| name.to_string())
            .collect();
        let rows: Vec<KindRow> = mysql
            .fetch_all(
                &kind_by_group_names_statement(kind, namespaces.len(), names.len()),
                {
                    let mut args = Vec::new();
                    args.extend(namespaces);
                    args.extend(names);
                    args
                },
            )
            .await?;
        for row in rows {
            let key = (row.namespace.clone(), row.name.clone());
            result.entry(key).or_insert(row);
        }
    }
    Ok(result)
}

/// `Kind.user_id == owner AND kind AND namespace = 'default' AND name IN (…)`.
fn kind_by_owner_names_statement(kind: &str, name_count: usize) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = '{kind}' AND kinds.namespace = 'default' \
         AND kinds.name IN ({}) AND kinds.is_active = true",
        placeholders(name_count)
    )
}

/// `Kind.user_id = 0 AND kind AND namespace = 'default' AND name IN (…)`.
fn kind_by_public_names_statement(kind: &str, name_count: usize) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = '{kind}' AND kinds.namespace = 'default' \
         AND kinds.name IN ({}) AND kinds.is_active = true",
        placeholders(name_count)
    )
}

/// `Kind.kind AND namespace IN (…) AND name IN (…) AND is_active`.
fn kind_by_group_names_statement(kind: &str, namespace_count: usize, name_count: usize) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = '{kind}' \
         AND kinds.namespace IN ({}) AND kinds.name IN ({}) \
         AND kinds.is_active = true",
        placeholders(namespace_count),
        placeholders(name_count)
    )
}

/// `get_acl_accessible_knowledge_base_ids`: the ACL-visible candidates. The
/// recorded `queued` cases call this with `candidate_ids = [239607]` (the
/// Ghost's `defaultKnowledgeBaseRefs`), so the `user_id != 0` visibility query
/// below **is** reached. The empty-candidate early return is still the source's
/// first branch, and `build_direct_access_query_context` is built after it —
/// the source's own position and order — so a task without default knowledge
/// bases never reads the organization names or the caller's group roles.
pub async fn get_acl_accessible_knowledge_base_ids<R: Redis>(
    acl: &AclContextSource<'_, R>,
    user_id: i64,
    candidate_ids: &[i64],
) -> Result<Vec<i64>, KnowledgeAccessError> {
    let candidates = deduplicate(candidate_ids);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let candidate_params: Vec<BindingArg> =
        candidates.iter().copied().map(BindingArg::Int).collect();
    let rows = if user_id == 0 {
        acl.mysql
            .fetch_all::<_, _, MysqlRow>(
                acl_organization_knowledge_base_ids_statement(candidates.len()),
                candidate_params,
            )
            .await?
    } else {
        let context = acl.build(user_id, &candidates).await?;
        let (statement, params) = acl_visible_knowledge_base_ids_query(&context, &candidates);
        acl.mysql
            .fetch_all::<_, _, MysqlRow>(statement, params)
            .await?
    };
    let mut ids = Vec::with_capacity(rows.len());
    for row in &rows {
        ids.push(row.get_required::<i64>("kinds_id")?);
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::responses::create::knowledge_access::knowledge_access_error;
    use serde_json::json;

    /// `resource_members.resource_id` is a bigint column: the recorded read
    /// renders integer literals, so the target binds integers (a stringified
    /// id never matches).
    #[test]
    fn external_member_args_bind_resource_ids_as_integers() {
        assert_eq!(
            external_member_args("org_department", &[92]),
            vec![
                BindingArg::Int(92),
                BindingArg::Str("org_department".to_string()),
            ]
        );
        assert_eq!(
            external_member_args("org_department", &[703, 660]),
            vec![
                BindingArg::Int(703),
                BindingArg::Int(660),
                BindingArg::Str("org_department".to_string()),
            ]
        );
    }

    #[test]
    fn collects_agent_default_ids_in_order() {
        let ghosts = vec![
            json!({"defaultKnowledgeBaseRefs": [{"id": 239607}, {"id": 1}]}),
            json!({"defaultKnowledgeBaseRefs": [{"id": 2}, {"id": 239607}]}),
            json!({}),
        ];
        assert_eq!(
            team_member_default_knowledge_base_ids_from_specs(&ghosts),
            vec![239_607, 1, 2, 239_607]
        );
        assert_eq!(
            deduplicate(&team_member_default_knowledge_base_ids_from_specs(&ghosts)),
            vec![239_607, 1, 2]
        );
    }

    #[test]
    fn default_ids_keep_candidate_order_and_drop_denied() {
        assert_eq!(
            resolve_default_knowledge_base_ids(&[239_607, 1, 239_607, 2], &[239_607, 2]),
            vec![239_607, 2]
        );
        assert!(resolve_default_knowledge_base_ids(&[1], &[]).is_empty());
    }

    #[test]
    fn a_ghost_without_defaults_contributes_nothing() {
        assert!(ghost_default_knowledge_base_ids(&json!({})).is_empty());
        assert!(
            ghost_default_knowledge_base_ids(&json!({"defaultKnowledgeBaseRefs": []})).is_empty()
        );
    }

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn acl_organization_read_matches_the_source_shape() {
        // `db.query(Kind.id).join(Namespace, ...).filter(...)` for `user_id = 0`.
        let sql = normalize(&acl_organization_knowledge_base_ids_statement(2));
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id FROM kinds INNER JOIN namespace"));
        assert!(sql.contains("WHERE kinds.id IN (?, ?)"));
        assert!(sql.contains("kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true"));
        assert!(sql.contains("namespace.level = 'organization' AND namespace.is_active IS true"));
    }

    #[test]
    fn acl_visible_query_matches_the_recorded_statement() {
        // The recorded ACL query for the `queued` case `2834ba9c`
        // (`user_id = 477`), with its literals replaced by `?`.
        let context = AclQueryContext {
            user_id: 477,
            authorized_groups: ["ns-a", "team-c", "team-a", "team-b", "team-d"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            organization_names: ["org-a", "org-b"].iter().map(|s| s.to_string()).collect(),
            accessible_namespace_ids: ["569", "90", "615", "557", "567"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            external_kb_ids: Vec::new(),
            restricted_group_names: Vec::new(),
        };
        let (sql, params) = acl_visible_knowledge_base_ids_query(&context, &[239_607]);
        let member = "EXISTS (SELECT 1 FROM resource_members WHERE \
             resource_members.resource_type IN ('KnowledgeBase', 'KNOWLEDGE_BASE') AND \
             resource_members.resource_id = kinds.id AND \
             resource_members.status IN ('approved', 'APPROVED') AND ";
        let expected = format!(
            "SELECT kinds.id AS kinds_id FROM kinds WHERE kinds.kind = 'KnowledgeBase' AND \
             kinds.is_active IS true AND (kinds.user_id = ? AND kinds.namespace = 'default' OR \
             kinds.namespace IN (?, ?, ?, ?, ?) OR kinds.namespace IN (?, ?) OR \
             ({member}resource_members.entity_type = 'user' AND resource_members.entity_id = ?)) OR \
             ({member}resource_members.entity_type = 'namespace' AND \
             resource_members.entity_id IN (?, ?, ?, ?, ?)))) AND kinds.id IN (?) AND \
             NOT ({member}resource_members.entity_type = 'user' AND \
             resource_members.entity_id = ? AND resource_members.`role` = 'RestrictedAnalyst'))"
        );
        assert_eq!(normalize(&sql), normalize(&expected));
        assert_eq!(
            params,
            vec![
                BindingArg::Int(477),
                BindingArg::Str("ns-a".to_string()),
                BindingArg::Str("team-c".to_string()),
                BindingArg::Str("team-a".to_string()),
                BindingArg::Str("team-b".to_string()),
                BindingArg::Str("team-d".to_string()),
                BindingArg::Str("org-a".to_string()),
                BindingArg::Str("org-b".to_string()),
                BindingArg::Str("477".to_string()),
                BindingArg::Str("569".to_string()),
                BindingArg::Str("90".to_string()),
                BindingArg::Str("615".to_string()),
                BindingArg::Str("557".to_string()),
                BindingArg::Str("567".to_string()),
                BindingArg::Int(239_607),
                BindingArg::Str("477".to_string()),
            ]
        );
    }

    #[test]
    fn acl_visible_query_omits_the_optional_edges_when_absent() {
        let context = AclQueryContext {
            user_id: 42,
            ..Default::default()
        };
        let (sql, params) = acl_visible_knowledge_base_ids_query(&context, &[7]);
        let flat = normalize(&sql);
        assert!(!flat.contains("kinds.namespace IN"));
        assert!(!flat.contains("kinds.namespace NOT IN"));
        // Only the shared user EXISTS and the deny user EXISTS remain; the
        // candidate filter is the sole `kinds.id IN`.
        assert_eq!(
            flat.matches("EXISTS (SELECT 1 FROM resource_members")
                .count(),
            2
        );
        assert_eq!(flat.matches("kinds.id IN (?)").count(), 1);
        assert_eq!(
            params,
            vec![
                BindingArg::Int(42),
                BindingArg::Str("42".to_string()),
                BindingArg::Int(7),
                BindingArg::Str("42".to_string()),
            ]
        );
    }

    /// `build_direct_access_query_context` (`knowledge_visibility_query.py:96`)
    /// begins with `_get_user_or_raise` (`:645`): the full `users` row is the
    /// first statement the ACL context issues, and the build stops when the
    /// row is missing (the Source's `ValueError`, rendered as a 500).
    #[tokio::test]
    async fn acl_context_reads_the_user_row_before_any_group_read() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mysql = crate::connect_mysql(&format!(
                "mysql://test:test@{}/test?ssl-mode=disabled",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(
                crate::sql_test_support::mysql_pool_server::capture_queries_until(
                    listener, stopped,
                ),
            );
            let resolvers = EntityResolvers::public(
                MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test")
                    .expect("lazy pool"),
            );
            let result = build_acl_query_context(
                &mysql,
                &resolvers,
                None::<&brz_redis::RedisService>,
                477,
                &[263_078],
            )
            .await;
            assert!(
                result.is_err(),
                "the fake server answers with a parse error"
            );
            stop.send(()).unwrap();
            let queries = server.await.unwrap();
            assert_eq!(queries.len(), 1, "{queries:?}");
            assert_eq!(
                normalize(&queries[0]),
                normalize(crate::user_reader::USER_BY_ID_QUERY),
                "the ACL context's first read is the team owner's users row"
            );
            mysql.close().await;
        })
        .await
        .expect("the user read should be the first prepared statement");
    }

    /// `get_acl_accessible_knowledge_base_ids` returns before
    /// `build_direct_access_query_context` when the candidate set is empty, so
    /// the ACL path never reads a user row for a task without defaults. The
    /// lazy pool would fail the test if any statement attempted a connection.
    #[tokio::test]
    async fn an_empty_access_set_never_reads_the_user_row() {
        let mysql =
            MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").expect("lazy pool");
        let resolvers = EntityResolvers::public(
            MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").expect("lazy pool"),
        );
        let acl = AclContextSource::new(&mysql, &resolvers, None::<&brz_redis::RedisService>);
        let ids = get_acl_accessible_knowledge_base_ids(&acl, 477, &[])
            .await
            .expect("the empty access set short-circuits before any read");
        assert!(ids.is_empty());
    }

    /// `_get_user_or_raise`'s `ValueError("User not found")` is not handled by
    /// `build_execution_request`, so the create endpoint's `except ValueError`
    /// (`openapi_responses.py:1202-1210`) answers `400` with the message as
    /// `detail`. A store failure keeps the dependency `500`.
    #[test]
    fn a_missing_user_row_is_the_source_value_error() {
        let missing = knowledge_access_error(KnowledgeAccessError::UserNotFound);
        assert_eq!(missing.status(), brz_http_server::StatusCode::BAD_REQUEST);
        assert_eq!(missing.detail_message(), Some("User not found"));

        let failed = knowledge_access_error(KnowledgeAccessError::Mysql(
            brz_mysql::MysqlError::RowNotFound,
        ));
        assert_eq!(
            failed.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
