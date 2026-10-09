// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Service logic for `GET /api/admin/connector-apps`.
//!
//! Ports `ConnectorAppService.admin_response` over the already-ported
//! `list_all_apps`/`_row_to_app` projection in `apps_installed::service`.
use brz_mysql::Mysql;

use crate::apps_installed::service::ConnectorApp;

use super::crypto::{self, CryptoError};
use super::db;
use super::models::{ConnectorAppAdminResponse, isoformat};

/// Failure of one administrator projection. Both arms render the source's
/// unhandled-exception 500, but stay distinct for logging.
#[derive(Debug)]
pub enum AdminError {
    Mysql(brz_mysql::MysqlError),
    ProviderHeaders(CryptoError),
}

impl From<brz_mysql::MysqlError> for AdminError {
    fn from(error: brz_mysql::MysqlError) -> Self {
        Self::Mysql(error)
    }
}

impl From<CryptoError> for AdminError {
    fn from(error: CryptoError) -> Self {
        Self::ProviderHeaders(error)
    }
}

impl std::fmt::Display for AdminError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mysql(error) => {
                write!(formatter, "connector app connection count failed: {error}")
            }
            Self::ProviderHeaders(_) => {
                formatter.write_str("connector app provider headers are not decryptable")
            }
        }
    }
}

/// `admin_response`: decrypt the stored provider headers (for the sorted name
/// list and the configured flag), count the app's active connections, and
/// build the full administrator view.
pub async fn admin_response<M>(
    mysql: &M,
    app: &ConnectorApp,
) -> Result<ConnectorAppAdminResponse, AdminError>
where
    M: Mysql,
{
    let provider_header_names =
        crypto::provider_header_names(app.provider_headers_encrypted.as_deref())?;
    let connection_count = db::count_connector_connections(mysql, &app.slug).await?;
    Ok(project(app, provider_header_names, connection_count))
}

