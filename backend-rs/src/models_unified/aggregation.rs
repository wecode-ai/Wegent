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
use super::mysql::{
    EntityIdRow, KindJsonRow, KindRow, MemberRow, NameRow, NamespaceRefRow, NamespaceRow,
    ReferencedKindRow, UserRow,
};
use crate::erp_provider::ErpProvider;

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
    erp: &dyn ErpProvider<R>,
    redis: Option<&R>,
    current_user: &UserRow,
    query: &UnifiedQuery,
) -> anyhow::Result<Vec<UnifiedModelResponse>>
where
    M: Mysql + Sync,
{
    let (support_model, actual_shell_type) = match &query.shell_type {
        Some(shell_type) => {
            let (support, shell_type_value) =
                get_shell_support_model(mysql, shell_type, current_user.id).await?;
            (support, shell_type_value)
        }
        None => (Vec::new(), String::new()),
    };

    let mut result: Vec<UnifiedModel> = Vec::new();
    let mut seen_names: BTreeMap<String, &'static str> = BTreeMap::new();

    let namespaces_to_query = match resolve_scope(
        mysql,
        erp,
        redis,
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
            result.push(UnifiedModel {
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
                model_capabilities: info.model_capabilities.map(Into::into),
                resource_id: Some(resource.id as i64),
                resource_user_id: Some(resource.user_id as i64),
                created_at: Some(resource.created_at.format("%Y-%m-%dT%H:%M:%S").to_string()),
                updated_at: Some(resource.updated_at.format("%Y-%m-%dT%H:%M:%S").to_string()),
                is_reference: referenced_ids.contains(&resource.id),
            });
            seen_names.insert(resource.name.clone(), resource_type);
        }
    }

    // Public models, mirroring `public_model_service.get_models`.
    let public_models = list_public_models(mysql, Some(current_user.user_name.as_str())).await?;
    for model_dict in public_models {
        let info = public_model_info(&model_dict);
        if query.shell_type.is_some()
            && !is_model_compatible_with_shell(
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
        result.push(UnifiedModel {
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
            model_capabilities: info.model_capabilities.map(Into::into),
            resource_id: None,
            resource_user_id: Some(0),
            created_at: info.created_at,
            updated_at: info.updated_at,
            is_reference: false,
        });
        seen_names.entry(model_name).or_insert(MODEL_TYPE_PUBLIC);
    }

    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result
        .into_iter()
        .map(|model| model.into_response(query.include_config))
        .collect())
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
        model_capabilities: info.model_capabilities,
        created_at: Some(resource.created_at.format("%Y-%m-%dT%H:%M:%S").to_string()),
        updated_at: Some(resource.updated_at.format("%Y-%m-%dT%H:%M:%S").to_string()),
    }
}

/// Resolve scope into the ordered namespace list, mirroring the source
/// branch behavior; `None` means an invalid scope.
async fn resolve_scope<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &dyn ErpProvider<R>,
    redis: Option<&R>,
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
            None => Ok(Some(get_user_groups(mysql, erp, redis, user_id).await?)),
        },
        "all" => {
            let mut namespaces = vec!["default".to_string()];
            namespaces.extend(get_user_groups(mysql, erp, redis, user_id).await?);
            Ok(Some(namespaces))
        }
        _ => Ok(None),
    }
}

