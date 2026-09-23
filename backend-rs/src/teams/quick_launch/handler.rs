// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/users/quick-launch`
//! (source `app.api.endpoints.users.get_user_quick_launch`).
//!
//! Flow, in source order:
//! 1. `get_current_user` resolves the Bearer JWT to a `users` row.
//! 2. `system_configs` row `quick_launch_functions` provides the raw
//!    `functions` list (`_get_system_config_value`).
//! 3. `_load_quick_launch_function_configs` validates each raw item into a
//!    `QuickLaunchFunctionConfig` (invalid items are skipped), then the
//!    enabled configs are sorted by `order` (stable) and each team is
//!    resolved through `kind_service.get_team_by_id`; missing teams drop the
//!    function.
//! 4. `_get_user_quick_access_team_ids` reads
//!    `preferences.quick_access.teams` and each favorite team becomes a
//!    `QuickLaunchFavoriteAgent` (missing teams are skipped).
use crate::json_compat::OptionalOpaqueJsonExt;
use crate::json_compat::{JsonProjection, OpaqueJson};
#[cfg(test)]
use serde_json::Value;

use super::super::auth::TeamsUser;
use super::super::http_error::HttpError;
use super::repository as repo;
use crate::state::AppState;

/// `MAX_QUICK_PHRASES` (`app.schemas.quick_launch`).
const MAX_QUICK_PHRASES: usize = 6;
/// `MAX_QUICK_PHRASE_LENGTH` (Python counts `str` characters).
#[cfg_attr(not(test), allow(dead_code))]
const MAX_QUICK_PHRASE_LENGTH: usize = 120;
/// `MAX_INPUT_PRESETS`.
const MAX_INPUT_PRESETS: usize = 6;
/// `MAX_INPUT_PRESET_PROMPT_LENGTH`.
const MAX_INPUT_PRESET_PROMPT_LENGTH: usize = 2000;
/// `MAX_INPUT_PRESET_ATTACHMENTS`.
const MAX_INPUT_PRESET_ATTACHMENTS: usize = 10;

/// One validated `QuickLaunchInputPreset`.
#[derive(Debug, Clone)]
#[cfg_attr(test, derive(serde::Serialize))]
struct InputPreset {
    id: String,
    title: String,
    prompt: Option<String>,
    enable_deep_thinking: Option<bool>,
    enable_clarification: Option<bool>,
    force_override: Option<bool>,
    selected_skill_names: Vec<String>,
    source_attachment_ids: Vec<i64>,
}

/// One validated `QuickLaunchFunctionConfig`.
#[derive(Debug, Clone)]
#[cfg_attr(test, derive(serde::Serialize))]
struct FunctionConfig {
    input_presets: Vec<InputPreset>,
    id: String,
    title: String,
    description: Option<String>,
    icon: Option<String>,
    cover: Option<String>,
    team_id: i64,
    enabled: bool,
    order: i64,
}

/// API projections retain explicit nulls; raw team extension values remain JSON.
#[derive(serde::Serialize)]
struct PresetOptionsResponse {
    enable_deep_thinking: Option<bool>,
    enable_clarification: Option<bool>,
    force_override: Option<bool>,
    selected_skill_names: Vec<String>,
}
#[derive(serde::Serialize)]
struct InputPresetResponse {
    id: String,
    title: String,
    prompt: Option<String>,
    options: PresetOptionsResponse,
    source_attachment_ids: Vec<i64>,
}
#[derive(serde::Serialize)]
struct SystemFunctionResponse {
    input_presets: Vec<InputPresetResponse>,
    id: String,
    title: String,
    description: Option<String>,
    icon: Option<String>,
    cover: Option<String>,
    team_id: i64,
    enabled: bool,
    order: i64,
    #[serde(rename = "type")]
    kind: &'static str,
    name: String,
    bind_mode: Vec<Box<serde_json::value::RawValue>>,
    recommended_mode: &'static str,
}
#[derive(serde::Serialize)]
struct FavoriteAgentResponse {
    quick_phrases: Vec<String>,
    input_presets: Vec<InputPresetResponse>,
    #[serde(rename = "type")]
    kind: &'static str,
    id: i64,
    team_id: i64,
    name: String,
    title: String,
    description: Option<String>,
    icon: Option<String>,
    bind_mode: Vec<Box<serde_json::value::RawValue>>,
    recommended_mode: &'static str,
    agent_type: Box<serde_json::value::RawValue>,
}
#[derive(serde::Serialize)]
struct QuickLaunchResponse {
    system_functions: Vec<SystemFunctionResponse>,
    favorite_agents: Vec<FavoriteAgentResponse>,
}

