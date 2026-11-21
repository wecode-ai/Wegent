// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Database access for the Smart app download descriptor.
//!
//! SQL strings reproduce the source SQLAlchemy statement shapes
//! (`SmartAppMarketplaceService._published_app`, `_latest_release`,
//! `_user_namespace_ids`, and the `_access_role` grant query).
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use super::models::{SmartAppReleaseRow, SmartAppRow};
use crate::sql_support::StatementArg;

/// `db.get(SmartApp, id)`.
pub const FIND_SMART_APP: &str = "SELECT smart_apps.id, smart_apps.owner_user_id, smart_apps.name, smart_apps.display_name, smart_apps.summary, smart_apps.description_md, smart_apps.source_type, smart_apps.visibility, smart_apps.status, smart_apps.tags_json, smart_apps.icon_storage_key, smart_apps.screenshots_json, smart_apps.extensions_json, smart_apps.latest_release_id, smart_apps.featured_rank, smart_apps.is_listed, smart_apps.created_at, smart_apps.updated_at, smart_apps.published_at \nFROM smart_apps \nWHERE smart_apps.id = ?";

/// `db.query(SmartAppRelease).filter(id == latest_release_id, smart_app_id ==
/// app.id).first()`.
pub const FIND_LATEST_RELEASE: &str = "SELECT smart_app_releases.id AS smart_app_releases_id, smart_app_releases.smart_app_id AS smart_app_releases_smart_app_id, smart_app_releases.version AS smart_app_releases_version, smart_app_releases.manifest_json AS smart_app_releases_manifest_json, smart_app_releases.release_notes AS smart_app_releases_release_notes, smart_app_releases.storage_key AS smart_app_releases_storage_key, smart_app_releases.sha256 AS smart_app_releases_sha256, smart_app_releases.size_bytes AS smart_app_releases_size_bytes, smart_app_releases.scan_status AS smart_app_releases_scan_status, smart_app_releases.scan_report_json AS smart_app_releases_scan_report_json, smart_app_releases.extensions_json AS smart_app_releases_extensions_json, smart_app_releases.created_by_user_id AS smart_app_releases_created_by_user_id, smart_app_releases.created_at AS smart_app_releases_created_at, smart_app_releases.published_at AS smart_app_releases_published_at \nFROM smart_app_releases \nWHERE smart_app_releases.id = ? AND smart_app_releases.smart_app_id = ? \n LIMIT 1";

/// `_user_namespace_ids` owned branch: `db.query(Namespace.id).filter(
/// owner_user_id == user_id, is_active.is_(True))`.
pub const FIND_OWNED_NAMESPACE_IDS: &str = "SELECT namespace.id AS namespace_id \nFROM namespace \nWHERE namespace.owner_user_id = ? AND namespace.is_active IS true";

/// `_user_namespace_ids` member branch: `db.query(ResourceMember.resource_id)`
/// for approved user membership of a Namespace.
pub const FIND_NAMESPACE_MEMBER_IDS: &str = "SELECT resource_members.resource_id AS resource_members_resource_id \nFROM resource_members \nWHERE resource_members.resource_type IN ('Namespace', 'NAMESPACE') AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? AND resource_members.status IN ('approved', 'APPROVED')";

/// One `id`-only projection used by the namespace lookups.
#[derive(FromMysqlRow)]
struct IntIdRow {
    #[mysql(rename = "namespace_id")]
    namespace_id: i64,
}

/// One `resource_id`-only projection.
#[derive(FromMysqlRow)]
struct ResourceIdRow {
    #[mysql(rename = "resource_members_resource_id")]
    resource_members_resource_id: i64,
}

/// One `resource_members.id`-only projection for the grant existence check.
#[derive(FromMysqlRow)]
struct MemberIdRow {
    #[allow(dead_code, reason = "only the row's existence is consumed")]
    #[mysql(rename = "resource_members_id")]
    resource_members_id: i64,
}

/// `_published_app`: the full row for `id`, or `None`.
pub async fn find_smart_app<M>(mysql: &M, id: i64) -> MysqlResult<Option<SmartAppRow>>
where
    M: Mysql,
{
    mysql.fetch_optional(FIND_SMART_APP, (id,)).await
}

/// `_latest_release`: the app's latest release row, or `None`.
pub async fn find_latest_release<M>(
    mysql: &M,
    release_id: i64,
    smart_app_id: i64,
) -> MysqlResult<Option<SmartAppReleaseRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(FIND_LATEST_RELEASE, (release_id, smart_app_id))
        .await
}

