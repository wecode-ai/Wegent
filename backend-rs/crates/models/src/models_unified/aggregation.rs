// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unified model aggregation entry points, ported from
//! `app/services/model_aggregation_service.py` and
//! `app/services/adapters/public_model.py`.
use std::collections::{BTreeMap, BTreeSet};

use brz_mysql::Mysql;
use serde_json::{Map as JsonMap, Value as Json};

use super::models::{
    MODEL_TYPE_GROUP, MODEL_TYPE_PUBLIC, MODEL_TYPE_USER, UnifiedModel, UnifiedModelResponse,
    UnifiedQuery, extract_model_info, highest_role, is_custom_model,
    is_model_compatible_with_shell, is_public_model_visible, is_wework_available,
};
use super::mysql::{KindRow, NameRow, NamespaceRefRow, ReferencedKindRow, UserRow};
use super::shell_lookup::get_shell_support_model;

/// Kind names that carry capability references, mirroring the source
/// `capability_reference_service.REFERENCE_KINDS`.
const REFERENCE_KINDS: [&str; 3] = ["Model", "Shell", "Retriever"];

/// The referenced capability kind served by this endpoint.
const REFERENCE_MODEL_KIND: &str = "Model";

/// Branch order of the referenced-capability `or_` filter, mirroring the
/// recorded source statement of the current recording: every multi-branch
/// statement renders the `user` branch before the `namespace` branch.
const ENTITY_TYPE_BRANCH_ORDER: [&str; 2] = ["user", "namespace"];

/// Aggregate the unified model list, mirroring `list_available_models`.
pub async fn list_available_models<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    current_user: &UserRow,
    query: &UnifiedQuery,
) -> anyhow::Result<Vec<UnifiedModelResponse>>
where
    M: Mysql + Sync,
{
    Ok(
        list_available_model_resources(mysql, redis, resolvers, current_user, query)
            .await?
            .into_iter()
            .map(|(model, _)| model.into_response(query.include_config))
            .collect(),
    )
}

