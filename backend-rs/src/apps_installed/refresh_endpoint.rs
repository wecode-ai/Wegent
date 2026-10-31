// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/connector-apps/{slug}/connection/refresh`
//! (`app/api/endpoints/connector_apps.py::refresh_connector_connection`).
//!
//! Renews an expired grant and probes the upstream so the settings retry action
//! reports what the provider actually answers instead of guessing from the
//! stored token state.

use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_mysql::Mysql;
use chrono::Utc;

use super::connection::{self, ConnectorConnection};
use super::db::{self, UserRow};
use super::handler::InstalledAppsUser;
use super::mcp;
use super::refresh::{self, RefreshError};
use super::service::{self, ConnectorApp};
use crate::http_compat::FastApiError;
use crate::state::AppState;

const APP_NOT_FOUND: &str = "Connector app not found";
const CONNECTION_NOT_FOUND: &str = "Connector connection not found";
const NOT_OAUTH: &str = "Connector app does not use OAuth";

/// POST /api/connector-apps/{slug}/connection/refresh.
#[brz_http_server::post("/api/connector-apps/:slug/connection/refresh")]
async fn refresh_connector_connection(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] principal: InstalledAppsUser,
    slug: String,
) -> Result<super::models::ConnectionResponse, FastApiError> {
    refresh_for(&state.mysql, &principal.into_row(), &slug).await
}

/// Handler body shared with the compatibility tests.
pub(crate) async fn refresh_for<M>(
    mysql: &M,
    user: &UserRow,
    slug: &str,
) -> Result<super::models::ConnectionResponse, FastApiError>
where
    M: Mysql,
{
    let rows = db::list_connector_app_kinds(mysql)
        .await
        .map_err(internal_error)?;
    let apps: Vec<ConnectorApp> = rows.iter().map(service::row_to_app).collect();
    let app = service::list_visible_apps(&apps, user)
        .into_iter()
        .find(|app| app.slug == slug)
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, APP_NOT_FOUND))?;
    if app.auth_type != "oauth2" {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            NOT_OAUTH,
        ));
    }
    let Some(row) = db::find_connector_connection(mysql, slug, user.users_id)
        .await
        .map_err(internal_error)?
    else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            CONNECTION_NOT_FOUND,
        ));
    };

    let mut row = row;
    if connection::response(Some(&ConnectorConnection::from_row(&row))).status == "expired" {
        refresh::refresh(mysql, app, user.users_id)
            .await
            .map_err(map_refresh_error)?;
        row = db::find_connector_connection(mysql, slug, user.users_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, CONNECTION_NOT_FOUND))?;
    }

    match probe_upstream(mysql, app, user).await {
        Ok(tools) => {
            let discovered_at = Utc::now().to_rfc3339();
            let summaries = tool_summaries(app, &tools);
            let _ = refresh::write_discovery_state(
                mysql,
                &row,
                &refresh::DiscoveryState {
                    discovered_at: Some(&discovered_at),
                    tool_summaries: Some(&summaries),
                    last_error: None,
                    expired: false,
                },
            )
            .await;
        }
        Err(ProbeError::Unauthorized(message)) => {
            // The upstream rejected the stored credential: an entry point for
            // re-authorization must appear even though the token has not
            // reached its `expiresAt` yet.
            tracing::warn!(connector = %app.slug, %message, "connector rejected its credential");
            let _ = refresh::write_discovery_state(
                mysql,
                &row,
                &refresh::DiscoveryState {
                    last_error: Some(&message),
                    expired: true,
                    ..Default::default()
                },
            )
            .await;
        }
        Err(ProbeError::Transport(message)) => {
            let _ = refresh::write_discovery_state(
                mysql,
                &row,
                &refresh::DiscoveryState {
                    last_error: Some(&message),
                    ..Default::default()
                },
            )
            .await;
        }
    }

    let refreshed = db::find_connector_connection(mysql, slug, user.users_id)
        .await
        .map_err(internal_error)?;
    let current = refreshed.as_ref().map(ConnectorConnection::from_row);
    Ok(connection::response(current.as_ref()))
}

/// Probe the app's MCP endpoint once with the stored credential.
///
/// The transport decides the protocol: `sse` apps only serve a `GET` event
/// stream, so probing them with the streamable-HTTP `POST initialize` exchange
/// would report a healthy upstream as unavailable.
async fn probe_upstream<M>(
    mysql: &M,
    app: &ConnectorApp,
    user: &UserRow,
) -> Result<Vec<mcp::UpstreamTool>, ProbeError>
where
    M: Mysql,
{
    if app.transport == "http" {
        // HTTP-transport apps carry inline definitions instead of an MCP
        // session; the recorded deployment exposes none.
        return Ok(Vec::new());
    }
    let headers = service::session_headers(mysql, app, user)
        .await
        .map_err(|error| ProbeError::Transport(error.to_string()))?;
    mcp::list_tools_for_transport(&app.transport, &app.mcp_url, &headers)
        .await
        .map_err(ProbeError::from)
}

