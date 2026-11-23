// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `SmartAppMarketplaceService.list_marketplace`.
//!
//! Reads every published Smart app, resolves the caller's ERP-department
//! grants once, filters and ranks the catalog, and renders each visible entry.
use brz_mysql::{Mysql, MysqlResult};
use brz_redis::Redis;
use chrono::NaiveDateTime;
use serde_json::Value;

use super::db;
use super::models::{
    PublishedSmartAppRow, SmartAppMarketplaceItem, SmartAppMarketplaceListResponse, empty_object,
    json_truthy, object_or_empty, pydantic_datetime, string_list,
};
use crate::permissions::EntityResolvers;
use crate::smart_apps_download::artifact::presign_download_url;
use crate::smart_apps_download::db as smart_app_db;
use crate::smart_apps_download::models::SmartAppReleaseRow;
use crate::smart_apps_download::service::{namespace_grant_role, org_department_resource_ids};

/// `settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS` default for the owner-less
/// display fallback (`_item`'s `"Wegent"`).
const OFFICIAL_OWNER_DISPLAY_NAME: &str = "Wegent";

/// The optional request filters (`q`, `source`, `tag`), mirroring the
/// endpoint's query parameters.
#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct MarketplaceQuery {
    pub q: Option<String>,
    pub source: Option<String>,
    pub tag: Option<String>,
}

/// Failure modes of `list_marketplace`, mapped to responses by the handler.
pub enum ListError {
    /// `HTTPException(404, detail)` raised by `_latest_release`.
    NotFound(&'static str),
    /// A dependency failure the source's global handler renders as 500.
    Dependency,
    /// `MarketplaceArtifactStorageError` from `presign_download`, rendered as
    /// the endpoint's 503.
    Storage,
}

/// One visible catalog entry with the source sort key.
struct RankedItem {
    featured_rank: i64,
    is_official: bool,
    updated_at: NaiveDateTime,
    item: SmartAppMarketplaceItem,
}

/// `list_marketplace`: the caller's visible catalog, ranked exactly like the
/// source's `(featured_rank, sourceType == "official", updatedAt, id)` sort in
/// reverse order.
pub async fn list_marketplace<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    query: &MarketplaceQuery,
) -> Result<SmartAppMarketplaceListResponse, ListError>
where
    M: Mysql,
    R: Redis,
{
    let apps = db::find_published_apps(mysql)
        .await
        .map_err(|_| ListError::Dependency)?;
    // `get_org_department_resource_ids`: resolved once per request, before
    // the per-app access checks.
    let org_department_app_ids = org_department_resource_ids(mysql, redis, resolvers, user_id)
        .await
        .map_err(|_| ListError::Dependency)?;
    let normalized_query = query.q.as_deref().unwrap_or_default().trim().to_lowercase();
    let source = query.source.as_deref().unwrap_or_default();
    let tag = query.tag.as_deref().unwrap_or_default();

    let mut ranked: Vec<RankedItem> = Vec::new();
    for app in &apps {
        if app.visibility == "public" && !app.is_listed {
            continue;
        }
        let Some(role) = access_role(mysql, app, user_id, &org_department_app_ids)
            .await
            .map_err(|_| ListError::Dependency)?
        else {
            continue;
        };
        if role == "owner" && app.visibility != "public" {
            continue;
        }
        if source == "official" && app.source_type != "official" {
            continue;
        }
        if source == "public" && (app.source_type != "user" || app.visibility != "public") {
            continue;
        }
        if source == "shared" && role != "recipient" {
            continue;
        }
        let tags = string_list(&app.tags_json);
        if !tag.is_empty() && !tags.iter().any(|value| value == tag) {
            continue;
        }
        if !normalized_query.is_empty() && !matches_query(app, &normalized_query) {
            continue;
        }
        ranked.push(RankedItem {
            featured_rank: app.featured_rank,
            is_official: app.source_type == "official",
            updated_at: app.updated_at,
            item: item(mysql, app, role).await?,
        });
    }
    ranked.sort_by(|left, right| {
        let key = |row: &RankedItem| {
            (
                row.featured_rank,
                row.is_official,
                row.updated_at,
                row.item.id,
            )
        };
        key(right).cmp(&key(left))
    });
    Ok(SmartAppMarketplaceListResponse {
        items: ranked.into_iter().map(|row| row.item).collect(),
    })
}

