// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Database access for the marketplace plugin listing API.
//!
//! Row structs and queries mirror the SQLAlchemy models and query shapes in
//! `app/models/plugin_marketplace.py` and
//! `app/services/plugin_marketplace_service.py` of the source service.
use std::collections::HashMap;

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};

pub use brz_mysql::Mysql as MysqlCapability;
use chrono::NaiveDateTime;

use crate::json_compat::OpaqueJson;

/// One `users` row, as used by marketplace listing and authentication.
///
/// The projection mirrors the source SQLAlchemy `db.query(User)` column list
/// exactly (all twelve mapped columns, aliased `<table>_<column>`), so the
/// prepared statement matches the recorded exchange for replay. Only `id`,
/// `user_name` and `is_active` are consumed here.
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    #[mysql(rename = "users_id")]
    pub id: i64,
    #[mysql(rename = "users_user_name")]
    pub user_name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_password_hash")]
    pub password_hash: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_email")]
    pub email: Option<String>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_git_info")]
    pub git_info: Json<OpaqueJson>,
    #[mysql(rename = "users_is_active")]
    pub is_active: bool,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_role")]
    pub role: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_auth_source")]
    pub auth_source: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_preferences")]
    pub preferences: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_created_at")]
    pub created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_updated_at")]
    pub updated_at: NaiveDateTime,
}

/// One `plugins` row.
#[derive(Debug, FromMysqlRow)]
pub struct PluginRow {
    #[mysql(rename = "plugins_id")]
    pub id: i64,
    #[mysql(rename = "plugins_catalog_namespace")]
    pub catalog_namespace: String,
    #[mysql(rename = "plugins_slug")]
    #[allow(dead_code)]
    pub slug: String,
    #[mysql(rename = "plugins_name")]
    pub name: String,
    #[mysql(rename = "plugins_display_name")]
    pub display_name: String,
    #[mysql(rename = "plugins_summary")]
    pub summary: String,
    #[mysql(rename = "plugins_description_md")]
    pub description_md: String,
    #[mysql(rename = "plugins_listing_type")]
    pub listing_type: String,
    #[mysql(rename = "plugins_source_type")]
    pub source_type: String,
    #[mysql(rename = "plugins_source_provider")]
    pub source_provider: String,
    #[mysql(rename = "plugins_owner_user_id")]
    pub owner_user_id: i64,
    #[mysql(rename = "plugins_origin_plugin_id")]
    pub origin_plugin_id: i64,
    #[mysql(rename = "plugins_category")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub category: String,
    #[mysql(rename = "plugins_keywords_json")]
    pub keywords_json: Json<OpaqueJson>,
    #[mysql(rename = "plugins_interface_json")]
    pub interface_json: Json<OpaqueJson>,
    #[mysql(rename = "plugins_visibility")]
    pub visibility: String,
    #[mysql(rename = "plugins_allow_copy")]
    pub allow_copy: bool,
    #[mysql(rename = "plugins_status")]
    #[allow(dead_code)]
    pub status: String,
    #[mysql(rename = "plugins_latest_release_id")]
    pub latest_release_id: i64,
    #[mysql(rename = "plugins_featured_rank")]
    pub featured_rank: i64,
    #[mysql(rename = "plugins_created_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub created_at: NaiveDateTime,
    #[mysql(rename = "plugins_updated_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub updated_at: NaiveDateTime,
    #[mysql(rename = "plugins_published_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub published_at: NaiveDateTime,
}

/// One `plugin_releases` row.
#[derive(Debug, FromMysqlRow)]
pub struct PluginReleaseRow {
    #[mysql(rename = "plugin_releases_id")]
    pub id: i64,
    #[mysql(rename = "plugin_releases_plugin_id")]
    #[allow(dead_code)]
    pub plugin_id: i64,
    #[mysql(rename = "plugin_releases_version")]
    pub version: String,
    #[mysql(rename = "plugin_releases_manifest_json")]
    pub manifest_json: Json<OpaqueJson>,
    #[mysql(rename = "plugin_releases_interface_json")]
    pub interface_json: Json<OpaqueJson>,
    #[mysql(rename = "plugin_releases_release_notes")]
    #[allow(dead_code)]
    pub release_notes: String,
    #[mysql(rename = "plugin_releases_storage_key")]
    #[allow(dead_code)]
    pub storage_key: String,
    #[mysql(rename = "plugin_releases_sha256")]
    #[allow(dead_code)]
    pub sha256: String,
    #[mysql(rename = "plugin_releases_size_bytes")]
    #[allow(dead_code)]
    pub size_bytes: i64,
    #[mysql(rename = "plugin_releases_status")]
    #[allow(dead_code)]
    pub status: String,
    #[mysql(rename = "plugin_releases_scan_status")]
    #[allow(dead_code)]
    pub scan_status: String,
    #[mysql(rename = "plugin_releases_scan_report_json")]
    pub scan_report_json: Json<OpaqueJson>,
    #[mysql(rename = "plugin_releases_created_by_user_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub created_by_user_id: i64,
    #[mysql(rename = "plugin_releases_publication_revision_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub publication_revision_id: i64,
    #[mysql(rename = "plugin_releases_source_commit_sha")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub source_commit_sha: String,
    #[mysql(rename = "plugin_releases_created_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub created_at: NaiveDateTime,
    #[mysql(rename = "plugin_releases_published_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub published_at: NaiveDateTime,
}

