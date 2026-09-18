// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/kinds/skills/unified` handler.
//!
//! Mirrors `app.api.endpoints.kind.skills.list_unified_skills` and the
//! services it composes:
//!
//! - `skill_binding_service.list_user_default_skill_ids` (default bindings
//!   filtered through `can_user_access_skill`);
//! - `group_permission.get_user_groups` for the user's group namespaces
//!   (direct memberships and external entity memberships via the configured
//!   cache, and parent-group inheritance);
//! - `skill_binding_service.list_group_skill_ids_for_authorized_namespaces`
//!   for `is_group_shared` and the bound-but-not-listed Skill merge;
//! - `check_group_permission` for `scope=group` access.
//!
//! Result JSON is assembled with insertion-ordered `serde_json` maps
//! (`preserve_order`), matching the source response field order.
use crate::json_compat::OptionalOpaqueJsonExt;
use std::collections::HashSet;

use crate::json_compat::{JsonProjection, OpaqueJson};
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::auth::{AuthFailure, UserRow, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::group_membership::{
    DirectoryMembership, ErpContext, effective_roles, user_group_memberships,
};

/// Query parameters.
#[derive(Debug, Deserialize)]
pub struct UnifiedParams {
    #[serde(default)]
    skip: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    group_name: Option<String>,
}

/// `kinds` row with the SQLAlchemy `kinds_<column>` aliases
/// (`db.query(Kind)` full projection).
#[derive(FromMysqlRow)]
pub struct KindRow {
    pub kinds_id: i32,
    pub kinds_user_id: i32,
    #[allow(dead_code)]
    pub kinds_kind: String,
    pub kinds_name: String,
    pub kinds_namespace: String,
    kinds_json: Option<Json<JsonProjection<SkillDisplayInput>>>,
    #[allow(dead_code)]
    pub kinds_is_active: i8,
    pub kinds_created_at: chrono::NaiveDateTime,
    pub kinds_updated_at: chrono::NaiveDateTime,
}

impl KindRow {
    fn input(&self) -> Option<&SkillDisplayInput> {
        self.kinds_json
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }
}

#[derive(serde::Serialize)]
struct SkillItem {
    id: i32,
    name: String,
    namespace: String,
    description: Box<RawValue>,
    #[serde(rename = "displayName")]
    display_name: Box<RawValue>,
    version: Box<RawValue>,
    author: Box<RawValue>,
    tags: Box<RawValue>,
    #[serde(rename = "bindShells")]
    bind_shells: Box<RawValue>,
    visible: Box<RawValue>,
    is_active: bool,
    is_public: bool,
    user_id: i32,
    is_group_shared: bool,
    publication_status: Box<RawValue>,
    availability: SkillAvailability,
    source: Option<SkillSource>,
    created_at: String,
    updated_at: String,
}
#[derive(serde::Serialize)]
struct SkillAvailability {
    in_my_default: bool,
    agent_builtin: bool,
}
#[derive(serde::Serialize)]
struct SkillSource {
    #[serde(rename = "type")]
    kind: Box<RawValue>,
    repo_url: Box<RawValue>,
    skill_path: Box<RawValue>,
    imported_at: Box<RawValue>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SkillDisplayInput {
    spec: Option<SkillDisplaySpec>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SkillDisplaySpec {
    description: Option<OpaqueJson>,
    #[serde(rename = "displayName")]
    display_name: Option<OpaqueJson>,
    version: Option<OpaqueJson>,
    author: Option<OpaqueJson>,
    tags: Option<OpaqueJson>,
    #[serde(rename = "bindShells")]
    bind_shells: Option<OpaqueJson>,
    visible: Option<OpaqueJson>,
    capability: Option<SkillDisplayCapability>,
    source: Option<SkillSourceInput>,
    #[serde(rename = "targetType")]
    target_type: Option<String>,
    #[serde(rename = "targetId")]
    target_id: Option<String>,
    #[serde(rename = "skillRef")]
    skill_ref: Option<crate::crd::ResourceReference>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SkillDisplayCapability {
    visibility: Option<OpaqueJson>,
    #[serde(rename = "publishStatus")]
    publish_status: Option<OpaqueJson>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SkillSourceInput {
    #[serde(rename = "type")]
    kind: Option<OpaqueJson>,
    repo_url: Option<OpaqueJson>,
    skill_path: Option<OpaqueJson>,
    imported_at: Option<OpaqueJson>,
}

/// Preserve unvalidated CRD fields as opaque JSON while typing the projection.
fn user_skill_item(
    kind: &KindRow,
    is_group_shared: bool,
    user_default_ids: &HashSet<i32>,
) -> SkillItem {
    let default_spec = SkillDisplaySpec::default();
    let spec = kind
        .input()
        .and_then(|input| input.spec.as_ref())
        .unwrap_or(&default_spec);
    SkillItem {
        id: kind.kinds_id,
        name: kind.kinds_name.clone(),
        namespace: kind.kinds_namespace.clone(),
        description: spec.description.raw_or(""),
        display_name: spec.display_name.raw_or(()),
        version: spec.version.raw_or(()),
        author: spec.author.raw_or(()),
        tags: spec.tags.raw_or(()),
        bind_shells: spec.bind_shells.raw_or(()),
        visible: spec.visible.raw_or(true),
        is_active: true,
        is_public: false,
        user_id: kind.kinds_user_id,
        is_group_shared,
        publication_status: spec
            .capability
            .as_ref()
            .map(|capability| capability.publish_status.raw_or(()))
            .unwrap_or_else(|| serde_json::value::to_raw_value(&()).expect("null serializes")),
        availability: SkillAvailability {
            in_my_default: user_default_ids.contains(&kind.kinds_id),
            agent_builtin: false,
        },
        source: source_info(spec),
        created_at: kind
            .kinds_created_at
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string(),
        updated_at: kind
            .kinds_updated_at
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string(),
    }
}

/// Source information for git-imported skills: a truthy `spec.source` object
/// with the type defaulting to `upload`.
fn source_info(spec: &SkillDisplaySpec) -> Option<SkillSource> {
    let source = spec.source.as_ref()?;
    Some(SkillSource {
        kind: source.kind.raw_or("upload"),
        repo_url: source.repo_url.raw_or(()),
        skill_path: source.skill_path.raw_or(()),
        imported_at: source.imported_at.raw_or(()),
    })
}

/// `_is_user_default_binding` (`spec.targetType == "user"`,
/// `spec.targetId == "user:{user_id}"`).
fn is_user_default_binding(input: Option<&SkillDisplayInput>, target_id: &str) -> bool {
    input
        .and_then(|input| input.spec.as_ref())
        .is_some_and(|spec| {
            spec.target_type.as_deref() == Some("user")
                && spec.target_id.as_deref() == Some(target_id)
        })
}
fn is_group_binding(input: Option<&SkillDisplayInput>, group_namespace: &str) -> bool {
    input
        .and_then(|input| input.spec.as_ref())
        .is_some_and(|spec| {
            spec.target_type.as_deref() == Some("group")
                && spec.target_id.as_deref() == Some(group_namespace)
        })
}
fn extract_skill_id(input: Option<&SkillDisplayInput>) -> Option<i32> {
    let reference = input?.spec.as_ref()?.skill_ref.as_ref()?;
    let id = if reference.skill_id.is_some() {
        &reference.skill_id
    } else {
        &reference.legacy_skill_id
    };
    id.as_ref()?
        .integer_or_truncated_float()
        .map(|id| id as i32)
}

/// Escape one string literal for an inline `IN` list.
fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x1a => out.push_str("\\Z"),
            other => out.push(other as char),
        }
    }
    out.push('\'');
    out
}

/// `kinds` column list rendered by `db.query(Kind)` (SQLAlchemy labels every
/// column `kinds_<name>`).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// Fetch `kinds` rows with the full `kinds_<column>` projection for a
/// rendered statement.
async fn fetch_kinds<M>(mysql: &M, sql: &str) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    Ok(mysql
        .fetch_all::<_, _, KindRow>(sql, ())
        .await?
        .into_iter()
        .collect())
}

/// `list_user_default_skill_ids`: active default bindings whose referenced
/// Skill is active and accessible (`can_user_access_skill`).
async fn list_user_default_skill_ids<M>(
    mysql: &M,
    erp: &ErpContext<'_>,
    user: &UserRow,
) -> MysqlResult<HashSet<i32>>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.user_id = {} AND kinds.kind = 'SkillBinding' \
         AND kinds.namespace = 'default' AND kinds.is_active = true \
         ORDER BY kinds.created_at DESC",
        user.id
    );
    let bindings = fetch_kinds(mysql, sql.as_str()).await?;
    let target_id = format!("user:{}", user.id);
    let mut ids = HashSet::new();
    for binding in bindings {
        let input = binding.input();
        if !is_user_default_binding(input, &target_id) {
            continue;
        }
        let Some(skill_id) = extract_skill_id(input) else {
            continue;
        };
        let Some(skill) = get_active_skill(mysql, skill_id).await? else {
            continue;
        };
        if !can_user_access_skill(mysql, erp, user, &skill).await? {
            continue;
        }
        ids.insert(skill_id);
    }
    Ok(ids)
}

