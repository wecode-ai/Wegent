// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_get_bot_skills` and the user-default / group Skill-binding reads
//! (`app/services/execution/request_builder.py` +
//! `app/services/skill_binding_service.py` +
//! `app/services/skill_resolution.py`).
//!
//! The recorded `queued` case (`2834ba9c`, run `20261010055652`) pins the two
//! Skill reads: the Ghost's `wegent-knowledge` resolved by `skill_id`
//! (`kinds.id = 128913 AND kind = 'Skill' AND name = 'wegent-knowledge' AND
//! is_active = true LIMIT 1`) and the injected `subscription-manager` public
//! read (`user_id = 0 AND name = 'subscription-manager'`). For a group-owned
//! Team (`namespace != "default"`), `list_user_default_skill_refs` also reads
//! the group's `SkillBinding` rows (`ORDER BY created_at DESC`) and resolves
//! each binding's Skill; the recorded create cases carry four such group
//! bindings.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::Value;
use std::collections::HashSet;

use crate::teams::group_membership::ErpContext;

use super::ghost::MergedGhostCapabilities;

/// `SKILL_BINDING_KIND` / `SKILL_BINDING_NAMESPACE`.
const SKILL_BINDING_KIND: &str = "SkillBinding";
const SKILL_BINDING_NAMESPACE: &str = "default";

/// `SkillBindingContext` (`_build_skill_binding_context`): the runtime context
/// that filters automatic Skill bindings.
pub struct SkillBindingContext<'a> {
    pub mode: &'a str,
    pub agent_id: i64,
    pub project_id: Option<i64>,
    /// The Team namespace when it is not the personal `default` scope.
    pub group_namespace: Option<&'a str>,
}

/// The `kinds` projection the recorded Skill / SkillBinding reads use (the
/// labeled `db.query(Kind)` columns).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One Skill / SkillBinding `kinds` row.
#[derive(Debug, Clone, FromMysqlRow)]
pub struct SkillKindRow {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    #[allow(dead_code)]
    pub kinds_kind: String,
    pub kinds_name: String,
    pub kinds_namespace: String,
    pub kinds_json: Json<Value>,
    #[allow(dead_code)]
    pub kinds_is_active: i8,
    #[allow(dead_code)]
    pub kinds_created_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    pub kinds_updated_at: Option<chrono::NaiveDateTime>,
}

/// `build_skill_ref_meta`: the runtime skill reference metadata.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SkillRefMeta {
    pub skill_id: i64,
    pub namespace: String,
    pub is_public: bool,
    pub content_hash: Option<String>,
}

impl SkillRefMeta {
    /// From a Skill `kinds` row: `content_hash` is `sha256:{status.fileHash}`
    /// or `null`.
    pub fn from_kind(row: &SkillKindRow) -> Self {
        let file_hash = row
            .kinds_json
            .0
            .get("status")
            .and_then(|status| status.get("fileHash"))
            .and_then(Value::as_str);
        Self {
            skill_id: row.kinds_id,
            namespace: if row.kinds_namespace.is_empty() {
                "default".to_string()
            } else {
                row.kinds_namespace.clone()
            },
            is_public: row.kinds_user_id == 0,
            content_hash: file_hash.map(|hash| format!("sha256:{hash}")),
        }
    }

    /// The Ghost-stored ref plus the derived `content_hash` fallback.
    pub fn from_ghost_ref(reference: &Value, fallback: &SkillRefMeta) -> Self {
        let value = |key: &str| reference.get(key).cloned().unwrap_or(Value::Null);
        Self {
            skill_id: value("skill_id").as_i64().unwrap_or(fallback.skill_id),
            namespace: value("namespace").as_str().unwrap_or("default").to_string(),
            is_public: value("is_public").as_bool().unwrap_or(fallback.is_public),
            content_hash: value("content_hash")
                .as_str()
                .map(str::to_string)
                .or_else(|| fallback.content_hash.clone()),
        }
    }
}

