// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Service logic for `GET /api/apps/installed`.
//!
//! Ports `installed_apps` plus the pieces of
//! `app/services/connector_apps.py` and
//! `app/services/connector_runtime.py` it exercises:
//! `list_visible_apps` (enabled + role visibility), `user_response`
//! (connection view), `_connected_apps`, and `list_tools` (MCP discovery per
//! streamable-http app with `toolAllowlist` filtering).
use std::collections::HashMap;

use brz_mysql::Mysql;
use serde::Deserialize;

use super::db::{KindRow, UserRow};
use super::mcp::{self, UpstreamTool};
use super::models::{
    ConnectionResponse, InstalledApp, InstalledResponse, ToolSummary, connected_no_auth,
};

/// Runtime view of one connector app (`ConnectorApp` dataclass).
#[derive(Debug)]
pub struct ConnectorApp {
    #[allow(dead_code)]
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub enabled: bool,
    pub visibility: String,
    pub allowed_roles: Vec<String>,
    pub auth_type: String,
    pub transport: String,
    pub mcp_url: String,
    pub tool_allowlist: Vec<String>,
}

/// The `spec` object of one `kinds` row (`ConnectorAppService._spec`).
///
/// Every field decodes like the source's `spec.get(key) or default` chain:
/// missing, `null`, and empty-string values fall back to the default, and
/// non-string / non-array shapes also fall back (the source `str()`/`list()`
/// coercions are not reproduced beyond that; the recorded specs are strings).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AppSpec {
    #[serde(deserialize_with = "text_or_default")]
    name: String,
    #[serde(deserialize_with = "text_or_default")]
    description: String,
    #[serde(rename = "iconUrl")]
    icon_url: Option<String>,
    enabled: Option<bool>,
    #[serde(deserialize_with = "text_or_default")]
    visibility: String,
    #[serde(rename = "allowedRoles", deserialize_with = "text_list_or_default")]
    allowed_roles: Vec<String>,
    #[serde(rename = "authType", deserialize_with = "text_or_default")]
    auth_type: String,
    #[serde(deserialize_with = "text_or_default")]
    transport: String,
    #[serde(rename = "mcpUrl", deserialize_with = "text_or_default")]
    mcp_url: String,
    #[serde(rename = "toolAllowlist", deserialize_with = "text_list_or_default")]
    tool_allowlist: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct AppDocument {
    #[serde(default)]
    spec: Option<AppSpec>,
}

/// `str(spec.get(key) or default)`: a non-empty string is kept, every other
/// shape (missing, `null`, `""`, non-string) falls back to the field default.
fn text_or_default<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<String> = Option::<String>::deserialize(deserializer)?;
    Ok(value.unwrap_or_default())
}

/// `list(spec.get(key) or default)`: an array of strings is kept, every other
/// shape falls back to the field default.
fn text_list_or_default<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<Vec<String>> = Option::<Vec<String>>::deserialize(deserializer)?;
    Ok(value.unwrap_or_default())
}

impl AppSpec {
    /// Decode the `spec` object of a `kinds` row (`_spec`); a missing or
    /// non-object `spec` decodes to all defaults.
    fn from_row(row: &KindRow) -> Self {
        row.kinds_json
            .0
            .project::<AppDocument>()
            .and_then(|document| document.spec)
            .unwrap_or_default()
    }
}

/// One tool discovered for a connector (`ConnectorRuntimeService.list_tools`
/// output projection).
struct ConnectorTool {
    connector_id: String,
    name: String,
    title: Option<String>,
    description: String,
    raw_tool_name: String,
}

