// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL construction for `GET /api/knowledge-bases`:
//! `build_direct_access_query_context`, `build_knowledge_base_visibility_query`,
//! `apply_direct_access_filter`, and the paginated count/select statements of
//! `KnowledgeService.list_knowledge_bases_paginated`.
//!
//! The rendered SQL mirrors the recorded COM_QUERY text: the `kinds` batches,
//! the `EXISTS`-bearing direct-access predicate of `apply_direct_access_filter`
//! (which the replay engine matches in order), and the `count(*)` wrapper and
//! `LIMIT <offset>, <limit>` select the source issues.
use std::collections::HashMap;

use brz_mysql::{Mysql, MysqlResult};

use crate::knowledge_bases_all_grouped::membership::{
    effective_role_in_group, effective_roles, user_group_role_map, user_groups,
};
use crate::knowledge_bases_all_grouped::py_order::PyStrSetOrder;
use crate::knowledge_bases_all_grouped::queries::{
    accessible_namespace_ids, active_namespace_names, organization_namespace_names, user_by_id,
};
use crate::knowledge_bases_all_grouped::{
    APPROVED_STATUSES, KB_RESOURCE_TYPES, KIND_COLUMNS, has_permission, quote_literal,
};
use crate::permissions::EntityResolvers;
use crate::py_set_order::SetOrder;

use super::external_roles::collect_external_entity_member_roles;

/// `app.schemas.knowledge.ResourceScope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    Personal,
    Group,
    Organization,
    All,
}

impl Scope {
    /// `ResourceScope(value)`; an unknown value is a source `ValueError` the
    /// handler maps to `400`.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "personal" => Some(Self::Personal),
            "group" => Some(Self::Group),
            "organization" => Some(Self::Organization),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

/// `DirectAccessPermissionContext` for the paginated list request.
pub(crate) struct PermissionContext {
    pub(crate) user_id: i64,
    pub(crate) user_role: String,
    pub(crate) accessible_groups: Vec<String>,
    pub(crate) organization_names: Vec<String>,
    pub(crate) group_roles: HashMap<String, String>,
    pub(crate) group_role_order: Vec<String>,
    pub(crate) accessible_ns_ids: Vec<i64>,
    pub(crate) external_editable_ids: Vec<i64>,
    pub(crate) external_kb_ids: Vec<i64>,
}

/// `build_direct_access_query_context(db, user_id)` — the source evaluates its
/// keyword arguments in order: `_get_user_or_raise`, `get_user_groups`,
/// `_get_organization_names`, `get_effective_roles_in_groups`,
/// `_get_accessible_namespace_ids`, then `collect_external_entity_member_roles`.
pub(crate) async fn build_context<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    user_role: &str,
) -> MysqlResult<PermissionContext>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    // `_get_user_or_raise`.
    let (_, context_user_role) = user_by_id(mysql, user_id)
        .await?
        .unwrap_or((user_id, user_role.to_string()));

    // `get_user_groups` -> `get_user_group_roles`: every active namespace name,
    // then the first membership batch.
    let active_names = active_namespace_names(mysql).await?;
    let role_map = user_group_role_map(mysql, redis, resolvers, user_id).await?;
    let accessible_groups = user_groups(&role_map, &active_names);

    let organization_names = organization_namespace_names(mysql).await?;

    // `get_effective_roles_in_groups`: the second membership batch; the source
    // returns early for an empty group list without running it.
    let non_org_groups: Vec<String> = accessible_groups
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
    let group_role_order: Vec<String> = non_org_groups
        .iter()
        .filter(|name| group_roles.contains_key(*name))
        .cloned()
        .collect();

    let accessible_ns_ids = accessible_namespace_ids(mysql, &accessible_groups).await?;

    let external = collect_external_entity_member_roles(mysql, redis, resolvers, user_id).await?;
    let external_editable_ids = external_editable_ids(&external);

    Ok(PermissionContext {
        user_id,
        user_role: context_user_role,
        accessible_groups,
        organization_names,
        group_roles,
        group_role_order,
        accessible_ns_ids,
        external_editable_ids,
        external_kb_ids: external.kb_ids(),
    })
}

/// `apply_direct_access_filter`'s `external_editable_ids` set comprehension.
fn external_editable_ids(external: &super::external_roles::ExternalMemberRoles) -> Vec<i64> {
    let mut order = SetOrder::new();
    for (kb_id, roles) in &external.role_map {
        if roles.iter().any(|role| has_permission(role, "Developer")) {
            order.add(*kb_id);
        }
    }
    order.order()
}

/// The base `FROM`/visibility clause of `build_knowledge_base_visibility_query`.
/// `None` is the source's `if query is None: return [], 0` (an inaccessible
/// group scope).
pub(crate) struct Visibility {
    /// `INNER JOIN namespace ON kinds.namespace = namespace.name` for the
    /// organization scope; empty otherwise.
    pub(crate) join: &'static str,
    /// Everything after `WHERE` (the base filters plus the visibility filter).
    pub(crate) filters: String,
}

