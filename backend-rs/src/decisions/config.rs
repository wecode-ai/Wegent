// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Decision Model CRD validation and HTTPS endpoint resolution.
use serde_json::Value;

use super::{DecisionError, protocol::Protocol};
use crate::llm_proxy::model_config::{ModelConfig, extract_and_process_model_config};

pub(super) use wegent_resource_store::decision_model::endpoint;
pub(crate) use wegent_resource_store::decision_model::validate_spec;

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
