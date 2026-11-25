// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Stored authorization for the external Connector App API.

use brz_http_server::StatusCode;
use brz_mysql::{Mysql, MysqlError};
use serde::Serialize;

use crate::apps_installed::{db, service};
use crate::http_compat::FastApiError;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationStatus {
    Authorized,
    AuthorizationRequired,
    NotRequired,
}

pub async fn lookup<M: Mysql>(
    mysql: &M,
    user_id: i64,
    slug: &str,
) -> Result<(i64, AuthorizationStatus), FastApiError> {
    let user = db::find_user_by_id(mysql, user_id)
        .await
        .map_err(lookup_failed)?
        .filter(|user| user.users_is_active)
        .ok_or_else(|| FastApiError::unauthorized("User not found or inactive"))?;
    let app = db::find_connector_app(mysql, slug)
        .await
        .map_err(lookup_failed)?
        .as_ref()
        .map(service::row_to_app)
        .filter(|app| app.slug == slug && service::is_visible(app, &user))
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Connector app not found"))?;
    let status = if app.auth_type == "none" {
        AuthorizationStatus::NotRequired
    } else if service::app_connected(mysql, &app, user_id)
        .await
        .map_err(lookup_failed)?
    {
        AuthorizationStatus::Authorized
    } else {
        AuthorizationStatus::AuthorizationRequired
    };
    Ok((app.id, status))
}

fn lookup_failed(error: MysqlError) -> FastApiError {
    tracing::error!(%error, "external connector authorization lookup failed");
    FastApiError::unhandled()
}