/// Authorized entries and their source CRDs from the same fresh visibility read.
/// Execution consumers must keep the CRD private and project a safe catalog.
pub async fn list_available_model_resources<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    current_user: &UserRow,
    query: &UnifiedQuery,
) -> anyhow::Result<Vec<(UnifiedModel, KindRow)>>
where
    M: Mysql + Sync,
{
    let (support_model, actual_shell_type) = match &query.shell_type {
        Some(shell_type) => {
            get_shell_support_model(mysql, redis, resolvers, shell_type, current_user.id).await?
        }
        None => (Vec::new(), String::new()),
    };

    let mut result: Vec<(UnifiedModel, KindRow)> = Vec::new();
    let mut seen_names: BTreeMap<String, &'static str> = BTreeMap::new();

    let namespaces_to_query = match resolve_scope(
        mysql,
        redis,
        resolvers,
        &query.scope,
        query.group_name.as_deref(),
        current_user.id,
    )
    .await?
    {
        Some(namespaces) => namespaces,
        None => anyhow::bail!("invalid scope: {}", query.scope),
    };

    // Both reads are batched over every requested namespace, mirroring
    // `load_direct_models_by_namespace` followed by
    // `list_referenced_capabilities_by_namespace`.
    let mut direct_by_namespace =
        load_direct_models_by_namespace(mysql, current_user.id, &namespaces_to_query).await?;
    let mut references_by_namespace = list_referenced_capabilities_by_namespace(
        mysql,
        REFERENCE_MODEL_KIND,
        current_user.id,
        &namespaces_to_query,
    )
    .await?;

    for namespace in namespaces_to_query {
        let resource_type = if namespace == "default" {
            MODEL_TYPE_USER
        } else {
            MODEL_TYPE_GROUP
        };
        let mut direct_models = direct_by_namespace.remove(&namespace).unwrap_or_default();
        let mut referenced_models = references_by_namespace
            .remove(&namespace)
            .unwrap_or_default();
        // The source sorts both reads by row id, keeps the first row per name,
        // and appends only the referenced names that are still absent.
        direct_models.sort_by_key(|row| row.id);
        referenced_models.sort_by_key(|row| row.id);
        let direct_names: BTreeSet<String> =
            direct_models.iter().map(|row| row.name.clone()).collect();
        let referenced_ids: BTreeSet<i32> = referenced_models
            .iter()
            .filter(|row| !direct_names.contains(&row.name))
            .map(|row| row.id)
            .collect();
        let mut selected: Vec<KindRow> = Vec::new();
        let mut chosen: BTreeSet<String> = BTreeSet::new();
        let referenced_only = referenced_models
            .into_iter()
            .filter(|row| !direct_names.contains(&row.name));
        for resource in direct_models.into_iter().chain(referenced_only) {
            if chosen.insert(resource.name.clone()) {
                selected.push(resource);
            }
        }

        for resource in selected {
            let model_data = &resource.json.0;
            if is_custom_model(model_data) {
                continue;
            }
            let info = extract_model_info(model_data);
            if query.shell_type.is_some()
                && !is_model_compatible_with_shell(
                    &info.model_category_type,
                    info.provider.as_deref(),
                    &actual_shell_type,
                    &support_model,
                    &info.config,
                )
            {
                continue;
            }
            if let Some(category) = &query.model_category_type
                && info.model_category_type != *category
            {
                continue;
            }
            if query.client_origin.as_deref() == Some("wework") && !is_wework_available(model_data)
            {
                continue;
            }
            if seen_names.contains_key(&resource.name) {
                continue;
            }
            let model = UnifiedModel {
                name: resource.name.clone(),
                model_type: resource_type,
                display_name: info.display_name,
                provider: info.provider,
                model_id: info.model_id,
                config: info.config,
                is_active: resource.is_active,
                namespace: namespace.clone(),
                model_category_type: info.model_category_type,
                is_advanced: info.is_advanced,
                model_group: info.model_group,
                model_sub_group: info.model_sub_group,
                context_window: info.context_window,
                max_output_tokens: info.max_output_tokens,
                cost_index: info.cost_index,
                capability: info.capability,
                model_capabilities: info.model_capabilities.map(Into::into),
                resource_id: Some(resource.id as i64),
                resource_user_id: Some(resource.user_id as i64),
                created_at: Some(resource.created_at.format("%Y-%m-%dT%H:%M:%S").to_string()),
                updated_at: Some(resource.updated_at.format("%Y-%m-%dT%H:%M:%S").to_string()),
                is_reference: referenced_ids.contains(&resource.id),
            };
            seen_names.insert(resource.name.clone(), resource_type);
            result.push((model, resource));
        }
    }

    // Public models, mirroring `public_model_service.get_models`.
    let public_models = list_public_models(mysql, Some(current_user.user_name.as_str())).await?;
    for model_dict in public_models {
        let info = public_model_info(&model_dict);
        if query.shell_type.is_some()
            && !is_model_compatible_with_shell(
                &info.model_category_type,
                info.provider.as_deref(),
                &actual_shell_type,
                &support_model,
                &info.config,
            )
        {
            continue;
        }
        if let Some(category) = &query.model_category_type
            && info.model_category_type != *category
        {
            continue;
        }
        if query.client_origin.as_deref() == Some("wework") && !info.is_wework_available {
            continue;
        }
        let model_name = info.name.clone().unwrap_or_default();
        let model = UnifiedModel {
            name: model_name.clone(),
            model_type: MODEL_TYPE_PUBLIC,
            display_name: info.display_name,
            provider: info.provider,
            model_id: info.model_id,
            config: info.config,
            is_active: info.is_active,
            namespace: "default".to_string(),
            model_category_type: info.model_category_type,
            is_advanced: info.is_advanced,
            model_group: info.model_group,
            model_sub_group: info.model_sub_group,
            context_window: info.context_window,
            max_output_tokens: info.max_output_tokens,
            cost_index: info.cost_index,
            capability: info.capability,
            model_capabilities: info.model_capabilities.map(Into::into),
            resource_id: None,
            resource_user_id: Some(0),
            created_at: info.created_at,
            updated_at: info.updated_at,
            is_reference: false,
        };
        result.push((model, model_dict));
        seen_names.entry(model_name).or_insert(MODEL_TYPE_PUBLIC);
    }

    result.sort_by(|(a, _), (b, _)| a.name.cmp(&b.name));
    Ok(result)
}