/// `_access_role` with the caller's precomputed ERP department ids.
async fn access_role<M>(
    mysql: &M,
    app: &PublishedSmartAppRow,
    user_id: i64,
    org_department_app_ids: &[i64],
) -> MysqlResult<Option<&'static str>>
where
    M: Mysql,
{
    if app.source_type == "official" && app.visibility == "public" {
        return Ok(Some("official"));
    }
    if app.owner_user_id == user_id {
        return Ok(Some("owner"));
    }
    if app.visibility == "public" {
        return Ok(Some("public"));
    }
    if app.visibility != "restricted" {
        return Ok(None);
    }
    if org_department_app_ids.contains(&app.id) {
        return Ok(Some("recipient"));
    }
    namespace_grant_role(mysql, app.id, user_id).await
}

/// `normalized_query not in " ".join((name, display_name, summary,
/// description_md)).lower()`.
fn matches_query(app: &PublishedSmartAppRow, normalized_query: &str) -> bool {
    let haystack = format!(
        "{} {} {} {}",
        app.name, app.display_name, app.summary, app.description_md
    )
    .to_lowercase();
    haystack.contains(normalized_query)
}

/// `_item`: the latest release, owner display name, presigned assets, and the
/// rendered catalog entry.
async fn item<M>(
    mysql: &M,
    app: &PublishedSmartAppRow,
    role: &str,
) -> Result<SmartAppMarketplaceItem, ListError>
where
    M: Mysql,
{
    let release = smart_app_db::find_latest_release(mysql, app.latest_release_id, app.id)
        .await
        .map_err(|_| ListError::Dependency)?
        .ok_or(ListError::NotFound("Smart app release not found"))?;
    let owner_display_name = owner_display_name(mysql, app.owner_user_id).await?;
    let icon_url = if app.icon_storage_key.is_empty() {
        String::new()
    } else {
        presign_download_url(&app.icon_storage_key).map_err(|_| ListError::Storage)?
    };
    let mut screenshot_urls = Vec::new();
    for storage_key in string_list(&app.screenshots_json) {
        screenshot_urls.push(presign_download_url(&storage_key).map_err(|_| ListError::Storage)?);
    }
    Ok(render_item(
        app,
        &release,
        role,
        owner_display_name,
        icon_url,
        screenshot_urls,
    ))
}

/// `db.get(User, app.owner_user_id) if app.owner_user_id else None` plus
/// `owner.user_name if owner else "Wegent"`.
async fn owner_display_name<M>(mysql: &M, owner_user_id: i64) -> Result<String, ListError>
where
    M: Mysql,
{
    if owner_user_id == 0 {
        return Ok(OFFICIAL_OWNER_DISPLAY_NAME.to_owned());
    }
    Ok(db::find_user_name(mysql, owner_user_id)
        .await
        .map_err(|_| ListError::Dependency)?
        .unwrap_or_else(|| OFFICIAL_OWNER_DISPLAY_NAME.to_owned()))
}

/// The pure `SmartAppMarketplaceItem` construction of `_item`.
fn render_item(
    app: &PublishedSmartAppRow,
    release: &SmartAppReleaseRow,
    role: &str,
    owner_display_name: String,
    icon_url: String,
    screenshot_urls: Vec<String>,
) -> SmartAppMarketplaceItem {
    let manifest = release.manifest_json.0.to_value();
    let requirements: Value = manifest
        .get("requirements")
        .filter(|value| json_truthy(value))
        .cloned()
        .unwrap_or_else(empty_object);
    let published_at = if is_epoch(app.published_at) {
        release.published_at
    } else {
        app.published_at
    };
    SmartAppMarketplaceItem {
        id: app.id,
        name: app.name.clone(),
        display_name: app.display_name.clone(),
        summary: app.summary.clone(),
        description_md: app.description_md.clone(),
        source_type: app.source_type.clone(),
        owner_user_id: app.owner_user_id,
        owner_display_name,
        access_role: role.to_owned(),
        visibility: app.visibility.clone(),
        tags: string_list(&app.tags_json),
        icon_url,
        screenshot_urls,
        featured: app.featured_rank != 0,
        latest_release_id: release.id,
        version: release.version.clone(),
        release_notes: release.release_notes.clone(),
        size_bytes: release.size_bytes,
        requirements,
        extensions: object_or_empty(&app.extensions_json),
        release_extensions: object_or_empty(&release.extensions_json),
        scan_status: "passed".to_owned(),
        updated_at: pydantic_datetime(app.updated_at),
        published_at: pydantic_datetime(published_at),
    }
}