/// `_get_active_skill`.
async fn get_active_skill<M>(mysql: &M, skill_id: i32) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.id = {skill_id} AND kinds.kind = 'Skill' \
         AND kinds.is_active = true \
         LIMIT 1"
    );
    mysql
        .fetch_optional::<_, _, KindRow>(sql.as_str(), ())
        .await
}

/// `can_user_access_skill`: owner/system access, published-public
/// visibility, or a Reporter-or-above role in the Skill's group namespace.
async fn can_user_access_skill<M>(
    mysql: &M,
    erp: &ErpContext<'_>,
    user: &UserRow,
    skill: &KindRow,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    if skill.kinds_user_id == user.id || skill.kinds_user_id == 0 {
        return Ok(true);
    }
    let published_public = skill
        .input()
        .and_then(|input| input.spec.as_ref())
        .and_then(|spec| spec.capability.as_ref())
        .is_some_and(|capability| {
            capability
                .visibility
                .as_ref()
                .and_then(|value| value.project::<String>())
                .as_deref()
                == Some("public")
                && capability
                    .publish_status
                    .as_ref()
                    .and_then(|value| value.project::<String>())
                    .as_deref()
                    == Some("published")
        });
    if published_public {
        return Ok(true);
    }
    if skill.kinds_namespace != "default" {
        let role = effective_role_in_group(mysql, erp, user.id, &skill.kinds_namespace).await?;
        if role.as_deref().is_some_and(reporter_or_above) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn reporter_or_above(role: &str) -> bool {
    matches!(role, "Owner" | "Maintainer" | "Developer" | "Reporter")
}

/// `get_effective_role_in_group`: direct membership, entity-derived
/// memberships resolved through the configured directory provider, then
/// parent-group inheritance.
pub(crate) async fn effective_role_in_group<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &ErpContext<'_, R>,
    user_id: i32,
    group_name: &str,
) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    let mut candidates: Vec<String> = Vec::new();
    // 1) Direct user membership (`get_user_role_in_group`:
    // `get_namespace_id_by_name`, then `get_group_member`).
    if let Some(role) = direct_member_role(mysql, user_id, group_name).await? {
        candidates.push(role);
    }
    // 2) Entity-derived memberships (`_resolve_entity_roles_in_namespace`).
    if let Some(namespace_id) = namespace_id_by_name(mysql, group_name).await? {
        candidates.extend(entity_roles_in_namespace(mysql, erp, user_id, namespace_id).await?);
    }
    if let Some(role) = highest_role(&candidates) {
        return Ok(Some(role));
    }
    // 3) Parent group inheritance: nearest parent with a role wins.
    if group_name.contains('/') {
        let parts: Vec<&str> = group_name.split('/').collect();
        for index in (1..parts.len()).rev() {
            let parent = parts[..index].join("/");
            let parent_role =
                Box::pin(effective_role_in_group(mysql, erp, user_id, &parent)).await?;
            if let Some(role) = parent_role {
                return Ok(Some(role));
            }
        }
    }
    Ok(None)
}

