// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/connector-apps` handler (source
//! `app/api/endpoints/admin/connector_apps.py::list_connector_apps`).
use std::sync::Arc;

use crate::apps_installed::{db as apps_db, service as apps_service};
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::models::ConnectorAppAdminResponse;
use super::service;

/// GET /api/admin/connector-apps: the administrator catalog listing,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/admin/connector-apps")]
async fn list_connector_apps(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] admin: SessionUser,
) -> Result<Vec<ConnectorAppAdminResponse>, FastApiError> {
    list(state, &admin).await
}

/// Handler body for `GET /api/admin/connector-apps`.
///
/// `list_all_apps` reads every active `ConnectorApp` kind, then
/// `admin_response` is applied per app. Database failures and the unswallowed
/// provider-header crypto configuration error both escape the source route and
/// render `python_exception_handler`'s 500.
async fn list(
    state: &Arc<AppState>,
    admin: &SessionUser,
) -> Result<Vec<ConnectorAppAdminResponse>, FastApiError> {
    ensure_admin(admin)?;
    let rows = apps_db::list_connector_app_kinds(&state.mysql)
        .await
        .map_err(|error| {
            tracing::error!(%error, "connector app catalog read failed");
            FastApiError::unhandled()
        })?;
    let mut responses = Vec::with_capacity(rows.len());
    for row in &rows {
        let app = apps_service::row_to_app(row);
        let response = service::admin_response(&state.mysql, &app)
            .await
            .map_err(|error| {
                tracing::error!(%error, "connector app admin projection failed");
                FastApiError::unhandled()
            })?;
        responses.push(response);
    }
    Ok(responses)
}

/// `get_admin_user`: an authenticated non-admin session is rejected with the
/// source `403 {"detail": "Permission denied. Admin access required."}`.
fn ensure_admin(user: &SessionUser) -> Result<(), FastApiError> {
    if user.role == "admin" {
        Ok(())
    } else {
        Err(FastApiError::forbidden(
            "Permission denied. Admin access required.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::__private::inventory;

    /// The administrator listing is registered exactly once in the public route
    /// group; before this migration the path had no route, so the listener
    /// answered the recorded request with the 502 fallback.
    #[test]
    fn admin_listing_is_registered_in_the_public_group() {
        let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .map(|route| route.path)
            .filter(|path| *path == "/api/admin/connector-apps")
            .collect();
        assert_eq!(paths, ["/api/admin/connector-apps"]);
    }

    /// A non-admin session is rejected before any catalog read, with the
    /// source's 403 detail.
    #[test]
    fn non_admin_is_forbidden() {
        let error = ensure_admin(&SessionUser(user_row("user"))).unwrap_err();
        assert_eq!(error.status(), brz_http_server::StatusCode::FORBIDDEN);
        assert_eq!(
            error.detail_message(),
            Some("Permission denied. Admin access required.")
        );
        assert!(ensure_admin(&SessionUser(user_row("admin"))).is_ok());
    }

    fn user_row(role: &str) -> crate::auth::UserRow {
        use crate::json_compat::OpaqueJson;
        crate::auth::UserRow {
            id: 1,
            user_name: "example-user".to_string(),
            users_password_hash: String::new(),
            email: None,
            git_info: brz_mysql::Json(OpaqueJson::from_serializable(Option::<u8>::None)),
            is_active: 1,
            role: role.to_string(),
            auth_source: "oidc".to_string(),
            preferences: String::new(),
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }
}
