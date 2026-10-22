// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Per-bot response construction for `GET /api/bots`
//! (`BotKindsService._convert_to_bot_dict`).
//!
//! Reads the persisted `kinds.json` CRDs through typed projections and the
//! shared [`crate::json_compat`] opaque type, keeping the pydantic field
//! order of the source `BotInDB` response model and the source dict order of
//! `agent_config`, `skill_refs`, and the Ghost-derived fields.
use std::collections::HashMap;

use brz_json::{RawJson, to_raw_value};
use chrono::NaiveDateTime;
use serde::Deserialize;
use serde_json::Map;

use crate::json_compat::OptionalOpaqueJsonExt;
use crate::teams::teams_repository::KindRow;
use brz_json::OpaqueJson;

use super::repository::BotRow;

/// One `Bot.spec.<ref>` (`GhostRef` / `ShellRef` / `ModelRef`).
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
pub struct Reference {
    pub name: Option<String>,
    pub namespace: Option<String>,
}

impl Reference {
    /// `Reference.namespace` with the pydantic `"default"` fallback.
    #[must_use]
    pub fn namespace_or_default(&self) -> String {
        self.namespace
            .clone()
            .unwrap_or_else(|| "default".to_string())
    }
}

/// Read projection of one Bot `kinds.json` document.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct BotDocument {
    pub spec: BotSpec,
}

/// The `Bot.spec` fields the list endpoint reads.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct BotSpec {
    #[serde(rename = "ghostRef")]
    pub ghost_ref: Option<Reference>,
    #[serde(rename = "shellRef")]
    pub shell_ref: Option<Reference>,
    #[serde(rename = "modelRef")]
    pub model_ref: Option<Reference>,
    pub capability_mode: Option<String>,
    #[serde(rename = "secondaryModelRef")]
    pub secondary_model_ref: Option<Reference>,
    pub execution_policy: Option<ExecutionPolicy>,
    pub model_policy: Option<ModelPolicy>,
}

/// `ExecutionPolicy` (`app/schemas/runner_routing.py`); the serialized field
/// order matches the pydantic declaration order.
#[derive(Debug, Default, Clone, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct ExecutionPolicy {
    pub mode: Option<String>,
    pub environment_id: Option<String>,
}

/// `ModelPolicy` (`app/schemas/runner_routing.py`).
#[derive(Debug, Default, Clone, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct ModelPolicy {
    pub mode: Option<String>,
    pub model: Option<ModelIdentity>,
}

/// `ModelIdentity` (`app/schemas/runner_routing.py`).
#[derive(Debug, Default, Clone, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct ModelIdentity {
    pub runtime: Option<String>,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub source: Option<String>,
    pub cloud_model: Option<CloudModelReference>,
}

/// `CloudModelReference` (`app/schemas/runner_routing.py`).
#[derive(Debug, Default, Clone, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct CloudModelReference {
    pub name: Option<String>,
    pub r#type: Option<String>,
    pub namespace: Option<String>,
    pub resource_user_id: Option<i64>,
}

/// Read projection of one Ghost `kinds.json` document.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct GhostDocument {
    spec: GhostSpec,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
struct GhostSpec {
    #[serde(rename = "systemPrompt")]
    system_prompt: Option<String>,
    #[serde(rename = "baseGhostRef")]
    base_ghost_ref: Option<OpaqueJson>,
    #[serde(rename = "mcpServers")]
    mcp_servers: Option<OpaqueJson>,
    plugins: Option<OpaqueJson>,
    #[serde(rename = "defaultKnowledgeBaseRefs")]
    default_knowledge_base_refs: Option<Vec<KnowledgeBaseRef>>,
    skills: Option<Vec<String>>,
    #[serde(rename = "skill_refs")]
    skill_refs: Option<Map<String, serde_json::Value>>,
    #[serde(rename = "preload_skills")]
    preload_skills: Option<Vec<String>>,
    #[serde(rename = "preload_skill_refs")]
    preload_skill_refs: Option<Map<String, serde_json::Value>>,
}