/// `build_knowledge_base_visibility_query(...)`.
pub(crate) async fn build_visibility<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    ctx: &PermissionContext,
    scope: Scope,
    group_name: Option<&str>,
) -> MysqlResult<Option<Visibility>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let base = "kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true";
    match scope {
        Scope::Group => {
            let Some(group_name) = group_name else {
                return Ok(None);
            };
            // `get_effective_role_in_group(db, user_id, group_name) is None`.
            if effective_role_in_group(mysql, redis, resolvers, ctx.user_id, group_name)
                .await?
                .is_none()
            {
                return Ok(None);
            }
            Ok(Some(Visibility {
                join: "",
                filters: format!("{base} AND kinds.namespace = {}", quote_literal(group_name)),
            }))
        }
        Scope::Organization => Ok(Some(Visibility {
            join: " INNER JOIN namespace ON kinds.namespace = namespace.name",
            filters: format!(
                "{base} AND namespace.level = 'organization' AND namespace.is_active IS true"
            ),
        })),
        Scope::Personal => Ok(Some(Visibility {
            join: "",
            filters: format!("{base} AND ({})", personal_condition(ctx)),
        })),
        Scope::All => Ok(Some(Visibility {
            join: "",
            filters: format!("{base} AND ({})", all_condition(ctx)),
        })),
    }
}

/// `_build_personal_query`: `or_((user_id & default), shared_access?)`.
fn personal_condition(ctx: &PermissionContext) -> String {
    let mut conditions = vec![format!(
        "kinds.user_id = {} AND kinds.namespace = 'default'",
        ctx.user_id
    )];
    conditions.extend(shared_access_conditions(ctx));
    conditions.join(" OR ")
}

/// `_build_all_query`: `or_((user_id & default), accessible, organization, shared?)`.
fn all_condition(ctx: &PermissionContext) -> String {
    let mut conditions = vec![format!(
        "kinds.user_id = {} AND kinds.namespace = 'default'",
        ctx.user_id
    )];
    if !ctx.accessible_groups.is_empty() {
        conditions.push(format!(
            "kinds.namespace IN ({})",
            quoted_list(&ctx.accessible_groups)
        ));
    }
    if !ctx.organization_names.is_empty() {
        conditions.push(format!(
            "kinds.namespace IN ({})",
            quoted_list(&ctx.organization_names)
        ));
    }
    conditions.extend(shared_access_conditions(ctx));
    conditions.join(" OR ")
}

/// `_shared_access_condition`: the direct-member, namespace-entity, and
/// external-entity grant branches.
fn shared_access_conditions(ctx: &PermissionContext) -> Vec<String> {
    let mut conditions = vec![member_exists(&format!(
        "resource_members.entity_type = 'user' AND resource_members.entity_id = '{}'",
        ctx.user_id
    ))];
    if !ctx.accessible_ns_ids.is_empty() {
        let ns_set = PyStrSetOrder::from_row_order(&ctx.accessible_ns_ids);
        let quoted = ns_set
            .order()
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        conditions.push(member_exists(&format!(
            "resource_members.entity_type = 'namespace' AND resource_members.entity_id IN ({quoted})"
        )));
    }
    if !ctx.external_kb_ids.is_empty() {
        let ids = ctx
            .external_kb_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        conditions.push(format!("kinds.id IN ({ids})"));
    }
    conditions
}

