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
use std::collections::{BTreeMap, HashMap};

use brz_mysql::{Mysql, MysqlError, MysqlResult};
use serde::Deserialize;

use brz_json::FieldState as _;
use brz_json::{JsonProjection, OpaqueJson};

use super::connection::{self, ConnectorConnection};
use super::db::{self, KindRow, UserRow};
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
    /// `spec["providerHeadersEncrypted"]`; the administrator view decrypts it.
    pub provider_headers_encrypted: Option<String>,
    pub forward_user_context_headers: bool,
    /// `list(spec.get("httpTools") or [])`; the administrator view echoes it.
    pub http_tools: Vec<OpaqueJson>,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
}

/// The `spec` object of one `kinds` row (`ConnectorAppService._spec`).
///
/// Every field decodes like the source's `spec.get(key) or default` chain:
/// missing and `null` use field defaults. Wrong string/list shapes reject
/// the typed projection, causing `from_row` to use the whole-spec default.
#[brz_json::model]
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AppSpec {
    #[serde(deserialize_with = "brz_json::adapters::null_as_default")]
    name: String,
    #[serde(deserialize_with = "brz_json::adapters::null_as_default")]
    description: String,
    #[serde(rename = "iconUrl")]
    icon_url: Option<String>,
    enabled: Option<bool>,
    #[serde(deserialize_with = "brz_json::adapters::null_as_default")]
    visibility: String,
    #[serde(
        rename = "allowedRoles",
        deserialize_with = "brz_json::adapters::null_as_default"
    )]
    allowed_roles: Vec<String>,
    #[serde(
        rename = "authType",
        deserialize_with = "brz_json::adapters::null_as_default"
    )]
    auth_type: String,
    #[serde(deserialize_with = "brz_json::adapters::null_as_default")]
    transport: String,
    #[serde(
        rename = "mcpUrl",
        deserialize_with = "brz_json::adapters::null_as_default"
    )]
    mcp_url: String,
    #[serde(
        rename = "toolAllowlist",
        deserialize_with = "brz_json::adapters::null_as_default"
    )]
    tool_allowlist: Vec<String>,
    /// `spec.get("providerHeadersEncrypted")`: only a string is kept.
    #[serde(rename = "providerHeadersEncrypted")]
    #[json(presence, lenient)]
    provider_headers_encrypted: String,
    /// `bool(spec.get("forwardUserContextHeaders", False))`: only a JSON
    /// boolean is truthy here.
    #[serde(rename = "forwardUserContextHeaders")]
    #[json(presence, lenient)]
    forward_user_context_headers: bool,
    /// `list(spec.get("httpTools") or [])`: a JSON array of opaque tool
    /// definitions is kept, every other shape is empty.
    #[serde(rename = "httpTools")]
    #[json(presence, lenient)]
    http_tools: Vec<OpaqueJson>,
}

#[derive(Debug, Default, Deserialize)]
struct AppDocument {
    #[serde(default)]
    spec: Option<AppSpec>,
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
        provider_headers_encrypted: spec.provider_headers_encrypted.into_value(),
        forward_user_context_headers: spec
            .forward_user_context_headers
            .into_value()
            .unwrap_or(false),
        http_tools: spec.http_tools.into_value().unwrap_or_default(),
        created_at: row.kinds_created_at,
        updated_at: row.kinds_updated_at,
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

/// `user_response` connection view: `connector_connection_service.response`
/// of the caller's stored connection, or the `auth_type == "none"` default
/// that the source synthesizes without a lookup.
pub(crate) async fn user_connection<M>(
    mysql: &M,
    app: &ConnectorApp,
    user_id: i64,
) -> MysqlResult<ConnectionResponse>
where
    M: Mysql,
{
    if app.auth_type == "none" {
        return Ok(connected_no_auth());
    }
    let row = db::find_connector_connection(mysql, &app.slug, user_id).await?;
    let connection = row.as_ref().map(ConnectorConnection::from_row);
    Ok(connection::response(connection.as_ref()))
}

/// Whether the app is connected for the user (`_connected_apps`).
///
/// `auth_type == "none"` apps are always connected; every other app requires
/// the caller's stored `ConnectorConnection` to have a `connected` view.
pub(crate) async fn app_connected<M>(
    mysql: &M,
    app: &ConnectorApp,
    user_id: i64,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    if app.auth_type == "none" {
        return Ok(true);
    }
    let row = db::find_connector_connection(mysql, &app.slug, user_id).await?;
    let connection = row.as_ref().map(ConnectorConnection::from_row);
    Ok(connection::response(connection.as_ref()).status == "connected")
}

/// `_connected_apps`: the visible apps whose connection view is `connected`.
/// Every authorization lookup completes before tool discovery starts, exactly
/// like the source's separate `_connected_apps` pass.
pub(crate) async fn connected_apps<'a, M>(
    mysql: &M,
    apps: &'a [ConnectorApp],
    user: &UserRow,
) -> MysqlResult<Vec<&'a ConnectorApp>>
where
    M: Mysql,
{
    let mut connected = Vec::new();
    for app in list_visible_apps(apps, user) {
        if app_connected(mysql, app, user.users_id).await? {
            connected.push(app);
        }
    }
    Ok(connected)
}

