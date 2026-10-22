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
//! read (`user_id = 0 AND name = 'subscription-manager'`). Both
//! `SkillBinding` reads (the user's default bindings and the group's) return
//! zero rows, so `list_user_default_skill_refs` yields nothing and the
//! `subscription-manager` skill arrives only through
//! `_inject_subscription_manager_skill`.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::Value;

use super::ghost::MergedGhostCapabilities;

/// `SKILL_BINDING_KIND` / `SKILL_BINDING_NAMESPACE`.
const SKILL_BINDING_KIND: &str = "SkillBinding";
const SKILL_BINDING_NAMESPACE: &str = "default";

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

/// `list_user_default_skill_refs` for the create flow: the user's default
/// bindings plus the group's, deduped by skill id, each resolved to an active
/// Skill. The recorded case's two binding reads return zero rows, so this
/// yields nothing.
pub async fn list_user_default_skill_refs<M: Mysql>(
    mysql: &M,
    user_id: i64,
    target_id: &str,
    group_namespace: Option<&str>,
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
        .collect();
    if let Some(group) = group_namespace {
        let group_rows: Vec<SkillKindRow> = mysql
            .fetch_all(group_bindings_statement(), (group.to_string(),))
            .await?;
        candidates.extend(
            group_rows
                .into_iter()
                .filter(|row| is_group_binding(&row.kinds_json.0, group)),
        );
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
pub async fn get_bot_skills<M: Mysql>(
    mysql: &M,
    merged: &MergedGhostCapabilities,
    bot_capability_mode: &str,
    user_id: i64,
    is_subscription: bool,
    user_default_target_id: &str,
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
    for reference in
        list_user_default_skill_refs(mysql, user_id, user_default_target_id, None).await?
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
        let skill: Option<SkillKindRow> = match skill_id {
            Some(skill_id) => {
                mysql
                    .fetch_optional(active_skill_by_id_statement(), (skill_id,))
                    .await?
            }
            None => {
                mysql
                    .fetch_optional(public_skill_statement(), (name.clone(),))
                    .await?
            }
        };
        let Some(skill) = skill else {
            continue;
        };
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
/// spec description/prompt/displayName, and the ids.
fn build_skill_data(skill: &SkillKindRow) -> Value {
    let spec = skill
        .kinds_json
        .0
        .get("spec")
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()));
    let text = |key: &str| {
        spec.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let mut data = serde_json::json!({
        "name": skill.kinds_name,
        "description": text("description"),
        "prompt": text("prompt"),
        "displayName": text("displayName"),
        "skill_id": skill.kinds_id,
        "skill_user_id": skill.kinds_user_id,
    });
    for key in ["config", "runtime", "mcpServers"] {
        if let Some(value) = spec.get(key).filter(|value| !value.is_null()) {
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

    /// The recorded statement carries `kinds.user_id = 6582`, an integer
    /// literal, so the read binds an integer (`kinds.user_id = ?`). A
    /// stringified id never matched the recorded exchange.
    #[tokio::test]
    async fn user_default_binding_read_binds_the_user_id_as_an_integer() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let refs = list_user_default_skill_refs(&mysql, 6582, "user-6582", None)
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