/// `_find_attached_skill_by_ref`: the exact Skill dependency validated on
/// Agent save (`id` + `kind` + `name` + `is_active`).
pub fn attached_skill_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = ? \
         AND kinds.kind = 'Skill' AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `find_skill_by_ref`'s public branch (`user_id = 0`).
pub fn public_skill_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
         AND kinds.kind = 'Skill' AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `list_user_default_bindings`'s read: the user's active default-namespace
/// SkillBindings, newest first.
pub fn user_default_bindings_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = '{SKILL_BINDING_KIND}' \
         AND kinds.namespace = '{SKILL_BINDING_NAMESPACE}' \
         AND kinds.is_active = true ORDER BY kinds.created_at DESC"
    )
}

/// `list_group_bindings`'s read: the group namespace's active SkillBindings,
/// newest first.
pub fn group_bindings_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = '{SKILL_BINDING_KIND}' \
         AND kinds.namespace = ? AND kinds.is_active = true \
         ORDER BY kinds.created_at DESC"
    )
}

/// `_get_active_skill` (the binding service's by-id read).
pub fn active_skill_by_id_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = ? \
         AND kinds.kind = 'Skill' AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `find_skill_by_ref`'s explicit-id branch, the lookup
/// `_get_bot_skills` runs for each binding ref it receives from
/// `list_user_default_skill_refs`: an exact attached-Skill dependency
/// (`id` + `kind` + `name` + `is_active`), not the binding service's
/// id-only `_get_active_skill` read. The id-only read already happened
/// while the ref was resolved; repeating it would issue a second,
/// unmatched statement for the same binding.
async fn resolve_binding_ref_skill<M: Mysql>(
    mysql: &M,
    skill_id: Option<i64>,
    skill_name: &str,
) -> MysqlResult<Option<SkillKindRow>> {
    match skill_id {
        Some(skill_id) => {
            mysql
                .fetch_optional(
                    attached_skill_statement(),
                    (skill_id, skill_name.to_string()),
                )
                .await
        }
        None => {
            mysql
                .fetch_optional(public_skill_statement(), (skill_name.to_string(),))
                .await
        }
    }
}

/// `_extract_skill_id`: `spec.skillRef.skillId` / `skill_id` as an int.
fn extract_skill_id(binding_json: &Value) -> Option<i64> {
    let raw = binding_json
        .get("spec")?
        .get("skillRef")?
        .get("skillId")
        .or_else(|| binding_json.get("spec")?.get("skillRef")?.get("skill_id"))?;
    raw.as_i64().or_else(|| raw.as_str()?.parse().ok())
}

/// `_extract_force_preload`.
fn extract_force_preload(binding_json: &Value) -> bool {
    let spec = binding_json.get("spec");
    spec.and_then(|spec| spec.get("forcePreload"))
        .or_else(|| spec.and_then(|spec| spec.get("force_preload")))
        == Some(&Value::Bool(true))
}

/// `_is_user_default_binding` (`targetType == "user"` and `targetId` matches).
fn is_user_default_binding(binding_json: &Value, target_id: &str) -> bool {
    let Some(spec) = binding_json.get("spec") else {
        return false;
    };
    spec.get("targetType").and_then(Value::as_str) == Some("user")
        && spec.get("targetId").and_then(Value::as_str) == Some(target_id)
}

/// `_is_group_binding` (`targetType == "group"` and `targetId` matches the
/// group namespace).
fn is_group_binding(binding_json: &Value, group_namespace: &str) -> bool {
    let Some(spec) = binding_json.get("spec") else {
        return false;
    };
    spec.get("targetType").and_then(Value::as_str) == Some("group")
        && spec.get("targetId").and_then(Value::as_str) == Some(group_namespace)
}

