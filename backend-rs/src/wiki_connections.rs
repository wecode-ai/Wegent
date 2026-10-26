// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/wiki/connections` — the caller's stored external Wiki
//! connections plus the builtin connector catalog
//! (`app.api.endpoints.external_wiki.list_wiki_connections`).
//!
//! Source pipeline:
//!
//! 1. `security.get_current_user` — the active user by session name;
//! 2. `WikiConnectionService.list_connections` ->
//!    `external_source_connection_service.list_owned(db, owner_user_id,
//!    provider_id="wiki")`: the `kinds` scan for
//!    `kind='ExternalSourceConnection' AND namespace='wiki' AND user_id` and
//!    `is_active IS true`, ordered by `created_at ASC, id ASC`, then the
//!    decrypted summary projection (`id`, `display_name`, `enabled`,
//!    `connector_type`, `site_url`, `default_locale`, `api_key_masked`);
//! 3. `_available_connectors()` — `register_builtin_connectors()` followed by
//!    `WIKI_CONNECTORS.list()`: the three shipped connectors in registration
//!    order (Wiki.js, GitLab Repo, GitLab Wiki) with their capability
//!    records. The registry is append-only, so the catalog is static.
//!
//! `_connection_summary` reads `stored.config` for `site_url` and
//! `default_locale` and masks the decrypted `credentials.api_key`
//! (`len <= 8` renders `****`, otherwise `first4****last4`).
//!
//! Recorded source evidence (`api-wiki-connections/073772b9`): the
//! authenticated `users` lookup by user name, the `kinds` connection scan
//! returning no rows, and two trailing `ROLLBACK` session cleanups the source
//! driver issues at request end; Replay classifies them as optional, so no
//! rollback statements are issued here.
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::{python_str, python_truthy};
use crate::state::AppState;

/// `external_source_connections.EXTERNAL_SOURCE_CONNECTION_KIND`.
const EXTERNAL_SOURCE_CONNECTION_KIND: &str = "ExternalSourceConnection";
/// `external_document_identity.WIKI_PROVIDER_ID` (the `kinds` namespace).
const WIKI_PROVIDER_ID: &str = "wiki";

/// `kinds` columns as rendered by `db.query(Kind)` (SQLAlchemy labels every
/// column `kinds_<name>`).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
     kinds_created_at, kinds.updated_at AS kinds_updated_at";

/// `WikiConnectorCapabilities` (`app/schemas/external_wiki.py`); field order
/// follows the pydantic model's declaration order.
#[derive(Debug, Clone, Serialize)]
struct WikiConnectorCapabilities {
    resource_kind: &'static str,
    supports_locale: bool,
    supports_project_selection: bool,
    supports_branch_selection: bool,
    supports_scheduled_sync: bool,
}

/// `WikiConnectorOption`.
#[derive(Debug, Clone, Serialize)]
struct WikiConnectorOption {
    r#type: &'static str,
    display_name: &'static str,
    capabilities: WikiConnectorCapabilities,
}

/// `WikiConnectionSummary` (the per-connection projection of
/// `list_connections` plus `_connection_summary`'s resolved capabilities and
/// catalog).
#[derive(Debug, Serialize)]
struct WikiConnectionSummary {
    id: String,
    display_name: String,
    enabled: bool,
    connector_type: String,
    site_url: String,
    default_locale: Option<String>,
    api_key_masked: String,
    capabilities: WikiConnectorCapabilities,
    available_connectors: &'static [WikiConnectorOption],
}

/// `WikiConnectionsResponse`.
#[derive(Debug, Serialize)]
struct WikiConnectionsResponse {
    connections: Vec<WikiConnectionSummary>,
    available_connectors: &'static [WikiConnectorOption],
}

/// One `kinds` row of the connection scan. Only the members the summary reads
/// are declared; the remaining selected columns stay in the statement so the
/// rendered SQL matches the recorded exchange.
#[derive(Debug, FromMysqlRow)]
struct ConnectionKindRow {
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
}