struct PublicModelInfo {
    name: Option<String>,
    display_name: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
    config: JsonMap<String, Json>,
    is_active: bool,
    is_advanced: bool,
    is_wework_available: bool,
    model_category_type: String,
    model_group: Option<String>,
    model_sub_group: Option<String>,
    context_window: Option<i64>,
    max_output_tokens: Option<i64>,
    cost_index: Option<String>,
    capability: Option<String>,
    model_capabilities: Option<super::models::ModelCapabilities>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// Convert a public kinds row, mirroring `ModelAdapter.to_model_dict`:
/// the env api key is stripped, provider/model_id extracted from env.
fn public_model_info(resource: &KindRow) -> PublicModelInfo {
    // The public adapter's `to_model_dict` only adds the type-specific
    // config for video models — unlike `_extract_model_info_from_crd`,
    // it has no imageConfig branch — so the image config extraction must
    // not run here even though the CRD carries it.
    let mut info = extract_model_info(&resource.json.0);
    // The public adapter adds the type-specific config only for video
    // models (no imageConfig branch), so drop the image variant here.
    info.config.remove("imageConfig");
    // The public adapter also exports `embeddingConfig`, which
    // `_extract_model_info_from_crd` validates through `Model.model_validate`
    // but never returns.
    if let Some(raw) = resource
        .json
        .0
        .get("spec")
        .and_then(Json::as_object)
        .and_then(|spec| spec.get("embeddingConfig"))
        .filter(|value| !value.is_null())
        && let Ok(dumped) = super::generation_config::embedding_config_dump(raw)
    {
        info.config.insert("embeddingConfig".into(), dumped);
    }
    // Strip sensitive env values; the public adapter keeps env as an empty map.
    info.config
        .insert("env".into(), Json::Object(JsonMap::new()));
    PublicModelInfo {
        name: Some(resource.name.clone()),
        display_name: info.display_name,
        provider: info.provider,
        model_id: info.model_id,
        config: info.config,
        is_active: resource.is_active,
        is_advanced: info.is_advanced,
        is_wework_available: info.is_wework_available,
        model_category_type: info.model_category_type,
        model_group: info.model_group,
        model_sub_group: info.model_sub_group,
        context_window: info.context_window,
        max_output_tokens: info.max_output_tokens,
        cost_index: info.cost_index,
        capability: info.capability,
        model_capabilities: info.model_capabilities,
        created_at: Some(resource.created_at.format("%Y-%m-%dT%H:%M:%S").to_string()),
        updated_at: Some(resource.updated_at.format("%Y-%m-%dT%H:%M:%S").to_string()),
    }
}

/// Resolve scope into the ordered namespace list, mirroring the source
/// branch behavior; `None` means an invalid scope.
async fn resolve_scope<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    scope: &str,
    group_name: Option<&str>,
    user_id: i32,
) -> anyhow::Result<Option<Vec<String>>>
where
    M: Mysql + Sync,
{
    match scope {
        "personal" => Ok(Some(vec!["default".to_string()])),
        "group" => match group_name {
            Some(name) => Ok(Some(vec![name.to_string()])),
            None => Ok(Some(
                get_user_groups(mysql, redis, resolvers, user_id).await?,
            )),
        },
        "all" => {
            let mut namespaces = vec!["default".to_string()];
            namespaces.extend(get_user_groups(mysql, redis, resolvers, user_id).await?);
            Ok(Some(namespaces))
        }
        _ => Ok(None),
    }
}

/// Get all group names the user belongs to, mirroring `get_user_groups`:
/// active namespaces plus `get_effective_roles_in_groups`, which runs the
/// shared `iter_user_groups_with_roles` batch (direct + entity-derived
/// memberships), applies parent-group inheritance, and keeps the groups with
/// an effective role sorted.
pub(super) async fn get_user_groups<M, R: brz_redis::Redis>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i32,
) -> anyhow::Result<Vec<String>>
where
    M: Mysql + Sync,
{
    // All active group names (source queries namespace.name where is_active).
    let group_names: Vec<String> = mysql
        .fetch_all::<_, _, NameRow>(
            "SELECT namespace.name AS name FROM namespace WHERE namespace.is_active IS true",
            (),
        )
        .await?
        .into_iter()
        .map(|row| row.name)
        .collect();
    if group_names.is_empty() {
        return Ok(Vec::new());
    }

    // `iter_user_groups_with_roles`: one shared batch over the registered
    // entity resolvers (direct memberships, then every entity type's approved
    // member rows matched in memory). The source's group-role path never runs
    // `get_resource_ids_by_entity`'s resource-visibility chain.
    let entries =
        crate::permissions::iter_user_groups_with_roles(mysql, resolvers, redis, user_id as i64)
            .await
            .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let mut role_map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in entries {
        role_map
            .entry(entry.group_name)
            .or_default()
            .push(entry.role);
    }

    let mut groups: Vec<String> = Vec::new();
    for group_name in &group_names {
        let mut roles = match role_map.get(group_name) {
            Some(roles) if !roles.is_empty() => roles.clone(),
            _ => {
                // Parent group inheritance: 'aaa/bbb' inherits from 'aaa'.
                if group_name.contains('/') {
                    let parts: Vec<&str> = group_name.split('/').collect();
                    let mut inherited: Option<Vec<String>> = None;
                    for index in (1..parts.len()).rev() {
                        let parent = parts[..index].join("/");
                        if let Some(parent_roles) = role_map.get(&parent)
                            && !parent_roles.is_empty()
                        {
                            inherited = Some(parent_roles.clone());
                            break;
                        }
                    }
                    match inherited {
                        Some(roles) => roles,
                        None => continue,
                    }
                } else {
                    continue;
                }
            }
        };
        if highest_role(&roles).is_some() {
            roles.clear();
            groups.push(group_name.clone());
        }
    }
    groups.sort();
    Ok(groups)
}

