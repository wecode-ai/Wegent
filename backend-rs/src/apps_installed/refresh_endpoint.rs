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
        refresh::refresh(mysql, &app, user.users_id)
            .await
            .map_err(map_refresh_error)?;
        row = db::find_connector_connection(mysql, slug, user.users_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, CONNECTION_NOT_FOUND))?;
    }

    match probe_upstream(mysql, &app, user).await {
        Ok(()) => {
            let discovered_at = Utc::now().to_rfc3339();
            let _ =
                refresh::write_discovery_state(mysql, &row, Some(&discovered_at), None).await;
        }
        Err(message) => {
            let _ = refresh::write_discovery_state(mysql, &row, None, Some(&message)).await;
        }
    }

    let refreshed = db::find_connector_connection(mysql, slug, user.users_id)
        .await
        .map_err(internal_error)?;
    let current = refreshed.as_ref().map(ConnectorConnection::from_row);
    Ok(connection::response(current.as_ref()))
}

/// Probe the app's MCP endpoint once with the stored credential.
async fn probe_upstream<M>(mysql: &M, app: &ConnectorApp, user: &UserRow) -> Result<(), String>
where
    M: Mysql,
{
    if app.transport == "http" {
        return Ok(());
    }
    let headers = service::session_headers(mysql, app, user)
        .await
        .map_err(|error| error.to_string())?;
    mcp::list_tools_with_headers(&app.mcp_url, &headers)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn map_refresh_error(error: RefreshError) -> FastApiError {
    match error {
        RefreshError::Rejected => FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Connector authorization was rejected",
        ),
        RefreshError::Unavailable => FastApiError::detail(StatusCode::NOT_FOUND, CONNECTION_NOT_FOUND),
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
}