/// `_is_excluded_by_context`: a binding whose `exceptions` name the current
/// mode, agent or project is not applied automatically.
fn is_excluded_by_context(binding_json: &Value, context: &SkillBindingContext<'_>) -> bool {
    let Some(exceptions) = binding_json
        .get("spec")
        .and_then(|spec| spec.get("exceptions"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    let mut context_values: Vec<(&str, String)> = vec![
        ("mode", context.mode.to_string()),
        ("agent", context.agent_id.to_string()),
    ];
    if let Some(project_id) = context.project_id {
        context_values.push(("project", project_id.to_string()));
    }
    exceptions.iter().any(|item| {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        // `_normalize_exceptions`: trim the value and drop an empty one.
        let Some(value) = item
            .get("value")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return false;
        };
        context_values
            .iter()
            .any(|(candidate, expected)| *candidate == kind && expected == value)
    })
}

/// `_inject_subscription_manager_skill`: the always-injected available
/// (non-preloaded) public Skill, skipped for subscription tasks.
pub fn inject_subscription_manager_skill(is_subscription: bool) -> Vec<Value> {
    if is_subscription {
        return Vec::new();
    }
    vec![serde_json::json!({
        "name": "subscription-manager",
        "namespace": "default",
        "is_public": true,
    })]
}

/// `find_skill_by_ref`'s access checks and the group-bindings gate.
///
/// The source validates every resolved Skill with the skill-binding service:
/// a group-shared Skill must be bound to a group the user can access, and a
/// group-namespace Skill needs at least Reporter access. The same group-role
/// resolution gates `list_group_bindings`.
pub struct SkillAccess<'a> {
    pub mysql: &'a brz_mysql::MysqlService,
    pub redis: Option<&'a brz_redis::RedisService>,
    pub erp: &'a dyn crate::erp_provider::ErpProvider,
    pub resolvers: &'a crate::permissions::EntityResolvers,
}

