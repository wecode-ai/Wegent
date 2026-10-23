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
) -> Result<ConnectorToolListResponse, FastApiError> {
    connector_tools(state, &user).await
}

/// Handler body for `GET /api/connector-runtime/tools`.
async fn connector_tools(
    state: &Arc<AppState>,
    user: &super::auth::ConnectorUser,
) -> Result<ConnectorToolListResponse, FastApiError> {
    let rows = db::list_connector_app_kinds(&state.mysql)
        .await
        .map_err(|error| {
            tracing::error!(%error, "connector app catalog read failed");
            FastApiError::internal()
        })?;
    let catalog: Vec<apps::ConnectorApp> = rows.iter().map(apps::row_to_app).collect();
    let tools = service::list_tools(&state.mysql, &catalog, user).await?;
    Ok(ConnectorToolListResponse { tools })
}

#[cfg(test)]
mod tests {
    use brz_http_server::__private::inventory;

    const PATH: &str = "/api/connector-runtime/tools";

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