/// `KnowledgeBaseDefaultRef` (`{id, name}`).
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
struct KnowledgeBaseRef {
    id: i64,
    name: String,
}

/// `SkillRefMeta` (`app/schemas/kind.py`); the serialized field order matches
/// the pydantic declaration order.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
struct SkillRefMeta {
    skill_id: i64,
    #[serde(default = "default_namespace")]
    namespace: String,
    #[serde(default)]
    is_public: bool,
    #[serde(default)]
    content_hash: Option<String>,
}

fn default_namespace() -> String {
    "default".to_string()
}

/// Read projection of one Shell `kinds.json` document.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ShellDocument {
    spec: ShellSpec,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ShellSpec {
    #[serde(rename = "shellType")]
    shell_type: Option<String>,
    runtime: Option<String>,
}

impl ShellSpec {
    /// `ShellSpec.shellType` with the backward-compatible `spec.runtime`
    /// fallback (`validation_alias=AliasChoices("shellType", "runtime")`). A
    /// Shell CRD may carry either key, or both; both must resolve without a
    /// deserialization conflict.
    fn resolved_shell_type(self) -> Option<String> {
        self.shell_type.or(self.runtime)
    }
}

/// Read projection of one Model `kinds.json` document.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ModelDocument {
    spec: ModelSpec,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ModelSpec {
    #[serde(rename = "modelConfig")]
    model_config: Option<Map<String, serde_json::Value>>,
    #[serde(rename = "isCustomConfig")]
    is_custom_config: Option<bool>,
    protocol: Option<String>,
}

/// Parse a Bot CRD projection (`Bot.model_validate`).
#[must_use]
pub fn bot_spec(json: &OpaqueJson) -> BotSpec {
    json.project::<BotDocument>()
        .map(|document| document.spec)
        .unwrap_or_default()
}

/// One item of the `BotListResponse.items` array, in the pydantic `BotInDB`
/// field declaration order.
#[derive(Debug, serde::Serialize)]
pub struct BotItem {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub namespace: String,
    pub shell_name: String,
    pub shell_type: String,
    pub agent_config: RawJson,
    pub system_prompt: String,
    pub mcp_servers: RawJson,
    pub plugins: RawJson,
    pub capability_mode: String,
    pub execution_policy: Option<ExecutionPolicy>,
    pub model_policy: Option<ModelPolicy>,
    pub inherit_base_capabilities: bool,
    pub default_knowledge_base_refs: RawJson,
    pub skills: RawJson,
    pub skill_refs: RawJson,
    pub preload_skills: RawJson,
    pub preload_skill_refs: RawJson,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
    pub secondary_model_name: Option<String>,
    pub secondary_model_namespace: Option<String>,
}

/// `_convert_to_bot_dict` for one Bot and its resolved components.
#[must_use]
pub fn bot_item(
    bot: &BotRow,
    ghost: Option<&KindRow>,
    shell: Option<&KindRow>,
    model: Option<&KindRow>,
) -> BotItem {
    let spec = bot_spec(&bot.json.0);
    let shell_name = spec
        .shell_ref
        .as_ref()
        .and_then(|reference| reference.name.clone())
        .unwrap_or_default();

    let ghost_document = ghost.and_then(|ghost| ghost.kinds_json.0.project::<GhostDocument>());
    let ghost_spec = ghost_document
        .as_ref()
        .map(|document| &document.spec)
        .cloned()
        .unwrap_or_default();

    let shell_type = shell
        .and_then(|shell| shell.kinds_json.0.project::<ShellDocument>())
        .and_then(|document| document.spec.resolved_shell_type())
        .unwrap_or_default();

    let agent_config = agent_config(&bot.name, &spec, model);

    let secondary_ref = spec.secondary_model_ref.as_ref();
    let secondary_model_name = secondary_ref.and_then(|reference| reference.name.clone());
    let secondary_model_namespace = secondary_ref.map(|reference| reference.namespace_or_default());

    let capabilities = GhostProjection::from_spec(&ghost_spec);

    BotItem {
        id: bot.id,
        user_id: bot.user_id,
        name: bot.name.clone(),
        namespace: bot.namespace.clone(),
        shell_name,
        shell_type,
        agent_config,
        system_prompt: capabilities.system_prompt,
        mcp_servers: capabilities.mcp_servers,
        plugins: capabilities.plugins,
        capability_mode: spec.capability_mode.unwrap_or_else(|| "manual".to_string()),
        execution_policy: spec.execution_policy.clone(),
        model_policy: spec.model_policy.clone(),
        inherit_base_capabilities: capabilities.inherit_base_capabilities,
        default_knowledge_base_refs: capabilities.default_knowledge_base_refs,
        skills: capabilities.skills,
        skill_refs: capabilities.skill_refs,
        preload_skills: capabilities.preload_skills,
        preload_skill_refs: capabilities.preload_skill_refs,
        is_active: bot.is_active != 0,
        created_at: pydantic_datetime(bot.created_at),
        updated_at: pydantic_datetime(bot.updated_at),
        secondary_model_name,
        secondary_model_namespace,
    }
}