/// `_cache_tool_summaries`: the cached surface the settings view renders.
fn tool_summaries(app: &ConnectorApp, tools: &[mcp::UpstreamTool]) -> Vec<serde_json::Value> {
    let allowlist = &app.tool_allowlist;
    tools
        .iter()
        .filter(|tool| allowlist.is_empty() || allowlist.contains(&tool.name))
        .map(|tool| {
            serde_json::json!({
                "name": format!("{}__{}", app.slug, tool.name),
                "title": tool.title,
                "description": tool.description.clone().unwrap_or_default(),
                "rawToolName": tool.name,
                "inputSchema": tool.input_schema.as_ref().map(brz_json::OpaqueJson::to_value),
            })
        })
        .collect()
}

/// Why a probe could not list the upstream's tools.
#[derive(Debug)]
enum ProbeError {
    /// The upstream answered `401`/`403`: the stored grant is rejected.
    Unauthorized(String),
    /// Any other transport, status, or configuration failure.
    Transport(String),
}

impl From<mcp::McpError> for ProbeError {
    fn from(error: mcp::McpError) -> Self {
        match error {
            mcp::McpError::Unauthorized(message) => Self::Unauthorized(message),
            mcp::McpError::Transport(message) => Self::Transport(message),
        }
    }
}

fn map_refresh_error(error: RefreshError) -> FastApiError {
    match error {
        RefreshError::Rejected => FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Connector authorization was rejected",
        ),
        RefreshError::Unavailable => {
            FastApiError::detail(StatusCode::NOT_FOUND, CONNECTION_NOT_FOUND)
        }
        other => {
            tracing::warn!(%other, "connector grant refresh failed");
            FastApiError::internal()
        }
    }
}

fn internal_error(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "connector connection refresh failed");
    FastApiError::internal()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A rejected grant is a client-visible 400, not an internal failure.
    #[test]
    fn rejected_grants_map_to_bad_request() {
        let error = map_refresh_error(RefreshError::Rejected);
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    }

    /// A missing stored grant keeps the Python 404 contract.
    #[test]
    fn missing_grants_map_to_not_found() {
        let error = map_refresh_error(RefreshError::Unavailable);
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
    }

    /// Provider failures stay internal so the desktop retries later.
    #[test]
    fn provider_failures_map_to_internal() {
        let error = map_refresh_error(RefreshError::Provider("boom".to_string()));
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    fn app(slug: &str, allowlist: serde_json::Value) -> ConnectorApp {
        let spec = serde_json::json!({
            "name": slug,
            "mcpUrl": "https://mcp.example.invalid/mcp",
            "enabled": true,
            "authType": "oauth2",
            "transport": "streamable-http",
            "visibility": "all",
            "description": "d",
            "allowedRoles": [],
            "toolAllowlist": allowlist,
        });
        let row = db::KindRow {
            kinds_id: 1,
            kinds_user_id: 0,
            kinds_kind: "ConnectorApp".to_string(),
            kinds_name: slug.to_string(),
            kinds_namespace: "system".to_string(),
            kinds_json: brz_mysql::Json(
                serde_json::json!({"kind": "ConnectorApp", "spec": spec}).into(),
            ),
            kinds_is_active: true,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        };
        service::row_to_app(&row)
    }

    fn tool(name: &str) -> mcp::UpstreamTool {
        mcp::UpstreamTool {
            name: name.to_string(),
            title: Some(format!("{name} title")),
            description: Some(format!("{name} description")),
            input_schema: None,
            annotations: None,
        }
    }

    /// The summary shape `_cache_tool_summaries` writes, so the Python view
    /// reads the same cache the Rust write produced.
    #[test]
    fn summaries_mirror_the_python_cache_entry() {
        let app = app("dingtalk_docs", serde_json::json!([]));
        let summaries = tool_summaries(&app, &[tool("read_doc")]);

        assert_eq!(
            summaries,
            vec![serde_json::json!({
                "name": "dingtalk_docs__read_doc",
                "title": "read_doc title",
                "description": "read_doc description",
                "rawToolName": "read_doc",
                "inputSchema": null,
            })]
        );
    }

    /// A successful probe replaces the cached surface: tools the upstream no
    /// longer serves must disappear instead of surviving behind a fresh
    /// `toolsDiscoveredAt`.
    #[test]
    fn summaries_follow_the_current_tool_surface() {
        let app = app("dingtalk_docs", serde_json::json!([]));
        let summaries = tool_summaries(&app, &[tool("write_doc")]);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0]["rawToolName"], serde_json::json!("write_doc"));
    }

    /// The administrator's allowlist still bounds the cached surface.
    #[test]
    fn summaries_respect_the_tool_allowlist() {
        let app = app("dingtalk_docs", serde_json::json!(["read_doc"]));
        let summaries = tool_summaries(&app, &[tool("read_doc"), tool("delete_doc")]);

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0]["name"],
            serde_json::json!("dingtalk_docs__read_doc")
        );
    }

    /// Only a rejected credential flips the connection; other failures keep it
    /// connected so a transient outage does not demand re-authorization.
    #[test]
    fn only_authorization_failures_are_unauthorized() {
        assert!(matches!(
            ProbeError::from(mcp::McpError::Unauthorized("401".to_string())),
            ProbeError::Unauthorized(_)
        ));
        assert!(matches!(
            ProbeError::from(mcp::McpError::Transport("boom".to_string())),
            ProbeError::Transport(_)
        ));
    }
}