/// `apply_direct_access_filter` plus `apply_acl_deny_filter`: the rendered
/// direct-access predicate.
pub(crate) fn direct_access_predicate(ctx: &PermissionContext) -> String {
    let user_id = ctx.user_id;
    let mut edit_conditions = vec![
        format!("kinds.user_id = {user_id}"),
        member_exists(&format!(
            "resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' \
             AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer')"
        )),
    ];
    if !ctx.accessible_ns_ids.is_empty() {
        // `context.accessible_namespace_ids` is a `frozenset[str]`; the IN list
        // renders its CPython `set[str]` iteration order.
        let ns_set = PyStrSetOrder::from_row_order(&ctx.accessible_ns_ids);
        let quoted = ns_set
            .order()
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        edit_conditions.push(member_exists(&format!(
            "resource_members.entity_type = 'namespace' AND resource_members.entity_id IN ({quoted}) \
             AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer')"
        )));
    }
    if !ctx.external_editable_ids.is_empty() {
        let ids = ctx
            .external_editable_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        edit_conditions.push(format!("kinds.id IN ({ids})"));
    }
    let editable_groups: Vec<String> = ctx
        .group_role_order
        .iter()
        .filter(|name| {
            ctx.group_roles
                .get(*name)
                .is_some_and(|role| has_permission(role, "Developer"))
        })
        .map(|name| quote_literal(name))
        .collect();
    if !editable_groups.is_empty() {
        edit_conditions.push(format!(
            "kinds.namespace IN ({})",
            editable_groups.join(", ")
        ));
    }
    if ctx.user_role == "admin" && !ctx.organization_names.is_empty() {
        edit_conditions.push(format!(
            "kinds.namespace IN ({})",
            quoted_list(&ctx.organization_names)
        ));
    }

    let requirement = requirement_expr();
    let mut predicate = format!(
        "({requirement} = '' OR {requirement} = 'read' OR {requirement} = 'edit' AND ({})) \
         AND NOT {}",
        edit_conditions.join(" OR "),
        member_exists(&format!(
            "resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' \
             AND resource_members.`role` = 'RestrictedAnalyst'"
        )),
    );

    // `apply_acl_deny_filter`'s restricted-group `NOT IN`.
    let restricted: Vec<String> = ctx
        .group_role_order
        .iter()
        .filter(|name| ctx.group_roles.get(*name).map(String::as_str) == Some("RestrictedAnalyst"))
        .map(|name| quote_literal(name))
        .collect();
    if !restricted.is_empty() {
        predicate.push_str(&format!(
            " AND (kinds.namespace NOT IN ({}))",
            restricted.join(", ")
        ));
    }
    predicate
}

/// `knowledge_base_json_text(db, "$.spec.directAccessRequirement")` on MySQL.
fn requirement_expr() -> &'static str {
    "coalesce(json_unquote(json_extract(kinds.json, '$.spec.directAccessRequirement')), '')"
}

/// `_approved_member_query(db).filter(...).exists()` rendering.
fn member_exists(extra: &str) -> String {
    format!(
        "(EXISTS (SELECT 1 \nFROM resource_members \n\
         WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
         AND resource_members.resource_id = kinds.id \
         AND resource_members.status IN {APPROVED_STATUSES} \
         AND {extra}))"
    )
}

fn quoted_list(values: &[String]) -> String {
    values
        .iter()
        .map(|value| quote_literal(value))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The `count(*)` wrapper and the ordered, paginated select for the list.
pub(crate) struct ListSql {
    pub(crate) count: String,
    pub(crate) select: String,
}

/// `KnowledgeService.list_knowledge_bases_paginated`'s count and page query.
pub(crate) fn build_list_sql(
    scope: Scope,
    visibility: &Visibility,
    predicate: &str,
    ctx: &PermissionContext,
    limit: i64,
    offset: i64,
) -> ListSql {
    // `apply_direct_access_filter` appends `AND (<or_>)` and
    // `apply_acl_deny_filter` appends `AND NOT (<exists>)` as separate
    // `filter(...)` calls, so the predicate carries its own parentheses.
    let where_clause = format!("{} AND {predicate}", visibility.filters);
    let from_where = format!("FROM kinds{} \nWHERE {where_clause}", visibility.join);
    let inner = format!("SELECT {KIND_COLUMNS} \n{from_where}");
    let count = format!("SELECT count(*) AS count_1 \nFROM ({inner}) AS anon_1");

    let order = match scope {
        Scope::All => format!(
            " ORDER BY {}, kinds.updated_at DESC, kinds.id DESC",
            category_order(ctx)
        ),
        _ => " ORDER BY kinds.updated_at DESC, kinds.id DESC".to_string(),
    };
    let select = format!("SELECT {KIND_COLUMNS} \n{from_where}{order} \n LIMIT {offset}, {limit}");
    ListSql { count, select }
}

/// The `category_order` `case(...)` of the `ALL` scope ordering.
fn category_order(ctx: &PermissionContext) -> String {
    let team_names: Vec<&String> = ctx
        .accessible_groups
        .iter()
        .filter(|name| !ctx.organization_names.contains(name))
        .collect();
    let mut clauses = vec![format!(
        "CASE WHEN (kinds.user_id = {} AND kinds.namespace = 'default') THEN 0",
        ctx.user_id
    )];
    if team_names.is_empty() {
        clauses.push(" WHEN (0 = 1) THEN 1".to_string());
    } else {
        let quoted = team_names
            .iter()
            .map(|name| quote_literal(name))
            .collect::<Vec<_>>()
            .join(", ");
        clauses.push(format!(" WHEN (kinds.namespace IN ({quoted})) THEN 1"));
    }
    if ctx.organization_names.is_empty() {
        clauses.push(" WHEN (0 = 1) THEN 2".to_string());
    } else {
        clauses.push(format!(
            " WHEN (kinds.namespace IN ({})) THEN 2",
            quoted_list(&ctx.organization_names)
        ));
    }
    clauses.push(" ELSE 3 END".to_string());
    clauses.concat()
}