/// `register_builtin_connectors()` registers exactly these connectors, in this
/// order, before `WIKI_CONNECTORS.list()` reads the registry.
static BUILTIN_CONNECTORS: [WikiConnectorOption; 3] = [
    // `WikijsConnector`: resource_kind="page", supports_locale=True.
    WikiConnectorOption {
        r#type: "wikijs",
        display_name: "Wiki.js",
        capabilities: WikiConnectorCapabilities {
            resource_kind: "page",
            supports_locale: true,
            supports_project_selection: false,
            supports_branch_selection: false,
            supports_scheduled_sync: true,
        },
    },
    // `GitLabRepoConnector`: resource_kind="file", project and branch
    // selection.
    WikiConnectorOption {
        r#type: "gitlab_repo",
        display_name: "GitLab Repo",
        capabilities: WikiConnectorCapabilities {
            resource_kind: "file",
            supports_locale: false,
            supports_project_selection: true,
            supports_branch_selection: true,
            supports_scheduled_sync: true,
        },
    },
    // `GitLabWikiConnector`: resource_kind="page", project selection.
    WikiConnectorOption {
        r#type: "gitlab_wiki",
        display_name: "GitLab Wiki",
        capabilities: WikiConnectorCapabilities {
            resource_kind: "page",
            supports_locale: false,
            supports_project_selection: true,
            supports_branch_selection: false,
            supports_scheduled_sync: true,
        },
    },
];

/// GET /api/wiki/connections: the listing free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/wiki/connections")]
async fn list_wiki_connections(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<WikiConnectionsResponse, FastApiError> {
    let rows: Vec<ConnectionKindRow> = state
        .mysql
        .fetch_all(connections_sql(i64::from(current_user.id)), ())
        .await
        .map_err(internal)?;
    let connections = rows
        .into_iter()
        .map(connection_summary)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WikiConnectionsResponse {
        connections,
        available_connectors: &BUILTIN_CONNECTORS,
    })
}

/// `db.query(Kind).filter(kind == EXTERNAL_SOURCE_CONNECTION_KIND,
/// namespace == WIKI_PROVIDER_ID, user_id == <current>, is_active)
/// .order_by(Kind.created_at.asc(), Kind.id.asc()).all()`.
fn connections_sql(user_id: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = \
         '{EXTERNAL_SOURCE_CONNECTION_KIND}' AND kinds.namespace = '{WIKI_PROVIDER_ID}' \
         AND kinds.user_id = {user_id} AND kinds.is_active IS true \
         ORDER BY kinds.created_at ASC, kinds.id ASC"
    )
}

/// `WikiConnectionService.list_connections` + `_connection_summary` over one
/// stored row: the masked summary with the capabilities of the matching
/// connector (the `WikiConnectorCapabilities()` default when the stored
/// adapter type matches no registered connector).
fn connection_summary(row: ConnectionKindRow) -> Result<WikiConnectionSummary, FastApiError> {
    let document = row.json.0.to_value();
    let spec = stored_spec(&document)?;

    // `str(spec.get("displayName") or row.name)`.
    let display_name = python_or(&spec, "displayName", || row.name.clone());
    // `str(spec.get("adapterType") or "")`.
    let connector_type = python_or(&spec, "adapterType", String::new);
    // `bool(spec.get("enabled", True))`.
    let enabled = spec.get("enabled").is_none_or(python_truthy);
    // `dict(spec.get("config") or {})`.
    let config = stored_object(&spec, "config")?;
    // `str(stored.config.get("site_url") or "")`.
    let site_url = python_or(&config, "site_url", String::new);
    // `WikiConnectionSummary.default_locale: Optional[str]`; a non-string
    // value fails the response model with the unhandled 500.
    let default_locale = match config.get("default_locale") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return Err(FastApiError::unhandled()),
    };
    // `stored.credentials.get("api_key")`; `list_connections` masks the
    // decrypted key only when it is truthy.
    let credentials = decrypted_credentials(&spec)?;
    let api_key_masked = credentials
        .get("api_key")
        .filter(|api_key| !api_key.is_empty())
        .map_or_else(String::new, |api_key| mask_api_key(api_key));
    let capabilities = BUILTIN_CONNECTORS
        .iter()
        .find(|option| option.r#type == connector_type)
        .map(|option| option.capabilities.clone())
        .unwrap_or(WikiConnectorCapabilities {
            resource_kind: "page",
            supports_locale: false,
            supports_project_selection: false,
            supports_branch_selection: false,
            supports_scheduled_sync: false,
        });
    Ok(WikiConnectionSummary {
        id: row.name,
        display_name,
        enabled,
        connector_type,
        site_url,
        default_locale,
        api_key_masked,
        capabilities,
        available_connectors: &BUILTIN_CONNECTORS,
    })
}