async fn fetch_in_list<T, A, M>(mysql: &M, sql: &str, arguments: Vec<A>) -> anyhow::Result<Vec<T>>
where
    M: Mysql + Sync,
    A: brz_mysql::MysqlValue + Send,
    T: brz_mysql::FromMysqlRow + Send,
{
    // brz-mysql implements MysqlArgs for Vec; each element binds to one `?`.
    Ok(mysql.fetch_all(sql, arguments).await?)
}

/// Direct (namespace-owned) models for every requested namespace, mirroring
/// `load_direct_models_by_namespace`: the personal namespace keeps its owner
/// filter, and every group namespace is read in one batched `IN` query.
async fn load_direct_models_by_namespace<M>(
    mysql: &M,
    user_id: i32,
    namespaces: &[String],
) -> anyhow::Result<BTreeMap<String, Vec<KindRow>>>
where
    M: Mysql + Sync,
{
    let mut result: BTreeMap<String, Vec<KindRow>> = namespaces
        .iter()
        .map(|name| (name.clone(), Vec::new()))
        .collect();
    if result.contains_key("default") {
        // `kind_service.list_resources(kind="Model", namespace="default")`
        // keeps personal ownership filtering and `is_active = true`.
        let rows: Vec<KindRow> = mysql
            .fetch_all(
                "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at \
                 FROM kinds WHERE kind = 'Model' AND namespace = ? AND is_active = true AND user_id = ?",
                ("default", user_id),
            )
            .await?;
        result.insert("default".to_string(), rows);
    }
    let group_names: Vec<String> = namespaces
        .iter()
        .filter(|name| name.as_str() != "default")
        .cloned()
        .collect();
    if !group_names.is_empty() {
        let sql = format!(
            "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at \
             FROM kinds WHERE kind = 'Model' AND namespace IN ({}) AND is_active IS true",
            placeholders(group_names.len())
        );
        let rows: Vec<KindRow> = fetch_in_list(mysql, &sql, group_names).await?;
        for row in rows {
            // A namespace that appeared twice keeps the source's single bucket.
            if let Some(bucket) = result.get_mut(&row.namespace) {
                bucket.push(row);
            }
        }
    }
    Ok(result)
}

/// Referenced capability rows for every requested namespace, mirroring
/// `list_referenced_capabilities_by_namespace`: the visible membership targets
/// are resolved first, then one join reads every referenced `kinds` row.
pub(super) async fn list_referenced_capabilities_by_namespace<M>(
    mysql: &M,
    kind: &str,
    user_id: i32,
    namespaces: &[String],
) -> anyhow::Result<BTreeMap<String, Vec<KindRow>>>
where
    M: Mysql + Sync,
{
    let mut result: BTreeMap<String, Vec<KindRow>> = namespaces
        .iter()
        .map(|name| (name.clone(), Vec::new()))
        .collect();
    if !REFERENCE_KINDS.contains(&kind) || namespaces.is_empty() {
        return Ok(result);
    }

    // Membership targets in source insertion order: the personal target first,
    // then the active group namespaces.
    let mut targets: Vec<(String, String, String)> = Vec::new();
    if namespaces.iter().any(|name| name == "default") {
        targets.push((
            "user".to_string(),
            user_id.to_string(),
            "default".to_string(),
        ));
    }
    let group_names: Vec<String> = namespaces
        .iter()
        .filter(|name| name.as_str() != "default")
        .cloned()
        .collect();
    if !group_names.is_empty() {
        let sql = format!(
            "SELECT id, name FROM namespace WHERE name IN ({}) AND is_active IS true",
            placeholders(group_names.len())
        );
        let rows: Vec<NamespaceRefRow> = fetch_in_list(mysql, &sql, group_names).await?;
        for row in rows {
            targets.push(("namespace".to_string(), row.id.to_string(), row.name));
        }
    }
    if targets.is_empty() {
        return Ok(result);
    }

    let namespace_by_target: BTreeMap<(String, String), String> = targets
        .iter()
        .map(|(entity_type, entity_id, namespace)| {
            ((entity_type.clone(), entity_id.clone()), namespace.clone())
        })
        .collect();
    let (sql, arguments) = referenced_capabilities_statement(kind, &targets);
    let rows: Vec<ReferencedKindRow> = fetch_in_list(mysql, &sql, arguments).await?;
    let mut seen: BTreeSet<(String, i32)> = BTreeSet::new();
    for row in rows {
        let id = row.id;
        let target = (row.entity_type.clone(), row.entity_id.clone());
        let Some(namespace) = namespace_by_target.get(&target) else {
            continue;
        };
        if !seen.insert((namespace.clone(), id)) {
            continue;
        }
        if let Some(bucket) = result.get_mut(namespace) {
            bucket.push(row.into_kind_row());
        }
    }
    Ok(result)
}

