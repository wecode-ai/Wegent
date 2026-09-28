// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/installed` handler (source
//! `app/api/endpoints/installed_plugins.py::list_installed_plugins`).
use crate::json_compat::raw_json;
use brz_mysql::MysqlResult;
#[derive(serde::Serialize)]
struct InstalledPluginsResponse {
    items: Vec<Box<serde_json::value::RawValue>>,
}

use super::auth;
use super::enrich_installed_list;
use super::kind_to_item;
use super::list_installed_kinds;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// GET /api/plugins/installed: the plugins-installed free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/plugins/installed")]
async fn list_installed_plugins(
    #[inject(state)] state: &AppState,
    #[auth] user: auth::InstalledPluginsUser,
    device_id: Option<String>,
) -> Result<InstalledPluginsResponse, FastApiError> {
    installed(state, &user, device_id.as_deref()).await
}

/// Handler body for `GET /api/plugins/installed`.
async fn installed(
    state: &AppState,
    user: &auth::InstalledPluginsUser,
    device_id: Option<&str>,
) -> Result<InstalledPluginsResponse, FastApiError> {
    match list_installed(&state.mysql, user.id, device_id).await {
        Ok(body) => Ok(body),
        Err(error) => {
            tracing::error!(%error, "list installed plugins failed");
            Err(FastApiError::internal())
        }
    }
}

async fn list_installed<M>(
    mysql: &M,
    user_id: i64,
    device_id: Option<&str>,
) -> MysqlResult<InstalledPluginsResponse>
where
    M: brz_mysql::Mysql,
{
    let rows = list_installed_kinds(mysql, user_id).await?;
    let mut items: Vec<serde_json::Value> = rows.iter().filter_map(kind_to_item).collect();
    enrich_installed_list(mysql, &mut items, device_id).await?;
    Ok(InstalledPluginsResponse {
        items: items.iter().map(raw_json).collect(),
    })
}