impl SkillAccess<'_> {
    fn erp_context(&self) -> ErpContext<'_, brz_redis::RedisService> {
        ErpContext {
            erp: self.erp,
            redis: self.redis,
        }
    }

    /// `get_user_groups`: the sorted group names the user holds a role in.
    async fn user_groups(&self, user_id: i64) -> MysqlResult<Vec<String>> {
        crate::permissions::user_groups(self.mysql, self.resolvers, self.redis, user_id).await
    }

    /// `get_effective_role_in_group` + `has_permission(Reporter)`.
    async fn reporter_access(&self, user_id: i64, group: &str) -> MysqlResult<bool> {
        let erp = self.erp_context();
        let role = crate::skills::skills_unified::effective_role_in_group(
            self.mysql,
            &erp,
            i32::try_from(user_id).unwrap_or(i32::MAX),
            group,
        )
        .await?;
        Ok(role
            .as_deref()
            .is_some_and(|role| crate::teams::group_membership::has_permission(role, "Reporter")))
    }

    /// `check_group_permission(db, user_id, group, GroupRole.Reporter)`.
    async fn check_group_permission(&self, user_id: i64, group: &str) -> MysqlResult<bool> {
        self.reporter_access(user_id, group).await
    }

    /// `list_user_group_skill_ids`: the active Skill ids shared with any group
    /// the user can access with at least Reporter access.
    async fn list_user_group_skill_ids(&self, user_id: i64) -> MysqlResult<HashSet<i64>> {
        let mut authorized = Vec::new();
        for group in self.user_groups(user_id).await? {
            if group == "default" {
                continue;
            }
            if self.check_group_permission(user_id, &group).await? {
                authorized.push(group);
            }
        }
        Ok(
            crate::skills::skills_unified::group_skill_ids_for_namespaces(self.mysql, &authorized)
                .await?
                .into_iter()
                .map(i64::from)
                .collect(),
        )
    }

    /// `can_user_access_skill`: owner/system, published-public, or Reporter
    /// access in the Skill's group namespace.
    async fn can_user_access_skill(&self, user_id: i64, skill: &SkillKindRow) -> MysqlResult<bool> {
        if skill.kinds_user_id == 0 || skill.kinds_user_id == user_id {
            return Ok(true);
        }
        if is_published_public(&skill.kinds_json.0) {
            return Ok(true);
        }
        if skill.kinds_namespace != "default"
            && self
                .reporter_access(user_id, &skill.kinds_namespace)
                .await?
        {
            return Ok(true);
        }
        Ok(false)
    }

    /// `list_user_default_skill_ids`: the user's default bindings whose Skill
    /// is active and accessible.
    async fn list_user_default_skill_ids(
        &self,
        user_id: i64,
        target_id: &str,
    ) -> MysqlResult<HashSet<i64>> {
        let bindings: Vec<SkillKindRow> = self
            .mysql
            .fetch_all(user_default_bindings_statement(), (user_id,))
            .await?;
        let mut ids = HashSet::new();
        for binding in bindings {
            if !is_user_default_binding(&binding.kinds_json.0, target_id) {
                continue;
            }
            let Some(skill_id) = extract_skill_id(&binding.kinds_json.0) else {
                continue;
            };
            let skill: Option<SkillKindRow> = self
                .mysql
                .fetch_optional(active_skill_by_id_statement(), (skill_id,))
                .await?;
            let Some(skill) = skill else {
                continue;
            };
            if self.can_user_access_skill(user_id, &skill).await? {
                ids.insert(skill_id);
            }
        }
        Ok(ids)
    }

    /// `find_skill_by_ref`'s explicit-id branch after the `id + name` read.
    async fn find_skill_by_ref_accessible(
        &self,
        user_id: i64,
        target_id: &str,
        skill_id: i64,
        skill: &SkillKindRow,
    ) -> MysqlResult<bool> {
        if skill.kinds_user_id == 0 || skill.kinds_user_id == user_id {
            return Ok(true);
        }
        if self
            .list_user_group_skill_ids(user_id)
            .await?
            .contains(&skill_id)
        {
            return Ok(true);
        }
        if skill.kinds_namespace != "default"
            && self
                .check_group_permission(user_id, &skill.kinds_namespace)
                .await?
        {
            return Ok(true);
        }
        Ok(self.can_user_access_skill(user_id, skill).await?
            && self
                .list_user_default_skill_ids(user_id, target_id)
                .await?
                .contains(&skill_id))
    }
}

/// `_get_capability`'s published-public pair.
fn is_published_public(json: &Value) -> bool {
    let Some(capability) = json.get("spec").and_then(|spec| spec.get("capability")) else {
        return false;
    };
    capability.get("visibility").and_then(Value::as_str) == Some("public")
        && capability.get("publishStatus").and_then(Value::as_str) == Some("published")
}

