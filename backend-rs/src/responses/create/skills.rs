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

use crate::http_compat::FastApiError;
use crate::mcp_provider_registry::{get_mcp_service_by_skill_name, list_mcp_providers};
use crate::mcp_user_service::enabled_provider_server;
use crate::provider_guidance::build_provider_configuration_prompt;
use crate::teams::group_membership::ErpContext;
use crate::user_mcp_oauth::UserMcpAccessTokens;

use super::ghost::MergedGhostCapabilities;

/// MySQL failures in `_get_bot_skills` surface as the create request's
/// dependency error, matching the other request-builder reads.
fn dependency(error: brz_mysql::MysqlError) -> FastApiError {
    super::request::dependency(error)
}

#[path = "skills_requested.rs"]
mod requested;
pub(super) use requested::{
    append_coding_mcp, append_requested_skills, is_coding_shell, late_bot_reads,
    resolve_request_preload_skills,
};

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
}

/// `_get_bot_skills`' Ghost-skill ref (`request_builder.py:1685-1701`):
/// `skill_refs[skill_name] = build_skill_ref_meta(skill)`. Every field —
/// including `content_hash` — comes from the resolved Skill row: the Ghost's
/// stored ref only selects which Skill to read (`skill_id`), so a stale stored
/// hash never reaches the dispatch body. The live row is the version source
/// (`skill_resolution.py:19-25`).
fn ghost_skill_ref_meta(skill: &SkillKindRow) -> Value {
    serde_json::to_value(SkillRefMeta::from_kind(skill)).unwrap_or(Value::Null)
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

/// `_inject_conditional_provider_skills`: preload the runtime Skill of every
/// provider service whose `message_keywords` appear in the prompt.
///
/// The provider's own keywords must match before any service is considered; a
/// provider whose keywords match but whose services do not preloads every
/// service it declares. A matched provider therefore makes its Skills part of
/// `preload_skills`, which adds them to the request metadata and lets
/// `apply_provider_configuration_guidance` find their guidance. The create
/// flow's prompt is a string, so `_extract_prompt_text` is the identity here.
pub fn inject_conditional_provider_skills(prompt: &str, references: &mut Vec<Value>) {
    let text = normalize_provider_keyword_text(prompt);
    if text.is_empty() {
        return;
    }
    let mut existing: Vec<String> = references
        .iter()
        .filter_map(|reference| match reference {
            Value::String(name) => Some(name.clone()),
            Value::Object(_) => reference
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .collect();
    for provider in list_mcp_providers() {
        if provider.message_keywords.is_empty()
            || !matches_any_keyword(provider.message_keywords, &text)
        {
            continue;
        }
        let mut matched: Vec<&crate::mcp_provider_registry::McpProviderServiceDefinition> =
            provider
                .services
                .iter()
                .filter(|service| matches_any_keyword(service.message_keywords, &text))
                .collect();
        if matched.is_empty() {
            matched = provider.services.iter().collect();
        }
        for service in matched {
            let skill_name = service.skill_name;
            if skill_name.is_empty() || existing.iter().any(|name| name == skill_name) {
                continue;
            }
            references.push(serde_json::json!({
                "name": skill_name,
                "namespace": "default",
                "is_public": true,
            }));
            existing.push(skill_name.to_string());
        }
    }
}

/// `_normalize_provider_keyword_text`: remove every whitespace character and
/// case-fold, so a keyword matches regardless of spacing or case.
fn normalize_provider_keyword_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn matches_any_keyword(keywords: &[&str], text: &str) -> bool {
    keywords
        .iter()
        .any(|keyword| text.contains(&normalize_provider_keyword_text(keyword)))
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
///
/// The source resolves a user-default binding twice: `list_user_default_bindings`
/// (`skill_binding_service.py:403`) reads `_get_active_skill` by id to drop
/// inactive/inaccessible bindings, then `list_user_default_skill_refs`
/// (`skill_binding_service.py:460-469`) reads the same Skill by id again to
/// build the ref. Both are business SELECTs, so the second read is reproduced
/// here rather than reusing the first row. Group bindings have no
/// `list_user_default_bindings` pass; the loop's read is their only one.
pub async fn list_user_default_skill_refs<M: Mysql>(
    mysql: &M,
    user_id: i64,
    target_id: &str,
    context: &SkillBindingContext<'_>,
    access: Option<&SkillAccess<'_>>,
) -> MysqlResult<Vec<Value>> {
    // `list_user_default_bindings` (`skill_binding_service.py:403-431`): the
    // user's default bindings whose Skill is active and accessible.
    //
    // `kinds.user_id` is an integer column: the source renders the bound value
    // as the unquoted literal `kinds.user_id = 6582`, so it must not be bound
    // as a string.
    let bindings: Vec<SkillKindRow> = mysql
        .fetch_all(user_default_bindings_statement(), (user_id,))
        .await?;
    let mut candidates: Vec<SkillKindRow> = Vec::new();
    for binding in bindings {
        if !is_user_default_binding(&binding.kinds_json.0, target_id) {
            continue;
        }
        let Some(skill_id) = extract_skill_id(&binding.kinds_json.0) else {
            continue;
        };
        let skill: Option<SkillKindRow> = mysql
            .fetch_optional(active_skill_by_id_statement(), (skill_id,))
            .await?;
        let Some(skill) = skill else {
            continue;
        };
        let accessible = match access {
            Some(access) => access.can_user_access_skill(user_id, &skill).await?,
            None => true,
        };
        if !accessible {
            continue;
        }
        candidates.push(binding);
    }
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
                    .filter(|row| is_group_binding(&row.kinds_json.0, group)),
            );
        }
    }

    // `list_user_default_skill_refs`'s own loop: exception filter, id dedupe,
    // then a fresh `_get_active_skill` read for the ref.
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
        if is_excluded_by_context(&binding.kinds_json.0, context) {
            continue;
        }
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
    /// The index where the request-selected Skill entries belong.
    ///
    /// `_get_bot_skills` resolves the Ghost's Skills, then the caller's
    /// preloaded Skills, then the injected available Skills, so an entry added
    /// by a later pass must not land behind an available one. Zero is the end
    /// of a Skill-free Ghost, which is also the correct position for a caller
    /// that resolves no Ghost Skills.
    pub preload_insert_at: usize,
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
pub(crate) async fn get_bot_skills<M: Mysql, T: UserMcpAccessTokens>(
    mysql: &M,
    merged: &MergedGhostCapabilities,
    bot_capability_mode: &str,
    user_id: i64,
    user_preferences: Option<&str>,
    tokens: &T,
    is_subscription: bool,
    user_default_target_id: &str,
    binding_context: &SkillBindingContext<'_>,
    access: Option<&SkillAccess<'_>>,
    // `user_available_skills` (`_get_bot_skills`' third input): the automatic
    // user-default/group binding refs. The late `resolve_request_preload_skills`
    // re-resolution passes none, so it must not re-read the SkillBinding rows.
    include_available_skills: bool,
) -> Result<BotSkills, FastApiError> {
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
                        Some(skill_id) => mysql
                            .fetch_optional(
                                attached_skill_statement(),
                                (skill_id, skill_name.clone()),
                            )
                            .await
                            .map_err(dependency)?,
                        None => mysql
                            .fetch_optional(public_skill_statement(), (skill_name.clone(),))
                            .await
                            .map_err(dependency)?,
                    }
                }
                None => mysql
                    .fetch_optional(public_skill_statement(), (skill_name.clone(),))
                    .await
                    .map_err(dependency)?,
            };
            let Some(skill) = skill else {
                continue;
            };
            result
                .skills
                .push(build_skill_data_with_oauth(&skill, user_preferences, tokens).await?);
            result
                .skill_refs
                .insert(skill_name.clone(), ghost_skill_ref_meta(&skill));
            if preload_set.contains(&skill_name) {
                result.preload_skills.push(skill_name.clone());
                result.user_selected_skills.push(skill_name.clone());
            }
        }
    }
    // The Ghost's Skills end here; the caller's preloaded Skills belong before
    // the injected available ones that follow.
    result.preload_insert_at = result.skills.len();

    // The injected `subscription-manager` available skill: added to `skills`
    // and `skill_refs` but never to the preload lists. The caller builds it as
    // part of `user_available_skills` (`request_builder.py:364`) and
    // `_get_bot_skills` only consumes it inside `if user_available_skills:`
    // (`:1815`), so a re-resolution without available skills must not add it.
    if include_available_skills {
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
                .await
                .map_err(dependency)?;
            let Some(skill) = skill else {
                continue;
            };
            result
                .skills
                .push(build_skill_data_with_oauth(&skill, user_preferences, tokens).await?);
            result.skill_refs.insert(
                name,
                serde_json::to_value(SkillRefMeta::from_kind(&skill)).unwrap_or(Value::Null),
            );
        }
    }

    // The user-default binding refs (available, not preloaded, unless
    // `force_preload`).
    let available_refs = if include_available_skills {
        list_user_default_skill_refs(
            mysql,
            user_id,
            user_default_target_id,
            binding_context,
            access,
        )
        .await
        .map_err(dependency)?
    } else {
        Vec::new()
    };
    for reference in available_refs {
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
        let skill = resolve_binding_ref_skill(mysql, skill_id, &name)
            .await
            .map_err(dependency)?;
        let Some(skill) = skill else {
            continue;
        };
        // `find_skill_by_ref`'s access checks after the id + name read.
        if let (Some(access), Some(skill_id)) = (access, skill_id)
            && !access
                .find_skill_by_ref_accessible(user_id, user_default_target_id, skill_id, &skill)
                .await
                .map_err(dependency)?
        {
            continue;
        }
        result
            .skills
            .push(build_skill_data_with_oauth(&skill, user_preferences, tokens).await?);
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
/// value), and `config`/`runtime`/`mcpServers`/`tools`/`provider` are copied
/// only when the source's truthiness check accepts them.
///
/// `provider` also gates `binary_download_url`
/// (`request_builder.py:2042-2054`): the field exists for a public skill
/// (`user_id == 0`, the source's security restriction) with a provider, and
/// points at the backend's internal binary endpoint.
///
/// `user_preferences` is the request user's `users.preferences`, read by the
/// user-managed runtime-service branch below; the create flow always carries
/// the reloaded row.
fn build_skill_data(
    skill: &SkillKindRow,
    user_preferences: Option<&str>,
) -> Result<Value, FastApiError> {
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
    // `_build_skill_data`'s user-managed runtime-service branch
    // (`request_builder.py:2004-2035`): a public Skill in the `default`
    // namespace whose name is registered by a user-mode provider renders the
    // configuration guidance instead of its stored MCP servers when the request
    // user has not configured that service. The branch runs after
    // `mcpServers` was copied, so it removes a field that is otherwise present.
    let is_public_default_runtime_skill =
        skill.kinds_user_id == 0 && skill_namespace(skill) == "default";
    if is_public_default_runtime_skill
        && let Some((provider, service)) = get_mcp_service_by_skill_name(&skill.kinds_name)
        && provider.configuration_mode == "user"
    {
        // `configured_server = None; if user: configured_server = ...`: a
        // request without a user record has no configured server and therefore
        // requires configuration.
        let configured_server = match user_preferences {
            Some(preferences) => {
                enabled_provider_server(preferences, provider.provider_id, service.service_id)?
            }
            None => None,
        };
        if configured_server.is_none() {
            if let Some(object) = data.as_object_mut() {
                object.remove("mcpServers");
            }
            data["configuration_required"] = Value::Bool(true);
            data["prompt"] = Value::String(build_provider_configuration_prompt(provider, service));
        }
    }
    // `skill_crd.spec.tools`: `[tool.model_dump(exclude_none=True) for tool in
    // skill_crd.spec.tools]` — the declaration's `name`/`provider` plus its
    // `config` only when it is not `None`.
    if let Some(tools) = spec
        .get("tools")
        .filter(|value| brz_json::adapters::python_truthy(value))
    {
        let tools = tools
            .as_array()
            .map(|tools| tools.iter().map(skill_tool_declaration).collect())
            .unwrap_or_default();
        data["tools"] = Value::Array(tools);
    }
    // `skill_crd.spec.provider`: the loader `module` (the pydantic default when
    // the spec omits it) and the `class` alias, emitted verbatim.
    if let Some(provider) = spec
        .get("provider")
        .filter(|value| brz_json::adapters::python_truthy(value))
    {
        let module = provider
            .get("module")
            .and_then(Value::as_str)
            .unwrap_or("provider");
        let class = provider.get("class").and_then(Value::as_str).unwrap_or("");
        data["provider"] = serde_json::json!({"module": module, "class": class});
        // "For HTTP mode: include download URL for remote skill binary loading.
        // Only for public skills (user_id=0) for security."
        if skill.kinds_user_id == 0 {
            data["binary_download_url"] = Value::String(binary_download_url(
                &super::bot_config::backend_url(),
                skill.kinds_id,
            ));
        }
    }
    Ok(data)
}

#[path = "skills_oauth.rs"]
mod oauth;
use oauth::build_skill_data_with_oauth;

/// `skill_crd.metadata.namespace`; the pydantic `ObjectMeta` defaults an
/// omitted namespace to `"default"`.
fn skill_namespace(skill: &SkillKindRow) -> &str {
    if skill.kinds_namespace.is_empty() {
        "default"
    } else {
        &skill.kinds_namespace
    }
}

/// One `SkillToolDeclaration.model_dump(exclude_none=True)`: `name` and
/// `provider` are required, `config` is kept only when it is not `None`, and
/// undeclared keys are dropped by the pydantic model.
fn skill_tool_declaration(tool: &Value) -> Value {
    let mut dumped = serde_json::Map::new();
    for key in ["name", "provider"] {
        if let Some(value) = tool.get(key) {
            dumped.insert(key.to_string(), value.clone());
        }
    }
    if let Some(config) = tool.get("config").filter(|value| !value.is_null()) {
        dumped.insert("config".to_string(), config.clone());
    }
    Value::Object(dumped)
}

/// `f"{settings.BACKEND_INTERNAL_URL.rstrip('/')}/api/internal/skills/{id}/binary"`
/// (`request_builder.py:2050-2053`).
fn binary_download_url(base_url: &str, skill_id: i64) -> String {
    format!(
        "{}/api/internal/skills/{skill_id}/binary",
        base_url.trim_end_matches('/')
    )
}

#[cfg(test)]
#[path = "skills_tests.rs"]
mod tests;