/// `resolve_entity_roles_for_resource`: the namespace's approved non-user,
/// non-namespace entity member rows, with registered external entity types
/// resolved through the configured directory provider.
async fn entity_roles_in_namespace<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &ErpContext<'_, R>,
    user_id: i32,
    namespace_id: i64,
) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let rows = entity_member_rows(mysql, namespace_id).await?;
    // Group by entity type. The public provider returns no matches; the
    // private deployment registers its department resolver at startup.
    let mut departments: Vec<(String, String)> = Vec::new();
    let provider_type = erp.erp.entity_type();
    for (entity_type, entity_id, role) in &rows {
        if provider_type == Some(entity_type.as_str()) && !entity_id.is_empty() {
            departments.push((entity_id.clone(), role.clone().unwrap_or_default()));
        }
    }
    if departments.is_empty() {
        return Ok(Vec::new());
    }
    // `match_entity_bindings` -> `_get_user_ssn` -> ERP cache.
    let Some(ssn) = erp.erp.employee_id(user_id as i64).await? else {
        return Ok(Vec::new());
    };
    let department_ids: Vec<String> = departments.iter().map(|(id, _)| id.clone()).collect();
    let matched: Vec<String> =
        DirectoryMembership::matched_departments(erp, user_id as i64, &ssn, &department_ids).await;
    let matched_set: std::collections::BTreeSet<&str> =
        matched.iter().map(String::as_str).collect();
    Ok(departments
        .into_iter()
        .filter(|(entity_id, _)| matched_set.contains(entity_id.as_str()))
        .map(|(_, role)| role)
        .filter(|role| !role.is_empty())
        .collect())
}