/// Convert one `kinds` row to a `ConnectorApp` like `_row_to_app`.
pub fn row_to_app(row: &KindRow) -> ConnectorApp {
    let spec = AppSpec::from_row(row);
    ConnectorApp {
        id: row.kinds_id,
        slug: row.kinds_name.clone(),
        // `str(spec.get("name") or row.name)`: an empty spec name falls back
        // to the slug.
        name: if spec.name.is_empty() {
            row.kinds_name.clone()
        } else {
            spec.name
        },
        description: spec.description,
        icon_url: spec.icon_url,
        // `bool(spec.get("enabled", True))`.
        enabled: spec.enabled.unwrap_or(true),
        // `str(spec.get("visibility") or "all")`.
        visibility: if spec.visibility.is_empty() {
            "all".to_string()
        } else {
            spec.visibility
        },
        allowed_roles: spec.allowed_roles,
        // `str(spec.get("authType") or "none")`.
        auth_type: if spec.auth_type.is_empty() {
            "none".to_string()
        } else {
            spec.auth_type
        },
        // `str(spec.get("transport") or "streamable-http")`.
        transport: if spec.transport.is_empty() {
            "streamable-http".to_string()
        } else {
            spec.transport
        },
        mcp_url: spec.mcp_url,
        tool_allowlist: spec.tool_allowlist,
    }
}

/// `list_visible_apps`: enabled apps visible to the user's role.
///
/// Shared with the connector-runtime tool listing, which applies the same
/// visibility filter before its per-app connection check.
pub(crate) fn list_visible_apps<'a>(
    apps: &'a [ConnectorApp],
    user: &UserRow,
) -> Vec<&'a ConnectorApp> {
    apps.iter()
        .filter(|app| app.enabled)
        .filter(|app| app.visibility == "all" || app.allowed_roles.contains(&user.users_role))
        .collect()
}

/// `user_response` connection view. Only the `auth_type == "none"` branch is
/// reachable on this endpoint without an OAuth connection store; the source
/// falls back to `connector_connection_service.response(None)` which is
/// `{"status": "disconnected", ...}` for apps that require authorization.
fn connection_view(app: &ConnectorApp) -> ConnectionResponse {
    if app.auth_type == "none" {
        connected_no_auth()
    } else {
        ConnectionResponse {
            status: "disconnected",
            external_account_name: None,
            granted_scopes: Vec::new(),
            expires_at: None,
        }
    }
}

/// Whether the app is connected for the user (`_connected_apps`).
///
/// Shared with the connector-runtime tool listing.
pub(crate) fn app_connected(app: &ConnectorApp) -> bool {
    // Without a stored OAuth connection, only `auth_type == "none"` apps are
    // connected; `connector_connection_service.get` returning None maps to
    // status "disconnected" for every other auth type.
    app.auth_type == "none"
}

/// `connector_runtime_service.list_tools` restricted to this endpoint's
/// needs: per connected app, MCP tools filtered by the allowlist. Apps whose
/// discovery fails are skipped with a warning, exactly like the source's
/// `except HTTPException` branch.
async fn list_tools(apps: &[&ConnectorApp]) -> Vec<ConnectorTool> {
    let mut tools = Vec::new();
    for app in apps {
        if !app_connected(app) {
            continue;
        }
        if app.transport == "http" {
            // HTTP-transport apps carry inline `httpTools` definitions; the
            // recorded deployment exposes none, so the definition list is
            // empty and contributes no tools.
            continue;
        }
        let upstream: Vec<UpstreamTool> = match mcp::list_tools(&app.mcp_url).await {
            Ok(tools) => tools,
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
            tools.push(ConnectorTool {
                connector_id: app.slug.clone(),
                name: format!("{}__{}", app.slug, tool.name),
                title: tool.title,
                description: tool.description.unwrap_or_default(),
                raw_tool_name: tool.name,
            });
        }
    }
    tools
}

/// Build the response for `installed_apps`.
pub async fn installed_apps(
    _mysql: &impl Mysql,
    apps: &[ConnectorApp],
    user: &UserRow,
) -> Result<InstalledResponse, mcp::McpError> {
    // `_tool_summaries_by_app` runs discovery before the projection loop.
    let visible_for_tools = list_visible_apps(apps, user);
    let connected_for_tools: Vec<&ConnectorApp> = visible_for_tools
        .iter()
        .copied()
        .filter(|app| app_connected(app))
        .collect();
    let tools = list_tools(&connected_for_tools).await;
    let mut tools_by_app: HashMap<&str, Vec<ToolSummary>> = HashMap::new();
    for tool in &tools {
        let summaries = tools_by_app.entry(tool.connector_id.as_str()).or_default();
        summaries.push(ToolSummary {
            name: tool.name.clone(),
            title: tool.title.clone(),
            description: tool.description.clone(),
            raw_tool_name: Some(tool.raw_tool_name.clone()),
        });
    }

    // The projection loop re-lists visible apps (a second identical query in
    // the source) and keeps apps whose connection view is "connected".
    let visible = list_visible_apps(apps, user);
    let mut items = Vec::new();
    for app in visible {
        let connection = connection_view(app);
        if connection.status != "connected" {
            continue;
        }
        let app_tools = tools_by_app.get(app.slug.as_str());
        let callable = app_tools.is_some_and(|tools| !tools.is_empty());
        items.push(InstalledApp {
            id: app.slug.clone(),
            slug: app.slug.clone(),
            name: app.name.clone(),
            description: app.description.clone(),
            icon_url: app.icon_url.clone(),
            runtime_name: callable.then(|| app.name.clone()),
            enabled: app.enabled,
            callable,
            connection,
            tool_summaries: app_tools.map(|tools| tools.to_vec()).unwrap_or_default(),
        });
    }
    Ok(InstalledResponse { apps: items })
}