/// The Ghost-derived response fields (`_convert_to_bot_dict` after the shell
/// and model blocks).
struct GhostProjection {
    system_prompt: String,
    mcp_servers: RawJson,
    plugins: RawJson,
    inherit_base_capabilities: bool,
    default_knowledge_base_refs: RawJson,
    skills: RawJson,
    skill_refs: RawJson,
    preload_skills: RawJson,
    preload_skill_refs: RawJson,
}

impl GhostProjection {
    fn from_spec(spec: &GhostSpec) -> Self {
        Self {
            system_prompt: spec.system_prompt.clone().unwrap_or_default(),
            mcp_servers: spec
                .mcp_servers
                .raw_or(Map::<String, serde_json::Value>::new()),
            plugins: spec.plugins.raw_or(Vec::<serde_json::Value>::new()),
            inherit_base_capabilities: spec.base_ghost_ref.is_some(),
            default_knowledge_base_refs: to_raw_value(
                &spec.default_knowledge_base_refs.clone().unwrap_or_default(),
            )
            .expect("knowledge base refs serialize"),
            skills: to_raw_value(&spec.skills.clone().unwrap_or_default())
                .expect("skills serialize"),
            skill_refs: normalize_skill_refs(&spec.skill_refs),
            preload_skills: to_raw_value(&spec.preload_skills.clone().unwrap_or_default())
                .expect("preload skills serialize"),
            preload_skill_refs: normalize_skill_refs(&spec.preload_skill_refs),
        }
    }
}

/// Serialize `Ghost.spec.skill_refs` / `preload_skill_refs`, re-emitting each
/// value in the pydantic `SkillRefMeta` field order (`model_dump`). A missing
/// or null map becomes `{}`.
fn normalize_skill_refs(refs: &Option<Map<String, serde_json::Value>>) -> RawJson {
    let mut output = Map::new();
    if let Some(refs) = refs {
        for (name, value) in refs {
            if let Ok(meta) = serde_json::from_value::<SkillRefMeta>(value.clone()) {
                output.insert(
                    name.clone(),
                    serde_json::to_value(meta).expect("meta serializes"),
                );
            }
        }
    }
    to_raw_value(&output).expect("skill refs serialize")
}

