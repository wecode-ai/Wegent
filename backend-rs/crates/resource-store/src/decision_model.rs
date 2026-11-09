//! Decision model resource schema and HTTPS endpoint policy.

use serde_json::Value;
use url::Url;

/// Invalid decision model schema, protocol, or endpoint configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidDecisionModel;

impl std::fmt::Display for InvalidDecisionModel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("invalid decision model configuration")
    }
}

impl std::error::Error for InvalidDecisionModel {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    SystemOne,
    OpenAi,
}

impl Protocol {
    pub fn parse(value: &str) -> Result<Self, InvalidDecisionModel> {
        match value {
            "systemone" => Ok(Self::SystemOne),
            "openai" => Ok(Self::OpenAi),
            _ => Err(InvalidDecisionModel),
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            Self::SystemOne => "systemone",
            Self::OpenAi => "decisions",
        }
    }
}

pub fn valid_model_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._/:-".contains(&byte))
}

pub fn endpoint(base: &str, protocol: Protocol) -> Result<String, InvalidDecisionModel> {
    let mut url = Url::parse(base.trim()).map_err(|_| InvalidDecisionModel)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || base.contains(['?', '#'])
        || url.query().is_some()
        || url.fragment().is_some()
        || base
            .trim()
            .split_once("://")
            .is_some_and(|(_, rest)| rest.split('/').next().unwrap_or_default().contains('@'))
    {
        return Err(InvalidDecisionModel);
    }
    let path = url.path().trim_end_matches('/');
    let last = path.rsplit('/').next().unwrap_or_default();
    let target = protocol.endpoint();
    let path = match last {
        "systemone" | "decisions" if last == target => path.to_owned(),
        "v1" => format!("{path}/{target}"),
        "" if path.is_empty() => format!("/v1/{target}"),
        _ => return Err(InvalidDecisionModel),
    };
    url.set_path(&path);
    Ok(url.to_string())
}

pub fn validate_spec(spec: &Value) -> Result<(), InvalidDecisionModel> {
    let protocol = Protocol::parse(
        spec.get("protocol")
            .and_then(Value::as_str)
            .ok_or(InvalidDecisionModel)?,
    )?;
    if spec.get("apiFormat").is_some_and(|value| !value.is_null()) {
        return Err(InvalidDecisionModel);
    }
    let env = spec
        .pointer("/modelConfig/env")
        .and_then(Value::as_object)
        .ok_or(InvalidDecisionModel)?;
    for key in ["model_id", "base_url", "api_key"] {
        if env
            .get(key)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(InvalidDecisionModel);
        }
    }
    if !valid_model_id(env["model_id"].as_str().ok_or(InvalidDecisionModel)?) {
        return Err(InvalidDecisionModel);
    }
    if let Some(headers) = env.get("custom_headers").filter(|value| !value.is_null())
        && !headers
            .as_object()
            .is_some_and(|headers| headers.values().all(Value::is_string))
    {
        return Err(InvalidDecisionModel);
    }
    endpoint(
        env["base_url"].as_str().ok_or(InvalidDecisionModel)?,
        protocol,
    )?;
    Ok(())
}
