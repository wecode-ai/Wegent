// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `model_resolver.replace_placeholders_with_sources` /
//! `resolve_value_from_source` (`app/services/chat/config/model_resolver.py`),
//! used by `_process_model_config_placeholders` to resolve `${…}` in the
//! Model CRD's `api_key` and `default_headers`.
//!
//! A placeholder is `${source.path}` (`${task_data.user.name}`) or `${path}`
//! (which defaults to the `agent_config` source). The value renders like Python
//! `str(value)` — `True`/`False` for booleans, the number's text, and `""` for
//! a missing path or `None`. Arrays/objects are not modeled (they do not appear
//! in the recorded header/API-key placeholders) and render as `""`.
use serde_json::{Map, Value};

/// `replace_placeholders_with_sources`: replace every `${…}` in `template`.
pub fn replace_placeholders_with_sources(template: &str, sources: &Map<String, Value>) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$'
            && bytes.get(index + 1) == Some(&b'{')
            && let Some(end) = template[index + 2..].find('}')
        {
            let spec = &template[index + 2..index + 2 + end];
            out.push_str(&resolve_value_from_source(sources, spec));
            index = index + 2 + end + 1;
            continue;
        }
        // Copy one UTF-8 character.
        let ch = template[index..].chars().next().expect("char");
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

/// `resolve_value_from_source`: navigate `source.path` and render the value.
pub fn resolve_value_from_source(sources: &Map<String, Value>, source_spec: &str) -> String {
    let (source_name, path) = match source_spec.split_once('.') {
        Some((source_name, path)) => (source_name, path),
        None => ("agent_config", source_spec),
    };
    let Some(mut current) = sources.get(source_name) else {
        return String::new();
    };
    for key in path.split('.') {
        current = match current {
            Value::Object(map) => match map.get(key) {
                Some(value) => value,
                None => return String::new(),
            },
            Value::Array(items) => match key.parse::<usize>() {
                Ok(index) if index < items.len() => &items[index],
                _ => return String::new(),
            },
            _ => return String::new(),
        };
    }
    python_str(current)
}

/// Python `str(value)` for the scalars the placeholders carry.
fn python_str(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => if *flag { "True" } else { "False" }.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        // Arrays/objects would render as a Python repr; not modeled.
        Value::Array(_) | Value::Object(_) => String::new(),
    }
}

/// `_extract_model_config`'s failure: `modelConfig` has no usable `env`.
#[derive(Debug)]
pub enum ModelConfigError {
    /// `Model config has no env configuration`.
    NoEnv,
}

impl std::fmt::Display for ModelConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoEnv => write!(f, "Model config has no env configuration"),
        }
    }
}

impl std::error::Error for ModelConfigError {}

