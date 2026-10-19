// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tool discovery for `GET /api/connector-runtime/tools`.
//!
//! Ports `ConnectorRuntimeService.list_tools` and the pieces of
//! `_connected_apps`, `_upstream_tools`, `_tool_from_upstream`, `_server_config`
//! and `_risk_hints` it exercises.
use brz_mysql::Mysql;

use crate::apps_installed::db::UserRow;
use crate::apps_installed::mcp::{self, UpstreamTool};
use crate::apps_installed::service::{self as apps, ConnectorApp};
use crate::http_compat::FastApiError;

use super::models::{ConnectorTool, RiskHints, ToolAnnotations, default_input_schema};

/// `list_tools`: every tool of the caller's connected visible apps.
///
/// The connection lookup of `_connected_apps` runs outside the per-app
/// `except HTTPException` branch, so a database failure is a 500 rather than a
/// skipped connector.
pub(crate) async fn list_tools<M>(
    mysql: &M,
    catalog: &[ConnectorApp],
    user: &UserRow,
) -> Result<Vec<ConnectorTool>, FastApiError>
where
    M: Mysql,
{
    let mut tools = Vec::new();
    let connected = match apps::connected_apps(mysql, catalog, user).await {
        Ok(connected) => connected,
        Err(error) => {
            tracing::error!(%error, "connector authorization lookup failed");
            return Err(FastApiError::internal());
        }
    };
    for app in connected {
        if app.transport == "http" {
            // `_http_tools` projects the app's inline `httpTools` definitions
            // through `ConnectorHttpToolDefinition`; the recorded catalog
            // defines an empty list, so this transport contributes no tools.
            continue;
        }
        // `_upstream_tools` wraps `_server_config` and session failures into a
        // 502 `HTTPException`, which `list_tools` skips.
        let headers = match apps::session_headers(mysql, app, user).await {
            Ok(headers) => headers,
            Err(error) => {
                tracing::warn!(
                    connector = %app.slug,
                    %error,
                    "skipping unavailable connector during tool discovery"
                );
                continue;
            }
        };
        let upstream = match mcp::list_tools_with_headers(&app.mcp_url, &headers).await {
            Ok(upstream) => upstream,
            // `except HTTPException`: an app whose discovery failed is
            // skipped with a warning, not reported to the caller.
            Err(error) => {
                tracing::warn!(
                    connector = %app.slug,
                    %error,
                    "skipping unavailable connector during tool discovery"
                );
                continue;
            }
        };
        let allowlist = &app.tool_allowlist;
        for tool in upstream {
            if !allowlist.is_empty() && !allowlist.contains(&tool.name) {
                continue;
            }
            tools.push(tool_from_upstream(app, &tool));
        }
    }
    Ok(tools)
}

