// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/ghost_capabilities.py`: merge one-level Ghost capability
//! inheritance (`_get_bot_ghost_chain` -> `load_ghost_chain` ->
//! `merge_ghost_capabilities`).
//!
//! A Bot's Ghost may name a base Ghost (`spec.baseGhostRef`). The chain is the
//! base Ghost first and the bot's own Ghost last; same-name values from the
//! later Ghost win. The merged `mcp_servers` / `skills` / `skill_refs` /
//! `plugins` feed `_build_bot_config`'s `metadata.bot` entry.
use brz_mysql::{Mysql, MysqlResult};
use serde_json::{Map, Value};

use super::resolution::{KIND_COLUMNS, KindRow};

/// `load_ghost_chain`'s failure modes.
#[derive(Debug)]
pub enum GhostChainError {
    /// `Ghost cannot inherit from itself`.
    SelfInheritance,
    /// `Base Ghost '<ns>/<name>' is unavailable`.
    BaseUnavailable(String),
    /// `Nested base Ghost inheritance is not supported`.
    NestedBase,
    /// A Ghost read failed.
    Dependency(brz_mysql::MysqlError),
}

impl std::fmt::Display for GhostChainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SelfInheritance => write!(f, "Ghost cannot inherit from itself"),
            Self::BaseUnavailable(reference) => {
                write!(f, "Base Ghost '{reference}' is unavailable")
            }
            Self::NestedBase => {
                write!(f, "Nested base Ghost inheritance is not supported")
            }
            Self::Dependency(error) => write!(f, "base ghost dependency failure: {error}"),
        }
    }
}

impl std::error::Error for GhostChainError {}

/// `kindReader.get_by_name_and_namespace(GHOST)`: the group Ghost for a
/// non-default namespace, else the owner's personal Ghost then the public one,
/// through the deployment's cached-reader contract (`kind:v2` documents first,
/// SQL only on a miss).
async fn read_ghost<M: Mysql, R: brz_redis::Redis>(
    cache: &crate::task_skills::kinds::KindCacheStore<'_, M, R>,
    owner_user_id: i64,
    namespace: &str,
    name: &str,
) -> MysqlResult<Option<KindRow>> {
    cache
        .get_by_name_and_namespace_row(owner_user_id, "Ghost", namespace, name)
        .await
        .map(|ghost| ghost.map(super::resolution::kinds_row))
}

/// The `spec` of a Ghost row.
fn spec_of(row: &KindRow) -> Value {
    row.json
        .0
        .get("spec")
        .cloned()
        .unwrap_or(Value::Object(Map::new()))
}

/// `load_ghost_chain`: the base Ghost first (when the custom Ghost names one)
/// and the custom Ghost last.
///
/// Rejects a self-referential `baseGhostRef`, an unavailable base Ghost, and a
/// base Ghost that itself declares a `baseGhostRef` (nested inheritance).
pub async fn load_ghost_chain<M: Mysql, R: brz_redis::Redis>(
    cache: &crate::task_skills::kinds::KindCacheStore<'_, M, R>,
    owner_user_id: i64,
    namespace: &str,
    name: &str,
) -> Result<Vec<GhostNode>, GhostChainError> {
    let Some(ghost) = read_ghost(cache, owner_user_id, namespace, name)
        .await
        .map_err(GhostChainError::Dependency)?
    else {
        return Ok(Vec::new());
    };
    let ghost_spec = spec_of(&ghost);
    let mut chain = Vec::new();

    if let Some(base_ref) = ghost_spec
        .get("baseGhostRef")
        .filter(|value| !value.is_null())
    {
        let base_user = base_ref.get("user_id").and_then(Value::as_i64).unwrap_or(0);
        let base_namespace = base_ref
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("default");
        let base_name = base_ref.get("name").and_then(Value::as_str).unwrap_or("");
        if base_user == owner_user_id && base_namespace == namespace && base_name == name {
            return Err(GhostChainError::SelfInheritance);
        }
        let Some(base) = read_ghost(cache, base_user, base_namespace, base_name)
            .await
            .map_err(GhostChainError::Dependency)?
        else {
            return Err(GhostChainError::BaseUnavailable(format!(
                "{base_namespace}/{base_name}"
            )));
        };
        let base_spec = spec_of(&base);
        if base_spec
            .get("baseGhostRef")
            .is_some_and(|value| !value.is_null())
        {
            return Err(GhostChainError::NestedBase);
        }
        chain.push(GhostNode {
            namespace: base.namespace.clone(),
            spec: base_spec,
        });
    }

    chain.push(GhostNode {
        namespace: ghost.namespace.clone(),
        spec: ghost_spec,
    });
    Ok(chain)
}