/// `_convert_to_bot_dict`'s model branch: the bot `agent_config`.
fn agent_config(bot_name: &str, spec: &BotSpec, model: Option<&KindRow>) -> RawJson {
    let Some(model) = model else {
        return to_raw_value(&Map::<String, serde_json::Value>::new())
            .expect("empty config serializes");
    };
    let Some(model_document) = model.kinds_json.0.project::<ModelDocument>() else {
        return to_raw_value(&Map::<String, serde_json::Value>::new())
            .expect("empty config serializes");
    };
    let model_spec = model_document.spec;
    let model_ref = spec.model_ref.as_ref();
    let model_ref_name = model_ref.and_then(|reference| reference.name.clone());
    let model_ref_namespace = model_ref
        .map(Reference::namespace_or_default)
        .unwrap_or_else(|| "default".to_string());
    let is_custom_config = model_spec.is_custom_config == Some(true);
    let dedicated_name = format!("{bot_name}-model");
    let is_dedicated_private_model = model_ref_name
        .as_deref()
        .filter(|name| !name.is_empty())
        .is_some_and(|name| name == dedicated_name)
        && is_custom_config;

    let config = if model.kinds_user_id == 0 {
        bind_model_config(&model.kinds_name, "public", &model_ref_namespace)
    } else if !is_dedicated_private_model {
        bind_model_config(
            model_ref_name.as_deref().unwrap_or_default(),
            model_type(&model_ref_namespace),
            &model_ref_namespace,
        )
    } else if is_custom_config {
        let mut config = model_spec.model_config.unwrap_or_default();
        if let Some(protocol) = model_spec.protocol {
            config.insert("protocol".to_string(), serde_json::Value::String(protocol));
        }
        config
    } else {
        bind_model_config(
            model_ref_name.as_deref().unwrap_or_default(),
            model_type(&model_ref_namespace),
            &model_ref_namespace,
        )
    };
    to_raw_value(&config).expect("agent config serializes")
}

/// `"group"` for a non-default namespace, otherwise `"user"`.
fn model_type(namespace: &str) -> &'static str {
    if namespace != "default" {
        "group"
    } else {
        "user"
    }
}

/// The `{"bind_model", "bind_model_type"[`, "bind_model_namespace"]}` config,
/// in the source dict insertion order.
fn bind_model_config(
    name: &str,
    model_type: &str,
    namespace: &str,
) -> Map<String, serde_json::Value> {
    let mut config = Map::new();
    config.insert(
        "bind_model".to_string(),
        serde_json::Value::String(name.to_string()),
    );
    config.insert(
        "bind_model_type".to_string(),
        serde_json::Value::String(model_type.to_string()),
    );
    if namespace != "default" {
        config.insert(
            "bind_model_namespace".to_string(),
            serde_json::Value::String(namespace.to_string()),
        );
    }
    config
}

/// Pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero.
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// Key the batch preload resolves each Bot's Ghost/Shell/Model by.
pub type RefKey = (String, String);

/// The `(name, namespace)` lookup keys collected from one Bot.
#[must_use]
pub fn bot_keys(spec: &BotSpec) -> (Option<RefKey>, Option<RefKey>, Option<RefKey>) {
    let ghost = spec.ghost_ref.as_ref().map(|reference| {
        (
            reference.name.clone().unwrap_or_default(),
            reference.namespace_or_default(),
        )
    });
    let shell = spec.shell_ref.as_ref().map(|reference| {
        (
            reference.name.clone().unwrap_or_default(),
            reference.namespace_or_default(),
        )
    });
    let model = spec.model_ref.as_ref().map(|reference| {
        (
            reference.name.clone().unwrap_or_default(),
            reference.namespace_or_default(),
        )
    });
    (ghost, shell, model)
}