/// `db.query(SmartAppRelease).filter(id == release_id, smart_app_id ==
/// app.id, scan_status == 'passed').first()` (`download_artifact`).
pub const FIND_PASSED_RELEASE: &str = "SELECT smart_app_releases.id AS smart_app_releases_id, smart_app_releases.smart_app_id AS smart_app_releases_smart_app_id, smart_app_releases.version AS smart_app_releases_version, smart_app_releases.manifest_json AS smart_app_releases_manifest_json, smart_app_releases.release_notes AS smart_app_releases_release_notes, smart_app_releases.storage_key AS smart_app_releases_storage_key, smart_app_releases.sha256 AS smart_app_releases_sha256, smart_app_releases.size_bytes AS smart_app_releases_size_bytes, smart_app_releases.scan_status AS smart_app_releases_scan_status, smart_app_releases.scan_report_json AS smart_app_releases_scan_report_json, smart_app_releases.extensions_json AS smart_app_releases_extensions_json, smart_app_releases.created_by_user_id AS smart_app_releases_created_by_user_id, smart_app_releases.created_at AS smart_app_releases_created_at, smart_app_releases.published_at AS smart_app_releases_published_at \nFROM smart_app_releases \nWHERE smart_app_releases.id = ? AND smart_app_releases.smart_app_id = ? AND smart_app_releases.scan_status = 'passed' \n LIMIT 1";

/// `download_artifact`'s release lookup: the token's release for `app.id`
/// with a passed scan, or `None`.
pub async fn find_passed_release<M>(
    mysql: &M,
    release_id: i64,
    smart_app_id: i64,
) -> MysqlResult<Option<SmartAppReleaseRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(FIND_PASSED_RELEASE, (release_id, smart_app_id))
        .await
}

/// `_user_namespace_ids`: owned plus approved-member namespace ids as strings.
pub async fn find_namespace_ids<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let owned: Vec<IntIdRow> = mysql
        .fetch_all(FIND_OWNED_NAMESPACE_IDS, (user_id,))
        .await?;
    let member: Vec<ResourceIdRow> = mysql
        .fetch_all(FIND_NAMESPACE_MEMBER_IDS, (user_id.to_string(),))
        .await?;
    let mut ids: Vec<String> = Vec::new();
    for id in owned.into_iter().map(|row| row.namespace_id).chain(
        member
            .into_iter()
            .map(|row| row.resource_members_resource_id),
    ) {
        let id = id.to_string();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// The `_access_role` grant existence check: any approved `SmartApp`
/// membership granted directly to the user or through one of the user's
/// namespaces.
pub async fn find_smart_app_grant<M>(
    mysql: &M,
    smart_app_id: i64,
    user_id: i64,
    namespace_ids: &[String],
) -> MysqlResult<bool>
where
    M: Mysql,
{
    // `entity_id.in_(namespace_ids or {"-1"})`: an empty namespace set keeps
    // the SQL valid with a never-matching sentinel.
    let namespace_ids: Vec<String> = if namespace_ids.is_empty() {
        vec!["-1".to_owned()]
    } else {
        namespace_ids.to_vec()
    };
    let placeholders = vec!["?"; namespace_ids.len()].join(", ");
    let sql = format!(
        "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
         WHERE resource_members.resource_type IN ('SmartApp', 'SMART_APP') AND \
         resource_members.resource_id = ? AND resource_members.status IN \
         ('approved', 'APPROVED') AND (resource_members.entity_type = 'user' AND \
         resource_members.entity_id = ? OR resource_members.entity_type = 'namespace' \
         AND resource_members.entity_id IN ({placeholders})) \n LIMIT 1"
    );
    let params = grant_params(smart_app_id, user_id, &namespace_ids);
    let row: Option<MemberIdRow> = mysql.fetch_optional(sql, params).await?;
    Ok(row.is_some())
}

/// The grant query's bind values. `resource_members.resource_id` is an
/// integer column, so the Smart app id stays an integer (the source's integer
/// bind); the identity columns are text. Replay matches the materialized
/// statement tokens, so binding the id as text would change the value family.
fn grant_params(smart_app_id: i64, user_id: i64, namespace_ids: &[String]) -> Vec<StatementArg> {
    let mut params = vec![
        StatementArg::Int(smart_app_id),
        StatementArg::Str(user_id.to_string()),
    ];
    params.extend(namespace_ids.iter().cloned().map(StatementArg::Str));
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_params_bind_the_integer_resource_id() {
        let params = grant_params(2, 89, &["285".to_owned(), "42".to_owned()]);
        assert_eq!(params.len(), 4);
        assert!(matches!(params[0], StatementArg::Int(2)));
        assert!(matches!(&params[1], StatementArg::Str(value) if value == "89"));
        assert!(matches!(&params[2], StatementArg::Str(value) if value == "285"));
        assert!(matches!(&params[3], StatementArg::Str(value) if value == "42"));
    }
}