/// `list_user_default_skill_refs` for the create flow: the user's default
/// bindings plus the team's group bindings (`context.group_namespace`), each
/// filtered by the binding exceptions, deduped by skill id, and resolved to an
/// active Skill in query order (newest binding first).
pub async fn list_user_default_skill_refs<M: Mysql>(
    mysql: &M,
    user_id: i64,
    target_id: &str,
    context: &SkillBindingContext<'_>,
    access: Option<&SkillAccess<'_>>,
) -> MysqlResult<Vec<Value>> {
    // `kinds.user_id` is an integer column: the source renders the bound value
    // as the unquoted literal `kinds.user_id = 6582`, so it must not be bound
    // as a string.
    let bindings: Vec<SkillKindRow> = mysql
        .fetch_all(user_default_bindings_statement(), (user_id,))
        .await?;
    let mut candidates: Vec<SkillKindRow> = bindings
        .into_iter()
        .filter(|row| is_user_default_binding(&row.kinds_json.0, target_id))
        .filter(|row| !is_excluded_by_context(&row.kinds_json.0, context))
        .collect();
    if let Some(group) = context.group_namespace {
        // `list_group_bindings` returns nothing without Reporter access.
        let allowed = match access {
            Some(access) => access.check_group_permission(user_id, group).await?,
            None => true,
        };
        if allowed {
            let group_rows: Vec<SkillKindRow> = mysql
                .fetch_all(group_bindings_statement(), (group.to_string(),))
                .await?;
            candidates.extend(
                group_rows
                    .into_iter()
                    .filter(|row| is_group_binding(&row.kinds_json.0, group))
                    .filter(|row| !is_excluded_by_context(&row.kinds_json.0, context)),
            );
        }
    }

    let mut seen: Vec<i64> = Vec::new();
    let mut refs = Vec::new();
    for binding in candidates {
        let Some(skill_id) = extract_skill_id(&binding.kinds_json.0) else {
            continue;
        };
        if seen.contains(&skill_id) {
            continue;
        }
        seen.push(skill_id);
        let skill: Option<SkillKindRow> = mysql
            .fetch_optional(active_skill_by_id_statement(), (skill_id,))
            .await?;
        let Some(skill) = skill else {
            continue;
        };
        let mut reference = serde_json::json!({
            "skill_id": skill.kinds_id,
            "name": skill.kinds_name,
            "namespace": skill.kinds_namespace,
            "is_public": skill.kinds_user_id == 0,
        });
        if extract_force_preload(&binding.kinds_json.0) {
            reference["force_preload"] = Value::Bool(true);
        }
        refs.push(reference);
    }
    Ok(refs)
}

/// The `_get_bot_skills` result.
#[derive(Debug, Default)]
pub struct BotSkills {
    /// `_build_skill_data` entries (`skill_configs`).
    pub skills: Vec<Value>,
    pub preload_skills: Vec<String>,
    pub user_selected_skills: Vec<String>,
    /// `skill_refs` keyed by skill name.
    pub skill_refs: serde_json::Map<String, Value>,
}

