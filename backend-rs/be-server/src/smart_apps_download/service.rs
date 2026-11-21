// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `SmartAppMarketplaceService.download_descriptor`.
//!
//! Resolves the published Smart app, rechecks the caller's access role, loads
//! the latest release, and mints the signed artifact URL.
use brz_mysql::{Mysql, MysqlResult};
use brz_redis::Redis;
use chrono::{DateTime, Utc};

use super::db;
use super::link;
use super::models::{SmartAppDownloadDescriptor, SmartAppRow};
use crate::config::AuthConfig;
use crate::permissions::{EntityResolvers, ResolutionPurpose};

/// The source `ResourceType.SMART_APP.value`.
const SMART_APP_RESOURCE_TYPE: &str = "SmartApp";
/// The source `ORG_DEPARTMENT_ENTITY_TYPE`.
const ORG_DEPARTMENT_ENTITY_TYPE: &str = "org_department";

/// Failure modes of `download_descriptor`, mapped to responses by the handler.
pub enum DescriptorError {
    /// `HTTPException(404, detail)` raised by the source service.
    NotFound(&'static str),
    /// A dependency failure the source's global handler renders as 500.
    Dependency,
}

/// `download_descriptor`: the JSON descriptor for `smart_app_id`, or the
/// source's not-found/access failures.
pub async fn download_descriptor<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    auth: &AuthConfig,
    smart_app_id: i64,
    user_id: i64,
    now: DateTime<Utc>,
) -> Result<SmartAppDownloadDescriptor, DescriptorError>
where
    M: Mysql,
    R: Redis,
{
    let app = match db::find_smart_app(mysql, smart_app_id)
        .await
        .map_err(|_| DescriptorError::Dependency)?
    {
        Some(app) if app.status == "published" => app,
        _ => return Err(DescriptorError::NotFound("Smart app not found")),
    };
    if access_role(mysql, redis, resolvers, &app, user_id)
        .await
        .map_err(|_| DescriptorError::Dependency)?
        .is_none()
    {
        return Err(DescriptorError::NotFound("Smart app not found"));
    }
    let release = db::find_latest_release(mysql, app.latest_release_id, app.id)
        .await
        .map_err(|_| DescriptorError::Dependency)?;
    let Some(release) = release else {
        return Err(DescriptorError::NotFound("Smart app release not found"));
    };

    let (download_url, expires_at) =
        link::build_download_url(auth, app.id, release.id, user_id, now);
    Ok(SmartAppDownloadDescriptor {
        smart_app_id: app.id,
        release_id: release.id,
        version: release.version.clone(),
        filename: format!("{}-{}.zip", app.name, release.version),
        download_url,
        sha256: release.sha256,
        size_bytes: release.size_bytes,
        expires_at: link::format_expires_at(expires_at),
    })
}

/// `_access_role`: the caller's role for a published app, or `None` when the
/// caller has no access. Shared with the ticketed artifact download, which
/// rechecks access for the token's `user_id`.
pub(crate) async fn access_role<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    app: &SmartAppRow,
    user_id: i64,
) -> MysqlResult<Option<&'static str>>
where
    M: Mysql,
    R: Redis,
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
    if org_department_grants_app(mysql, redis, resolvers, app.id, user_id).await? {
        return Ok(Some("recipient"));
    }
    namespace_grant_role(mysql, app.id, user_id).await
}

/// The `visibility == "restricted"` branch after the caller's precomputed ERP
/// department ids: an approved direct or namespace grant makes the caller a
/// recipient. The marketplace listing resolves the department ids once per
/// request and calls this directly; the single-app paths route through
/// [`access_role`].
pub(crate) async fn namespace_grant_role<M>(
    mysql: &M,
    smart_app_id: i64,
    user_id: i64,
) -> MysqlResult<Option<&'static str>>
where
    M: Mysql,
{
    let namespace_ids = db::find_namespace_ids(mysql, user_id).await?;
    let granted = db::find_smart_app_grant(mysql, smart_app_id, user_id, &namespace_ids).await?;
    Ok(granted.then_some("recipient"))
}

/// `app.id in get_org_department_resource_ids(...)`.
///
/// The source helper catches every failure and returns an empty set (logging
/// it), so a dependency error here falls through to the namespace grants.
async fn org_department_grants_app<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    smart_app_id: i64,
    user_id: i64,
) -> MysqlResult<bool>
where
    M: Mysql,
    R: Redis,
{
    match org_department_resource_ids(mysql, redis, resolvers, user_id).await {
        Ok(ids) => Ok(ids.contains(&smart_app_id)),
        Err(error) => {
            tracing::error!(%error, "failed to resolve ERP department access");
            Ok(false)
        }
    }
}

/// `get_org_department_resource_ids(resource_type='SmartApp')`:
/// candidate department bindings, the caller's matched departments, then the
/// resource ids bound to those departments. Shared with the marketplace
/// listing, which resolves the whole set once per request.
pub(crate) async fn org_department_resource_ids<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
    R: Redis,
{
    let department_ids = crate::plugins_marketplace::db::distinct_entity_resource_ids(
        mysql,
        SMART_APP_RESOURCE_TYPE,
        ORG_DEPARTMENT_ENTITY_TYPE,
    )
    .await?;
    if department_ids.is_empty() {
        return Ok(Vec::new());
    }
    let matched = resolvers
        .match_bindings(
            redis,
            user_id,
            ORG_DEPARTMENT_ENTITY_TYPE,
            &department_ids,
            ResolutionPurpose::ResourceAccess,
        )
        .await?;
    if matched.is_empty() {
        return Ok(Vec::new());
    }
    crate::plugins_marketplace::db::resource_ids_by_entity_ids(
        mysql,
        SMART_APP_RESOURCE_TYPE,
        ORG_DEPARTMENT_ENTITY_TYPE,
        &matched,
    )
    .await
}