/// `dict((row.json or {}).get("spec") or {})`. A truthy non-object document
/// has no `.get` and is the source's unhandled `AttributeError`; a falsy
/// document projects the empty spec.
fn stored_spec(document: &Value) -> Result<serde_json::Map<String, Value>, FastApiError> {
    let empty = serde_json::Map::new();
    let root = match document {
        Value::Null => &empty,
        Value::Object(map) => map,
        other if python_truthy(other) => return Err(FastApiError::unhandled()),
        _ => &empty,
    };
    stored_object(root, "spec")
}

/// `dict(value.get(key) or {})` for a nested mapping: a falsy value projects
/// the empty mapping and a truthy non-object is the source's unhandled
/// `ValueError`/`TypeError` (a list of pairs is the one accepted shape this
/// projection does not model; connections are written as objects).
fn stored_object(
    map: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<serde_json::Map<String, Value>, FastApiError> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(serde_json::Map::new()),
        Some(Value::Object(object)) => Ok(object.clone()),
        Some(other) if !python_truthy(other) => Ok(serde_json::Map::new()),
        Some(_) => Err(FastApiError::unhandled()),
    }
}

/// `str(spec.get(key) or default)`.
fn python_or(
    map: &serde_json::Map<String, Value>,
    key: &str,
    default: impl FnOnce() -> String,
) -> String {
    map.get(key)
        .filter(|value| python_truthy(value))
        .map_or_else(default, python_str)
}

/// `_from_row`'s credentials projection: decrypt every non-empty string
/// member of `spec.credentialsEncrypted`. `decrypt_sensitive_data` keeps the
/// stored text when decryption fails and raises only on missing crypto
/// configuration (the source's unhandled 500).
fn decrypted_credentials(
    spec: &serde_json::Map<String, Value>,
) -> Result<HashMap<String, String>, FastApiError> {
    let encrypted = stored_object(spec, "credentialsEncrypted")?;
    encrypted
        .iter()
        .filter_map(|(key, value)| match value {
            Value::String(text) if !text.is_empty() => Some((key, text)),
            _ => None,
        })
        .map(|(key, text)| {
            crate::subscriptions_item::crypto::decrypt_sensitive_data(text)
                .map(|decrypted| (key.clone(), decrypted))
                .map_err(|_| FastApiError::unhandled())
        })
        .collect()
}

/// `WikiConnectionService.mask_api_key`: `****` for keys of at most eight
/// characters, otherwise `first4****last4`. Python counts characters rather
/// than UTF-8 bytes.
fn mask_api_key(api_key: &str) -> String {
    let characters: Vec<char> = api_key.chars().collect();
    if characters.len() <= 8 {
        return "****".to_string();
    }
    let first: String = characters[..4].iter().collect();
    let last: String = characters[characters.len() - 4..].iter().collect();
    format!("{first}****{last}")
}