/// `_get_bot_skills` for the create flow: the merged Ghost capabilities'
/// skills resolved by their Ghost-stored refs (fallback: the public skill
/// read), plus the injected `subscription-manager` available skill, plus the
/// user-default binding refs.
///
/// Recorded shape (`2834ba9c`): `skills = ["wegent-knowledge",
/// "subscription-manager"]` (the skill `name` order), `preload_skills =
/// ["wegent-knowledge"]` (the Ghost's preload), `user_selected_skills =
/// ["wegent-knowledge"]`, and `skill_refs` keyed by both names with the
/// `skill_id`/`namespace`/`is_public`/`content_hash` metadata.
#[allow(clippy::too_many_arguments)]
pub async fn get_bot_skills<M: Mysql>(
    mysql: &M,
    merged: &MergedGhostCapabilities,
    bot_capability_mode: &str,
    user_id: i64,
    is_subscription: bool,
    user_default_target_id: &str,
    binding_context: &SkillBindingContext<'_>,
    access: Option<&SkillAccess<'_>>,
) -> MysqlResult<BotSkills> {
    let mut result = BotSkills::default();
    let include_ghost = bot_capability_mode != "follow_device";
    let preload_set: Vec<&String> = if include_ghost {
        merged.preload_skills.iter().collect()
    } else {
        Vec::new()
    };

    if include_ghost {
        for skill_name in &merged.skills {
            let reference = merged.skill_refs.get(skill_name);
            let skill: Option<SkillKindRow> = match reference {
                Some(reference) => {
                    let skill_id = reference.get("skill_id").and_then(Value::as_i64);
                    match skill_id {
                        Some(skill_id) => {
                            mysql
                                .fetch_optional(
                                    attached_skill_statement(),
                                    (skill_id, skill_name.clone()),
                                )
                                .await?
                        }
                        None => {
                            mysql
                                .fetch_optional(public_skill_statement(), (skill_name.clone(),))
                                .await?
                        }
                    }
                }
                None => {
                    mysql
                        .fetch_optional(public_skill_statement(), (skill_name.clone(),))
                        .await?
                }
            };
            let Some(skill) = skill else {
                continue;
            };
            let fallback = SkillRefMeta::from_kind(&skill);
            result.skills.push(build_skill_data(&skill));
            if let Some(reference) = reference {
                result.skill_refs.insert(
                    skill_name.clone(),
                    serde_json::to_value(SkillRefMeta::from_ghost_ref(reference, &fallback))
                        .unwrap_or(Value::Null),
                );
            } else {
                result.skill_refs.insert(
                    skill_name.clone(),
                    serde_json::to_value(fallback).unwrap_or(Value::Null),
                );
            }
            if preload_set.contains(&skill_name) {
                result.preload_skills.push(skill_name.clone());
                result.user_selected_skills.push(skill_name.clone());
            }
        }
    }

    // The injected `subscription-manager` available skill: added to `skills`
    // and `skill_refs` but never to the preload lists.
    for injected in inject_subscription_manager_skill(is_subscription) {
        let name = injected
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if result.skill_refs.contains_key(&name) {
            continue;
        }
        let skill: Option<SkillKindRow> = mysql
            .fetch_optional(public_skill_statement(), (name.clone(),))
            .await?;
        let Some(skill) = skill else {
            continue;
        };
        result.skills.push(build_skill_data(&skill));
        result.skill_refs.insert(
            name,
            serde_json::to_value(SkillRefMeta::from_kind(&skill)).unwrap_or(Value::Null),
        );
    }

    // The user-default binding refs (available, not preloaded, unless
    // `force_preload`).
    for reference in list_user_default_skill_refs(
        mysql,
        user_id,
        user_default_target_id,
        binding_context,
        access,
    )
    .await?
    {
        let name = reference
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let force_preload = reference.get("force_preload") == Some(&Value::Bool(true));
        if result.skill_refs.contains_key(&name) {
            continue;
        }
        let skill_id = reference.get("skill_id").and_then(Value::as_i64);
        let skill = resolve_binding_ref_skill(mysql, skill_id, &name).await?;
        let Some(skill) = skill else {
            continue;
        };
        // `find_skill_by_ref`'s access checks after the id + name read.
        if let (Some(access), Some(skill_id)) = (access, skill_id)
            && !access
                .find_skill_by_ref_accessible(user_id, user_default_target_id, skill_id, &skill)
                .await?
        {
            continue;
        }
        result.skills.push(build_skill_data(&skill));
        result.skill_refs.insert(
            name.clone(),
            serde_json::to_value(SkillRefMeta::from_kind(&skill)).unwrap_or(Value::Null),
        );
        if force_preload {
            result.preload_skills.push(name.clone());
            result.user_selected_skills.push(name.clone());
        }
    }
    Ok(result)
}