/// `_extract_model_config`: the flat model config from a Model CRD's `spec`.
///
/// Produces the recorded keys in order (`api_key`, `base_url`, `model_id`,
/// `model`, `default_headers`, `api_format`, `protocol`, `context_window`,
/// `max_output_tokens`, `modelType`, `videoConfig`, `think_config`,
/// `temperature`, plus the conditional `modelCapabilities`). The caller appends
/// `model_name` / `model_namespace` (`get_model_config_for_bot`) and resolves
/// the `api_key` placeholder through the deployment adapter and the placeholder
/// engine.
///
/// Not modeled: `decrypt_api_key`, the `EXECUTOR_ENV`/`DEFAULT_HEADERS`
/// environment fallback, `codex_catalog_model_id`, and `imageConfig`; no
/// recorded create case reaches them.
pub fn extract_model_config(model_spec: &Value) -> Result<Map<String, Value>, ModelConfigError> {
    let model_config = model_spec
        .get("modelConfig")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));
    let env = model_config
        .get("env")
        .filter(|value| is_non_empty_object(value))
        .ok_or(ModelConfigError::NoEnv)?;

    let env_str = |key: &str| {
        env.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let api_key = env_str("api_key");
    let base_url = env
        .get("base_url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.openai.com/v1")
        .to_string();
    let model_id = env
        .get("model_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("gpt-4")
        .to_string();
    let model_type = env
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("openai")
        .to_string();

    let default_headers = model_config
        .get("DEFAULT_HEADERS")
        .filter(|value| is_non_empty_object(value))
        .or_else(|| {
            env.get("DEFAULT_HEADERS")
                .filter(|value| is_non_empty_object(value))
        })
        .cloned()
        .unwrap_or(Value::Object(Map::new()));

    let mut api_format = model_spec
        .get("apiFormat")
        .or_else(|| model_config.get("apiFormat"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut protocol = model_spec
        .get("protocol")
        .or_else(|| model_config.get("protocol"))
        .cloned()
        .unwrap_or(Value::Null);
    let env_model = model_type.to_lowercase();
    if protocol.is_null() {
        match env_model.as_str() {
            "openai" => protocol = Value::String("openai".to_string()),
            "claude" => protocol = Value::String("claude".to_string()),
            _ => {}
        }
    }
    if api_format.is_null() {
        match protocol.as_str() {
            Some("openai-responses") => api_format = Value::String("responses".to_string()),
            Some("openai") => api_format = Value::String("chat/completions".to_string()),
            _ => {}
        }
    }

    let mut result = Map::new();
    result.insert("api_key".into(), Value::String(api_key));
    result.insert("base_url".into(), Value::String(base_url));
    result.insert("model_id".into(), Value::String(model_id));
    result.insert("model".into(), Value::String(model_type));
    result.insert("default_headers".into(), default_headers);
    result.insert("api_format".into(), api_format);
    result.insert("protocol".into(), protocol);
    result.insert(
        "context_window".into(),
        model_config
            .get("context_window")
            .cloned()
            .unwrap_or(Value::Null),
    );
    result.insert(
        "max_output_tokens".into(),
        model_config
            .get("max_output_tokens")
            .cloned()
            .unwrap_or(Value::Null),
    );
    result.insert(
        "modelType".into(),
        model_spec.get("modelType").cloned().unwrap_or(Value::Null),
    );
    result.insert(
        "videoConfig".into(),
        model_spec
            .get("videoConfig")
            .cloned()
            .unwrap_or(Value::Null),
    );
    result.insert(
        "think_config".into(),
        env.get("thinking_config")
            .or_else(|| env.get("thinkingConfig"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    result.insert(
        "temperature".into(),
        env.get("temperature").cloned().unwrap_or(Value::Null),
    );
    if let Some(capabilities) = model_spec
        .get("modelCapabilities")
        .filter(|value| is_non_empty_object(value))
        .or_else(|| {
            model_config
                .get("modelCapabilities")
                .filter(|value| is_non_empty_object(value))
        })
    {
        result.insert("modelCapabilities".into(), capabilities.clone());
    }
    Ok(result)
}

/// `get_bot_system_prompt`: the Ghost's `spec.systemPrompt`, the team member
/// prompt appended, wrapped in `<base_prompt>` tags.
pub fn wrap_base_prompt(system_prompt: &str, team_member_prompt: Option<&str>) -> String {
    let mut combined = system_prompt.to_string();
    if let Some(member) = team_member_prompt.filter(|value| !value.is_empty()) {
        if combined.is_empty() {
            combined = member.to_string();
        } else {
            combined = format!("{combined}\n\n{member}");
        }
    }
    if combined.is_empty() {
        return String::new();
    }
    format!("<base_prompt>\n{combined}\n</base_prompt>")
}

/// `build_agent_config_for_bot`: the bot's inline `agent_config` when its `env`
/// already carries `model` and `api_key` and no override is forced; otherwise
/// the resolved Model CRD's `modelConfig`, with `protocol` / `apiFormat`
/// promoted from the Model spec.
///
/// `resolved_model_spec` is the Model CRD `spec` for the bot's modelRef (or the
/// task's `model_id` override); `None` means the model did not resolve and the
/// raw agent config is returned unchanged.
pub fn build_agent_config(
    raw_agent_config: &Value,
    force_override: bool,
    override_model_name: Option<&str>,
    resolved_model_spec: Option<&Value>,
) -> Value {
    let inline_ready = !(force_override && override_model_name.is_some())
        && raw_agent_config
            .get("env")
            .and_then(|env| env.get("model"))
            .is_some_and(is_truthy)
        && raw_agent_config
            .get("env")
            .and_then(|env| env.get("api_key"))
            .is_some_and(is_truthy);
    if inline_ready {
        return raw_agent_config.clone();
    }

    let Some(spec) = resolved_model_spec else {
        return raw_agent_config.clone();
    };
    let Some(mut model_config) = spec
        .get("modelConfig")
        .filter(|value| is_non_empty_object(value))
        .cloned()
    else {
        return raw_agent_config.clone();
    };

    for key in ["protocol", "apiFormat"] {
        if let Some(value) = spec.get(key).filter(|value| is_truthy(value))
            && let Some(map) = model_config.as_object_mut()
        {
            map.insert(key.to_string(), value.clone());
        }
    }
    model_config
}

/// Python truthiness for the scalars the config carries.
use brz_json::adapters::python_truthy as is_truthy;

/// Whether `value` is a JSON object with at least one key.
fn is_non_empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(|map| !map.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sources() -> Map<String, Value> {
        match json!({
            "agent_config": {"env": {"user": "alice"}},
            "task_data": {"user": {"name": "alice"}, "team": {"name": "test-team", "namespace": "test-namespace"}},
            "env": {"session-id": 123456789_i64},
            "user": {"id": 6527, "name": "alice", "user_name": "alice"},
        }) {
            Value::Object(map) => map,
            _ => Map::new(),
        }
    }

    #[test]
    fn replaces_named_and_default_sources() {
        let sources = sources();
        assert_eq!(
            replace_placeholders_with_sources("${task_data.user.name}", &sources),
            "alice"
        );
        assert_eq!(
            replace_placeholders_with_sources("${user.user_name}", &sources),
            "alice"
        );
        assert_eq!(
            replace_placeholders_with_sources("${task_data.team.name}", &sources),
            "test-team"
        );
    }

    #[test]
    fn renders_scalars_like_python_str() {
        let sources = sources();
        assert_eq!(
            replace_placeholders_with_sources("${env.session-id}", &sources),
            "123456789"
        );
        // A missing source, a missing path and `null` render empty.
        assert_eq!(replace_placeholders_with_sources("${nope.x}", &sources), "");
        assert_eq!(
            replace_placeholders_with_sources("${task_data.missing}", &sources),
            ""
        );
    }

    #[test]
    fn leaves_text_without_placeholders_unchanged() {
        let sources = sources();
        assert_eq!(
            replace_placeholders_with_sources("plain-key", &sources),
            "plain-key"
        );
        // An unterminated `${` is left as literal text.
        assert_eq!(replace_placeholders_with_sources("a${b", &sources), "a${b");
    }

    #[test]
    fn extract_model_config_matches_the_recorded_projection() {
        let spec = json!({
            "apiFormat": null,
            "protocol": "claude",
            "modelType": null,
            "videoConfig": null,
            "modelCapabilities": {"supportsImage": true, "supportsVideo": true},
            "modelConfig": {
                "env": {
                    "model": "claude",
                    "api_key": "test-api-key",
                    "base_url": "https://model.example.test",
                    "model_id": "qwen3.7-plus",
                    "small_model": "qwen3.7-plus",
                    "thinking_config": {"effort": "high", "thinking": {"type": "adaptive"}},
                },
                "context_window": 991000,
                "max_output_tokens": 64000,
                "DEFAULT_HEADERS": {"wecode-source": "agent"},
            },
        });
        let config = extract_model_config(&spec).expect("config");
        let keys: Vec<&str> = config.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "api_key",
                "base_url",
                "model_id",
                "model",
                "default_headers",
                "api_format",
                "protocol",
                "context_window",
                "max_output_tokens",
                "modelType",
                "videoConfig",
                "think_config",
                "temperature",
                "modelCapabilities",
            ]
        );
        assert_eq!(config["model_id"], json!("qwen3.7-plus"));
        assert_eq!(config["model"], json!("claude"));
        assert_eq!(config["api_format"], Value::Null);
        assert_eq!(config["protocol"], json!("claude"));
        assert_eq!(config["context_window"], json!(991000));
        assert_eq!(config["default_headers"]["wecode-source"], json!("agent"));
        assert_eq!(
            config["modelCapabilities"],
            json!({"supportsImage": true, "supportsVideo": true})
        );
    }

    #[test]
    fn inline_agent_config_wins_without_a_forced_override() {
        let raw = json!({"env": {"model": "claude", "api_key": "sk-x"}});
        assert_eq!(build_agent_config(&raw, false, None, None), raw);
        // A forced override ignores the inline env.
        let spec = json!({"modelConfig": {"env": {"model": "openai"}}});
        assert_eq!(
            build_agent_config(&raw, true, Some("other-model"), Some(&spec)),
            json!({"env": {"model": "openai"}})
        );
    }

    #[test]
    fn resolved_model_config_promotes_protocol_and_api_format() {
        let raw = json!({"env": {}});
        let spec = json!({
            "protocol": "claude",
            "apiFormat": "responses",
            "modelConfig": {"env": {"model": "claude", "api_key": "sk-x"}},
        });
        assert_eq!(
            build_agent_config(&raw, false, None, Some(&spec)),
            json!({
                "env": {"model": "claude", "api_key": "sk-x"},
                "protocol": "claude",
                "apiFormat": "responses",
            })
        );
        // A missing model spec returns the raw config.
        assert_eq!(build_agent_config(&raw, false, None, None), raw);
    }

    #[test]
    fn extract_model_config_requires_env() {
        assert!(matches!(
            extract_model_config(&json!({"modelConfig": {}})),
            Err(ModelConfigError::NoEnv)
        ));
    }

    #[test]
    fn base_prompt_wraps_and_appends_the_member_prompt() {
        assert_eq!(
            wrap_base_prompt("ghost", None),
            "<base_prompt>\nghost\n</base_prompt>"
        );
        assert_eq!(
            wrap_base_prompt("ghost", Some("member")),
            "<base_prompt>\nghost\n\nmember\n</base_prompt>"
        );
        assert_eq!(wrap_base_prompt("", None), "");
    }

    #[test]
    fn boolean_placeholders_render_python_style() {
        let mut sources = Map::new();
        sources.insert("env".to_string(), json!({"flag": true}));
        assert_eq!(
            replace_placeholders_with_sources("${env.flag}", &sources),
            "True"
        );
    }
}