/// One installed-plugin `kinds` row.
#[derive(Debug, FromMysqlRow)]
pub struct InstalledKindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_user_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub user_id: i64,
    #[mysql(rename = "kinds_kind")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub kind: String,
    #[mysql(rename = "kinds_name")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub name: String,
    #[mysql(rename = "kinds_namespace")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub namespace: String,
    #[mysql(rename = "kinds_json")]
    pub json: Json<OpaqueJson>,
    #[mysql(rename = "kinds_is_active")]
    pub is_active: bool,
    #[mysql(rename = "kinds_created_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub updated_at: NaiveDateTime,
}

/// One `resource_members` row describing a plugin grant.
///
/// The projection mirrors the source SQLAlchemy `db.query(ResourceMember)`
/// column list exactly; only `resource_id`, `entity_type` and `entity_id` are
/// consumed by the marketplace access checks.
#[derive(Debug, Clone, FromMysqlRow)]
pub struct ResourceMemberRow {
    #[mysql(rename = "resource_members_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub id: i64,
    #[mysql(rename = "resource_members_resource_type")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub resource_type: String,
    #[mysql(rename = "resource_members_resource_id")]
    pub resource_id: i64,
    #[mysql(rename = "resource_members_entity_type")]
    pub entity_type: String,
    #[mysql(rename = "resource_members_entity_id")]
    pub entity_id: String,
    #[mysql(rename = "resource_members_entity_display_name")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub entity_display_name: String,
    #[mysql(rename = "resource_members_user_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub user_id: i64,
    #[mysql(rename = "resource_members_role")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub role: String,
    #[mysql(rename = "resource_members_status")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub status: String,
    #[mysql(rename = "resource_members_invited_by_user_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub invited_by_user_id: i64,
    #[mysql(rename = "resource_members_share_link_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub share_link_id: i64,
    #[mysql(rename = "resource_members_reviewed_by_user_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub reviewed_by_user_id: i64,
    #[mysql(rename = "resource_members_reviewed_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub reviewed_at: NaiveDateTime,
    #[mysql(rename = "resource_members_copied_resource_id")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub copied_resource_id: i64,
    #[mysql(rename = "resource_members_requested_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub requested_at: NaiveDateTime,
    #[mysql(rename = "resource_members_created_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub created_at: NaiveDateTime,
    #[mysql(rename = "resource_members_updated_at")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub updated_at: NaiveDateTime,
}

/// One active `namespace` row.
#[derive(Debug, FromMysqlRow)]
pub struct NamespaceRow {
    #[mysql(rename = "namespace_id")]
    pub id: i64,
    #[mysql(rename = "namespace_name")]
    pub name: String,
}

/// One `plugin_device_installations` row.
#[derive(Debug, FromMysqlRow)]
pub struct DeviceInstallationRow {
    #[mysql(rename = "plugin_device_installations_id")]
    #[allow(dead_code)]
    pub id: i64,
    #[mysql(rename = "plugin_device_installations_installed_kind_id")]
    pub installed_kind_id: i64,
    #[mysql(rename = "plugin_device_installations_device_id")]
    pub device_id: String,
    #[mysql(rename = "plugin_device_installations_desired_release_id")]
    pub desired_release_id: i64,
    #[mysql(rename = "plugin_device_installations_actual_release_id")]
    pub actual_release_id: i64,
    #[mysql(rename = "plugin_device_installations_state")]
    pub state: String,
    #[mysql(rename = "plugin_device_installations_error_code")]
    pub error_code: String,
    #[mysql(rename = "plugin_device_installations_error_message")]
    pub error_message: String,
    #[mysql(rename = "plugin_device_installations_attempt_count")]
    pub attempt_count: i64,
    #[mysql(rename = "plugin_device_installations_last_sync_at")]
    pub last_sync_at: NaiveDateTime,
    #[mysql(rename = "plugin_device_installations_updated_at")]
    pub updated_at: NaiveDateTime,
}

const USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, users.`role` AS \
     users_role, users.auth_source AS users_auth_source, users.preferences AS \
     users_preferences, users.created_at AS users_created_at, users.updated_at AS \
     users_updated_at";
const PLUGIN_COLUMNS: &str = "plugins.id AS plugins_id, plugins.catalog_namespace AS \
     plugins_catalog_namespace, plugins.slug AS plugins_slug, plugins.name AS plugins_name, \
     plugins.display_name AS plugins_display_name, plugins.summary AS plugins_summary, \
     plugins.description_md AS plugins_description_md, plugins.listing_type AS \
     plugins_listing_type, plugins.source_type AS plugins_source_type, plugins.source_provider \
     AS plugins_source_provider, plugins.owner_user_id AS plugins_owner_user_id, \
     plugins.origin_plugin_id AS plugins_origin_plugin_id, plugins.category AS \
     plugins_category, plugins.keywords_json AS plugins_keywords_json, \
     plugins.interface_json AS plugins_interface_json, plugins.visibility AS \
     plugins_visibility, plugins.allow_copy AS plugins_allow_copy, plugins.status AS \
     plugins_status, plugins.latest_release_id AS plugins_latest_release_id, \
     plugins.featured_rank AS plugins_featured_rank, plugins.created_at AS \
     plugins_created_at, plugins.updated_at AS plugins_updated_at, plugins.published_at AS \
     plugins_published_at";
const RELEASE_COLUMNS: &str = "plugin_releases.id AS plugin_releases_id, \
     plugin_releases.plugin_id AS plugin_releases_plugin_id, plugin_releases.version AS \
     plugin_releases_version, plugin_releases.manifest_json AS plugin_releases_manifest_json, \
     plugin_releases.interface_json AS plugin_releases_interface_json, \
     plugin_releases.release_notes AS plugin_releases_release_notes, \
     plugin_releases.storage_key AS plugin_releases_storage_key, plugin_releases.sha256 AS \
     plugin_releases_sha256, plugin_releases.size_bytes AS plugin_releases_size_bytes, \
     plugin_releases.status AS plugin_releases_status, plugin_releases.scan_status AS \
     plugin_releases_scan_status, plugin_releases.scan_report_json AS \
     plugin_releases_scan_report_json, plugin_releases.created_by_user_id AS \
     plugin_releases_created_by_user_id, plugin_releases.publication_revision_id AS \
     plugin_releases_publication_revision_id, plugin_releases.source_commit_sha AS \
     plugin_releases_source_commit_sha, plugin_releases.created_at AS \
     plugin_releases_created_at, plugin_releases.published_at AS plugin_releases_published_at";
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
     kinds_created_at, kinds.updated_at AS kinds_updated_at";
const GRANT_COLUMNS: &str = "resource_members.id AS resource_members_id, \
     resource_members.resource_type AS resource_members_resource_type, \
     resource_members.resource_id AS resource_members_resource_id, \
     resource_members.entity_type AS resource_members_entity_type, resource_members.entity_id \
     AS resource_members_entity_id, resource_members.entity_display_name AS \
     resource_members_entity_display_name, resource_members.user_id AS \
     resource_members_user_id, resource_members.`role` AS resource_members_role, \
     resource_members.status AS resource_members_status, resource_members.invited_by_user_id \
     AS resource_members_invited_by_user_id, resource_members.share_link_id AS \
     resource_members_share_link_id, resource_members.reviewed_by_user_id AS \
     resource_members_reviewed_by_user_id, resource_members.reviewed_at AS \
     resource_members_reviewed_at, resource_members.copied_resource_id AS \
     resource_members_copied_resource_id, resource_members.requested_at AS \
     resource_members_requested_at, resource_members.created_at AS \
     resource_members_created_at, resource_members.updated_at AS resource_members_updated_at";
const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, namespace.name AS namespace_name";
const DEVICE_COLUMNS: &str = "plugin_device_installations.id AS \
     plugin_device_installations_id, plugin_device_installations.installed_kind_id AS \
     plugin_device_installations_installed_kind_id, plugin_device_installations.device_id AS \
     plugin_device_installations_device_id, plugin_device_installations.desired_release_id AS \
     plugin_device_installations_desired_release_id, plugin_device_installations.actual_release_id \
     AS plugin_device_installations_actual_release_id, plugin_device_installations.state AS \
     plugin_device_installations_state, plugin_device_installations.error_code AS \
     plugin_device_installations_error_code, plugin_device_installations.error_message AS \
     plugin_device_installations_error_message, plugin_device_installations.attempt_count AS \
     plugin_device_installations_attempt_count, plugin_device_installations.last_sync_at AS \
     plugin_device_installations_last_sync_at, plugin_device_installations.updated_at AS \
     plugin_device_installations_updated_at";