/// The pure field projection of `admin_response`, split out so the mapping is
/// testable without a database.
fn project(
    app: &ConnectorApp,
    provider_header_names: Vec<String>,
    connection_count: i64,
) -> ConnectorAppAdminResponse {
    // `provider_headers_configured=bool(provider_headers)`: every kept entry
    // has a string value, so an empty name list is the empty header object.
    let provider_headers_configured = !provider_header_names.is_empty();
    ConnectorAppAdminResponse {
        id: app.id,
        slug: app.slug.clone(),
        name: app.name.clone(),
        description: app.description.clone(),
        icon_url: app.icon_url.clone(),
        enabled: app.enabled,
        visibility: app.visibility.clone(),
        allowed_roles: app.allowed_roles.clone(),
        auth_type: app.auth_type.clone(),
        transport: app.transport.clone(),
        mcp_url: app.mcp_url.clone(),
        provider_header_names,
        provider_headers_configured,
        forward_user_context_headers: app.forward_user_context_headers,
        tool_allowlist: app.tool_allowlist.clone(),
        http_tools: app.http_tools.clone(),
        connection_count,
        created_at: isoformat(app.created_at),
        updated_at: isoformat(app.updated_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps_installed::db::KindRow;
    use crate::apps_installed::service::row_to_app;
    use crate::json_compat::OpaqueJson;

    /// One `ConnectorApp` projection from a `{"spec": ...}` document text,
    /// which is the exact shape a connector spec stores.
    fn app(spec: &str) -> ConnectorApp {
        let document = format!(r#"{{"spec":{spec}}}"#);
        let row = KindRow {
            kinds_id: 42,
            kinds_user_id: 0,
            kinds_kind: "ConnectorApp".to_string(),
            kinds_name: "example-app".to_string(),
            kinds_namespace: "system".to_string(),
            kinds_json: brz_mysql::Json(
                OpaqueJson::from_json_text(&document).expect("fixture document is valid JSON"),
            ),
            kinds_is_active: true,
            kinds_created_at: chrono::NaiveDateTime::parse_from_str(
                "2026-01-02 03:04:05",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
            kinds_updated_at: chrono::NaiveDateTime::parse_from_str(
                "2026-02-03 04:05:06",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        };
        row_to_app(&row)
    }

    /// `project` maps the runtime app and the counted connections onto the
    /// administrator response.
    #[test]
    fn project_maps_the_connector_app_onto_the_admin_response() {
        let app = app(
            r#"{"name":"Example App","description":"Example description","mcpUrl":"http://mcp.example.invalid/mcp","enabled":true,"iconUrl":"http://icons.example.invalid/app.png","authType":"bearer","transport":"sse","visibility":"roles","allowedRoles":["admin"],"forwardUserContextHeaders":true,"toolAllowlist":["ping"]}"#,
        );
        let response = project(&app, vec!["Authorization".to_string()], 2);
        assert_eq!(response.id, 42);
        assert_eq!(response.slug, "example-app");
        assert_eq!(response.name, "Example App");
        assert_eq!(response.description, "Example description");
        assert_eq!(
            response.icon_url.as_deref(),
            Some("http://icons.example.invalid/app.png")
        );
        assert!(response.enabled);
        assert_eq!(response.visibility, "roles");
        assert_eq!(response.allowed_roles, vec!["admin"]);
        assert_eq!(response.auth_type, "bearer");
        assert_eq!(response.transport, "sse");
        assert_eq!(response.mcp_url, "http://mcp.example.invalid/mcp");
        assert_eq!(response.provider_header_names, vec!["Authorization"]);
        assert!(response.provider_headers_configured);
        assert!(response.forward_user_context_headers);
        assert_eq!(response.tool_allowlist, vec!["ping"]);
        assert!(response.http_tools.is_empty());
        assert_eq!(response.connection_count, 2);
        assert_eq!(response.created_at, "2026-01-02T03:04:05");
        assert_eq!(response.updated_at, "2026-02-03T04:05:06");
    }

    /// The empty spec falls back to the source defaults, and an absent
    /// `providerHeadersEncrypted` yields the empty header list.
    #[test]
    fn project_applies_the_source_defaults() {
        let app = app("{}");
        let response = project(&app, Vec::new(), 0);
        assert_eq!(response.name, "example-app");
        assert_eq!(response.description, "");
        assert_eq!(response.icon_url, None);
        assert!(response.enabled);
        assert_eq!(response.visibility, "all");
        assert_eq!(response.auth_type, "none");
        assert_eq!(response.transport, "streamable-http");
        assert_eq!(response.mcp_url, "");
        assert!(!response.forward_user_context_headers);
        assert!(!response.provider_headers_configured);
    }

    #[test]
    fn configured_flag_follows_the_provider_header_names() {
        let app = app("{}");
        assert!(!project(&app, Vec::new(), 3).provider_headers_configured);
        assert!(project(&app, vec!["Authorization".to_string()], 3).provider_headers_configured);
    }

    #[test]
    fn forward_user_context_headers_defaults_to_false() {
        let app = app("{}");
        assert!(!app.forward_user_context_headers);
        assert_eq!(app.provider_headers_encrypted, None);
        assert!(app.http_tools.is_empty());
    }

    #[test]
    fn http_tools_and_provider_headers_survive_the_projection() {
        let app = app(
            r#"{"forwardUserContextHeaders":false,"providerHeadersEncrypted":"cipher","httpTools":[{"name":"ping","path":"/ping"}]}"#,
        );
        assert_eq!(app.provider_headers_encrypted.as_deref(), Some("cipher"));
        assert!(!app.forward_user_context_headers);
        assert_eq!(app.http_tools.len(), 1);
    }

    /// A non-array `httpTools` and a non-string `providerHeadersEncrypted` keep
    /// the rest of the spec and fall back to their defaults.
    #[test]
    fn malformed_optional_spec_fields_do_not_invalidate_the_spec() {
        let app = app(r#"{"name":"Kept","httpTools":5,"providerHeadersEncrypted":7}"#);
        assert_eq!(app.name, "Kept");
        assert!(app.http_tools.is_empty());
        assert_eq!(app.provider_headers_encrypted, None);
    }
}
