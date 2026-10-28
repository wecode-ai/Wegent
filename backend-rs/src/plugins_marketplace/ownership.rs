// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Verify source ownership independently of publication and sharing state.

use brz_mysql::{FromMysqlRow, Mysql};
use serde::Serialize;

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

#[derive(FromMysqlRow)]
struct OwnedPlugin {
    id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginOwnerResponse {
    plugin_id: i64,
}

#[brz_http_server::get("/api/plugins/marketplace/:plugin_id/owner")]
async fn get_marketplace_plugin_owner(
    #[inject(state)] state: &AppState,
    plugin_id: &str,
    #[auth] user: SessionUser,
) -> Result<PluginOwnerResponse, FastApiError> {
    let plugin_id = plugin_id.parse::<i64>().map_err(|_| not_found())?;
    verify_owner(&state.mysql, i64::from(user.id), plugin_id).await
}

async fn verify_owner<M: Mysql>(
    mysql: &M,
    user_id: i64,
    plugin_id: i64,
) -> Result<PluginOwnerResponse, FastApiError> {
    let owned: Option<OwnedPlugin> = mysql
        .fetch_optional(
            "SELECT id FROM plugins WHERE owner_user_id = ? AND id = ? \
             AND status <> 'deleted' LIMIT 1",
            (user_id, plugin_id),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "plugin source ownership lookup failed");
            FastApiError::internal()
        })?;
    owner_response(owned)
}

fn owner_response(plugin: Option<OwnedPlugin>) -> Result<PluginOwnerResponse, FastApiError> {
    plugin
        .map(|plugin| PluginOwnerResponse {
            plugin_id: plugin.id,
        })
        .ok_or_else(not_found)
}

fn not_found() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::NOT_FOUND,
        "Owned plugin not found",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn owner_lookup_is_scoped_to_the_current_user_without_shareability_filters() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();

        assert!(verify_owner(&mysql, 71, 42).await.is_err());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].first_integer, Some(71));
        assert_eq!(queries[0].args, 2);
        assert!(queries[0].sql.contains("owner_user_id = ? AND id = ?"));
        assert!(queries[0].sql.contains("status <> 'deleted'"));
        assert!(!queries[0].sql.contains("visibility"));
        assert!(!queries[0].sql.contains("status = 'published'"));
    }

    #[test]
    fn ownership_confirmation_does_not_expose_source_or_share_policy() {
        let response = owner_response(Some(OwnedPlugin { id: 42 })).unwrap();
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({"pluginId": 42})
        );
        assert!(owner_response(None).is_err());
    }
}