#[cfg(test)]
mod tests {
    /// Synthetic MCP endpoint used by the parser tests.
    const TEST_MCP_URL: &str = "http://mcp.example.invalid/mcp";

    use serde_json::Value;

    use super::*;

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

    fn user() -> UserRow {
        UserRow {
            users_id: 128,
            users_user_name: "xiangji".to_string(),
            users_password_hash: String::new(),
            users_email: None,
            users_git_info: brz_mysql::Json(Value::Null.into()),
            users_is_active: true,
            users_role: "user".to_string(),
            users_auth_source: "oidc".to_string(),
            users_preferences: String::new(),
            users_created_at: chrono::NaiveDateTime::default(),
            users_updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn row_to_app_reads_spec_defaults() {
        let row = app_row(
            266184,
            "wegent-sites",
            serde_json::json!({
                "name": "Wegent Sites",
                "mcpUrl": TEST_MCP_URL,
                "enabled": true,
                "iconUrl": null,
                "authType": "none",
                "transport": "streamable-http",
                "visibility": "all",
                "description": "d",
                "allowedRoles": [],
                "toolAllowlist": []
            }),
        );
        let app = row_to_app(&row);
        assert_eq!(app.slug, "wegent-sites");
        assert_eq!(app.name, "Wegent Sites");
        assert_eq!(app.auth_type, "none");
        assert_eq!(app.transport, "streamable-http");
        assert_eq!(app.mcp_url, TEST_MCP_URL);
        assert_eq!(app.visibility, "all");
        assert!(app.enabled);
        assert_eq!(app.icon_url, None);
    }

    #[test]
    fn row_to_app_defaults_missing_spec_fields() {
        let row = app_row(1, "bare", serde_json::json!({}));
        let app = row_to_app(&row);
        assert_eq!(app.auth_type, "none");
        assert_eq!(app.transport, "streamable-http");
        assert_eq!(app.visibility, "all");
        assert_eq!(app.name, "bare");
        assert_eq!(app.description, "");
        assert_eq!(app.mcp_url, "");
        assert!(app.enabled);
    }

    #[test]
    fn visible_apps_filter_disabled_and_role_visibility() {
        let rows = [
            app_row(
                1,
                "on",
                serde_json::json!({"enabled": true, "visibility": "all"}),
            ),
            app_row(
                2,
                "off",
                serde_json::json!({"enabled": false, "visibility": "all"}),
            ),
            app_row(
                3,
                "admin-only",
                serde_json::json!({"enabled": true, "visibility": "roles", "allowedRoles": ["admin"]}),
            ),
        ];
        let apps: Vec<ConnectorApp> = rows.iter().map(row_to_app).collect();
        let visible = list_visible_apps(&apps, &user());
        let slugs: Vec<&str> = visible.iter().map(|app| app.slug.as_str()).collect();
        assert_eq!(slugs, vec!["on"]);
    }

    #[test]
    fn connection_view_requires_no_auth_for_connected() {
        let none = app_row(1, "a", serde_json::json!({"authType": "none"}));
        let oauth = app_row(2, "b", serde_json::json!({"authType": "oauth2"}));
        assert_eq!(connection_view(&row_to_app(&none)).status, "connected");
        assert_eq!(connection_view(&row_to_app(&oauth)).status, "disconnected");
    }
}
