// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Decision Model CRD validation and HTTPS endpoint resolution.
use serde_json::Value;
use url::Url;

use super::{DecisionError, protocol::Protocol, schema::valid_model_id};
use crate::llm_proxy::model_config::{ModelConfig, extract_and_process_model_config};

pub(super) fn endpoint(base: &str, protocol: Protocol) -> Result<String, ()> {
    let mut url = Url::parse(base.trim()).map_err(|_| ())?;
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
        return Err(());
    }
    let path = url.path().trim_end_matches('/');
    let last = path.rsplit('/').next().unwrap_or_default();
    let target = protocol.endpoint();
    let path = match last {
        "systemone" | "decisions" if last == target => path.to_owned(),
        "v1" => format!("{path}/{target}"),
        "" if path.is_empty() => format!("/v1/{target}"),
        _ => return Err(()),
    };
    url.set_path(&path);
    Ok(url.to_string())
}

pub(super) fn resolve(
    spec: &Value,
    user_id: i32,
    user_name: &str,
) -> Result<(Protocol, ModelConfig, String), DecisionError> {
    let invalid = DecisionError::invalid_config;
    validate_spec(spec).map_err(|_| invalid())?;
    let protocol =
        Protocol::parse(spec["protocol"].as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
    let config = extract_and_process_model_config(spec, i64::from(user_id), user_name)
        .map_err(|_| invalid())?;
    let endpoint = endpoint(&config.base_url, protocol).map_err(|_| invalid())?;
    Ok((protocol, config, endpoint))
}

pub(crate) fn validate_spec(spec: &Value) -> Result<(), ()> {
    let protocol = Protocol::parse(spec.get("protocol").and_then(Value::as_str).ok_or(())?)?;
    if spec.get("apiFormat").is_some_and(|value| !value.is_null()) {
        return Err(());
    }
    let env = spec
        .pointer("/modelConfig/env")
        .and_then(Value::as_object)
        .ok_or(())?;
    for key in ["model_id", "base_url", "api_key"] {
        if env
            .get(key)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(());
        }
    }
    if !valid_model_id(env["model_id"].as_str().ok_or(())?) {
        return Err(());
    }
    if let Some(headers) = env.get("custom_headers").filter(|value| !value.is_null())
        && !headers
            .as_object()
            .is_some_and(|headers| headers.values().all(Value::is_string))
    {
        return Err(());
    }
    endpoint(env["base_url"].as_str().ok_or(())?, protocol)?;
    Ok(())
}