/// `get_bot_system_prompt` (via `_build_runtime_system_prompt`): the Ghost's
/// `spec.systemPrompt`, with the team member prompt appended, wrapped in
/// `<base_prompt>` tags. A missing Ghost yields an empty prompt.
///
/// The source reads this Ghost with a plain `db.query` filter
/// (`model_resolver.get_bot_system_prompt`), not the cached reader, so this
/// keeps the direct SQL statement.
pub async fn bot_system_prompt<M: Mysql>(
    mysql: &M,
    user_id: i64,
    namespace: &str,
    name: &str,
    team_member_prompt: Option<&str>,
) -> Result<String, GhostChainError> {
    let ghost = mysql
        .fetch_optional::<_, _, KindRow>(
            bot_system_prompt_ghost_statement(),
            (user_id, name, namespace),
        )
        .await
        .map_err(GhostChainError::Dependency)?;
    let system_prompt = ghost
        .as_ref()
        .and_then(|row| {
            spec_of(row)
                .get("systemPrompt")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    Ok(super::model_config::wrap_base_prompt(
        &system_prompt,
        team_member_prompt,
    ))
}

/// `get_bot_system_prompt`'s Ghost read: the plain ORM filter
/// `user_id == user_id AND kind == 'Ghost' AND name == ... AND namespace == ...`
/// (`app/services/chat/config/model_resolver.py`).
fn bot_system_prompt_ghost_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Ghost' AND kinds.name = ? AND kinds.namespace = ? \
         AND kinds.is_active = true \n LIMIT 1"
    )
}

/// One Ghost in the chain: its `namespace` and its parsed `spec`.
pub struct GhostNode {
    pub namespace: String,
    pub spec: Value,
}

/// `MergedGhostCapabilities`.
#[derive(Debug, Default)]
pub struct MergedGhostCapabilities {
    /// `mcpServers` keyed by server name; later Ghosts override same names.
    pub mcp_servers: Map<String, Value>,
    /// `skills` in first-seen order, deduplicated.
    pub skills: Vec<String>,
    /// `skill_refs` keyed by skill name.
    pub skill_refs: Map<String, Value>,
    /// Each skill's owning Ghost namespace.
    pub skill_namespaces: Map<String, Value>,
    /// `preload_skills` in first-seen order, deduplicated.
    pub preload_skills: Vec<String>,
    /// `preload_skill_refs` keyed by skill name.
    pub preload_skill_refs: Map<String, Value>,
    /// `plugins`, deduplicated by merge key, in insertion order.
    pub plugins: Vec<Value>,
}

/// `merge_ghost_capabilities`: base Ghost first, custom Ghost last.
pub fn merge_ghost_capabilities(chain: &[GhostNode]) -> MergedGhostCapabilities {
    let mut merged = MergedGhostCapabilities::default();
    let mut seen_skills: Vec<String> = Vec::new();
    let mut seen_preload: Vec<String> = Vec::new();
    let mut plugins_by_key: Map<String, Value> = Map::new();

    for node in chain {
        if let Some(servers) = node.spec.get("mcpServers").and_then(Value::as_object) {
            for (name, config) in servers {
                merged.mcp_servers.insert(name.clone(), config.clone());
            }
        }
        if let Some(skills) = node.spec.get("skills").and_then(Value::as_array) {
            for skill in skills.iter().filter_map(Value::as_str) {
                if !seen_skills.iter().any(|seen| seen == skill) {
                    seen_skills.push(skill.to_string());
                    merged.skills.push(skill.to_string());
                }
                merged
                    .skill_namespaces
                    .insert(skill.to_string(), Value::String(node.namespace.clone()));
            }
        }
        if let Some(refs) = node.spec.get("skill_refs").and_then(Value::as_object) {
            for (name, reference) in refs {
                merged.skill_refs.insert(name.clone(), reference.clone());
            }
        }
        if let Some(preload) = node.spec.get("preload_skills").and_then(Value::as_array) {
            for skill in preload.iter().filter_map(Value::as_str) {
                if !seen_preload.iter().any(|seen| seen == skill) {
                    seen_preload.push(skill.to_string());
                    merged.preload_skills.push(skill.to_string());
                }
            }
        }
        if let Some(refs) = node
            .spec
            .get("preload_skill_refs")
            .and_then(Value::as_object)
        {
            for (name, reference) in refs {
                merged
                    .preload_skill_refs
                    .insert(name.clone(), reference.clone());
            }
        }
        if let Some(plugins) = node.spec.get("plugins").and_then(Value::as_array) {
            for plugin in plugins {
                plugins_by_key.insert(plugin_merge_key(plugin), plugin.clone());
            }
        }
    }

    merged.plugins = plugins_by_key.into_values().collect();
    merged
}