/// `app.published_at == EPOCH_TIME` (`1970-01-01 00:00:00`).
fn is_epoch(value: NaiveDateTime) -> bool {
    value.and_utc().timestamp() == 0 && value.and_utc().timestamp_subsec_nanos() == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::OpaqueJson;
    use brz_mysql::Json;
    use chrono::NaiveDate;

    fn datetime(day: u32, hour: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 9, day)
            .expect("valid date")
            .and_hms_micro_opt(hour, 0, 0, 0)
            .expect("valid time")
    }

    fn app(visibility: &str, source_type: &str, is_listed: bool) -> PublishedSmartAppRow {
        PublishedSmartAppRow {
            id: 13,
            owner_user_id: 8,
            name: "dsh-xlsx2dashboard".to_owned(),
            display_name: "DSH 数据大盘生成器".to_owned(),
            summary: "Host 本地解析 Excel".to_owned(),
            description_md: "可导入导出模板".to_owned(),
            source_type: source_type.to_owned(),
            visibility: visibility.to_owned(),
            status: "published".to_owned(),
            tags_json: Json(OpaqueJson::from_serializable(vec!["daily_work"])),
            icon_storage_key: String::new(),
            screenshots_json: Json(OpaqueJson::from_serializable(Vec::<String>::new())),
            extensions_json: Json(OpaqueJson::from_serializable(
                serde_json::json!({"schemaVersion": 1}),
            )),
            latest_release_id: 29,
            featured_rank: 0,
            is_listed,
            created_at: datetime(1, 0),
            updated_at: datetime(21, 9),
            published_at: datetime(10, 10),
        }
    }

    fn release(published_at: NaiveDateTime) -> SmartAppReleaseRow {
        SmartAppReleaseRow {
            id: 29,
            smart_app_id: 13,
            version: "0.4.0".to_owned(),
            manifest_json: Json(OpaqueJson::from_serializable(
                serde_json::json!({"requirements": {"dsh": "0.1.0-rc.8", "node": ">=22"}}),
            )),
            release_notes: String::new(),
            storage_key: "smart-apps/releases/13/29/pkg.zip".to_owned(),
            sha256: "sha".to_owned(),
            size_bytes: 516_482,
            scan_status: "passed".to_owned(),
            scan_report_json: Json(OpaqueJson::from_serializable(serde_json::json!({}))),
            extensions_json: Json(OpaqueJson::from_serializable(serde_json::json!({}))),
            created_by_user_id: 0,
            created_at: published_at,
            published_at,
        }
    }

    #[test]
    fn renders_the_recorded_item_without_assets() {
        let item = render_item(
            &app("public", "user", true),
            &release(datetime(10, 10)),
            "public",
            "jiangyang7".to_owned(),
            String::new(),
            Vec::new(),
        );
        assert_eq!(item.access_role, "public");
        assert_eq!(item.owner_display_name, "jiangyang7");
        assert!(!item.featured);
        assert_eq!(
            serde_json::to_value(&item.extensions).expect("json"),
            serde_json::json!({"schemaVersion": 1})
        );
        assert_eq!(
            item.requirements,
            serde_json::json!({"dsh": "0.1.0-rc.8", "node": ">=22"})
        );
        assert_eq!(item.updated_at, "2026-09-21T09:00:00");
        assert_eq!(item.published_at, "2026-09-10T10:00:00");
    }

    #[test]
    fn epoch_published_at_falls_back_to_the_release_publish_time() {
        let mut row = app("public", "user", true);
        row.published_at = NaiveDate::from_ymd_opt(1970, 1, 1)
            .expect("valid date")
            .and_hms_opt(0, 0, 0)
            .expect("valid time");
        let item = render_item(
            &row,
            &release(datetime(12, 11)),
            "public",
            "jiangyang7".to_owned(),
            String::new(),
            Vec::new(),
        );
        assert_eq!(item.published_at, "2026-09-12T11:00:00");
    }

    #[test]
    fn query_matches_name_display_summary_and_description_case_insensitively() {
        let row = app("public", "user", true);
        assert!(matches_query(&row, "dsh-xlsx"));
        assert!(matches_query(&row, "数据大盘"));
        assert!(matches_query(&row, "excel"));
        assert!(matches_query(&row, "导入导出"));
        assert!(!matches_query(&row, "tingwen"));
    }
}
