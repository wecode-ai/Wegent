// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

// Match the deserialization boundary in Codex rust-v0.169.1 config/src/mcp_types.rs.
// Keep opaque metadata: native deserialization ignores unknown server/tool/OAuth fields.
#[derive(Deserialize)]
#[allow(dead_code)] // Fields are consumed by serde to validate the entire native definition.
struct RawMcpServerConfig {
    args: Option<Vec<String>>,
    auth: Option<McpServerAuth>,
    bearer_token_env_var: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    default_tools_approval_mode: Option<AppToolApproval>,
    disabled_tools: Option<Vec<String>>,
    enabled: Option<bool>,
    enabled_tools: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
    env_http_headers: Option<BTreeMap<String, String>>,
    env_vars: Option<Vec<McpServerEnvVar>>,
    environment_id: Option<String>,
    http_headers: Option<BTreeMap<String, String>>,
    http_headers_helper: Option<String>,
    name: Option<String>,
    oauth: Option<McpServerOAuthConfig>,
    oauth_resource: Option<String>,
    omit_tools_from: Option<Vec<ToolExposureSurface>>,
    required: Option<bool>,
    scopes: Option<Vec<String>>,
    startup_readiness: Option<McpStartupReadiness>,
    startup_timeout_ms: Option<u64>,
    startup_timeout_sec: Option<f64>,
    supports_parallel_tool_calls: Option<bool>,
    tool_input_schema_max_bytes: Option<std::num::NonZeroUsize>,
    tool_timeout_sec: Option<f64>,
    tools: Option<BTreeMap<String, McpServerToolConfig>>,
    url: Option<String>,
    bearer_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
#[allow(dead_code)] // Names are validated by serde; only the source needs semantic checks.
enum McpServerEnvVar {
    Name(String),
    Config {
        name: String,
        source: Option<String>,
    },
}

#[derive(Deserialize)]
#[allow(dead_code)] // Fields are consumed by serde to validate the entire native definition.
struct McpServerToolConfig {
    approval_mode: Option<AppToolApproval>,
    output_token_limit: Option<std::num::NonZeroUsize>,
}

#[derive(Deserialize)]
#[allow(dead_code)] // Fields are consumed by serde to validate the entire native definition.
struct McpServerOAuthConfig {
    authorization_server_issuer: Option<String>,
    callback_port: Option<u16>,
    callback_url: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    token_endpoint_auth_method: Option<McpEmaTokenEndpointAuthMethod>,
}

#[derive(Deserialize, PartialEq)]
enum AppToolApproval {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "prompt")]
    Prompt,
    #[serde(rename = "writes")]
    Writes,
    #[serde(rename = "approve")]
    Approve,
}

#[derive(Deserialize, PartialEq)]
enum McpServerAuth {
    #[serde(rename = "oauth")]
    Oauth,
    #[serde(rename = "chatgpt")]
    Chatgpt,
    #[serde(rename = "ema_auth")]
    EmaAuth,
}

#[derive(Deserialize, PartialEq)]
enum McpStartupReadiness {
    #[serde(rename = "connection")]
    Connection,
    #[serde(rename = "catalog")]
    Catalog,
}

#[derive(Deserialize, PartialEq)]
enum ToolExposureSurface {
    #[serde(rename = "code_mode")]
    CodeMode,
    #[serde(rename = "deferred")]
    Deferred,
    #[serde(rename = "direct")]
    Direct,
}

#[derive(Deserialize, PartialEq)]
enum McpEmaTokenEndpointAuthMethod {
    #[serde(rename = "client_secret_basic")]
    ClientSecretBasic,
    #[serde(rename = "client_secret_post")]
    ClientSecretPost,
}

pub(super) fn validate(definition: &Value) -> Result<(), String> {
    let config: RawMcpServerConfig = serde_json::from_value(definition.clone())
        .map_err(|_| "Invalid native Codex MCP fields")?;
    validate_transport(&config)?;
    validate_oauth(&config)
}

fn validate_transport(config: &RawMcpServerConfig) -> Result<(), String> {
    if config.bearer_token.is_some() {
        return Err("Native MCP bearer_token is unsupported".to_owned());
    }
    if config.command.is_some() {
        if config.url.is_some()
            || config.http_headers_helper.is_some()
            || config.http_headers.is_some()
            || config.env_http_headers.is_some()
            || config.bearer_token_env_var.is_some()
            || config.oauth.is_some()
            || config.oauth_resource.is_some()
            || config.auth.is_some()
        {
            return Err("Invalid native stdio MCP fields".to_owned());
        }
        for variable in config.env_vars.iter().flatten() {
            if let McpServerEnvVar::Config {
                source: Some(source),
                ..
            } = variable
            {
                if !matches!(source.as_str(), "local" | "remote") {
                    return Err("Invalid native MCP environment source".to_owned());
                }
            }
        }
    } else if config.url.is_some() {
        if config.args.is_some()
            || config.env.is_some()
            || config.env_vars.is_some()
            || config.cwd.is_some()
        {
            return Err("Invalid native HTTP MCP fields".to_owned());
        }
        if let Some(helper) = &config.http_headers_helper {
            if helper.trim().is_empty()
                || config.environment_id.as_deref().unwrap_or("local") != "local"
            {
                return Err("Invalid native MCP HTTP header helper".to_owned());
            }
        }
    } else {
        return Err("Invalid native MCP transport".to_owned());
    }
    Ok(())
}

fn validate_oauth(config: &RawMcpServerConfig) -> Result<(), String> {
    let Some(oauth) = &config.oauth else {
        return Ok(());
    };
    if let Some(credential) = &oauth.client_secret {
        if credential.trim().is_empty()
            || oauth
                .client_id
                .as_deref()
                .map_or(true, |id| id.trim().is_empty())
        {
            return Err("Invalid native MCP OAuth client settings".to_owned());
        }
    }
    let enterprise_auth = config.auth == Some(McpServerAuth::EmaAuth);
    if oauth.token_endpoint_auth_method.is_some()
        && (!enterprise_auth || oauth.client_secret.is_none())
    {
        return Err("Invalid native MCP OAuth token authentication".to_owned());
    }
    if oauth.authorization_server_issuer.is_some() && !enterprise_auth {
        return Err("Invalid native MCP OAuth issuer configuration".to_owned());
    }
    Ok(())
}
