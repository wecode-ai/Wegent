// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/installed` handler (source
//! `app/api/endpoints/installed_plugins.py::list_installed_plugins`).
use brz_json::raw_json;
use brz_mysql::MysqlResult;
#[derive(serde::Serialize)]
struct InstalledPluginsResponse {
    items: Vec<brz_json::RawJson>,
}

use super::auth;
use super::enrich_installed_list;
use super::kind_to_item;
use super::list_installed_kinds;
use crate::PluginState;
use crate::http_compat::FastApiError;

#[cfg(test)]
#[path = "list_mysql_tests.rs"]
mod mysql_tests;
#[cfg(test)]
#[path = "list_test_support.rs"]
mod test_support;
#[cfg(test)]
#[path = "list_tests.rs"]
mod tests;

/// GET /api/plugins/installed: the plugins-installed free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/plugins/installed")]
async fn list_installed_plugins(
    #[inject(state)] state: &PluginState,
    #[auth] user: auth::InstalledPluginsUser,
    device_id: Option<String>,
) -> Result<InstalledPluginsResponse, FastApiError> {
    installed(state, &user, device_id.as_deref()).await
}

/// POST /api/plugins/installed/report-device: acknowledge the plugins a device
/// reports as locally present (source `report_installed_plugins_on_device`).
#[brz_http_server::post("/api/plugins/installed/report-device")]
async fn report_installed_plugins_on_device(
    #[inject(state)] state: &PluginState,
    #[auth] user: auth::InstalledPluginsUser,
    device_id: String,
    payload: super::report::PluginDeviceReportRequest,
) -> Result<super::report::PluginDeviceReportResponse, FastApiError> {
    super::report::report_device(&state.mysql, user.id, &device_id, &payload.plugins).await
}

/// Handler body for `GET /api/plugins/installed`.
async fn installed(
    state: &PluginState,
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
    let start = std::time::Instant::now();
    let rows = list_installed_kinds(mysql, user_id).await?;
    tracing::debug!(
        item_count = rows.len(),
        elapsed_ms = start.elapsed().as_secs_f64() * 1000.0,
        "loaded installed plugins"
    );
    let mut items: Vec<serde_json::Value> = rows.iter().filter_map(kind_to_item).collect();
    enrich_installed_list(mysql, &mut items, device_id).await?;
    Ok(InstalledPluginsResponse {
        items: items.iter().map(raw_json).collect(),
    })
}
