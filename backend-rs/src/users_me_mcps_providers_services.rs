// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/me/mcps/providers/{provider_id}/services`.
//!
//! Mirrors `app.api.endpoints.users.list_mcp_provider_services` together with
//! `app.services.mcp_provider_registry` and
//! `app.services.user_mcp_service.UserMCPService`: a provider that is unknown
//! or not configured for user-scoped services is rejected with the source's
//! 404, and otherwise every static service of the provider is rendered merged
//! with the current user's stored configuration.
//!
//! The pydantic `MCPProviderServiceConfigResponse` keeps `provider_id`,
//! `service_id`, `server_name`, `detail_url`, `enabled`, `url`, `auth_mode`,
//! `oauth_supported`, `oauth_connected`, `oauth_expires_at`, and
//! `oauth_account`, in that declaration order; the registry's `skill_name`,
//! `display_name`, and `message_keywords` are not part of this response.
use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::mcp_user_service::{CryptoError, decrypt_with_env, service_config_with};
use crate::state::AppState;
use brz_http_server::StatusCode;

/// The rendered `MCPProviderServiceConfigResponse`; field order is the pydantic
/// model's declaration order.
#[derive(Serialize)]
struct ProviderServiceConfig {
    provider_id: String,
    service_id: &'static str,
    server_name: &'static str,
    detail_url: &'static str,
    enabled: bool,
    url: String,
    auth_mode: &'static str,
    oauth_supported: bool,
    oauth_connected: bool,
    oauth_expires_at: Option<i64>,
    oauth_account: Option<String>,
}

/// GET /api/users/me/mcps/providers/{provider_id}/services: the free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/users/me/mcps/providers/:provider_id/services")]
async fn list_mcp_provider_services(
    #[inject(state)] _state: &AppState,
    provider_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<Vec<ProviderServiceConfig>, FastApiError> {
    list_services(provider_id, &current_user.preferences)
}

/// Handler body for `GET /api/users/me/mcps/providers/{provider_id}/services`.
fn list_services(
    provider_id: &str,
    preferences: &str,
) -> Result<Vec<ProviderServiceConfig>, FastApiError> {
    list_services_with(provider_id, preferences, decrypt_with_env)
}

/// [`list_services`] with an explicit URL decryptor.
fn list_services_with(
    provider_id: &str,
    preferences: &str,
    decrypt: impl Fn(&str) -> Result<String, CryptoError>,
) -> Result<Vec<ProviderServiceConfig>, FastApiError> {
    // `has_provider_services`: unknown or non-user providers are 404.
    let Some(provider) = crate::mcp_provider_registry::get_mcp_provider(provider_id) else {
        return Err(unsupported_provider(provider_id));
    };
    if provider.configuration_mode != "user" {
        return Err(unsupported_provider(provider_id));
    }

    let mut configs = Vec::with_capacity(provider.services.len());
    for service in provider.services {
        let config = service_config_with(preferences, provider_id, service.service_id, &decrypt)?;
        configs.push(ProviderServiceConfig {
            provider_id: provider_id.to_owned(),
            service_id: service.service_id,
            server_name: service.server_name,
            detail_url: service.detail_url,
            enabled: config.enabled,
            url: config.url,
            auth_mode: config.auth_mode,
            oauth_supported: service.oauth_supported,
            oauth_connected: config.oauth_connected,
            oauth_expires_at: config.oauth_expires_at,
            oauth_account: config.oauth_account,
        });
    }
    Ok(configs)
}

/// `HTTPException(404, f"Unsupported MCP provider: {provider_id}")`.
fn unsupported_provider(provider_id: &str) -> FastApiError {
    FastApiError::detail(
        StatusCode::NOT_FOUND,
        format!("Unsupported MCP provider: {provider_id}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_user_service::decrypt_sensitive_data;
    use serde_json::json;

    const KEY: &[u8] = b"12345678901234567890123456789012";
    const IV: &[u8] = b"1234567890123456";

    /// The production decryptor with the source's default key material, so the
    /// handler's behavior can be exercised without process environment.
    fn test_decrypt(url: &str) -> Result<String, CryptoError> {
        Ok(decrypt_sensitive_data(KEY, IV, url))
    }

    #[test]
    fn list_services_renders_registry_order_and_fields() {
        let preferences = json!({
            "mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "enabled": true,
                            "credentials": {"url": "N4DP229zmyi0e4Mwh5IlSg=="},
                        }
                    }
                }
            }
        })
        .to_string();
        let configs = list_services_with("dingtalk", &preferences, test_decrypt).unwrap();
        let body = serde_json::to_string(&configs).unwrap();
        assert_eq!(
            body,
            "[{\"provider_id\":\"dingtalk\",\"service_id\":\"docs\",\
             \"server_name\":\"dingtalk_docs\",\
             \"detail_url\":\"https://mcp.dingtalk.com/#/detail?mcpId=9629\",\
             \"enabled\":true,\"url\":\"docs\",\"auth_mode\":\"url\",\
             \"oauth_supported\":true,\"oauth_connected\":false,\
             \"oauth_expires_at\":null,\"oauth_account\":null},\
             {\"provider_id\":\"dingtalk\",\"service_id\":\"table\",\
             \"server_name\":\"dingtalk_table\",\
             \"detail_url\":\"https://mcp.dingtalk.com/#/detail?mcpId=9704\",\
             \"enabled\":false,\"url\":\"\",\"auth_mode\":\"url\",\
             \"oauth_supported\":true,\"oauth_connected\":false,\
             \"oauth_expires_at\":null,\"oauth_account\":null},\
             {\"provider_id\":\"dingtalk\",\"service_id\":\"ai_table\",\
             \"server_name\":\"dingtalk_ai_table\",\
             \"detail_url\":\"https://mcp.dingtalk.com/#/detail?mcpId=9555\",\
             \"enabled\":false,\"url\":\"\",\"auth_mode\":\"url\",\
             \"oauth_supported\":true,\"oauth_connected\":false,\
             \"oauth_expires_at\":null,\"oauth_account\":null},\
             {\"provider_id\":\"dingtalk\",\"service_id\":\"wikispace\",\
             \"server_name\":\"dingtalk_wikispace\",\
             \"detail_url\":\"https://mcp.dingtalk.com/#/detail?mcpId=9730\",\
             \"enabled\":false,\"url\":\"\",\"auth_mode\":\"url\",\
             \"oauth_supported\":true,\"oauth_connected\":false,\
             \"oauth_expires_at\":null,\"oauth_account\":null}]"
        );
    }

    #[test]
    fn unknown_or_system_providers_are_not_found() {
        assert!(list_services_with("missing", "{}", test_decrypt).is_err());
        // The internal `ap` provider is system-mode, so it is not user-scoped.
        assert!(crate::mcp_provider_registry::get_mcp_provider("ap").is_none());
        assert_eq!(
            unsupported_provider("missing").detail_message(),
            Some("Unsupported MCP provider: missing")
        );
    }
}