/// Resolve one Bot's components from the batch caches.
#[must_use]
pub fn resolve<'a>(
    ghost_map: &'a HashMap<RefKey, KindRow>,
    shell_map: &'a HashMap<RefKey, KindRow>,
    model_map: &'a HashMap<RefKey, KindRow>,
    keys: &(Option<RefKey>, Option<RefKey>, Option<RefKey>),
) -> (
    Option<&'a KindRow>,
    Option<&'a KindRow>,
    Option<&'a KindRow>,
) {
    (
        keys.0.as_ref().and_then(|key| ghost_map.get(key)),
        keys.1.as_ref().and_then(|key| shell_map.get(key)),
        keys.2.as_ref().and_then(|key| model_map.get(key)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_mysql::Json;
    use chrono::NaiveDate;
    use serde_json::json;

    fn bot_row(json_value: serde_json::Value) -> BotRow {
        BotRow {
            id: 281639,
            user_id: 1214,
            name: "bot1".to_string(),
            namespace: "default".to_string(),
            json: Json(OpaqueJson::from(json_value)),
            is_active: 1,
            created_at: date(),
            updated_at: date(),
        }
    }

    fn kind_row(name: &str, user_id: i64, json_value: serde_json::Value) -> KindRow {
        KindRow {
            kinds_id: 1,
            kinds_user_id: user_id,
            kinds_name: name.to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: Json(OpaqueJson::from(json_value)),
        }
    }

    fn date() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_opt(8, 49, 57)
            .unwrap()
    }

    fn bot_json() -> serde_json::Value {
        json!({
            "kind": "Bot",
            "spec": {
                "ghostRef": {"name": "ghost1", "namespace": "default"},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
                "modelRef": {"name": "openai-x", "namespace": "default"},
                "capability_mode": "manual"
            }
        })
    }

    fn ghost_json() -> serde_json::Value {
        json!({
            "spec": {
                "systemPrompt": "hi",
                "mcpServers": {},
                "plugins": [],
                "defaultKnowledgeBaseRefs": [{"id": 257123, "name": "kb"}],
                "skills": ["s1"],
                "skill_refs": {
                    "s1": {
                        "namespace": "default",
                        "skill_id": 262433,
                        "is_public": false,
                        "content_hash": "sha256:abc"
                    }
                },
                "preload_skills": [],
                "preload_skill_refs": {}
            }
        })
    }

    #[test]
    fn item_matches_botin_db_field_order_and_public_model() {
        let bot = bot_row(bot_json());
        let ghost = kind_row("ghost1", 1214, ghost_json());
        let shell = kind_row(
            "ClaudeCode",
            0,
            json!({"spec": {"shellType": "ClaudeCode"}}),
        );
        // `model.user_id == 0` renders the public `bind_model` form.
        let model = kind_row("openai-x", 0, json!({"spec": {"modelConfig": {}}}));
        let item = bot_item(&bot, Some(&ghost), Some(&shell), Some(&model));
        let body = serde_json::to_string(&item).unwrap();
        assert_eq!(
            body,
            r#"{"id":281639,"user_id":1214,"name":"bot1","namespace":"default","shell_name":"ClaudeCode","shell_type":"ClaudeCode","agent_config":{"bind_model":"openai-x","bind_model_type":"public"},"system_prompt":"hi","mcp_servers":{},"plugins":[],"capability_mode":"manual","execution_policy":null,"model_policy":null,"inherit_base_capabilities":false,"default_knowledge_base_refs":[{"id":257123,"name":"kb"}],"skills":["s1"],"skill_refs":{"s1":{"skill_id":262433,"namespace":"default","is_public":false,"content_hash":"sha256:abc"}},"preload_skills":[],"preload_skill_refs":{},"is_active":true,"created_at":"2026-09-10T08:49:57","updated_at":"2026-09-10T08:49:57","secondary_model_name":null,"secondary_model_namespace":null}"#
        );
    }

    #[test]
    fn stored_policies_render_in_pydantic_field_order() {
        // `bot_crd.spec.execution_policy` / `model_policy` are re-serialized
        // through `BotInDB.model_dump`, preserving each pydantic model's field
        // declaration order.
        let mut bot = bot_json();
        bot["spec"]["execution_policy"] = json!({"mode": "fixed", "environment_id": "123"});
        bot["spec"]["model_policy"] = json!({
            "mode": "fixed",
            "model": {
                "runtime": "claude_code",
                "provider": "p",
                "model_id": "m",
                "source": "cloud",
                "cloud_model": {
                    "name": "m",
                    "type": "public",
                    "namespace": "default",
                    "resource_user_id": 0
                }
            }
        });
        let bot = bot_row(bot);
        let item = bot_item(&bot, None, None, None);
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(
            serde_json::to_string(&value["execution_policy"]).unwrap(),
            r#"{"mode":"fixed","environment_id":"123"}"#
        );
        assert_eq!(
            value["model_policy"]["model"]["cloud_model"],
            json!({"name":"m","type":"public","namespace":"default","resource_user_id":0})
        );
    }

    #[test]
    fn missing_components_render_source_defaults() {
        let bot = bot_row(bot_json());
        let item = bot_item(&bot, None, None, None);
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(value["agent_config"], json!({}));
        assert_eq!(value["system_prompt"], json!(""));
        assert_eq!(value["shell_type"], json!(""));
        assert_eq!(value["mcp_servers"], json!({}));
        assert_eq!(value["plugins"], json!([]));
        assert_eq!(value["skills"], json!([]));
        assert_eq!(value["skill_refs"], json!({}));
        assert_eq!(value["default_knowledge_base_refs"], json!([]));
    }

    #[test]
    fn shell_type_reads_both_runtime_and_shell_type_keys() {
        // Recorded Shell CRDs carry `spec.runtime`; the public ClaudeCode row
        // carries both `spec.runtime` and `spec.shellType`. `ShellSpec` must
        // resolve both to the same value rather than failing deserialization.
        let bot = bot_row(bot_json());
        for (index, spec) in [
            json!({"runtime": "ClaudeCode"}),
            json!({"shellType": "ClaudeCode"}),
            json!({"runtime": "ClaudeCode", "shellType": "ClaudeCode"}),
        ]
        .into_iter()
        .enumerate()
        {
            let label = spec.to_string();
            let shell = kind_row("ClaudeCode", 0, json!({"spec": spec}));
            let item = bot_item(&bot, None, Some(&shell), None);
            let value = serde_json::to_value(&item).unwrap();
            assert_eq!(
                value["shell_type"],
                json!("ClaudeCode"),
                "case {index}: {label}"
            );
        }
    }

    #[test]
    fn dedicated_custom_model_returns_model_config_with_protocol_last() {
        let mut bot = bot_json();
        bot["spec"]["modelRef"]["name"] = json!("bot1-model");
        let bot = bot_row(bot);
        let model = kind_row(
            "bot1-model",
            1214,
            json!({"spec": {
                "modelConfig": {"api_key": "k", "base_url": "u"},
                "isCustomConfig": true,
                "protocol": "openai"
            }}),
        );
        let item = bot_item(&bot, None, None, Some(&model));
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(
            serde_json::to_string(&value["agent_config"]).unwrap(),
            r#"{"api_key":"k","base_url":"u","protocol":"openai"}"#
        );
    }

    #[test]
    fn shared_user_model_renders_bind_model_type_user() {
        let bot = bot_row(bot_json());
        let model = kind_row(
            "openai-x",
            1214,
            json!({"spec": {"modelConfig": {}, "isCustomConfig": false}}),
        );
        let item = bot_item(&bot, None, None, Some(&model));
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(
            value["agent_config"],
            json!({"bind_model": "openai-x", "bind_model_type": "user"})
        );
    }

    #[test]
    fn group_model_namespace_renders_group_type_and_namespace_key() {
        let mut bot = bot_json();
        bot["spec"]["modelRef"]["namespace"] = json!("g/sub");
        let bot = bot_row(bot);
        let mut model = kind_row(
            "openai-x",
            1214,
            json!({"spec": {"modelConfig": {}, "isCustomConfig": false}}),
        );
        model.kinds_namespace = "g/sub".to_string();
        let item = bot_item(&bot, None, None, Some(&model));
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(
            serde_json::to_string(&value["agent_config"]).unwrap(),
            r#"{"bind_model":"openai-x","bind_model_type":"group","bind_model_namespace":"g/sub"}"#
        );
    }

    #[test]
    fn base_ghost_ref_marks_inherited_capabilities() {
        let bot = bot_row(bot_json());
        let ghost = kind_row(
            "ghost1",
            1214,
            json!({"spec": {"systemPrompt": "", "baseGhostRef": {"name": "b", "namespace": "default", "user_id": 0}}}),
        );
        let item = bot_item(&bot, Some(&ghost), None, None);
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(value["inherit_base_capabilities"], json!(true));
    }

    #[test]
    fn skill_refs_missing_content_hash_renders_null_in_canonical_order() {
        let spec: GhostSpec = serde_json::from_value(json!({
            "skill_refs": {"s": {"skill_id": 5}}
        }))
        .unwrap();
        let raw = normalize_skill_refs(&spec.skill_refs);
        assert_eq!(
            raw.get(),
            r#"{"s":{"skill_id":5,"namespace":"default","is_public":false,"content_hash":null}}"#
        );
    }
}