/// Build the batched referenced-capability join and its bound entity ids.
///
/// The rendered statement mirrors the source's SQLAlchemy query text: one
/// `entity_type = ? AND entity_id IN (...)` branch per target type, wrapped in
/// `or_`, which renders a single branch without parentheses, and the branch
/// order the recorded source statements render.
fn referenced_capabilities_statement(
    kind: &str,
    targets: &[(String, String, String)],
) -> (String, Vec<String>) {
    // The source renders one `or_` branch per entity type in the order
    // `{target_type for target_type, _ in targets}` iterates. That set
    // iteration order is not reproducible, so the target renders the order the
    // recorded source statements of the current recording show: `user` first,
    // then `namespace`. The bound arguments follow the branch order, and any
    // remaining target type follows in first-appearance order.
    let mut entity_types: Vec<&str> = Vec::new();
    for entity_type in ENTITY_TYPE_BRANCH_ORDER {
        if targets
            .iter()
            .any(|(target_type, _, _)| target_type.as_str() == entity_type)
        {
            entity_types.push(entity_type);
        }
    }
    for (entity_type, _, _) in targets {
        if !entity_types.contains(&entity_type.as_str()) {
            entity_types.push(entity_type.as_str());
        }
    }
    let mut arguments: Vec<String> = Vec::new();
    let mut branches: Vec<String> = Vec::new();
    for entity_type in entity_types {
        let mut slots: Vec<&str> = Vec::new();
        for (target_type, entity_id, _) in targets {
            if target_type.as_str() == entity_type {
                arguments.push(entity_id.clone());
                slots.push("?");
            }
        }
        branches.push(format!(
            "resource_members.entity_type = '{entity_type}' \
             AND resource_members.entity_id IN ({})",
            slots.join(", ")
        ));
    }
    let target_filter = if branches.len() == 1 {
        branches.pop().unwrap_or_default()
    } else {
        format!("({})", branches.join(" OR "))
    };
    let sql = format!(
        "SELECT resource_members.entity_type AS resource_members_entity_type, \
         resource_members.entity_id AS resource_members_entity_id, kinds.id AS kinds_id, \
         kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
         kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
         kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
         kinds.updated_at AS kinds_updated_at \
         FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \
         WHERE resource_members.resource_type = '{kind}' \
         AND resource_members.status = 'approved' AND {target_filter} \
         AND kinds.kind = '{kind}' AND kinds.user_id != 0 AND kinds.is_active IS true \
         ORDER BY kinds.id"
    );
    (sql, arguments)
}

/// Render `?, ?, ...` for a dynamically sized `IN` list.
fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// Active visible public models, mirroring `PublicModelService.get_models`.
///
/// The source filters each row through `is_public_model_visible` and
/// `is_public_model_allowed_for_user` (the request user's `user_name`
/// against the row's `allowedUsers` whitelist); both predicates run inside
/// `get_models` before its pagination.
async fn list_public_models<M>(mysql: &M, user_name: Option<&str>) -> anyhow::Result<Vec<KindRow>>
where
    M: Mysql + Sync,
{
    let rows: Vec<KindRow> = mysql
        .fetch_all(
            "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at \
             FROM kinds WHERE user_id = 0 AND kind = 'Model' AND namespace = 'default' \
             AND is_active = true ORDER BY kinds.created_at DESC",
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .filter(|row| {
            is_public_model_visible(&row.json.0)
                && wegent_access::public_models::allowed_for_user_name(
                    &brz_json::OpaqueJson::from(row.json.0.clone()),
                    user_name,
                )
        })
        .collect())
}

#[cfg(test)]
#[path = "aggregation_tests.rs"]
mod aggregation_contracts;