/// One `_server_config` failure. `_upstream_tools` converts every one of
/// these into its 502 wrapper, which `list_tools` then skips.
#[derive(Debug)]
pub(crate) enum SessionError {
    /// The connection lookup failed.
    Database(MysqlError),
    /// `_get_encryption_key` could not resolve a usable key/IV.
    Crypto,
    /// The app is not connected or carries no access token.
    AuthorizationRequired,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "connection lookup failed: {error}"),
            Self::Crypto => formatter.write_str("sensitive-data decryption is not configured"),
            Self::AuthorizationRequired => {
                formatter.write_str("connector authorization is unavailable")
            }
        }
    }
}

/// `_server_config` session headers for the authenticated caller.
///
/// The source starts from `_decrypt_json(app.provider_headers_encrypted)`,
/// adds `Authorization: Bearer <decrypted access token>` for authorized apps,
/// and then always adds the caller's user context headers, forwarding them on
/// every request of the MCP session.
pub(crate) async fn session_headers<M>(
    mysql: &M,
    app: &ConnectorApp,
    user: &UserRow,
) -> Result<Vec<(String, String)>, SessionError>
where
    M: Mysql,
{
    let mut headers = provider_headers(app)?;
    if app.auth_type != "none" {
        let row = db::find_connector_connection(mysql, &app.slug, user.users_id)
            .await
            .map_err(SessionError::Database)?;
        let connection = row.as_ref().map(ConnectorConnection::from_row);
        // `_server_config` refreshes an expired connection before this check;
        // refresh lives in the OAuth service and is not reachable from the
        // recorded streamable-HTTP tool discovery.
        if connection::response(connection.as_ref()).status != "connected" {
            return Err(SessionError::AuthorizationRequired);
        }
        let access_token = connection
            .as_ref()
            .ok_or(SessionError::AuthorizationRequired)?
            .access_token()
            .map_err(|_| SessionError::Crypto)?;
        if access_token.is_empty() {
            return Err(SessionError::AuthorizationRequired);
        }
        insert_header(
            &mut headers,
            "Authorization",
            format!("Bearer {access_token}"),
        );
    }
    insert_header(
        &mut headers,
        "X-Wegent-Username",
        user.users_user_name.clone(),
    );
    insert_header(&mut headers, "X-Wegent-User-Id", user.users_id.to_string());
    Ok(headers)
}

/// `_decrypt_json(app.provider_headers_encrypted)`: the decrypted JSON object's
/// string-valued entries. `""` answers no headers; an undecryptable payload
/// keeps its stored text, which then fails JSON parsing and also answers none.
fn provider_headers(app: &ConnectorApp) -> Result<Vec<(String, String)>, SessionError> {
    let Some(value) = app
        .provider_headers_encrypted
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Ok(Vec::new());
    };
    let decrypted = crate::subscriptions_item::crypto::decrypt_sensitive_data(value)
        .map_err(|_| SessionError::Crypto)?;
    let body = if decrypted.is_empty() {
        "{}"
    } else {
        decrypted.as_str()
    };
    let parsed = OpaqueJson::from_json_text(body)
        .and_then(|document| document.project::<BTreeMap<String, JsonProjection<String>>>());
    Ok(parsed
        .map(|entries| {
            entries
                .into_iter()
                .filter_map(|(name, value)| value.value.map(|value| (name, value)))
                .collect()
        })
        .unwrap_or_default())
}