/// `get_highest_role`: the most privileged known role (unknown roles lose to
/// every known role).
fn highest_role(roles: &[String]) -> Option<String> {
    roles
        .iter()
        .min_by_key(|role| match role.as_str() {
            "Owner" => 0,
            "Maintainer" => 1,
            "Developer" => 2,
            "Reporter" => 3,
            "RestrictedAnalyst" => 4,
            _ => 999,
        })
        .cloned()
}

/// `namespace` full projection constant (`db.query(Namespace)`).
const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, \
     namespace.name AS namespace_name, namespace.display_name AS namespace_display_name, \
     namespace.owner_user_id AS namespace_owner_user_id, \
     namespace.visibility AS namespace_visibility, \
     namespace.description AS namespace_description, \
     namespace.level AS namespace_level, namespace.is_active AS namespace_is_active, \
     namespace.created_at AS namespace_created_at, \
     namespace.updated_at AS namespace_updated_at";

/// `get_namespace_id_by_name` (full `Namespace` projection, `LIMIT 1`).
async fn namespace_id_by_name<M>(mysql: &M, group_name: &str) -> MysqlResult<Option<i64>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        namespace_id: i64,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT {NAMESPACE_COLUMNS} \
                 FROM namespace \
                 WHERE namespace.name = {} AND namespace.is_active = 1 \
                 LIMIT 1",
                quote_literal(group_name)
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| row.namespace_id))
}

/// `get_group_member` (full `ResourceMember` projection, `LIMIT 1`). Shared
/// with the task-skills group-member cache fallback.
pub(crate) async fn direct_member_role<M>(
    mysql: &M,
    user_id: i32,
    group_name: &str,
) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    let Some(namespace_id) = namespace_id_by_name(mysql, group_name).await? else {
        return Ok(None);
    };
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "resource_members_role")]
        role: Option<String>,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT {} \
                 FROM resource_members \
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id = {namespace_id} \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{}' \
                 AND resource_members.status = 'approved' \
                 LIMIT 1",
                crate::teams::teams_repository::MEMBER_COLUMNS,
                user_id
            ),
            (),
        )
        .await?;
    Ok(row.and_then(|row| row.role))
}

