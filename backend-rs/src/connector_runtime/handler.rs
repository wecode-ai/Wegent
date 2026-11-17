// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/connector-runtime/tools` handler (source
//! `app/api/endpoints/connector_runtime.py::list_connector_tools`).
use std::sync::Arc;

use crate::apps_installed::{db, service as apps};
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::models::ConnectorToolListResponse;
use super::service;

/// GET /api/connector-runtime/tools: the connector-runtime tool listing,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/connector-runtime/tools")]
async fn list_connector_tools(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: super::auth::ConnectorUser,
    #[header("x-connector-app")] app_scope: Option<&str>,
    #[header("x-connector-loading")] loading: Option<&str>,
) -> Result<ConnectorToolListResponse, FastApiError> {
    connector_tools(state, &user, app_scope, loading).await
}

/// Handler body for `GET /api/connector-runtime/tools`.
async fn connector_tools(
    state: &Arc<AppState>,
    user: &super::auth::ConnectorUser,
    app_scope: Option<&str>,
    loading: Option<&str>,
) -> Result<ConnectorToolListResponse, FastApiError> {
    let rows = db::list_connector_app_kinds(&state.mysql)
        .await
        .map_err(|error| {
            tracing::error!(%error, "connector app catalog read failed");
            FastApiError::internal()
        })?;
    let catalog: Vec<apps::ConnectorApp> = rows
        .iter()
        .map(apps::row_to_app)
        .filter(|app| app_scope.is_none_or(|slug| app.slug == slug))
        .collect();
    if let Some(slug) = app_scope {
        let app = apps::list_visible_apps(&catalog, user)
            .into_iter()
            .find(|app| app.slug == slug)
            .ok_or_else(|| FastApiError::not_found("Connector app not found"))?;
        // An on-demand discovery is an operation, not a best-effort inventory
        // read. Keep a missing grant distinguishable from an empty directory.
        apps::session_headers(&state.mysql, app, user)
            .await
            .map_err(|error| scoped_session_error(slug, error))?;
    }
    let compact = loading == Some("compact");
    let deferred_tools = if compact {
        let connected = apps::connected_apps(&state.mysql, &catalog, user)
            .await
            .map_err(|_| FastApiError::internal())?;
        Some(
            connected
                .into_iter()
                .filter(|app| app.tool_loading_mode == "lazy")
                .flat_map(super::loading::deferred_tools)
                .collect(),
        )
    } else {
        None
    };
    let catalog = catalog
        .into_iter()
        .filter(|app| !compact || app.tool_loading_mode != "lazy")
        .collect::<Vec<_>>();
    let tools = service::list_tools(&state.mysql, &catalog, user).await?;
    Ok(ConnectorToolListResponse {
        tools,
        deferred_tools,
    })
}

fn scoped_session_error(slug: &str, error: apps::SessionError) -> FastApiError {
    match error {
        apps::SessionError::AuthorizationRequired => {
            FastApiError::unauthorized(format!("Connector '{slug}' requires authorization"))
        }
        other => FastApiError::detail(
            brz_http_server::StatusCode::SERVICE_UNAVAILABLE,
            other.to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use brz_http_server::__private::inventory;

    const PATH: &str = "/api/connector-runtime/tools";

    #[test]
    fn scoped_discovery_distinguishes_missing_grants_from_configuration_errors() {
        let missing = super::scoped_session_error(
            "records",
            super::apps::SessionError::AuthorizationRequired,
        );
        assert_eq!(missing.status(), brz_http_server::StatusCode::UNAUTHORIZED);
        assert_eq!(
            missing.detail_message(),
            Some("Connector 'records' requires authorization")
        );
        let configuration =
            super::scoped_session_error("records", super::apps::SessionError::Crypto);
        assert_eq!(
            configuration.status(),
            brz_http_server::StatusCode::SERVICE_UNAVAILABLE
        );
        assert!(
            !configuration
                .detail_message()
                .unwrap()
                .contains("requires authorization")
        );
    }

    /// The connector-runtime tool listing is selected for Rust and registered
    /// exactly once in the public route group. Before this cutover the path had
    /// no active rule, so the listener forwarded the recorded request to the
    /// Python fallback, which answered the traffic `502 fallback upstream
    /// unavailable`.
    #[test]
    fn tool_listing_is_selected_and_registered_in_the_public_group() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = crate::RouteTable::compile(crate::load_routes_config(&file).unwrap()).unwrap();
        assert!(
            table.matches(&http::Method::GET, PATH),
            "GET {PATH} must be selected for Rust"
        );
        let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .filter(|path| *path == PATH)
            .collect();
        assert_eq!(paths, [PATH]);
    }
}