/// Python dict assignment: an existing key keeps its position and takes the
/// new value; a new key is appended.
fn insert_header(headers: &mut Vec<(String, String)>, name: &str, value: String) {
    if let Some(existing) = headers.iter_mut().find(|(key, _)| key == name) {
        existing.1 = value;
    } else {
        headers.push((name.to_string(), value));
    }
}

/// `connector_runtime_service.list_tools` restricted to this endpoint's
/// needs: per connected app, MCP tools filtered by the allowlist. Apps whose
/// discovery fails are skipped with a warning, exactly like the source's
/// `except HTTPException` branch. The connection lookup itself runs inside
/// `_connected_apps`, outside that catch, so its failures propagate.
async fn list_tools<M>(
    mysql: &M,
    apps: &[ConnectorApp],
    user: &UserRow,
) -> MysqlResult<Vec<ConnectorTool>>
where
    M: Mysql,
{
    let mut tools = Vec::new();
    for app in connected_apps(mysql, apps, user).await? {
        if app.transport == "http" {
            // HTTP-transport apps carry inline `httpTools` definitions; the
            // recorded deployment exposes none, so the definition list is
            // empty and contributes no tools.
            continue;
        }
        let headers = match session_headers(mysql, app, user).await {
            Ok(headers) => headers,
            // `_upstream_tools` wraps configuration failures in its 502
            // `HTTPException`, which `list_tools` skips.
            Err(error) => {
                tracing::warn!(
                    connector = %app.slug,
                    %error,
                    "skipping unavailable connector during tool discovery"
                );
                continue;
            }
        };
        let upstream: Vec<UpstreamTool> =
            match mcp::list_tools_with_headers(&app.mcp_url, &headers).await {
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
    Ok(tools)
}

/// Build the response for `installed_apps`.
pub async fn installed_apps<M>(
    mysql: &M,
    apps: &[ConnectorApp],
    user: &UserRow,
) -> MysqlResult<InstalledResponse>
where
    M: Mysql,
{
    // `_tool_summaries_by_app` runs discovery before the projection loop.
    let tools = list_tools(mysql, apps, user).await?;
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
        let connection = user_connection(mysql, app, user.users_id).await?;
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

    #[tokio::test]
    async fn user_connection_requires_no_auth_for_connected() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let none = app_row(1, "a", serde_json::json!({"authType": "none"}));
        let oauth = app_row(2, "b", serde_json::json!({"authType": "oauth2"}));
        assert_eq!(
            user_connection(&mysql, &row_to_app(&none), 83)
                .await
                .unwrap()
                .status,
            "connected"
        );
        assert_eq!(
            user_connection(&mysql, &row_to_app(&oauth), 83)
                .await
                .unwrap()
                .status,
            "disconnected"
        );
        // Only the authorized app needs a stored connection lookup.
        assert_eq!(mysql.queries().len(), 1);
        assert!(mysql.queries()[0].sql.contains("ConnectorConnection"));
        assert_eq!(mysql.queries()[0].args, 2);
    }

    #[tokio::test]
    async fn app_connected_looks_up_the_stored_authorization() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let none = app_row(1, "a", serde_json::json!({"authType": "none"}));
        let oauth = app_row(2, "b", serde_json::json!({"authType": "oauth2"}));
        assert!(app_connected(&mysql, &row_to_app(&none), 83).await.unwrap());
        // The capture returns no connection row, so the OAuth app is not
        // connected.
        assert!(
            !app_connected(&mysql, &row_to_app(&oauth), 83)
                .await
                .unwrap()
        );
        assert_eq!(mysql.queries().len(), 1);
    }

    #[tokio::test]
    async fn session_headers_carry_the_user_context() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let app = row_to_app(&app_row(1, "a", serde_json::json!({"authType": "none"})));
        let user = UserRow {
            users_id: 83,
            users_user_name: "junshu".to_string(),
            ..user()
        };
        assert_eq!(
            session_headers(&mysql, &app, &user).await.unwrap(),
            vec![
                ("X-Wegent-Username".to_string(), "junshu".to_string()),
                ("X-Wegent-User-Id".to_string(), "83".to_string()),
            ]
        );
        assert!(mysql.queries().is_empty());
    }
}