/// One bound argument of the device-installation query, preserving the
/// recorded literal's token kind: the source's SQLAlchemy `in_` renders the
/// installed kind ids as integer literals while `device_id ==` renders the
/// device id as a quoted string.
#[derive(Debug, Clone)]
enum DeviceArg {
    Int(i64),
    Str(String),
}

impl brz_mysql::MysqlValue for DeviceArg {
    fn write(self, writer: &mut brz_mysql::MysqlValueWriter) -> brz_mysql::MysqlResult<()> {
        match self {
            Self::Int(value) => value.write(writer),
            Self::Str(value) => value.write(writer),
        }
    }

    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Int(value) => value.encoded_size_hint(),
            Self::Str(value) => value.encoded_size_hint(),
        }
    }
}

/// Query helpers for the marketplace listing.
pub struct UserRepository;

/// `IExternalEntityResolver.get_resource_ids_by_entity` step 1: the DISTINCT
/// approved entity ids bound to one resource type (the candidate list passed
/// to the application-supplied resolver).
pub async fn distinct_entity_resource_ids<M>(
    mysql: &M,
    resource_type: &str,
    entity_type: &str,
) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_entity_id: String,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            "SELECT DISTINCT resource_members.entity_id AS resource_members_entity_id \
             FROM resource_members WHERE resource_members.resource_type = ? AND \
             resource_members.entity_type = ? AND \
             resource_members.entity_id IS NOT NULL AND \
             resource_members.status = 'approved'",
            (resource_type, entity_type),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_entity_id)
        .collect())
}

