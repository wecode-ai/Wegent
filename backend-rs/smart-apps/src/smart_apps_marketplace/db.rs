// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Database access for the Smart app marketplace listing.
//!
//! SQL strings reproduce the source SQLAlchemy statement shapes
//! (`SmartAppMarketplaceService.list_marketplace` and `_item`).
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use super::models::PublishedSmartAppRow;
use crate::user_reader::USER_ENTITY_BY_ID_QUERY;

/// `db.query(SmartApp).filter(SmartApp.status == "published").all()`.
pub const FIND_PUBLISHED_SMART_APPS: &str = "SELECT smart_apps.id AS smart_apps_id, smart_apps.owner_user_id AS smart_apps_owner_user_id, \
     smart_apps.name AS smart_apps_name, smart_apps.display_name AS smart_apps_display_name, \
     smart_apps.summary AS smart_apps_summary, \
     smart_apps.description_md AS smart_apps_description_md, \
     smart_apps.source_type AS smart_apps_source_type, \
     smart_apps.visibility AS smart_apps_visibility, \
     smart_apps.status AS smart_apps_status, smart_apps.tags_json AS smart_apps_tags_json, \
     smart_apps.icon_storage_key AS smart_apps_icon_storage_key, \
     smart_apps.screenshots_json AS smart_apps_screenshots_json, \
     smart_apps.extensions_json AS smart_apps_extensions_json, \
     smart_apps.latest_release_id AS smart_apps_latest_release_id, \
     smart_apps.featured_rank AS smart_apps_featured_rank, \
     smart_apps.is_listed AS smart_apps_is_listed, \
     smart_apps.created_at AS smart_apps_created_at, \
     smart_apps.updated_at AS smart_apps_updated_at, \
     smart_apps.published_at AS smart_apps_published_at \n\
     FROM smart_apps \nWHERE smart_apps.status = 'published'";

/// One `users` row projection for `db.get(User, app.owner_user_id)`.
#[derive(FromMysqlRow)]
struct UserNameRow {
    #[allow(dead_code, reason = "selected to match the source column list")]
    id: i64,
    user_name: String,
}

/// `db.query(SmartApp).filter(SmartApp.status == "published").all()` in the
/// database's returned order (the source applies no `ORDER BY`).
pub async fn find_published_apps<M>(mysql: &M) -> MysqlResult<Vec<PublishedSmartAppRow>>
where
    M: Mysql,
{
    mysql.fetch_all(FIND_PUBLISHED_SMART_APPS, ()).await
}

/// `db.get(User, owner_user_id)`: the owner's display name, or `None` when the
/// row is absent (or the source's falsy `owner_user_id` skips the lookup).
pub async fn find_user_name<M>(mysql: &M, user_id: i64) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    let row: Option<UserNameRow> = mysql
        .fetch_optional(USER_ENTITY_BY_ID_QUERY, (user_id,))
        .await?;
    Ok(row.map(|row| row.user_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_apps_query_matches_the_source_projection() {
        // Exact recorded statement (`sequence` 1734): every mapped column is
        // aliased `smart_apps_<column>` and the status filter is inlined.
        assert!(FIND_PUBLISHED_SMART_APPS.contains("smart_apps.id AS smart_apps_id"));
        assert!(FIND_PUBLISHED_SMART_APPS.contains(
            "smart_apps.published_at AS smart_apps_published_at \nFROM smart_apps \n\
             WHERE smart_apps.status = 'published'"
        ));
        assert_eq!(FIND_PUBLISHED_SMART_APPS.matches('?').count(), 0);
    }

    #[test]
    fn owner_lookup_reuses_the_session_get_statement() {
        assert!(USER_ENTITY_BY_ID_QUERY.contains("WHERE users.id = ?"));
        assert_eq!(USER_ENTITY_BY_ID_QUERY.matches('?').count(), 1);
    }
}
