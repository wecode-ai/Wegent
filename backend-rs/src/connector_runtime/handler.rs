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
    #[header] authorization: Option<&str>,
) -> Result<ConnectorToolListResponse, FastApiError> {
    connector_tools(state, authorization).await
}

/// Handler body for `GET /api/connector-runtime/tools`.
async fn connector_tools(
    state: &Arc<AppState>,
    authorization: Option<&str>,
) -> Result<ConnectorToolListResponse, FastApiError> {
    let user = super::auth::authenticate(state, authorization).await?;
    let rows = db::list_connector_app_kinds(&state.mysql)
        .await
        .map_err(|error| {
            tracing::error!(%error, "connector app catalog read failed");
            FastApiError::internal()
        })?;
    let catalog: Vec<apps::ConnectorApp> = rows.iter().map(apps::row_to_app).collect();
    let tools = service::list_tools(&catalog, &user).await;
    Ok(ConnectorToolListResponse { tools })
}

#[cfg(test)]
mod tests {
    use brz_http_server::__private::inventory;

    /// The connector-runtime tool listing is registered exactly once in the
    /// public route group. Before this repair the path had no route at all, so
    /// the listener answered the recorded request with a framework 404.
    #[test]
    fn tool_listing_is_registered_in_the_public_group() {
        let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .filter(|path| *path == "/api/connector-runtime/tools")
            .collect();
        assert_eq!(paths, ["/api/connector-runtime/tools"]);
    }
}
