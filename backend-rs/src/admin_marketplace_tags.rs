// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/system-config/marketplace-tags` — the admin marketplace
//! tag catalog.
//!
//! Mirrors `app.api.endpoints.admin.system_config.get_marketplace_tags_config`:
//! require an authenticated admin (`app.core.security.get_admin_user`), then
//! render the shared catalog through
//! [`marketplace_tags::get_config`] (`MarketplaceTagService.get_config`).
use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::marketplace_tags::{self, MarketplaceTagsResponse};
use crate::state::AppState;
use brz_mysql::Mysql;

/// `get_admin_user`: a non-admin role renders
/// `403 {"detail": "Permission denied. Admin access required."}`.
fn require_admin(current_user: &UserRow) -> Result<(), FastApiError> {
    if current_user.role == "admin" {
        Ok(())
    } else {
        Err(FastApiError::forbidden(
            "Permission denied. Admin access required.",
        ))
    }
}

/// GET /api/admin/system-config/marketplace-tags: the catalog free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/admin/system-config/marketplace-tags")]
async fn get_marketplace_tags_config(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<MarketplaceTagsResponse, FastApiError> {
    marketplace_tags_config(&state.mysql, current_user.0).await
}

/// Handler body for `GET /api/admin/system-config/marketplace-tags`.
async fn marketplace_tags_config<M>(
    mysql: &M,
    current_user: UserRow,
) -> Result<MarketplaceTagsResponse, FastApiError>
where
    M: Mysql,
{
    require_admin(&current_user)?;
    marketplace_tags::get_config(mysql).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_compat::OpaqueJson;
    use crate::sql_test_support::KindQueryCapture;
    use brz_mysql::Json;
    use chrono::NaiveDate;

    fn user(role: &str) -> UserRow {
        UserRow {
            id: 1001,
            user_name: "example-user".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("example-user@example.invalid".to_string()),
            git_info: Json(OpaqueJson::from_serializable(())),
            is_active: 1,
            role: role.to_string(),
            auth_source: "dingtalk".to_string(),
            preferences: "{}".to_string(),
            created_at: NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        }
    }

    #[tokio::test]
    async fn absent_row_selects_defaults_with_version_zero() {
        let mysql = KindQueryCapture::default();
        let response = marketplace_tags_config(&mysql, user("admin"))
            .await
            .unwrap();
        assert_eq!(response.version, 0);
        assert_eq!(response.items, marketplace_tags::default_items());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM system_configs"));
        assert!(
            queries[0]
                .sql
                .contains("WHERE system_configs.config_key = 'marketplace_tags'")
        );
        assert_eq!(queries[0].args, 0);
    }

    #[tokio::test]
    async fn non_admin_is_forbidden_without_a_read() {
        let mysql = KindQueryCapture::default();
        let error = marketplace_tags_config(&mysql, user("user"))
            .await
            .unwrap_err();
        assert_eq!(error.status(), brz_http_server::StatusCode::FORBIDDEN);
        assert_eq!(
            error.validation_detail(),
            "\"Permission denied. Admin access required.\""
        );
        assert!(mysql.queries().is_empty());
    }
}
