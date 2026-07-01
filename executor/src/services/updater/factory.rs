// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use crate::config::device::UpdateConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionCheckerKind {
    Github {
        token: Option<String>,
    },
    Registry {
        registry_url: String,
        auth_token: Option<String>,
    },
}

pub fn create_version_checker_kind(
    config: &UpdateConfig,
    env: &BTreeMap<String, String>,
) -> Result<VersionCheckerKind, String> {
    if let Some(registry_url) = registry_url(config, env) {
        return Ok(VersionCheckerKind::Registry {
            registry_url,
            auth_token: registry_token(config, env),
        });
    }

    Ok(VersionCheckerKind::Github { token: None })
}

fn registry_url(config: &UpdateConfig, env: &BTreeMap<String, String>) -> Option<String> {
    non_empty(&config.registry).or_else(|| env.get("REGISTRY").and_then(|value| non_empty(value)))
}

fn registry_token(config: &UpdateConfig, env: &BTreeMap<String, String>) -> Option<String> {
    non_empty(&config.registry_token)
        .or_else(|| env.get("REGISTRY_TOKEN").and_then(|value| non_empty(value)))
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}