/// Get all group names the user belongs to, mirroring `get_user_groups`:
/// active namespaces, direct memberships, and registered external entity
/// memberships resolved through the configured provider.
async fn get_user_groups<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &dyn ErpProvider<R>,
    redis: Option<&R>,
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

    // Effective role map: direct user memberships plus entity-derived ones.
    let direct_rows: Vec<MemberRow> = mysql
        .fetch_all::<_, _, MemberRow>(
            "SELECT resource_type, resource_id, entity_type, entity_id, role, status \
             FROM resource_members WHERE resource_type = 'Namespace' \
             AND entity_type = 'user' AND entity_id = ? AND status = 'approved'",
            (user_id.to_string(),),
        )
        .await?;
    let direct_ns_ids: Vec<i64> = direct_rows.iter().map(|row| row.resource_id).collect();
    let namespaces = load_namespaces(mysql, &direct_ns_ids).await?;
    let mut role_map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &direct_rows {
        if let Some(name) = namespaces.iter().find(|ns| ns.id as i64 == row.resource_id) {
            role_map
                .entry(name.name.clone())
                .or_default()
                .push(row.role.clone());
        }
    }

    // `iter_user_groups_with_roles` iterates every registered entity resolver
    // in registration order — `namespace` (NamespaceEntityResolver) first.
    // Its `get_resource_ids_by_entity` pass: direct ns ids, the org-department
    // bindings, the ERP membership cache read, then the namespace-entity grant
    // query over the combined ids. No roles are contributed here (its matched
    // namespace ids feed the ErpEntityResolver pass below through the shared
    // role map), but the read chain is observable.
    if erp.entity_type().is_some() {
        let direct_ns_ids =
            crate::teams::teams_repository::direct_namespace_resource_ids(mysql, user_id as i64)
                .await
                .map_err(|error| anyhow::anyhow!("{error:?}"))?;
        let org_bindings = crate::teams::teams_repository::external_namespace_bindings(
            mysql,
            erp.entity_type().unwrap_or("external"),
        )
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
        let mut entity_ns_ids: Vec<i64> = Vec::new();
        if !org_bindings.is_empty() {
            // `NamespaceEntityResolver.get_resource_ids_by_entity` delegates to
            // `ErpEntityResolver.match_entity_bindings`, whose
            // `_resolve_matched_departments` resolves the ssn through
            // `_get_user_ssn` — the full lazy-sync path (profile read, email
            // read, distributed lock, ERP search), not a bare profile read.
            let ssn = erp
                .resolve_employee_id(redis, user_id)
                .await
                .map_err(|error| anyhow::anyhow!("{error:?}"))?;
            if let Some(ssn) = ssn {
                let mut department_ids: Vec<String> = org_bindings
                    .iter()
                    .map(|(_, entity_id)| entity_id.clone())
                    .collect();
                department_ids.sort();
                department_ids.dedup();
                let erp_context = crate::teams::group_membership::ErpContext { erp, redis };
                let matched: Vec<String> =
                    crate::teams::group_membership::DirectoryMembership::matched_departments(
                        &erp_context,
                        user_id as i64,
                        &ssn,
                        &department_ids,
                    )
                    .await;
                let matched_set: std::collections::BTreeSet<&str> =
                    matched.iter().map(String::as_str).collect();
                entity_ns_ids.extend(
                    org_bindings
                        .iter()
                        .filter(|(_, entity_id)| matched_set.contains(entity_id.as_str()))
                        .map(|(ns_id, _)| *ns_id),
                );
            }
        }
        let mut all_ns_ids: Vec<i64> = direct_ns_ids;
        all_ns_ids.extend(entity_ns_ids);
        all_ns_ids.sort_unstable();
        all_ns_ids.dedup();
        let _grants =
            crate::teams::teams_repository::namespace_entity_resource_ids(mysql, &all_ns_ids)
                .await
                .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    }

    // Entity-derived memberships through the configured external provider.
    let entity_type = erp.entity_type();
    let dept_ids: Vec<String> = if let Some(entity_type) = entity_type {
        let dept_rows: Vec<EntityIdRow> = mysql
            .fetch_all::<_, _, EntityIdRow>(
                &format!(
                    "SELECT DISTINCT resource_members.entity_id AS entity_id \
                     FROM resource_members WHERE resource_type = 'Namespace' \
                     AND entity_type = '{}' AND entity_id IS NOT NULL \
                     AND status = 'approved'",
                    entity_type
                ),
                (),
            )
            .await?;
        dept_rows.into_iter().map(|row| row.entity_id).collect()
    } else {
        Vec::new()
    };
    let matched_depts = resolve_matched_departments(mysql, erp, redis, user_id, &dept_ids).await?;
    if !matched_depts.is_empty() {
        // `ErpEntityResolver.get_resource_ids_by_entity` tail:
        // `list_resources_by_entity_match` — DISTINCT namespace ids bound to
        // the matched departments.
        let matched_resource_ids =
            crate::teams::teams_repository::namespace_ids_for_external_entities(
                mysql,
                entity_type.unwrap_or("external"),
                &matched_depts,
            )
            .await
            .map_err(|error| anyhow::anyhow!("{error:?}"))?;
        if !matched_resource_ids.is_empty() {
            // `iter_user_groups_with_roles` step 2: batch query the
            // External entity members of the matched resource ids. The ids
            // keep row order (duplicates included) like the source list.
            let entity_members: Vec<crate::teams::teams_repository::MemberRow> =
                crate::teams::teams_repository::external_members_for_namespaces(
                    mysql,
                    entity_type.unwrap_or("external"),
                    &matched_resource_ids,
                )
                .await
                .map_err(|error| anyhow::anyhow!("{error:?}"))?;
            let entity_ns_ids: Vec<i64> = entity_members
                .iter()
                .map(|row| row.resource_members_resource_id)
                .collect();
            let entity_namespaces: Vec<crate::teams::teams_repository::NamespaceRow> =
                crate::teams::teams_repository::namespaces_by_ids(mysql, &entity_ns_ids)
                    .await
                    .map_err(|error| anyhow::anyhow!("{error:?}"))?;
            for row in &entity_members {
                if let Some(name) = entity_namespaces
                    .iter()
                    .find(|ns| ns.namespace_id == row.resource_members_resource_id)
                {
                    role_map
                        .entry(name.namespace_name.clone())
                        .or_default()
                        .push(row.resource_members_role.clone());
                }
            }
        }
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

async fn resolve_matched_departments<M, R: brz_redis::Redis>(
    _mysql: &M,
    erp: &dyn ErpProvider<R>,
    redis: Option<&R>,
    user_id: i32,
    dept_ids: &[String],
) -> anyhow::Result<Vec<String>>
where
    M: Mysql + Sync,
{
    if dept_ids.is_empty() {
        return Ok(Vec::new());
    }
    // `ErpEntityResolver._resolve_matched_departments` -> `_get_user_ssn`:
    // the full lazy-sync resolution (profile read, email read, distributed
    // lock, ERP search) — identical to the NamespaceEntityResolver pass
    // above, because both call `match_entity_bindings`.
    let ssn = erp
        .resolve_employee_id(redis, user_id)
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let Some(ssn) = ssn else {
        return Ok(Vec::new());
    };
    Ok(erp
        .membership_with_cache(redis, user_id, &ssn, dept_ids)
        .await)
}

async fn load_namespaces<M>(mysql: &M, ids: &[i64]) -> anyhow::Result<Vec<NamespaceRow>>
where
    M: Mysql + Sync,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let in_list = placeholders(ids.len());
    let sql = format!(
        "SELECT id, name, display_name, owner_user_id, visibility, level, is_active \
         FROM namespace WHERE id IN ({in_list}) AND is_active = 1"
    );
    fetch_in_list(mysql, &sql, ids.to_vec()).await
}