/// `_plugin_merge_key`:
/// `id:<id>`, else `name:<marketplace>:<pluginName>`, else `config:<json>`.
pub fn plugin_merge_key(plugin: &Value) -> String {
    if let Some(id) = plugin.get("id") {
        let text = match id {
            Value::String(text) => text.trim().to_string(),
            Value::Number(number) => number.to_string(),
            _ => String::new(),
        };
        if !text.is_empty() {
            return format!("id:{text}");
        }
    }
    let plugin_name = plugin
        .get("pluginName")
        .or_else(|| plugin.get("name"))
        .and_then(Value::as_str);
    if let Some(plugin_name) = plugin_name {
        let marketplace = plugin
            .get("marketplaceId")
            .or_else(|| plugin.get("marketplace"))
            .and_then(Value::as_str)
            .unwrap_or("");
        return format!("name:{marketplace}:{plugin_name}");
    }
    format!("config:{}", canonical_json(plugin))
}

/// Python `json.dumps(plugin, sort_keys=True)`.
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let entries: Vec<String> = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}: {}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&map[*key])
                    )
                })
                .collect();
            format!("{{{}}}", entries.join(", "))
        }
        Value::Array(items) => {
            let entries: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", entries.join(", "))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Apply the merged Ghost capabilities to the request's skill fields
/// (`skill_names`, `skill_refs`, `preload_skills`, `preload_skill_refs`);
/// `user_selected_skills` is the caller's explicit selection.
pub fn apply_ghost_skills(
    request: &mut super::dispatch::ExecutionRequest,
    merged: &MergedGhostCapabilities,
    user_selected_skills: Vec<Value>,
) {
    request.skill_names = merged
        .skills
        .iter()
        .map(|skill| Value::String(skill.clone()))
        .collect();
    request.skill_refs = Value::Object(merged.skill_refs.clone());
    request.preload_skills = merged
        .preload_skills
        .iter()
        .map(|skill| Value::String(skill.clone()))
        .collect();
    request.preload_skill_refs = Value::Object(merged.preload_skill_refs.clone());
    request.user_selected_skills = user_selected_skills;
}

/// The Team CRD's `spec.collaborationModel` (default `solo`).
pub fn collaboration_model(team_json: &Value) -> String {
    team_json
        .get("spec")
        .and_then(|spec| spec.get("collaborationModel"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("solo")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(namespace: &str, spec: Value) -> GhostNode {
        GhostNode {
            namespace: namespace.to_string(),
            spec,
        }
    }

    #[test]
    fn custom_ghost_overrides_and_dedupes() {
        let chain = vec![
            node(
                "default",
                json!({
                    "mcpServers": {"srv": {"url": "base"}, "base-only": {"url": "b"}},
                    "skills": ["wegent-knowledge", "base-skill"],
                    "skill_refs": {"wegent-knowledge": {"skill_id": 1}},
                    "plugins": [{"id": "p1"}],
                }),
            ),
            node(
                "ns-a",
                json!({
                    "mcpServers": {"srv": {"url": "custom"}},
                    "skills": ["wegent-knowledge", "subscription-manager"],
                    "skill_refs": {"wegent-knowledge": {"skill_id": 128913}},
                    "plugins": [{"id": "p1"}, {"id": "p2"}],
                }),
            ),
        ];
        let merged = merge_ghost_capabilities(&chain);
        // Same-name mcp server overridden, base-only kept.
        assert_eq!(merged.mcp_servers["srv"], json!({"url": "custom"}));
        assert_eq!(merged.mcp_servers["base-only"], json!({"url": "b"}));
        // Skills deduped in first-seen order; the custom ref wins.
        assert_eq!(
            merged.skills,
            vec![
                "wegent-knowledge".to_string(),
                "base-skill".to_string(),
                "subscription-manager".to_string(),
            ]
        );
        assert_eq!(
            merged.skill_namespaces["subscription-manager"],
            json!("ns-a")
        );
        assert_eq!(merged.skill_namespaces["base-skill"], json!("default"));
        assert_eq!(
            merged.skill_refs["wegent-knowledge"],
            json!({"skill_id": 128913})
        );
        // Plugins deduped by id.
        assert_eq!(
            merged.plugins,
            vec![json!({"id": "p1"}), json!({"id": "p2"})]
        );
    }

    #[test]
    fn ghost_skills_flow_into_the_request() {
        let merged = merge_ghost_capabilities(&[node(
            "ns-a",
            json!({
                "skills": ["wegent-knowledge", "subscription-manager"],
                "skill_refs": {"wegent-knowledge": {"skill_id": 128913}},
                "preload_skills": ["wegent-knowledge"],
            }),
        )]);
        let mut request = crate::responses::create::dispatch::ExecutionRequest::default();
        apply_ghost_skills(&mut request, &merged, vec![json!("wegent-knowledge")]);
        assert_eq!(
            request.skill_names,
            vec![json!("wegent-knowledge"), json!("subscription-manager")]
        );
        assert_eq!(
            request.skill_refs,
            json!({"wegent-knowledge": {"skill_id": 128913}})
        );
        assert_eq!(request.preload_skills, vec![json!("wegent-knowledge")]);
        assert_eq!(request.preload_skill_refs, json!({}));
        assert_eq!(
            request.user_selected_skills,
            vec![json!("wegent-knowledge")]
        );
    }

    #[test]
    fn collaboration_model_defaults_to_solo() {
        assert_eq!(
            collaboration_model(&json!({"spec": {"collaborationModel": "pipeline"}})),
            "pipeline"
        );
        assert_eq!(collaboration_model(&json!({"spec": {}})), "solo");
    }

    #[tokio::test]
    async fn bot_system_prompt_is_empty_without_a_ghost() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let prompt = bot_system_prompt(&mysql, 5831, "ns-a", "ghost", None)
            .await
            .expect("prompt");
        // The capture fake returns no Ghost row.
        assert_eq!(prompt, "");
        assert_eq!(mysql.queries().len(), 1);
        assert!(mysql.queries()[0].sql.contains("kinds.kind = 'Ghost'"));
    }

    #[test]
    fn bot_system_prompt_read_matches_the_recorded_statement() {
        let normalize = |sql: &str| sql.split_whitespace().collect::<Vec<_>>().join(" ");
        // Query shape: WHERE kinds.user_id = ? AND kinds.kind = 'Ghost' AND
        // kinds.name = ? AND kinds.namespace = ? AND
        // kinds.is_active = true LIMIT 1.
        let sql = normalize(&bot_system_prompt_ghost_statement());
        assert!(sql.contains("WHERE kinds.user_id = ?"));
        assert!(sql.contains("AND kinds.kind = 'Ghost'"));
        assert!(sql.contains("AND kinds.name = ? AND kinds.namespace = ?"));
        assert!(sql.contains("AND kinds.is_active = true LIMIT 1"));
    }

    #[test]
    fn plugin_merge_key_prefers_id_then_name_then_config() {
        assert_eq!(plugin_merge_key(&json!({"id": 7})), "id:7");
        assert_eq!(
            plugin_merge_key(&json!({"pluginName": "x", "marketplaceId": "m"})),
            "name:m:x"
        );
        assert_eq!(plugin_merge_key(&json!({"name": "y"})), "name::y");
        assert_eq!(
            plugin_merge_key(&json!({"a": 1, "b": 2})),
            "config:{\"a\": 1, \"b\": 2}"
        );
    }
}