/// `resolve_entity_roles_for_resource` row fetch: the namespace's approved
/// entity-type member rows excluding `user` and `namespace`
/// (`entity_type`, `entity_id`, `role` projection).
async fn entity_member_rows<M>(
    mysql: &M,
    namespace_id: i64,
) -> MysqlResult<Vec<(String, String, Option<String>)>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "resource_members_entity_type")]
        entity_type: String,
        #[mysql(rename = "resource_members_entity_id")]
        entity_id: String,
        #[mysql(rename = "resource_members_role")]
        role: Option<String>,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            "SELECT resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, \
             resource_members.`role` AS resource_members_role \
             FROM resource_members \
             WHERE resource_members.resource_type IN ('Namespace') \
             AND resource_members.resource_id = ? \
             AND (resource_members.entity_type NOT IN ('', 'user', 'namespace')) \
             AND resource_members.entity_id IS NOT NULL \
             AND resource_members.status IN ('approved')",
            (namespace_id,),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.entity_type, row.entity_id, row.role))
        .collect())
}

/// `check_group_permission(db, user_id, group_name, GroupRole.Reporter)`:
/// admin bypass, then an effective role at or above Reporter.
async fn check_group_reporter_permission<M>(
    mysql: &M,
    erp: &ErpContext<'_>,
    user: &UserRow,
    group_name: &str,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    if user.role == "admin" {
        return Ok(true);
    }
    let role = effective_role_in_group(mysql, erp, user.id, group_name).await?;
    Ok(role.as_deref().is_some_and(reporter_or_above))
}

/// `get_user_groups`: sorted group names where the user has an effective
/// role.
async fn get_user_groups<M>(
    mysql: &M,
    erp: &ErpContext<'_>,
    user_id: i32,
) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let resolved = user_group_memberships(mysql, erp, user_id as i64).await?;
    let roles = effective_roles(&resolved.memberships, &resolved.active_names);
    let mut groups: Vec<String> = roles.into_keys().collect();
    groups.sort();
    Ok(groups)
}

/// `list_group_skill_ids_for_authorized_namespaces`: active SkillBinding
/// rows in the namespaces filtered to group bindings, mapped to their
/// still-active Skill ids. Shared with the task-skills group-binding lookup.
pub(crate) async fn group_skill_ids_for_namespaces<M>(
    mysql: &M,
    namespaces: &[String],
) -> MysqlResult<HashSet<i32>>
where
    M: Mysql,
{
    if namespaces.is_empty() {
        return Ok(HashSet::new());
    }
    let list = namespaces
        .iter()
        .map(|ns| quote_literal(ns))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = 'SkillBinding' AND kinds.namespace IN ({list}) \
         AND kinds.is_active = 1"
    );
    let bindings = fetch_kinds(mysql, sql.as_str()).await?;
    let mut candidates: Vec<i32> = Vec::new();
    for binding in &bindings {
        let input = binding.input();
        if is_group_binding(input, &binding.kinds_namespace)
            && let Some(id) = extract_skill_id(input)
        {
            candidates.push(id);
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    if candidates.is_empty() {
        return Ok(HashSet::new());
    }
    // Confirm the candidate Skills are still active (one inline IN query).
    let list = candidates
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    #[derive(Debug, FromMysqlRow)]
    struct IdRow {
        kinds_id: i32,
    }
    let rows: Vec<IdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT kinds.id AS kinds_id FROM kinds \
                 WHERE kinds.id IN ({list}) AND kinds.kind = 'Skill' \
                 AND kinds.is_active = 1"
            ),
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.kinds_id).collect())
}

/// GET /api/v1/kinds/skills/unified: the unified-skills free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/kinds/skills/unified")]
async fn list_unified_skills(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
    query: brz_http_server::Query<UnifiedParams>,
) -> Result<Vec<SkillItem>, FastApiError> {
    unified_skills(state, authorization, &query).await
}