/// Execute an `IN (?, ...)` query with a dynamically sized argument list.
async fn fetch_in_list<T, A, M>(mysql: &M, sql: &str, arguments: Vec<A>) -> anyhow::Result<Vec<T>>
where
    M: Mysql + Sync,
    A: brz_mysql::MysqlValue + Send,
    T: brz_mysql::FromMysqlRow + Send,
{
    // brz-mysql implements MysqlArgs for Vec; each element binds to one `?`.
    Ok(mysql.fetch_all(sql, arguments).await?)
}

/// `find_shell_json` public-shell lookup: `db.query(Kind.json)` projects the
/// CRD payload alone and `.first()` renders `LIMIT 1`.
const SHELL_JSON_PUBLIC_SQL: &str = "SELECT json FROM kinds \
     WHERE user_id = 0 AND kind = 'Shell' AND name = ? AND is_active = true LIMIT 1";

/// `find_shell_json` personal-shell lookup, with the same single-column
/// projection, `namespace = 'default'` filter and `.first()` pagination.
const SHELL_JSON_PERSONAL_SQL: &str = "SELECT json FROM kinds \
     WHERE user_id = ? AND kind = 'Shell' AND name = ? AND namespace = 'default' \
     AND is_active = true LIMIT 1";

async fn get_shell_support_model<M>(
    mysql: &M,
    shell_name: &str,
    user_id: i32,
) -> anyhow::Result<(Vec<String>, String)>
where
    M: Mysql + Sync,
{
    // Public shell first (user_id = 0), then the user's personal shell,
    // mirroring `find_shell_json`.
    let mut shell_json: Option<Json> = mysql
        .fetch_optional::<_, _, KindJsonRow>(SHELL_JSON_PUBLIC_SQL, (shell_name,))
        .await?
        .map(|row| row.json.0);
    if shell_json.is_none() {
        shell_json = mysql
            .fetch_optional::<_, _, KindJsonRow>(SHELL_JSON_PERSONAL_SQL, (user_id, shell_name))
            .await?
            .map(|row| row.json.0);
    }
    match shell_json {
        Some(value) => parse_shell_spec(&value, shell_name),
        None => Ok((Vec::new(), shell_name.to_string())),
    }
}