/// `list_resources_by_entity_match`: the DISTINCT approved resource ids
/// bound to resolver-matched entity ids for one resource type.
pub async fn resource_ids_by_entity_ids<M>(
    mysql: &M,
    resource_type: &str,
    entity_type: &str,
    matched_entity_ids: &[String],
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if matched_entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_resource_id: i64,
    }
    let placeholders = vec!["?"; matched_entity_ids.len()].join(", ");
    let rows: Vec<Row> = mysql
        .fetch_all(
            format!(
                "SELECT DISTINCT resource_members.resource_id AS \
                 resource_members_resource_id FROM resource_members WHERE \
                 resource_members.resource_type = ? AND resource_members.entity_type = \
                 ? AND resource_members.entity_id IN ({placeholders}) AND \
                 resource_members.status = 'approved'"
            ),
            std::iter::once(resource_type)
                .chain(std::iter::once(entity_type))
                .chain(matched_entity_ids.iter().map(String::as_str))
                .collect::<Vec<&str>>(),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// Build the process-lifetime MySQL service from the source URL.
///
/// Mirrors the source engine: pool size 10 plus 20 overflow (30 total), 30 s
/// acquire timeout, one-hour recycle, utf8mb4 charset, +08:00 session
/// timezone.
impl UserRepository {
    /// Look up one active-capable user by username.
    pub async fn find_by_username<M>(mysql: &M, username: &str) -> MysqlResult<Option<UserRow>>
    where
        M: Mysql,
    {
        mysql
            .fetch_optional(
                format!("SELECT {USER_COLUMNS} FROM users WHERE users.user_name = ? LIMIT 1"),
                (username,),
            )
            .await
    }

    /// Load published marketplace plugins in source listing order.
    pub async fn list_published_plugins<M>(mysql: &M) -> MysqlResult<Vec<PluginRow>>
    where
        M: Mysql,
    {
        mysql
            .fetch_all(
                format!(
                    "SELECT {PLUGIN_COLUMNS} FROM plugins WHERE plugins.status = 'published' \
                     AND plugins.latest_release_id != 0 AND plugins.visibility IN ('personal', \
                     'workspace', 'public') ORDER BY plugins.featured_rank = 0, \
                     plugins.featured_rank DESC, plugins.id DESC"
                ),
                (),
            )
            .await
    }

    /// Load ready, scan-passed releases for the given release IDs.
    pub async fn list_releases_by_ids<M>(
        mysql: &M,
        release_ids: &[i64],
    ) -> MysqlResult<Vec<PluginReleaseRow>>
    where
        M: Mysql,
    {
        if release_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; release_ids.len()].join(", ");
        mysql
            .fetch_all(
                format!(
                    "SELECT {RELEASE_COLUMNS} FROM plugin_releases WHERE plugin_releases.id IN \
                     ({placeholders}) AND plugin_releases.status = 'ready' AND \
                     plugin_releases.scan_status = 'passed'"
                ),
                release_ids.to_vec(),
            )
            .await
    }

    /// Load owners for the given user IDs.
    pub async fn list_users_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<UserRow>>
    where
        M: Mysql,
    {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        mysql
            .fetch_all(
                format!("SELECT {USER_COLUMNS} FROM users WHERE users.id IN ({placeholders})"),
                ids.to_vec(),
            )
            .await
    }

    /// Load installed-plugin kinds rows for one user.
    pub async fn list_installed_kinds<M>(
        mysql: &M,
        user_id: i64,
    ) -> MysqlResult<Vec<InstalledKindRow>>
    where
        M: Mysql,
    {
        mysql
            .fetch_all(
                format!(
                    "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = \
                     'InstalledPlugin' AND kinds.namespace = 'default'"
                ),
                (user_id,),
            )
            .await
    }

    /// Load approved plugin grants grouped by plugin ID.
    pub async fn list_plugin_grants<M>(
        mysql: &M,
        plugin_ids: &[i64],
    ) -> MysqlResult<HashMap<i64, Vec<ResourceMemberRow>>>
    where
        M: Mysql,
    {
        if plugin_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; plugin_ids.len()].join(", ");
        let rows: Vec<ResourceMemberRow> = mysql
            .fetch_all(
                format!(
                    "SELECT {GRANT_COLUMNS} FROM resource_members WHERE \
                     resource_members.resource_type IN ('Plugin', 'PLUGIN') AND \
                     resource_members.resource_id IN ({placeholders}) AND \
                     resource_members.status IN ('approved', 'APPROVED') ORDER BY \
                     resource_members.entity_type, resource_members.entity_display_name"
                ),
                plugin_ids.to_vec(),
            )
            .await?;
        let mut grouped: HashMap<i64, Vec<ResourceMemberRow>> = HashMap::new();
        for row in rows {
            grouped.entry(row.resource_id).or_default().push(row);
        }
        Ok(grouped)
    }

    /// Load the namespaces the user holds approved membership in.
    pub async fn list_user_namespaces<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<NamespaceRow>>
    where
        M: Mysql,
    {
        mysql
            .fetch_all(
                format!(
                    "SELECT {NAMESPACE_COLUMNS} FROM namespace INNER JOIN resource_members ON \
                     resource_members.resource_type = 'Namespace' AND \
                     resource_members.resource_id = namespace.id WHERE \
                     resource_members.entity_type = 'user' AND resource_members.entity_id = ? \
                     AND resource_members.status IN ('approved', 'APPROVED') AND \
                     namespace.is_active IS true"
                ),
                (user_id.to_string(),),
            )
            .await
    }

    /// Load active namespace rows for the given IDs.
    pub async fn list_namespaces_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<NamespaceRow>>
    where
        M: Mysql,
    {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        mysql
            .fetch_all(
                format!(
                    "SELECT {NAMESPACE_COLUMNS} FROM namespace WHERE namespace.id IN \
                     ({placeholders}) AND namespace.is_active IS true"
                ),
                ids.to_vec(),
            )
            .await
    }

    /// Load device installations for the given installed kind IDs on one
    /// device.
    pub async fn list_device_installations<M>(
        mysql: &M,
        installed_kind_ids: &[i64],
        device_id: &str,
    ) -> MysqlResult<Vec<DeviceInstallationRow>>
    where
        M: Mysql,
    {
        if installed_kind_ids.is_empty() {
            return Ok(Vec::new());
        }
        // Source filters `installed_kind_id IN (...) AND device_id = ?` for
        // the user's selected installed kinds only; the kind ids bind as
        // integers and the device id as a string, like the recorded
        // SQLAlchemy rendering.
        let placeholders = vec!["?"; installed_kind_ids.len()].join(", ");
        let mut arguments: Vec<DeviceArg> = installed_kind_ids
            .iter()
            .map(|kind_id| DeviceArg::Int(*kind_id))
            .collect();
        arguments.push(DeviceArg::Str(device_id.to_owned()));
        mysql
            .fetch_all(
                format!(
                    "SELECT {DEVICE_COLUMNS} FROM plugin_device_installations WHERE \
                     plugin_device_installations.installed_kind_id IN ({placeholders}) AND \
                     plugin_device_installations.device_id = ?"
                ),
                arguments,
            )
            .await
    }
}