/// `_build_skill_data` (the reachable fields): the Skill CRD's metadata name,
/// spec description/prompt/displayName, and the ids. An absent or `null`
/// spec field stays JSON `null` (the source serializes the pydantic `None`
/// value), and `config`/`runtime`/`mcpServers` are copied only when the
/// source's truthiness check accepts them.
fn build_skill_data(skill: &SkillKindRow) -> Value {
    let spec = skill
        .kinds_json
        .0
        .get("spec")
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()));
    let field = |key: &str| spec.get(key).cloned().unwrap_or(Value::Null);
    let mut data = serde_json::json!({
        "name": skill.kinds_name,
        "description": field("description"),
        "prompt": field("prompt"),
        "displayName": field("displayName"),
        "skill_id": skill.kinds_id,
        "skill_user_id": skill.kinds_user_id,
    });
    for key in ["config", "runtime", "mcpServers"] {
        if let Some(value) = spec
            .get(key)
            .filter(|value| brz_json::adapters::python_truthy(value))
        {
            data[key] = value.clone();
        }
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn skill_reads_match_the_recorded_statements() {
        let attached = normalize(&attached_skill_statement());
        assert!(attached.contains(
            "WHERE kinds.id = ? AND kinds.kind = 'Skill' AND kinds.name = ? \
             AND kinds.is_active = true LIMIT 1"
        ));
        let public = normalize(&public_skill_statement());
        assert!(public.contains(
            "WHERE kinds.user_id = 0 AND kinds.kind = 'Skill' AND kinds.name = ? \
             AND kinds.is_active = true LIMIT 1"
        ));
    }

    /// `_get_bot_skills` re-resolves each binding ref through
    /// `find_skill_by_ref`'s explicit-id branch (`id` + `name`), not a second
    /// id-only `_get_active_skill` read: the recorded case reads each Skill
    /// once by id while resolving the binding and once by id+name here.
    #[tokio::test]
    async fn binding_ref_lookup_uses_the_attached_skill_statement() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let _ =
            resolve_binding_ref_skill(&mysql, Some(1_757_975), "lbs-concert-json2table-star-uid")
                .await
                .expect("read");
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains(
            "WHERE kinds.id = ? AND kinds.kind = 'Skill' AND kinds.name = ? \
             AND kinds.is_active = true LIMIT 1"
        ));
        assert_eq!(queries[0].args, 2);
        assert_eq!(queries[0].first_integer, Some(1_757_975));
    }

    #[test]
    fn ref_meta_derives_from_the_kind_row() {
        let row = SkillKindRow {
            kinds_id: 200_318,
            kinds_user_id: 0,
            kinds_kind: "Skill".to_string(),
            kinds_name: "subscription-manager".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: Json(json!({
                "status": {"fileHash": "d9f8d69053873ea444f69e871cf9ce542d8315869b0f1b0bfe3aa00c26c50caa"}
            })),
            kinds_is_active: 1,
            kinds_created_at: None,
            kinds_updated_at: None,
        };
        assert_eq!(
            SkillRefMeta::from_kind(&row),
            SkillRefMeta {
                skill_id: 200_318,
                namespace: "default".to_string(),
                is_public: true,
                content_hash: Some(
                    "sha256:d9f8d69053873ea444f69e871cf9ce542d8315869b0f1b0bfe3aa00c26c50caa"
                        .to_string()
                ),
            }
        );
    }

    /// `_build_skill_data` keeps a present-or-absent text field as JSON
    /// `null` and omits `config`/`runtime`/`mcpServers` the source's
    /// truthiness check rejects. The chat-shell body compares values exactly,
    /// so `""` or `"mcpServers": null` would never match the recorded body.
    #[test]
    fn skill_data_keeps_present_nulls_and_omits_absent_optional_keys() {
        let skill = SkillKindRow {
            kinds_id: 1_757_975,
            kinds_user_id: 655,
            kinds_kind: "Skill".to_string(),
            kinds_name: "lbs-concert-json2table-star-uid".to_string(),
            kinds_namespace: "lbs-group1".to_string(),
            kinds_json: Json(json!({
                "spec": {"description": "convert", "prompt": "# prompt"},
            })),
            kinds_is_active: 1,
            kinds_created_at: None,
            kinds_updated_at: None,
        };
        let data = build_skill_data(&skill);
        let object = data.as_object().expect("object");
        assert_eq!(object["displayName"], Value::Null);
        assert!(!object.contains_key("mcpServers"));
        assert!(!object.contains_key("config"));
        assert!(!object.contains_key("runtime"));
        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "name",
                "description",
                "prompt",
                "displayName",
                "skill_id",
                "skill_user_id"
            ]
        );
    }

    /// A truthy `mcpServers` descriptor is copied verbatim (including the
    /// unsubstituted `${{...}}` placeholders the source keeps), while a falsy
    /// `config` object is omitted.
    #[test]
    fn skill_data_copies_truthy_optional_keys() {
        let skill = SkillKindRow {
            kinds_id: 200_318,
            kinds_user_id: 0,
            kinds_kind: "Skill".to_string(),
            kinds_name: "subscription-manager".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: Json(json!({
                "spec": {
                    "description": "d",
                    "prompt": "p",
                    "displayName": "订阅任务管理",
                    "mcpServers": {
                        "wegent-subscription": {"url": "${{backend_url}}/mcp/subscription/sse"}
                    },
                    "config": {},
                },
            })),
            kinds_is_active: 1,
            kinds_created_at: None,
            kinds_updated_at: None,
        };
        let data = build_skill_data(&skill);
        let object = data.as_object().expect("object");
        assert_eq!(object["displayName"], json!("订阅任务管理"));
        assert_eq!(
            object["mcpServers"],
            json!({"wegent-subscription": {"url": "${{backend_url}}/mcp/subscription/sse"}})
        );
        assert!(!object.contains_key("config"));
    }

    #[test]
    fn binding_predicates_and_extractors_follow_the_source() {
        let binding = json!({
            "spec": {
                "targetType": "user",
                "targetId": "user-5831",
                "skillRef": {"skillId": 128913, "name": "wegent-knowledge"},
                "forcePreload": true,
            }
        });
        assert!(is_user_default_binding(&binding, "user-5831"));
        assert!(!is_user_default_binding(&binding, "other"));
        assert_eq!(extract_skill_id(&binding), Some(128_913));
        assert!(extract_force_preload(&binding));

        let group = json!({"spec": {"targetType": "group", "targetId": "ns-a"}});
        assert!(is_group_binding(&group, "ns-a"));
        assert_eq!(extract_skill_id(&group), None);
        assert!(!extract_force_preload(&group));
    }

    #[test]
    fn subscription_manager_injection_skips_subscription_tasks() {
        assert_eq!(inject_subscription_manager_skill(true), Vec::<Value>::new());
        assert_eq!(
            inject_subscription_manager_skill(false),
            vec![json!({
                "name": "subscription-manager",
                "namespace": "default",
                "is_public": true,
            })]
        );
    }

    #[test]
    fn binding_exceptions_filter_by_mode_agent_and_project() {
        let context = SkillBindingContext {
            mode: "chat",
            agent_id: 302_292,
            project_id: Some(2571),
            group_namespace: Some("lbs-group1"),
        };
        let binding = |exceptions: Value| json!({"spec": {"exceptions": exceptions}});
        assert!(is_excluded_by_context(
            &binding(json!([{"type": "mode", "value": "chat"}])),
            &context
        ));
        assert!(is_excluded_by_context(
            &binding(json!([{"type": "agent", "value": "302292"}])),
            &context
        ));
        assert!(is_excluded_by_context(
            &binding(json!([{"type": "project", "value": " 2571 "}])),
            &context
        ));
        assert!(!is_excluded_by_context(
            &binding(json!([{"type": "mode", "value": "video"}])),
            &context
        ));
        assert!(!is_excluded_by_context(&binding(json!([])), &context));
    }

    /// The recorded statement carries `kinds.user_id = 6582`, an integer
    /// literal, so the read binds an integer (`kinds.user_id = ?`). A
    /// stringified id never matched the recorded exchange.
    #[tokio::test]
    async fn user_default_binding_read_binds_the_user_id_as_an_integer() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let context = SkillBindingContext {
            mode: "chat",
            agent_id: 302_292,
            project_id: None,
            group_namespace: None,
        };
        let refs = list_user_default_skill_refs(&mysql, 6582, "user:6582", &context, None)
            .await
            .expect("read");
        assert!(refs.is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("kinds.user_id = ?"));
        assert!(
            queries[0]
                .sql
                .contains("WHERE kinds.user_id = ? AND kinds.kind = 'SkillBinding'")
        );
        assert_eq!(queries[0].first_integer, Some(6582));
    }
}