fn parse_shell_spec(shell_json: &Json, shell_name: &str) -> anyhow::Result<(Vec<String>, String)> {
    let Some(spec) = shell_json
        .as_object()
        .and_then(|root| root.get("spec"))
        .and_then(Json::as_object)
    else {
        return Ok((Vec::new(), shell_name.to_string()));
    };
    let shell_type = spec
        .get("shellType")
        .or_else(|| spec.get("runtime"))
        .and_then(Json::as_str)
        .unwrap_or(shell_name)
        .to_string();
    let support_model = spec
        .get("supportModel")
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Json::as_str)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok((support_model, shell_type))
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
async fn list_referenced_capabilities_by_namespace<M>(
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
                && crate::teams::public_model_access::allowed_for_user_name(
                    &crate::json_compat::OpaqueJson::from(row.json.0.clone()),
                    user_name,
                )
        })
        .collect())
}

#[cfg(test)]
mod shell_lookup_contracts {
    use super::*;

    /// `find_shell_json` reads the CRD payload alone (`db.query(Kind.json)`)
    /// and stops at the first row (`.first()` -> `LIMIT 1`).
    fn assert_shell_statement(sql: &str, bound_parameters: usize) {
        let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            normalized.starts_with("SELECT json FROM kinds WHERE "),
            "single-column projection: {normalized}"
        );
        assert!(
            normalized.ends_with("LIMIT 1"),
            "first-row pagination: {normalized}"
        );
        assert_eq!(
            normalized.matches('?').count(),
            bound_parameters,
            "bound parameters: {normalized}"
        );
    }

    #[test]
    fn public_shell_lookup_matches_find_shell_json() {
        assert_shell_statement(SHELL_JSON_PUBLIC_SQL, 1);
        let normalized = SHELL_JSON_PUBLIC_SQL
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            normalized,
            "SELECT json FROM kinds WHERE user_id = 0 AND kind = 'Shell' AND name = ? \
             AND is_active = true LIMIT 1",
        );
    }

    #[test]
    fn personal_shell_lookup_matches_find_shell_json() {
        assert_shell_statement(SHELL_JSON_PERSONAL_SQL, 2);
        let normalized = SHELL_JSON_PERSONAL_SQL
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            normalized,
            "SELECT json FROM kinds WHERE user_id = ? AND kind = 'Shell' AND name = ? \
             AND namespace = 'default' AND is_active = true LIMIT 1",
        );
    }
}

#[cfg(test)]
#[path = "aggregation_tests.rs"]
mod aggregation_contracts;