// The `users.preferences` column decodes as JSON like the source `User`
// model; the users auth projection decodes it as a plain string, so this
// handler re-decodes the authenticated user's preferences payload.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PreferencesInput {
    quick_access: Option<QuickAccessInput>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct QuickAccessInput {
    teams: Option<Vec<Option<i64>>>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PresetOptionsInput {
    enable_deep_thinking: Option<bool>,
    enable_clarification: Option<bool>,
    force_override: Option<bool>,
    selected_skill_names: Option<Vec<String>>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PresetInput {
    id: String,
    title: String,
    prompt: Option<String>,
    options: Option<PresetOptionsInput>,
    source_attachment_ids: Option<Vec<i64>>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct FunctionInput {
    id: String,
    title: String,
    team_id: Option<i64>,
    input_presets: Option<Vec<PresetInput>>,
    quick_phrases: Option<Vec<Option<String>>>,
    description: Option<String>,
    icon: Option<String>,
    cover: Option<String>,
    enabled: Option<bool>,
    order: Option<i64>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SystemFunctionsInput {
    functions: Option<Vec<Option<FunctionInput>>>,
}

fn user_quick_access_team_ids(preferences: &str) -> Vec<i64> {
    serde_json::from_str::<JsonProjection<PreferencesInput>>(preferences)
        .ok()
        .and_then(|input| input.value)
        .and_then(|input| input.quick_access)
        .and_then(|input| input.teams)
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .collect()
}

fn normalized_phrases(items: &[Option<String>]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| item.as_deref())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .take(MAX_QUICK_PHRASES)
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
fn validate_quick_phrases(value: Option<&Value>) -> Option<Vec<String>> {
    let items = JsonProjection::<Vec<String>>::from_json(value?).value?;
    let phrases: Vec<String> = items
        .iter()
        .map(|item| item.trim())
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .collect();
    if phrases.len() > MAX_QUICK_PHRASES
        || phrases
            .iter()
            .any(|text| text.chars().count() > MAX_QUICK_PHRASE_LENGTH)
    {
        return None;
    }
    Some(phrases)
}

fn presets_from_phrases(phrases: Vec<String>) -> Vec<InputPreset> {
    phrases
        .into_iter()
        .enumerate()
        .map(|(index, phrase)| InputPreset {
            id: format!("preset_{}", index + 1),
            title: phrase.clone(),
            prompt: Some(phrase),
            enable_deep_thinking: None,
            enable_clarification: None,
            force_override: None,
            selected_skill_names: Vec::new(),
            source_attachment_ids: Vec::new(),
        })
        .collect()
}

fn normalized_skill_names(items: Vec<String>) -> Vec<String> {
    let mut names = Vec::new();
    for item in items {
        let name = item.trim();
        if !name.is_empty() && !names.iter().any(|seen| seen == name) {
            names.push(name.to_owned());
        }
    }
    names
}

impl PresetInput {
    fn validate(self) -> Option<InputPreset> {
        let id = self.id.trim().to_owned();
        let title = self.title.trim().to_owned();
        if id.is_empty() || title.is_empty() {
            return None;
        }
        let prompt = self.prompt.map(|text| text.trim().to_owned());
        if prompt
            .as_ref()
            .is_some_and(|text| text.chars().count() > MAX_INPUT_PRESET_PROMPT_LENGTH)
        {
            return None;
        }
        let prompt = prompt.filter(|text| !text.is_empty());
        let (enable_deep_thinking, enable_clarification, force_override, names) = match self.options
        {
            Some(options) => (
                options.enable_deep_thinking,
                options.enable_clarification,
                options.force_override,
                normalized_skill_names(options.selected_skill_names.unwrap_or_default()),
            ),
            None => (None, None, None, Vec::new()),
        };
        let source_attachment_ids = self.source_attachment_ids.unwrap_or_default();
        if source_attachment_ids.len() > MAX_INPUT_PRESET_ATTACHMENTS {
            return None;
        }
        for (index, id) in source_attachment_ids.iter().enumerate() {
            if *id <= 0 || source_attachment_ids[..index].contains(id) {
                return None;
            }
        }
        Some(InputPreset {
            id,
            title,
            prompt,
            enable_deep_thinking,
            enable_clarification,
            force_override,
            selected_skill_names: names,
            source_attachment_ids,
        })
    }
}

#[cfg(test)]
fn parse_function_config(item: &Value) -> Option<FunctionConfig> {
    let input = JsonProjection::<FunctionInput>::from_json(item).value?;
    validate_function_config(input)
}

fn validate_function_config(input: FunctionInput) -> Option<FunctionConfig> {
    let id = input.id.trim().to_owned();
    let title = input.title.trim().to_owned();
    if id.is_empty() || title.is_empty() {
        return None;
    }
    let presets = input.input_presets.unwrap_or_default();
    if presets.len() > MAX_INPUT_PRESETS {
        return None;
    }
    let mut input_presets = presets
        .into_iter()
        .map(PresetInput::validate)
        .collect::<Option<Vec<_>>>()?;
    if input_presets.is_empty() {
        input_presets =
            presets_from_phrases(normalized_phrases(&input.quick_phrases.unwrap_or_default()));
    }
    Some(FunctionConfig {
        input_presets,
        id,
        title,
        team_id: input.team_id?,
        description: input.description,
        icon: input.icon,
        cover: input.cover,
        enabled: input.enabled.unwrap_or(true),
        order: input.order.unwrap_or(0),
    })
}

/// Serialize one `QuickLaunchInputPreset` in model field order.
fn preset_response(preset: &InputPreset) -> InputPresetResponse {
    InputPresetResponse {
        id: preset.id.clone(),
        title: preset.title.clone(),
        prompt: preset.prompt.clone(),
        options: PresetOptionsResponse {
            enable_deep_thinking: preset.enable_deep_thinking,
            enable_clarification: preset.enable_clarification,
            force_override: preset.force_override,
            selected_skill_names: preset.selected_skill_names.clone(),
        },
        source_attachment_ids: preset.source_attachment_ids.clone(),
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct LaunchTeamInput {
    metadata: Option<LaunchMetadata>,
    spec: Option<LaunchSpec>,
    recommended_mode: Option<String>,
    agent_type: Option<OpaqueJson>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct LaunchMetadata {
    name: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct LaunchSpec {
    description: Option<String>,
    icon: Option<String>,
    capability: Option<LaunchCapability>,
    bind_mode: Option<Vec<BindMode>>,
    recommended_mode: Option<String>,
    quick_phrases: Option<Vec<Option<String>>>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct LaunchCapability {
    description: Option<String>,
    icon: Option<String>,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(untagged)]
enum BindMode {
    Known(String),
    Other(OpaqueJson),
}
impl LaunchTeamInput {
    fn recommended_mode(&self) -> &'static str {
        if let Some(modes) = self.spec.as_ref().and_then(|spec| spec.bind_mode.as_ref()) {
            let has = |name| {
                modes
                    .iter()
                    .any(|mode| matches!(mode, BindMode::Known(value) if value==name))
            };
            return if has("chat") && has("code") {
                "both"
            } else if has("code") {
                "code"
            } else {
                "chat"
            };
        }
        match self
            .recommended_mode
            .as_deref()
            .or_else(|| self.spec.as_ref()?.recommended_mode.as_deref())
        {
            Some("chat") => "chat",
            Some("code") => "code",
            _ => "both",
        }
    }
    fn bind_modes(&self) -> Vec<Box<serde_json::value::RawValue>> {
        self.spec
            .as_ref()
            .and_then(|spec| spec.bind_mode.as_ref())
            .into_iter()
            .flatten()
            .map(|mode| serde_json::value::to_raw_value(mode).expect("bind mode serializes"))
            .collect()
    }
}
#[cfg(test)]
fn team_recommended_mode(team_json: &Value) -> &'static str {
    JsonProjection::<LaunchTeamInput>::from_json(team_json)
        .value
        .unwrap_or_default()
        .recommended_mode()
}

fn system_function_response(
    config: &FunctionConfig,
    team: &repo::TeamKindRow,
) -> SystemFunctionResponse {
    let input = team
        .kinds_json
        .0
        .project::<LaunchTeamInput>()
        .unwrap_or_default();
    let spec = input.spec.as_ref();
    let capability = spec.and_then(|spec| spec.capability.as_ref());
    let description = config
        .description
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| capability?.description.clone())
        .or_else(|| spec?.description.clone());
    let icon = config
        .icon
        .clone()
        .filter(|value| !value.is_empty())
        .or_else(|| capability?.icon.clone())
        .or_else(|| spec?.icon.clone());
    let name = input
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.name.clone())
        .unwrap_or_else(|| format!("team-{}", config.team_id));
    SystemFunctionResponse {
        input_presets: config.input_presets.iter().map(preset_response).collect(),
        id: config.id.clone(),
        title: config.title.clone(),
        description,
        icon,
        cover: config.cover.clone().filter(|value| !value.is_empty()),
        team_id: config.team_id,
        enabled: config.enabled,
        order: config.order,
        kind: "system_function",
        name,
        bind_mode: input.bind_modes(),
        recommended_mode: input.recommended_mode(),
    }
}

fn favorite_agent_response(team: &repo::TeamKindRow) -> FavoriteAgentResponse {
    let input = team
        .kinds_json
        .0
        .project::<LaunchTeamInput>()
        .unwrap_or_default();
    let metadata = input.metadata.as_ref();
    let spec = input.spec.as_ref();
    let name = metadata
        .and_then(|metadata| metadata.name.clone())
        .unwrap_or_else(|| format!("team-{}", team.kinds_id));
    let title = metadata
        .and_then(|metadata| {
            metadata
                .display_name
                .clone()
                .or_else(|| metadata.name.clone())
        })
        .unwrap_or_else(|| format!("Team {}", team.kinds_id));
    let quick_phrases = normalized_phrases(
        spec.and_then(|spec| spec.quick_phrases.as_deref())
            .unwrap_or(&[]),
    );
    let input_presets = presets_from_phrases(quick_phrases.clone());
    FavoriteAgentResponse {
        quick_phrases,
        input_presets: input_presets.iter().map(preset_response).collect(),
        kind: "favorite_agent",
        id: team.kinds_id,
        team_id: team.kinds_id,
        name,
        title,
        description: spec.and_then(|spec| spec.description.clone()),
        icon: spec.and_then(|spec| spec.icon.clone()),
        bind_mode: input.bind_modes(),
        recommended_mode: input.recommended_mode(),
        agent_type: input.agent_type.raw_or(()),
    }
}

/// GET /api/users/quick-launch: the quick-launch free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/users/quick-launch")]
async fn get_user_quick_launch(
    #[inject(state)] state: &AppState,
    #[auth] current_user: TeamsUser,
) -> Result<QuickLaunchResponse, HttpError> {
    quick_launch(state, current_user).await
}

/// Handler body for `GET /api/users/quick-launch`.
async fn quick_launch(
    state: &AppState,
    current_user: TeamsUser,
) -> Result<QuickLaunchResponse, HttpError> {
    quick_launch_response(state, current_user.0.users_preferences.as_str()).await
}

/// Build the `QuickLaunchResponse` body.
async fn quick_launch_response(
    state: &AppState,
    preferences: &str,
) -> Result<QuickLaunchResponse, HttpError> {
    let internal = |error: brz_mysql::MysqlError| HttpError::internal(error.to_string());

    // `_get_system_config_value`: the `functions` list (absent config = {}).
    let system_config = repo::quick_launch_system_config(&state.mysql)
        .await
        .map_err(internal)?;
    let raw_functions = system_config
        .as_ref()
        .and_then(|config| {
            config
                .system_configs_config_value
                .0
                .project::<SystemFunctionsInput>()
        })
        .and_then(|input| input.functions)
        .unwrap_or_default();

    // `_load_quick_launch_function_configs` then a stable sort by `order`.
    let mut function_configs: Vec<FunctionConfig> = raw_functions
        .into_iter()
        .flatten()
        .filter_map(validate_function_config)
        .collect();
    function_configs.sort_by_key(|config| config.order);

    let mut system_functions = Vec::new();
    for config in &function_configs {
        // `_build_system_function` drops disabled functions and missing
        // teams.
        if !config.enabled {
            continue;
        }
        let team = repo::team_kind_by_id(&state.mysql, config.team_id)
            .await
            .map_err(internal)?;
        if let Some(team) = team {
            system_functions.push(system_function_response(config, &team));
        }
    }

    // `_get_user_quick_access_team_ids` then `_build_favorite_agent`.
    let mut favorite_agents = Vec::new();
    for team_id in user_quick_access_team_ids(preferences) {
        let team = repo::team_kind_by_id(&state.mysql, team_id)
            .await
            .map_err(internal)?;
        if let Some(team) = team {
            favorite_agents.push(favorite_agent_response(&team));
        }
    }

    Ok(QuickLaunchResponse {
        system_functions,
        favorite_agents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn user_team_ids_read_quick_access_preferences() {
        let preferences = json!({
            "company_profile": {"name": "Carol"},
            "quick_access": {"version": 1, "teams": [110467, 110600]}
        })
        .to_string();
        assert_eq!(
            user_quick_access_team_ids(&preferences),
            vec![110467, 110600]
        );
    }

    #[test]
    fn user_team_ids_fall_back_to_empty() {
        assert!(user_quick_access_team_ids("not json").is_empty());
        assert!(user_quick_access_team_ids("{\"quick_access\": {}}").is_empty());
    }

    #[test]
    fn function_config_parses_and_migrates_phrases() {
        let raw = json!({
            "id": "f1", "title": "T", "team_id": 7,
            "quick_phrases": [" a ", "", "b"],
        });
        let config = parse_function_config(&raw).expect("valid config");
        assert_eq!(config.team_id, 7);
        assert!(config.enabled);
        assert_eq!(config.order, 0);
        assert_eq!(config.input_presets.len(), 2);
        assert_eq!(config.input_presets[0].id, "preset_1");
        assert_eq!(config.input_presets[0].title, "a");
    }

    #[test]
    fn function_config_rejects_missing_required_fields() {
        assert!(parse_function_config(&json!({"id": "", "title": "t", "team_id": 1})).is_none());
        assert!(parse_function_config(&json!({"id": "f", "team_id": 1})).is_none());
        assert!(parse_function_config(&json!("not an object")).is_none());
    }

    #[test]
    fn preset_json_keeps_model_field_order() {
        let preset = InputPreset {
            id: "preset_1".to_string(),
            title: "t".to_string(),
            prompt: None,
            enable_deep_thinking: None,
            enable_clarification: Some(true),
            force_override: None,
            selected_skill_names: vec!["a".to_string()],
            source_attachment_ids: vec![5],
        };
        let value = serde_json::to_value(preset_response(&preset)).unwrap();
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["id", "title", "prompt", "options", "source_attachment_ids"]
        );
        assert_eq!(value["options"]["enable_clarification"], json!(true));
        assert_eq!(value["options"]["selected_skill_names"], json!(["a"]));
    }

    #[test]
    fn recommended_mode_reduces_bind_mode_list() {
        let team = json!({"spec": {"bind_mode": ["code"]}});
        assert_eq!(team_recommended_mode(&team), "code");
        let team = json!({"spec": {"bind_mode": ["chat", "code"]}});
        assert_eq!(team_recommended_mode(&team), "both");
        let team = json!({"spec": {"bind_mode": ["image"]}});
        assert_eq!(team_recommended_mode(&team), "chat");
        let team = json!({"spec": {"recommended_mode": "code"}});
        assert_eq!(team_recommended_mode(&team), "code");
        let team = json!({"spec": {"recommended_mode": "weird"}});
        assert_eq!(team_recommended_mode(&team), "both");
        assert_eq!(team_recommended_mode(&json!({})), "both");
    }

    #[test]
    fn quick_phrases_validation_bounds() {
        assert_eq!(
            validate_quick_phrases(Some(&json!([" a ", "b"]))),
            Some(vec!["a".to_string(), "b".to_string()])
        );
        let long = vec!["x"; 7];
        assert_eq!(validate_quick_phrases(Some(&json!(long))), None);
        assert_eq!(validate_quick_phrases(Some(&json!(["n", 7]))), None);
        assert_eq!(validate_quick_phrases(Some(&json!("text"))), None);
        assert_eq!(validate_quick_phrases(None), None);
    }
}
