// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Skill resolution chain for `GET /api/tasks/{task_id}/skills`, mirroring
//! `app.services.adapters.task_kinds.task_skills_resolver.resolve_task_skills`
//! (task -> team -> bots -> ghosts -> skills) and the helpers it composes:
//! `skill_resolution.find_skill_by_name` / `find_skill_by_ref`,
//! `skill_binding_service.list_user_default_skill_ids` /
//! `list_user_default_skill_refs`, and the subscription skillRefs load.
use std::collections::{HashMap, HashSet};

use super::kinds::KindCacheStore;
use super::repository as repo;
use crate::crd::{CrdDocument, CrdLabels, SkillRefMetaInput, reference_parts};
use crate::json_compat::{JsonProjection, OpaqueJson};
use crate::remote_workspace_tree::kinds::KindStore;
use brz_mysql::Mysql;

/// A resolved skill reference (`build_skill_ref_meta`): `content_hash` is
/// `null` when the Skill CRD carries no `status.fileHash`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillRefMeta {
    pub skill_id: i64,
    pub namespace: String,
    pub is_public: bool,
    pub content_hash: Option<String>,
}

impl SkillRefMeta {
    /// `build_skill_ref_meta`.
    pub fn from_kind(row: &repo::KindRow) -> Self {
        let crd = CrdDocument::project_opaque(&row.kinds_json.0);
        let file_hash = crd
            .status
            .as_ref()
            .and_then(|status| status.file_hash.as_deref());
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

pub use crate::resource_refs::RequestedSkillRef;
use crate::resource_refs::{EmptyNamespace, parse_requested_skill_refs};

/// The assembled `TaskSkillsResponse`.
#[derive(serde::Serialize)]
pub struct TaskSkills {
    pub task_id: i64,
    pub team_id: Option<i64>,
    pub team_namespace: String,
    /// Sorted name list (`sorted(...)` in source).
    pub skills: Vec<String>,
    pub preload_skills: Vec<String>,
    /// Skill names are dynamic keys; JSON object key order is not contractual.
    pub skill_refs: HashMap<String, SkillRefMeta>,
    pub preload_skill_refs: HashMap<String, SkillRefMeta>,
}

/// `parse_requested_skill_refs_from_labels` (`normalize_requested_skill_refs`
/// semantics: last entry per name wins).
pub fn parse_requested_skill_refs_from_labels(
    labels: Option<&CrdLabels>,
) -> Vec<RequestedSkillRef> {
    let Some(raw) = labels.and_then(|labels| labels.requested_skill_refs.as_deref()) else {
        return Vec::new();
    };
    parse_requested_skill_refs(raw, EmptyNamespace::UseDefault)
}

/// `parse_additional_skill_names_from_labels`.
pub fn parse_additional_skill_names_from_labels(labels: Option<&CrdLabels>) -> Vec<String> {
    let Some(raw) = labels.and_then(|labels| labels.additional_skills.as_deref()) else {
        return Vec::new();
    };
    let Ok(JsonProjection { value: Some(items) }) =
        serde_json::from_str::<JsonProjection<Vec<Option<String>>>>(raw)
    else {
        return Vec::new();
    };
    items
        .into_iter()
        .flatten()
        .filter(|name| !name.is_empty())
        .collect()
}

/// The task CRD fields the chain reads.
pub struct TaskContext {
    pub task_id: i64,
    pub owner_user_id: i64,
    pub project_id: Option<i64>,
    pub team_name: String,
    pub team_namespace: String,
    /// `task_crd.spec.teamRef.user_id` when set.
    pub team_ref_user_id: Option<i64>,
    pub labels: Option<CrdLabels>,
    pub external_knowledge_providers: Vec<String>,
}

impl TaskContext {
    pub fn from_task_row(task_id: i64, row: &repo::TaskRow) -> Self {
        let crd = CrdDocument::project_opaque(&row.json);
        let spec = crd.spec.as_ref();
        let team_ref = spec.and_then(|spec| spec.team_ref.as_ref());
        // `_resolve_team_owner_id` treats a `teamRef.user_id` of 0 as unset
        // (Python truthiness) and falls through to the task owner.
        let team_ref_user_id = team_ref
            .and_then(|reference| reference.user_id.as_ref())
            .and_then(|id| id.json_integer())
            .filter(|id| *id != 0);
        let external_knowledge_providers = spec
            .and_then(|spec| spec.external_knowledge_refs.as_ref())
            .map(|refs| {
                refs.iter()
                    .filter_map(|reference| reference.as_ref())
                    .filter_map(|reference| reference.provider.clone())
                    .collect()
            })
            .unwrap_or_default();
        Self {
            task_id,
            owner_user_id: row.user_id,
            project_id: row.project_id,
            team_name: team_ref
                .map(|reference| reference.name())
                .unwrap_or("")
                .to_owned(),
            team_namespace: team_ref
                .map(|reference| reference.namespace())
                .unwrap_or("default")
                .to_owned(),
            team_ref_user_id,
            labels: crd.metadata.and_then(|metadata| metadata.labels),
            external_knowledge_providers,
        }
    }
}

/// The task mode derived for the skill-binding context
/// (`_derive_task_mode`).
fn task_mode(labels: Option<&CrdLabels>) -> String {
    labels
        .and_then(|labels| {
            if labels.task_type.is_some() {
                labels.task_type.as_deref()
            } else {
                labels.legacy_type.as_deref()
            }
        })
        .unwrap_or("chat")
        .to_string()
}

/// The full resolution chain. `resolve_task_skills` in source.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_task_skills<M: Mysql>(
    mysql: &M,
    kinds_cache: &KindCacheStore<'_, M, impl brz_redis::Redis>,
    raw_kinds: &KindStore<'_, M, impl brz_redis::Redis>,
    task: &TaskContext,
    user_id: i64,
) -> Result<TaskSkills, brz_mysql::MysqlError> {
    // Team resolution: personal index, shared list, share-permission
    // candidates, public fallback (`kindReader.get_by_name_and_namespace`
    // Team branch). Returns None on the not-found path.
    let team = kinds_cache
        .resolve_team(task.owner_user_id, &task.team_namespace, &task.team_name)
        .await?;

    // `_resolve_team_owner_id`.
    let team_owner_id = match &team {
        Some(team) if team.kinds_user_id != 0 => team.kinds_user_id,
        _ => task.team_ref_user_id.unwrap_or(task.owner_user_id),
    };

    let Some(team) = team else {
        // Team-not-found fallback: user-selected labels + user defaults +
        // requested refs + provider skills, no team id.
        let mut skills: HashSet<String> = HashSet::new();
        let mut skill_refs: HashMap<String, SkillRefMeta> = HashMap::new();
        let mut preload_skills: HashSet<String> = HashSet::new();
        let mut preload_skill_refs: HashMap<String, SkillRefMeta> = HashMap::new();
        for name in parse_additional_skill_names_from_labels(task.labels.as_ref()) {
            skills.insert(name.clone());
            preload_skills.insert(name);
        }
        merge_user_default_skill_refs(
            kinds_cache,
            user_id,
            None,
            None,
            // The team is absent, so the binding context carries no group
            // namespace.
            None,
            task,
            &mut skills,
            &mut skill_refs,
            &mut preload_skills,
            &mut preload_skill_refs,
        )
        .await?;
        for requested in parse_requested_skill_refs_from_labels(task.labels.as_ref()) {
            skills.insert(requested.name.clone());
            if let Some(row) = find_skill_by_ref(
                mysql,
                &requested.name,
                &requested.namespace,
                requested.is_public,
                team_owner_id,
            )
            .await?
            {
                let meta = SkillRefMeta::from_kind(&row);
                skill_refs.insert(requested.name.clone(), meta.clone());
                preload_skills.insert(requested.name.clone());
                preload_skill_refs.insert(requested.name, meta);
            }
        }
        merge_provider_skill_refs(
            mysql,
            task,
            team_owner_id,
            &task.team_namespace,
            &mut skills,
            &mut skill_refs,
            &mut preload_skills,
            &mut preload_skill_refs,
        )
        .await?;
        return Ok(finish(TaskSkills {
            task_id: task.task_id,
            team_id: None,
            team_namespace: task.team_namespace.clone(),
            skills: skills.into_iter().collect(),
            preload_skills: preload_skills.into_iter().collect(),
            skill_refs,
            preload_skill_refs,
        }));
    };

    let team_id = team.kinds_id;
    let team_namespace = if team.kinds_namespace.is_empty() {
        "default".to_string()
    } else {
        team.kinds_namespace.clone()
    };

    let mut skills: HashSet<String> = HashSet::new();
    let mut skill_refs: HashMap<String, SkillRefMeta> = HashMap::new();
    let mut preload_skills: HashSet<String> = HashSet::new();
    let mut preload_skill_refs: HashMap<String, SkillRefMeta> = HashMap::new();

    // Team members -> bots -> ghosts (`_batch_load_kinds_by_refs` personal
    // then public, then the ghost loop).
    let team_crd = CrdDocument::project_opaque(&team.kinds_json.0);
    let bot_refs = team_crd
        .spec
        .as_ref()
        .and_then(|spec| spec.members.as_ref())
        .map(|members| {
            members
                .iter()
                .filter_map(|member| member.as_ref())
                .filter_map(|member| reference_parts(&member.bot_ref))
                .map(|(name, namespace)| (namespace, name))
                .filter(|(_, name)| !name.is_empty())
                .collect::<Vec<(String, String)>>()
        })
        .unwrap_or_default();
    let bots = kinds_cache
        .batch_load_kinds_by_refs(team_owner_id, "Bot", &bot_refs)
        .await?;
    let mut ghost_refs: Vec<(String, String)> = Vec::new();
    for bot in &bots {
        let crd = CrdDocument::project_opaque(&bot.kinds_json.0);
        if let Some((name, namespace)) = crd
            .spec
            .as_ref()
            .and_then(|spec| reference_parts(&spec.ghost_ref))
        {
            ghost_refs.push((namespace, name));
        }
    }
    let ghosts = kinds_cache
        .batch_load_kinds_by_refs(team_owner_id, "Ghost", &ghost_refs)
        .await?;

    for ghost in &ghosts {
        let crd = CrdDocument::project_opaque(&ghost.kinds_json.0);
        let spec = crd.spec.as_ref();
        let ghost_skills = spec
            .and_then(|spec| spec.skills.as_ref())
            .map(|names| {
                names
                    .iter()
                    .filter_map(|name| name.clone())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        let ghost_skill_refs = spec.and_then(|spec| spec.skill_refs.as_ref());
        for skill_name in &ghost_skills {
            skills.insert(skill_name.clone());
            if let Some(ref_meta) = ghost_skill_refs.and_then(|refs| refs.get(skill_name)) {
                let mut resolved = ref_meta_from_crd(ref_meta.as_ref());
                if resolved.content_hash.is_none()
                    && let Some(skill) =
                        find_skill_by_name(kinds_cache, skill_name, team_owner_id, &team_namespace)
                            .await?
                {
                    resolved.content_hash = SkillRefMeta::from_kind(&skill).content_hash;
                }
                skill_refs.insert(skill_name.clone(), resolved);
            } else if let Some(skill) =
                find_skill_by_name(kinds_cache, skill_name, team_owner_id, &team_namespace).await?
            {
                skill_refs.insert(skill_name.clone(), SkillRefMeta::from_kind(&skill));
            }
        }
        let ghost_preload = spec
            .and_then(|spec| spec.preload_skills.as_ref())
            .map(|names| {
                names
                    .iter()
                    .filter_map(|name| name.clone())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        let ghost_preload_refs = spec.and_then(|spec| spec.preload_skill_refs.as_ref());
        for skill_name in &ghost_preload {
            preload_skills.insert(skill_name.clone());
            if let Some(preload_ref) = ghost_preload_refs.and_then(|refs| refs.get(skill_name)) {
                let mut resolved = ref_meta_from_crd(preload_ref.as_ref());
                if resolved.content_hash.is_none() {
                    resolved.content_hash = skill_refs
                        .get(skill_name)
                        .and_then(|meta| meta.content_hash.clone());
                }
                preload_skill_refs.insert(skill_name.clone(), resolved);
            } else if let Some(meta) = skill_refs.get(skill_name) {
                preload_skill_refs.insert(skill_name.clone(), meta.clone());
            }
        }
    }

    // Subscription skillRefs (`_get_subscription_skill_refs_for_task`).
    let subscription_refs = subscription_skill_refs(mysql, task.task_id).await?;
    for requested in subscription_refs {
        skills.insert(requested.name.clone());
        preload_skills.insert(requested.name.clone());
        if let Some(row) = find_skill_by_ref(
            mysql,
            &requested.name,
            &requested.namespace,
            requested.is_public,
            team_owner_id,
        )
        .await?
        {
            let meta = SkillRefMeta::from_kind(&row);
            skill_refs.insert(requested.name.clone(), meta.clone());
            preload_skill_refs.insert(requested.name, meta);
        }
    }

    // User default skill bindings (`_merge_user_default_skill_refs`), with
    // the task-derived binding context (mode/agent/project/group). The group
    // namespace is the resolved team's namespace when it is not `default`.
    merge_user_default_skill_refs(
        kinds_cache,
        user_id,
        Some(team_id),
        task.project_id,
        (team_namespace != "default").then_some(team_namespace.as_str()),
        task,
        &mut skills,
        &mut skill_refs,
        &mut preload_skills,
        &mut preload_skill_refs,
    )
    .await?;

    // Requested task refs (labels) or legacy additional skills.
    let requested_refs = parse_requested_skill_refs_from_labels(task.labels.as_ref());
    let user_selected = parse_additional_skill_names_from_labels(task.labels.as_ref());
    if !requested_refs.is_empty() {
        for requested in requested_refs {
            skills.insert(requested.name.clone());
            preload_skills.insert(requested.name.clone());
            if let Some(row) = find_skill_by_ref(
                mysql,
                &requested.name,
                &requested.namespace,
                requested.is_public,
                team_owner_id,
            )
            .await?
            {
                let meta = SkillRefMeta::from_kind(&row);
                skill_refs.insert(requested.name.clone(), meta.clone());
                preload_skill_refs.insert(requested.name, meta);
            }
        }
    } else if !user_selected.is_empty() {
        for name in &user_selected {
            skills.insert(name.clone());
            preload_skills.insert(name.clone());
        }
        for (name, meta) in
            resolve_skill_refs_by_names(mysql, &user_selected, team_owner_id, &team_namespace)
                .await?
        {
            skill_refs.insert(name.clone(), meta.clone());
            preload_skill_refs.insert(name, meta);
        }
    }

    // Provider skills from persisted knowledge providers.
    merge_provider_skill_refs(
        mysql,
        task,
        team_owner_id,
        &team_namespace,
        &mut skills,
        &mut skill_refs,
        &mut preload_skills,
        &mut preload_skill_refs,
    )
    .await?;

    // Preload fallback: preloaded skills inherit their resolved ref.
    let preload_names: Vec<String> = preload_skills.iter().cloned().collect();
    for name in preload_names {
        if !preload_skill_refs.contains_key(&name)
            && let Some(meta) = skill_refs.get(&name)
        {
            preload_skill_refs.insert(name, meta.clone());
        }
    }

    let _ = raw_kinds;
    Ok(finish(TaskSkills {
        task_id: task.task_id,
        team_id: Some(team_id),
        team_namespace,
        skills: skills.into_iter().collect(),
        preload_skills: preload_skills.into_iter().collect(),
        skill_refs,
        preload_skill_refs,
    }))
}

/// Collect the sorted name lists (`skills` and `preload_skills` are
/// `sorted(...)` in source).
fn finish(mut resolved: TaskSkills) -> TaskSkills {
    resolved.skills.sort();
    resolved.preload_skills.sort();
    resolved
}

/// A ghost/preload CRD `skill_refs` entry (`SkillRefMeta.model_dump()`).
fn ref_meta_from_crd(value: Option<&SkillRefMetaInput>) -> SkillRefMeta {
    SkillRefMeta {
        skill_id: value.and_then(|value| value.skill_id).unwrap_or_default(),
        namespace: value
            .and_then(|value| value.namespace.as_deref())
            .unwrap_or("default")
            .to_string(),
        is_public: value.and_then(|value| value.is_public).unwrap_or(false),
        content_hash: value
            .and_then(|value| value.content_hash.as_deref())
            .map(str::to_string),
    }
}

/// `skill_resolution.find_skill_by_name`: personal -> group (team ns) ->
/// group-bound ids -> user-default bindings -> public. The source queries the
/// `kinds` table directly with `db.query(Kind)` at every step (no
/// reader), so the target issues the same direct SQL.
async fn find_skill_by_name<M: Mysql, R: brz_redis::Redis>(
    kinds: &KindCacheStore<'_, M, R>,
    skill_name: &str,
    owner_user_id: i64,
    team_namespace: &str,
) -> Result<Option<repo::KindRow>, brz_mysql::MysqlError> {
    let mysql = kinds.mysql;
    if let Some(skill) =
        repo::kinds_personal(mysql, owner_user_id, "Skill", "default", skill_name).await?
    {
        return Ok(Some(skill));
    }
    if team_namespace != "default" {
        if let Some(skill) = repo::kinds_group(mysql, "Skill", team_namespace, skill_name).await? {
            return Ok(Some(skill));
        }
        // `list_group_skill_ids(team_namespace, owner_user_id)`: the group
        // bindings the owner may use, gated on the Reporter group role.
        let bound_ids = kinds
            .list_group_skill_ids(team_namespace, owner_user_id)
            .await?;
        if !bound_ids.is_empty()
            && let Some(skill) = repo::skill_by_bound_ids(mysql, &bound_ids, skill_name).await?
        {
            return Ok(Some(skill));
        }
    }
    let default_ids = list_user_default_skill_ids(mysql, owner_user_id).await?;
    if !default_ids.is_empty()
        && let Some(skill) = repo::skill_by_bound_ids(mysql, &default_ids, skill_name).await?
    {
        return Ok(Some(skill));
    }
    repo::kinds_public(mysql, "Skill", "default", skill_name).await
}

/// `skill_resolution.find_skill_by_ref` (no `skill_id`): public -> personal
/// -> group namespace -> team namespace -> personal default. Like
/// `find_skill_by_name`, every step queries `kinds` directly.
async fn find_skill_by_ref<M: Mysql>(
    mysql: &M,
    skill_name: &str,
    namespace: &str,
    is_public: bool,
    team_owner_id: i64,
) -> Result<Option<repo::KindRow>, brz_mysql::MysqlError> {
    if is_public {
        return repo::kinds_public(mysql, "Skill", "default", skill_name).await;
    }
    if let Some(skill) =
        repo::kinds_personal(mysql, team_owner_id, "Skill", namespace, skill_name).await?
    {
        return Ok(Some(skill));
    }
    if namespace != "default"
        && let Some(skill) = repo::kinds_group(mysql, "Skill", namespace, skill_name).await?
    {
        return Ok(Some(skill));
    }
    let _ = team_owner_id;
    Ok(None)
}

/// `skill_binding_service.list_user_default_bindings`: the user's active
/// `SkillBinding` rows whose bound Skill is active and accessible. Each
/// binding is checked in database order (`created_at DESC`), which is also
/// the order the callers iterate.
async fn list_accessible_bindings<M: Mysql>(
    mysql: &M,
    user_id: i64,
) -> Result<Vec<repo::KindRow>, brz_mysql::MysqlError> {
    let bindings = repo::user_default_bindings(mysql, user_id).await?;
    let target_id = format!("user:{user_id}");
    let mut accessible = Vec::new();
    for binding in bindings {
        if !is_user_default_binding(&binding.kinds_json.0, &target_id) {
            continue;
        }
        let Some(skill_id) = extract_skill_id(&binding.kinds_json.0) else {
            continue;
        };
        let Some(skill) = repo::active_skill_by_id(mysql, skill_id).await? else {
            continue;
        };
        if !can_user_access_skill(&skill, user_id) {
            continue;
        }
        accessible.push(binding);
    }
    Ok(accessible)
}

/// `skill_binding_service.can_user_access_skill`: the bound Skill is
/// accessible when it is the user's own or public (`user_id = 0`), or when
/// its CRD marks it as a published public capability. The source also
/// admits a non-default-namespace Skill through the requester's group
/// Reporter role; every recorded default-namespace binding belongs to the
/// requesting user, so that branch has no recorded traffic.
fn can_user_access_skill(skill: &repo::KindRow, user_id: i64) -> bool {
    skill.kinds_user_id == 0
        || skill.kinds_user_id == user_id
        || CrdDocument::project_opaque(&skill.kinds_json.0).is_published_public()
}

/// `skill_binding_service.list_user_default_skill_ids`: the accessible
/// user-default bindings' skill ids, in binding order.
async fn list_user_default_skill_ids<M: Mysql>(
    mysql: &M,
    user_id: i64,
) -> Result<Vec<i64>, brz_mysql::MysqlError> {
    let mut ids = Vec::new();
    for binding in list_accessible_bindings(mysql, user_id).await? {
        if let Some(skill_id) = extract_skill_id(&binding.kinds_json.0) {
            ids.push(skill_id);
        }
    }
    Ok(ids)
}

/// `_merge_user_default_skill_refs`: `list_user_default_skill_refs` merges
/// the user's automatic bindings (plus the group bindings of a group-namespace
/// context), skipping context-excluded bindings.
#[allow(clippy::too_many_arguments)]
async fn merge_user_default_skill_refs<M: Mysql, R: brz_redis::Redis>(
    kinds: &KindCacheStore<'_, M, R>,
    user_id: i64,
    agent_id: Option<i64>,
    project_id: Option<i64>,
    group_namespace: Option<&str>,
    task: &TaskContext,
    skills: &mut HashSet<String>,
    skill_refs: &mut HashMap<String, SkillRefMeta>,
    preload_skills: &mut HashSet<String>,
    preload_skill_refs: &mut HashMap<String, SkillRefMeta>,
) -> Result<(), brz_mysql::MysqlError> {
    let mysql = kinds.mysql;
    let mode = task_mode(task.labels.as_ref());
    // `list_user_default_skill_refs` calls `list_user_default_bindings`
    // first, whose per-binding access check resolves each bound Skill with
    // `_get_active_skill`; the ref loop then resolves every accessible
    // binding's Skill a second time. Both runs issue `kinds.id = ? AND kind
    // = 'Skill' AND is_active = true LIMIT 1` per accessible binding, so the
    // target issues the same two passes over the same accessible list.
    let mut bindings = list_accessible_bindings(mysql, user_id).await?;
    // The group bindings of the context's group namespace follow the user's
    // default bindings (`list_group_bindings`), gated on the Reporter role.
    if let Some(group_namespace) = group_namespace {
        bindings.extend(
            kinds
                .list_group_bindings(group_namespace, user_id)
                .await?
                .into_iter()
                .filter(|binding| {
                    is_group_binding(&binding.kinds_json.0, group_namespace)
                        && extract_skill_id(&binding.kinds_json.0).is_some()
                }),
        );
    }
    let mut seen_skill_ids: HashSet<i64> = HashSet::new();
    for binding in &bindings {
        let Some(skill_id) = extract_skill_id(&binding.kinds_json.0) else {
            continue;
        };
        if !seen_skill_ids.insert(skill_id) {
            continue;
        }
        if is_excluded_by_context(&binding.kinds_json.0, &mode, agent_id, project_id) {
            continue;
        }
        let Some(skill) = repo::active_skill_by_id(mysql, skill_id).await? else {
            continue;
        };
        let skill_name = skill.kinds_name.clone();
        // `_merge_user_default_skill_refs` writes only skill_id/namespace/
        // is_public into the ref dict; the response model's `content_hash`
        // default then renders null even when the bound Skill row carries a
        // `status.fileHash` (unlike the ghost-loop refs, which resolve the
        // hash explicitly).
        let mut meta = SkillRefMeta::from_kind(&skill);
        meta.content_hash = None;
        let binding_crd = CrdDocument::project_opaque(&binding.kinds_json.0);
        let force_preload = binding_crd.spec.as_ref().is_some_and(|spec| {
            if spec.force_preload.is_some() {
                spec.force_preload.unwrap_or(false)
            } else {
                spec.legacy_force_preload.unwrap_or(false)
            }
        });
        skills.insert(skill_name.clone());
        skill_refs
            .entry(skill_name.clone())
            .or_insert_with(|| meta.clone());
        if force_preload {
            preload_skills.insert(skill_name.clone());
            preload_skill_refs.insert(skill_name, meta);
        }
    }
    Ok(())
}

/// `_merge_provider_skill_refs`: `PROVIDER_SKILLS` (wegent ->
/// wegent-knowledge, dingtalk -> dingtalk-docs) for the task's persisted
/// external knowledge providers, resolved as public skills.
#[allow(clippy::too_many_arguments)]
async fn merge_provider_skill_refs<M: Mysql>(
    mysql: &M,
    task: &TaskContext,
    team_owner_id: i64,
    team_namespace: &str,
    skills: &mut HashSet<String>,
    skill_refs: &mut HashMap<String, SkillRefMeta>,
    preload_skills: &mut HashSet<String>,
    preload_skill_refs: &mut HashMap<String, SkillRefMeta>,
) -> Result<(), brz_mysql::MysqlError> {
    let mut providers: Vec<&str> = task
        .external_knowledge_providers
        .iter()
        .map(String::as_str)
        .collect();
    providers.sort_unstable();
    providers.dedup();
    for provider_id in providers {
        let Some(skill_name) = provider_skill_name(provider_id) else {
            continue;
        };
        let Some(skill) =
            find_skill_by_ref(mysql, skill_name, "default", true, team_owner_id).await?
        else {
            continue;
        };
        let meta = SkillRefMeta::from_kind(&skill);
        skills.insert(skill_name.to_string());
        preload_skills.insert(skill_name.to_string());
        skill_refs.insert(skill_name.to_string(), meta.clone());
        preload_skill_refs.insert(skill_name.to_string(), meta);
    }
    let _ = team_namespace;
    Ok(())
}

/// `get_provider_skill_name` (`PROVIDER_SKILLS`).
fn provider_skill_name(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "wegent" => Some("wegent-knowledge"),
        "dingtalk" => Some("dingtalk-docs"),
        _ => None,
    }
}

/// `resolve_skill_refs_by_names` (the legacy additional-skills path). Like
/// the other skill_resolution helpers, the source queries `kinds` directly
/// at every step.
async fn resolve_skill_refs_by_names<M: Mysql>(
    mysql: &M,
    skill_names: &[String],
    user_id: i64,
    namespace: &str,
) -> Result<Vec<(String, SkillRefMeta)>, brz_mysql::MysqlError> {
    if skill_names.is_empty() {
        return Ok(Vec::new());
    }
    let mut resolved: Vec<(String, SkillRefMeta)> = Vec::new();
    let mut remaining: Vec<String> = Vec::new();
    for name in skill_names {
        if !remaining.contains(name) {
            remaining.push(name.clone());
        }
    }
    // Personal skills (one query per name, matching the ORM loop shape).
    for name in &remaining {
        if let Some(skill) = repo::kinds_personal(mysql, user_id, "Skill", "default", name).await? {
            resolved.push((name.clone(), SkillRefMeta::from_kind(&skill)));
        }
    }
    remaining.retain(|name| {
        !resolved
            .iter()
            .any(|(resolved_name, _)| resolved_name == name)
    });
    if remaining.is_empty() {
        return Ok(resolved);
    }
    // Group skills, then bound skills, then public (direct kinds queries).
    if namespace != "default" {
        for name in &remaining {
            if let Some(skill) = repo::kinds_group(mysql, "Skill", namespace, name).await? {
                resolved.push((name.clone(), SkillRefMeta::from_kind(&skill)));
            }
        }
        remaining.retain(|name| {
            !resolved
                .iter()
                .any(|(resolved_name, _)| resolved_name == name)
        });
    }
    if !remaining.is_empty() {
        let default_ids = list_user_default_skill_ids(mysql, user_id).await?;
        if !default_ids.is_empty() {
            for name in &remaining {
                if let Some(skill) = repo::skill_by_bound_ids(mysql, &default_ids, name).await? {
                    resolved.push((name.clone(), SkillRefMeta::from_kind(&skill)));
                }
            }
            remaining.retain(|name| {
                !resolved
                    .iter()
                    .any(|(resolved_name, _)| resolved_name == name)
            });
        }
    }
    for name in &remaining {
        if let Some(skill) = repo::kinds_public(mysql, "Skill", "default", name).await? {
            resolved.push((name.clone(), SkillRefMeta::from_kind(&skill)));
        }
    }
    Ok(resolved)
}

/// `_get_subscription_skill_refs_for_task`.
async fn subscription_skill_refs<M: Mysql>(
    mysql: &M,
    task_id: i64,
) -> Result<Vec<RequestedSkillRef>, brz_mysql::MysqlError> {
    let Some(execution) = repo::latest_background_execution(mysql, task_id).await? else {
        return Ok(Vec::new());
    };
    if execution.background_executions_subscription_id == 0 {
        return Ok(Vec::new());
    }
    let Some(subscription) =
        repo::subscription_by_id(mysql, execution.background_executions_subscription_id).await?
    else {
        return Ok(Vec::new());
    };
    let crd = CrdDocument::project_opaque(&subscription.kinds_json.0);
    Ok(crd
        .spec
        .as_ref()
        .and_then(|spec| spec.subscription_skill_refs.as_ref())
        .map(|refs| {
            refs.iter()
                .filter_map(|reference| reference.as_ref())
                .filter_map(|reference| {
                    (!reference.name().is_empty()).then_some(RequestedSkillRef {
                        // `spec.skillRefs` holds `SubscriptionSkillRef`
                        // documents (`app/schemas/subscription.py:199-206`),
                        // which carry name, namespace and is_public only. The
                        // skills response renders `SkillRefMeta` values and
                        // never this type, so no id is projected here.
                        skill_id: None,
                        name: reference.name().to_owned(),
                        namespace: if reference.namespace().is_empty() {
                            "default".to_owned()
                        } else {
                            reference.namespace().to_owned()
                        },
                        is_public: reference.is_public.unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// `_extract_skill_id`: `spec.skillRef.skillId` (or `skill_id`).
fn extract_skill_id(binding_json: &OpaqueJson) -> Option<i64> {
    let crd = CrdDocument::project_opaque(binding_json);
    let reference = crd.spec?.skill_ref?;
    let id = if reference.skill_id.is_some() {
        reference.skill_id
    } else {
        reference.legacy_skill_id
    };
    id?.integer_or_truncated_float()
}

/// `_is_user_default_binding`: `spec.targetType == "user"` and
/// `spec.targetId == "user:{user_id}"`.
fn is_user_default_binding(binding_json: &OpaqueJson, target_id: &str) -> bool {
    CrdDocument::project_opaque(binding_json).matches_target("user", target_id)
}

/// `_is_group_binding`: `spec.targetType == "group"` and
/// `spec.targetId == group_namespace`.
fn is_group_binding(binding_json: &OpaqueJson, group_namespace: &str) -> bool {
    CrdDocument::project_opaque(binding_json).matches_target("group", group_namespace)
}

/// `_is_excluded_by_context`: any binding exception matching the derived
/// mode, agent, or project context.
fn is_excluded_by_context(
    binding_json: &OpaqueJson,
    mode: &str,
    agent_id: Option<i64>,
    project_id: Option<i64>,
) -> bool {
    let crd = CrdDocument::project_opaque(binding_json);
    let Some(exceptions) = crd.spec.as_ref().and_then(|spec| spec.exceptions.as_ref()) else {
        return false;
    };
    for exception in exceptions {
        let exception_type = exception
            .as_ref()
            .and_then(|exception| exception.kind.as_deref());
        let value = exception
            .as_ref()
            .and_then(|exception| exception.value.as_deref());
        let (Some(exception_type), Some(value)) = (exception_type, value) else {
            continue;
        };
        let matches = match exception_type {
            "mode" => value == mode,
            "agent" => agent_id.is_some_and(|id| value == id.to_string()),
            "project" => project_id.is_some_and(|id| value == id.to_string()),
            _ => false,
        };
        if matches {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill_row(user_id: i64, spec: serde_json::Value) -> repo::KindRow {
        repo::KindRow {
            kinds_id: 274676,
            kinds_user_id: user_id,
            kinds_kind: "Skill".to_string(),
            kinds_name: "chaoneng-xiadanya-suicai-analysis".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: brz_mysql::Json(OpaqueJson::from_serializable(spec)),
            kinds_is_active: 1,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn group_bindings_match_their_namespace_target() {
        let binding = OpaqueJson::from_serializable(serde_json::json!({
            "kind": "SkillBinding",
            "spec": {"targetType": "group", "targetId": "example/example_community"}
        }));
        assert!(is_group_binding(&binding, "example/example_community"));
        assert!(!is_group_binding(&binding, "default"));
        assert!(!is_user_default_binding(&binding, "user:6013"));
    }

    #[test]
    fn accessibility_admits_own_and_public_skills() {
        let own = skill_row(4751, serde_json::json!({"kind": "Skill", "spec": {}}));
        assert!(can_user_access_skill(&own, 4751));
        let public = skill_row(0, serde_json::json!({"kind": "Skill", "spec": {}}));
        assert!(can_user_access_skill(&public, 4751));
    }

    #[test]
    fn accessibility_requires_a_published_public_capability_for_foreign_skills() {
        let foreign = skill_row(999, serde_json::json!({"kind": "Skill", "spec": {}}));
        assert!(!can_user_access_skill(&foreign, 4751));
        let published = skill_row(
            999,
            serde_json::json!({"kind": "Skill", "spec": {"capability": {
                "visibility": "public", "publishStatus": "published"}}}),
        );
        assert!(can_user_access_skill(&published, 4751));
    }
}