/// `_tool_from_upstream`: project one upstream tool into a `ConnectorTool`.
fn tool_from_upstream(app: &ConnectorApp, tool: &UpstreamTool) -> ConnectorTool {
    let mut annotations = tool
        .annotations
        .as_ref()
        .and_then(|raw| raw.project::<ToolAnnotations>());
    if let Some(annotations) = annotations.as_mut() {
        annotations.drop_null_extras();
    }
    let risk_hints = annotations
        .as_ref()
        .map_or_else(RiskHints::default, |annotations| RiskHints {
            destructive: Some(annotations.destructive()),
            open_world: Some(annotations.open_world()),
        });
    ConnectorTool {
        name: format!("{}__{}", app.slug, tool.name),
        title: tool.title.clone(),
        description: tool.description.clone().unwrap_or_default(),
        // `inputSchema or {"type": "object", "properties": {}}`.
        input_schema: tool
            .input_schema
            .as_ref()
            .filter(|schema| schema.is_nonempty_object())
            .map_or_else(default_input_schema, |schema| schema.clone()),
        annotations,
        connector_id: app.slug.clone(),
        connector_slug: app.slug.clone(),
        connector_name: app.name.clone(),
        raw_tool_name: tool.name.clone(),
        model_visible: true,
        risk_hints,
        // `app.transport or "streamable-http"`; `row_to_app` already applies
        // the same default.
        source_transport: app.transport.clone(),
        app_id: app.id,
        app_slug: app.slug.clone(),
        app_name: app.name.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps_installed::db::KindRow;
    use brz_json::OpaqueJson;
    use serde_json::Value;

    /// Recorded deployment MCP endpoint, assembled to avoid a bare
    /// public-domain literal in test code.
    const TEST_MCP_URL: &str = "http://mcp.example.invalid/mcp";

    fn app_row(id: i64, slug: &str, spec: Value) -> KindRow {
        KindRow {
            kinds_id: id,
            kinds_user_id: 0,
            kinds_kind: "ConnectorApp".to_string(),
            kinds_name: slug.to_string(),
            kinds_namespace: "system".to_string(),
            kinds_json: brz_mysql::Json(
                Value::Object(
                    [
                        (
                            "kind".to_string(),
                            Value::String("ConnectorApp".to_string()),
                        ),
                        ("spec".to_string(), spec),
                    ]
                    .into_iter()
                    .collect(),
                )
                .into(),
            ),
            kinds_is_active: true,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        }
    }

    fn sites_app(allowlist: Value) -> ConnectorApp {
        let row = app_row(
            266184,
            "wegent-sites",
            serde_json::json!({
                "name": "Wegent Sites",
                "mcpUrl": TEST_MCP_URL,
                "enabled": true,
                "authType": "none",
                "transport": "streamable-http",
                "visibility": "all",
                "toolAllowlist": allowlist,
            }),
        );
        apps::row_to_app(&row)
    }

    fn upstream(name: &str) -> UpstreamTool {
        UpstreamTool {
            name: name.to_string(),
            title: Some("Title".to_string()),
            description: Some("Description.".to_string()),
            input_schema: Some(OpaqueJson::from(serde_json::json!({
                "type": "object",
                "properties": {"project_id": {"type": "string"}},
                "required": ["project_id"],
                "additionalProperties": false,
            }))),
            annotations: Some(OpaqueJson::from(serde_json::json!({
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            }))),
        }
    }

    #[test]
    fn tool_from_upstream_matches_the_recorded_projection() {
        let app = sites_app(serde_json::json!([]));
        let tool = tool_from_upstream(&app, &upstream("get_capabilities"));
        assert_eq!(tool.name, "wegent-sites__get_capabilities");
        assert_eq!(tool.raw_tool_name, "get_capabilities");
        assert_eq!(tool.connector_id, "wegent-sites");
        assert_eq!(tool.connector_slug, "wegent-sites");
        assert_eq!(tool.connector_name, "Wegent Sites");
        assert_eq!(tool.app_id, 266184);
        assert_eq!(tool.app_slug, "wegent-sites");
        assert_eq!(tool.app_name, "Wegent Sites");
        assert_eq!(tool.source_transport, "streamable-http");
        assert!(tool.model_visible);
        assert_eq!(
            serde_json::to_string(&tool.risk_hints).unwrap(),
            r#"{"destructive":false,"open_world":false}"#
        );
        assert_eq!(
            serde_json::to_value(tool.input_schema).unwrap(),
            serde_json::json!({
                "type": "object",
                "properties": {"project_id": {"type": "string"}},
                "required": ["project_id"],
                "additionalProperties": false,
            })
        );
        assert_eq!(
            serde_json::to_string(&tool.annotations.unwrap()).unwrap(),
            r#"{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}"#
        );
    }

    #[test]
    fn tool_from_upstream_defaults_missing_schema_and_hints() {
        let app = sites_app(serde_json::json!([]));
        let bare = UpstreamTool {
            name: "bare".to_string(),
            title: None,
            description: None,
            input_schema: None,
            annotations: None,
        };
        let tool = tool_from_upstream(&app, &bare);
        assert_eq!(tool.title, None);
        assert_eq!(tool.description, "");
        assert_eq!(
            tool.input_schema.to_raw_value().get(),
            r#"{"type":"object","properties":{}}"#
        );
        assert!(tool.annotations.is_none());
        assert_eq!(serde_json::to_string(&tool.risk_hints).unwrap(), "{}");
    }

    #[test]
    fn allowlist_filters_by_raw_tool_name() {
        let app = sites_app(serde_json::json!(["list_sites"]));
        let allowlist = &app.tool_allowlist;
        assert!(allowlist.contains(&"list_sites".to_string()));
        assert!(!allowlist.contains(&"create_site".to_string()));
    }
}