/// Handler body for `GET /api/v1/kinds/skills/unified`.
async fn unified_skills(
    state: &AppState,
    authorization: Option<&str>,
    params: &UnifiedParams,
) -> Result<Vec<SkillItem>, FastApiError> {
    let mysql = &state.mysql;
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    let user = match get_current_user(&state.auth, mysql, authorization).await {
        Ok(user) => user,
        Err(AuthFailure::InvalidCredentials) => {
            return Err(FastApiError::unauthorized("Could not validate credentials"));
        }
        Err(AuthFailure::UserNotActivated) => {
            return Err(FastApiError::unauthorized("User not activated"));
        }
    };

    let scope = params
        .scope
        .clone()
        .unwrap_or_else(|| "personal".to_string());
    let group_name = params.group_name.clone().filter(|name| !name.is_empty());

    // `list_user_default_skill_ids` runs before the scope branch; its
    // per-binding `can_user_access_skill` calls are part of the recorded
    // dependency sequence.
    let user_default_ids = match list_user_default_skill_ids(mysql, &erp, &user).await {
        Ok(ids) => ids,
        Err(error) => return Err(dependency_error(error)),
    };

    // Group namespaces and group-shared skill ids (skipped when
    // scope == "group" with a group name).
    let mut group_namespaces: Vec<String> = Vec::new();
    let mut group_shared_skill_ids: HashSet<i32> = HashSet::new();
    if scope != "group" || group_name.is_none() {
        group_namespaces = match get_user_groups(mysql, &erp, user.id).await {
            Ok(groups) => groups,
            Err(error) => return Err(dependency_error(error)),
        };
        group_namespaces.retain(|group| group != "default");
        if !group_namespaces.is_empty() {
            group_shared_skill_ids =
                match group_skill_ids_for_namespaces(mysql, &group_namespaces).await {
                    Ok(ids) => ids,
                    Err(error) => return Err(dependency_error(error)),
                };
        }
    }

    // Bound skill ids: user defaults for personal/all; group-shared ids for
    // the group branches.
    let mut bound_skill_ids: HashSet<i32> = HashSet::new();
    if scope == "personal" || scope == "all" {
        bound_skill_ids.extend(user_default_ids.iter().copied());
    }

    // Scope query, mirroring the source branch construction.
    let scope_sql = if scope == "personal" {
        format!(
            "SELECT {KIND_COLUMNS} \
             FROM kinds \
             WHERE kinds.user_id = {} AND kinds.kind = 'Skill' \
             AND kinds.namespace = 'default' AND kinds.is_active = true \
             ORDER BY kinds.created_at DESC",
            user.id
        )
    } else if scope == "group" && group_name.is_some() {
        // Group scope with a specific group: permission check first, then
        // ALL skills in that namespace.
        let group_name = group_name.as_deref().expect("checked above");
        let allowed = match check_group_reporter_permission(mysql, &erp, &user, group_name).await {
            Ok(allowed) => allowed,
            Err(error) => return Err(dependency_error(error)),
        };
        if !allowed {
            return Err(FastApiError::forbidden(
                "You don't have permission to view this group's skills",
            ));
        }
        format!(
            "SELECT {KIND_COLUMNS} \
             FROM kinds \
             WHERE kinds.kind = 'Skill' AND kinds.namespace = {} \
             AND kinds.is_active = true ORDER BY kinds.created_at DESC",
            quote_literal(group_name)
        )
    } else if scope == "group" {
        // Group scope without a group: all of the user's groups. The source
        // queries only when the (non-default) group list is non-empty.
        if !group_namespaces.is_empty() {
            bound_skill_ids.extend(group_shared_skill_ids.iter().copied());
        }
        let list = group_namespaces
            .iter()
            .map(|ns| quote_literal(ns))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "SELECT {KIND_COLUMNS} \
             FROM kinds \
             WHERE kinds.kind = 'Skill' AND kinds.namespace IN ({list}) \
             AND kinds.is_active = true ORDER BY kinds.created_at DESC"
        )
    } else {
        // scope == "all" (the source's else branch).
        if !group_namespaces.is_empty() {
            bound_skill_ids.extend(group_shared_skill_ids.iter().copied());
        }
        let group_clause = if group_namespaces.is_empty() {
            String::new()
        } else {
            format!(
                " OR kinds.namespace IN ({})",
                group_namespaces
                    .iter()
                    .map(|ns| quote_literal(ns))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        format!(
            "SELECT {KIND_COLUMNS} \
             FROM kinds \
             WHERE kinds.kind = 'Skill' AND kinds.is_active = true \
             AND (kinds.user_id = {} AND kinds.namespace = 'default'{group_clause}) \
             ORDER BY kinds.created_at DESC",
            user.id
        )
    };

    let mut skill_kinds = match fetch_kinds(mysql, scope_sql.as_str()).await {
        Ok(kinds) => kinds,
        Err(error) => return Err(dependency_error(error)),
    };

    // Group-with-name scope: the group's shared ids are resolved after the
    // scope query, exactly like the source branch.
    if scope == "group"
        && let Some(group_name) = group_name.as_deref()
    {
        group_shared_skill_ids =
            match group_skill_ids_for_namespaces(mysql, &[group_name.to_string()]).await {
                Ok(ids) => ids,
                Err(error) => return Err(dependency_error(error)),
            };
        bound_skill_ids.extend(group_shared_skill_ids.iter().copied());
    }

    // Bound-but-not-listed skills.
    let direct_ids: HashSet<i32> = skill_kinds.iter().map(|kind| kind.kinds_id).collect();
    let mut missing: Vec<i32> = bound_skill_ids.difference(&direct_ids).copied().collect();
    missing.sort_unstable();
    if !missing.is_empty() {
        let list = missing
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {KIND_COLUMNS} \
             FROM kinds \
             WHERE kinds.id IN ({list}) AND kinds.kind = 'Skill' \
             AND kinds.is_active = true ORDER BY kinds.created_at DESC"
        );
        match fetch_kinds(mysql, sql.as_str()).await {
            Ok(rows) => skill_kinds.extend(rows),
            Err(error) => return Err(dependency_error(error)),
        }
    }

    // Convert user/group skills (dedup by (namespace, name)).
    let mut skills: Vec<SkillItem> = Vec::new();
    let mut user_skill_keys: HashSet<(String, String)> = HashSet::new();
    let mut user_skill_names: HashSet<String> = HashSet::new();
    for kind in &skill_kinds {
        let key = (kind.kinds_namespace.clone(), kind.kinds_name.clone());
        if user_skill_keys.insert(key) {
            user_skill_names.insert(kind.kinds_name.clone());
            skills.push(user_skill_item(
                kind,
                group_shared_skill_ids.contains(&kind.kinds_id),
                &user_default_ids,
            ));
        }
    }

    // Public skills not shadowed by a user/group skill of the same name.
    let public_sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.user_id = 0 AND kinds.kind = 'Skill' \
         AND kinds.namespace = 'default' AND kinds.is_active = true \
         ORDER BY kinds.created_at DESC"
    );
    let public_kinds = match fetch_kinds(mysql, public_sql.as_str()).await {
        Ok(kinds) => kinds,
        Err(error) => return Err(dependency_error(error)),
    };
    for kind in &public_kinds {
        if user_skill_names.insert(kind.kinds_name.clone()) {
            let mut item = user_skill_item(
                kind,
                group_shared_skill_ids.contains(&kind.kinds_id),
                &user_default_ids,
            );
            item.is_public = true;
            item.source = None;
            skills.push(item);
        }
    }

    // Pagination (`user_skills[skip : skip + limit]`).
    let skip = params.skip.unwrap_or(0).max(0) as usize;
    let limit = params.limit.unwrap_or(100).clamp(1, 100) as usize;
    let page: Vec<SkillItem> = skills.into_iter().skip(skip).take(limit).collect();

    Ok(page)
}

fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "unified skills database dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests;
