// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_apply_user_mcp_oauth_header` (`request_builder.py:2060-2135`): the
//! provider MCP bearer header the create flow attaches while it builds a
//! Skill's `skill_configs` entry.

use super::*;
use crate::mcp_user_service::{decrypt_with_env, service_config_with};
use crate::user_mcp_oauth::is_secure_mcp_url;

/// [`build_skill_data`] plus `_apply_user_mcp_oauth_header`
/// (`request_builder.py:2060-2135`), which the source runs inside
/// `_build_skill_data` after the configured user-managed provider branch.
pub(super) async fn build_skill_data_with_oauth<T: UserMcpAccessTokens>(
    skill: &SkillKindRow,
    user_preferences: Option<&str>,
    tokens: &T,
) -> Result<Value, FastApiError> {
    let mut data = build_skill_data(skill, user_preferences)?;
    apply_user_mcp_oauth_header(skill, user_preferences, &mut data, tokens).await?;
    Ok(data)
}

/// `_apply_user_mcp_oauth_header`: attach the stored OAuth bearer header to an
/// OAuth-authorized provider MCP server.
///
/// The source reaches this only for a public `default`-namespace Skill
/// registered by a `"user"`-mode provider whose service the request user has
/// configured; personal StreamableHttp URLs carry their own credential, so
/// only the OAuth mode receives an injected header.
async fn apply_user_mcp_oauth_header<T: UserMcpAccessTokens>(
    skill: &SkillKindRow,
    user_preferences: Option<&str>,
    data: &mut Value,
    tokens: &T,
) -> Result<(), FastApiError> {
    if !(skill.kinds_user_id == 0 && skill_namespace(skill) == "default") {
        return Ok(());
    }
    let Some((provider, service)) = get_mcp_service_by_skill_name(&skill.kinds_name) else {
        return Ok(());
    };
    if provider.configuration_mode != "user" {
        return Ok(());
    }
    // The source's `elif user:` under `if not configured_server:`.
    let Some(preferences) = user_preferences else {
        return Ok(());
    };
    if enabled_provider_server(preferences, provider.provider_id, service.service_id)?.is_none() {
        return Ok(());
    }
    let Some(servers) = data.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    let server_name = service.server_name;
    let legacy_name = server_name.replace('_', "-");
    let key = if servers.contains_key(server_name) {
        server_name
    } else if servers.contains_key(&legacy_name) {
        legacy_name.as_str()
    } else {
        tracing::warn!(
            provider_id = provider.provider_id,
            service_id = service.service_id,
            "provider MCP server {} or {} not found",
            server_name,
            legacy_name
        );
        return Ok(());
    };
    let Some(server) = servers.get_mut(key) else {
        return Ok(());
    };
    let config = service_config_with(
        preferences,
        provider.provider_id,
        service.service_id,
        decrypt_with_env,
    )?;
    if config.auth_mode != "oauth" {
        return Ok(());
    }
    if !is_secure_mcp_url(&config.url) {
        tracing::warn!(
            provider_id = provider.provider_id,
            service_id = service.service_id,
            "refusing to attach an MCP OAuth bearer header over an insecure transport"
        );
        return Ok(());
    }
    let access_token = tokens
        .ensure_access_token(preferences, provider.provider_id, service.service_id)
        .await?;
    if access_token.is_empty() {
        tracing::warn!(
            provider_id = provider.provider_id,
            service_id = service.service_id,
            "no usable MCP OAuth access token; the provider skill starts unauthenticated"
        );
        return Ok(());
    }
    let Some(server) = server.as_object_mut() else {
        return Ok(());
    };
    let mut headers = match server.get("headers") {
        Some(Value::Object(headers)) => headers.clone(),
        _ => serde_json::Map::new(),
    };
    headers.insert(
        "Authorization".into(),
        Value::String(format!("Bearer {access_token}")),
    );
    server.insert("headers".into(), Value::Object(headers));
    Ok(())
}