/// Dependent-query failure mapped to the application's unhandled-exception
/// response.
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "wiki connection list database dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::OpaqueJson;

    /// The exact body recorded from the Python source for the representative
    /// case (`GET /api/wiki/connections`, no stored connections).
    const SOURCE_BODY: &str = "{\"connections\":[],\"available_connectors\":[\
        {\"type\":\"wikijs\",\"display_name\":\"Wiki.js\",\"capabilities\":\
        {\"resource_kind\":\"page\",\"supports_locale\":true,\
        \"supports_project_selection\":false,\"supports_branch_selection\":false,\
        \"supports_scheduled_sync\":true}},{\"type\":\"gitlab_repo\",\
        \"display_name\":\"GitLab Repo\",\"capabilities\":{\"resource_kind\":\"file\",\
        \"supports_locale\":false,\"supports_project_selection\":true,\
        \"supports_branch_selection\":true,\"supports_scheduled_sync\":true}},\
        {\"type\":\"gitlab_wiki\",\"display_name\":\"GitLab Wiki\",\"capabilities\":\
        {\"resource_kind\":\"page\",\"supports_locale\":false,\
        \"supports_project_selection\":true,\"supports_branch_selection\":false,\
        \"supports_scheduled_sync\":true}}]}";

    fn row(json: &str) -> ConnectionKindRow {
        ConnectionKindRow {
            name: "conn_1".to_owned(),
            json: Json(OpaqueJson::from_json_text(json).unwrap()),
        }
    }

    #[test]
    fn empty_listing_matches_the_recorded_source_body() {
        let response = WikiConnectionsResponse {
            connections: Vec::new(),
            available_connectors: &BUILTIN_CONNECTORS,
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            SOURCE_BODY,
            "the empty listing must render the recorded body exactly"
        );
    }

    #[test]
    fn connections_sql_matches_the_recorded_statement() {
        // The exact `kinds` statement recorded from the representative case
        // (`user_id = 1769`).
        let recorded = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.kind = \
             'ExternalSourceConnection' AND kinds.namespace = 'wiki' AND \
             kinds.user_id = 1769 AND kinds.is_active IS true \
             ORDER BY kinds.created_at ASC, kinds.id ASC";
        assert_eq!(connections_sql(1769), recorded);
    }

    #[test]
    fn summary_projects_the_stored_spec() {
        let json = r#"{
            "apiVersion": "agent.wecode.io/v1",
            "kind": "ExternalSourceConnection",
            "metadata": {"name": "conn_1", "namespace": "wiki"},
            "spec": {
                "displayName": "Team Wiki",
                "adapterType": "gitlab_wiki",
                "enabled": true,
                "revision": 2,
                "config": {"site_url": "https://git.example.com", "default_locale": "zh-CN"},
                "credentialsEncrypted": {}
            }
        }"#;
        let summary = connection_summary(row(json)).unwrap();
        assert_eq!(summary.id, "conn_1");
        assert_eq!(summary.display_name, "Team Wiki");
        assert!(summary.enabled);
        assert_eq!(summary.connector_type, "gitlab_wiki");
        assert_eq!(summary.site_url, "https://git.example.com");
        assert_eq!(summary.default_locale.as_deref(), Some("zh-CN"));
        assert_eq!(summary.api_key_masked, "");
        assert_eq!(summary.capabilities.resource_kind, "page");
        assert!(summary.capabilities.supports_project_selection);
        assert!(!summary.capabilities.supports_branch_selection);
        // `_connection_summary` embeds the full catalog in every item.
        assert_eq!(summary.available_connectors.len(), 3);
        assert_eq!(summary.available_connectors[0].r#type, "wikijs");
    }

    #[test]
    fn summary_defaults_an_absent_spec() {
        // `(row.json or {}).get("spec") or {}` and `str(spec.get(...) or "")`
        // default every absent member except the display name, which falls
        // back to the stored row name; `enabled` keeps the `bool(..., True)`
        // default and an unknown adapter takes the all-false capabilities.
        let summary = connection_summary(row("{}")).unwrap();
        assert_eq!(summary.id, "conn_1");
        assert_eq!(summary.display_name, "conn_1");
        assert!(summary.enabled);
        assert_eq!(summary.connector_type, "");
        assert_eq!(summary.site_url, "");
        assert_eq!(summary.default_locale, None);
        assert_eq!(summary.api_key_masked, "");
        assert_eq!(summary.capabilities.resource_kind, "page");
        assert!(!summary.capabilities.supports_scheduled_sync);
    }

    #[test]
    fn summary_uses_python_truthiness_for_stored_fields() {
        // A present but falsy `enabled` is `bool(value)`, not the default;
        // a falsy display name falls back to the row name.
        let json = r#"{
            "spec": {
                "displayName": "",
                "enabled": null,
                "config": {"site_url": 42, "default_locale": "en"}
            }
        }"#;
        let summary = connection_summary(row(json)).unwrap();
        assert_eq!(summary.display_name, "conn_1");
        assert!(!summary.enabled);
        assert_eq!(summary.site_url, "42");
    }

    #[test]
    fn a_truthy_non_object_document_is_the_unhandled_error() {
        assert!(connection_summary(row(r#"["spec"]"#)).is_err());
        assert!(connection_summary(row(r#"{"spec": "invalid"}"#)).is_err());
    }

    #[test]
    fn mask_api_key_matches_the_source_rules() {
        assert_eq!(mask_api_key("short"), "****");
        assert_eq!(mask_api_key("12345678"), "****");
        assert_eq!(mask_api_key("123456789"), "1234****6789");
        assert_eq!(mask_api_key("abcdefghijkl"), "abcd****ijkl");
        // Python counts characters, so a four-character Unicode suffix fits.
        assert_eq!(mask_api_key("密钥abcdefgh"), "密钥ab****efgh");
    }

    /// Python owns the route while the Rust handler stays registered.
    #[test]
    fn registered_route_keeps_python_ownership() {
        const PATH: &str = "/api/wiki/connections";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain Python-owned"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, "/api/wiki/connections"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
