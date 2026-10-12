// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Row projections and statements for the admin plugin-publication list.
//!
//! Source models: `app/models/plugin_publication.py` and the `Plugin`/`User`
//! models. Every projection selects the full SQLAlchemy column list with the
//! `<table>_<column>` aliases SQLAlchemy renders, so the prepared statement
//! matches the recorded exchange for replay.

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlValue, MysqlValueWriter};
use chrono::NaiveDateTime;

use crate::json_compat::OpaqueJson;

use super::query::ListParams;

/// One bound statement value: the list filters bind ids, text, and datetimes.
#[derive(Debug, Clone)]
pub(super) enum SqlArg {
    Int(i64),
    Str(String),
    DateTime(NaiveDateTime),
}

impl MysqlValue for SqlArg {
    fn write(self, writer: &mut MysqlValueWriter) -> MysqlResult<()> {
        match self {
            Self::Int(value) => writer.push(value),
            Self::Str(value) => writer.push(value),
            Self::DateTime(value) => writer.push(value),
        }
    }

    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Int(_) => std::mem::size_of::<i64>(),
            Self::Str(value) => value.len(),
            Self::DateTime(_) => std::mem::size_of::<NaiveDateTime>(),
        }
    }
}

/// One `plugin_publication_requests` row (`db.query(PluginPublicationRequest)`).
#[derive(Debug, FromMysqlRow)]
#[allow(
    dead_code,
    reason = "every mapped column is selected to match the source"
)]
pub(super) struct RequestRow {
    #[mysql(rename = "plugin_publication_requests_id")]
    pub(super) id: i64,
    #[mysql(rename = "plugin_publication_requests_source_plugin_id")]
    pub(super) source_plugin_id: i64,
    #[mysql(rename = "plugin_publication_requests_target_plugin_id")]
    pub(super) target_plugin_id: i64,
    #[mysql(rename = "plugin_publication_requests_submitter_user_id")]
    pub(super) submitter_user_id: i64,
    #[mysql(rename = "plugin_publication_requests_current_revision_id")]
    pub(super) current_revision_id: i64,
    #[mysql(rename = "plugin_publication_requests_current_revision")]
    pub(super) current_revision: i64,
    #[mysql(rename = "plugin_publication_requests_aggregate_status")]
    pub(super) aggregate_status: String,
    #[mysql(rename = "plugin_publication_requests_risk_level")]
    pub(super) risk_level: String,
    #[mysql(rename = "plugin_publication_requests_submitted_at")]
    pub(super) submitted_at: NaiveDateTime,
    #[mysql(rename = "plugin_publication_requests_created_at")]
    pub(super) created_at: NaiveDateTime,
    #[mysql(rename = "plugin_publication_requests_updated_at")]
    pub(super) updated_at: NaiveDateTime,
}

/// One `plugins` row (`db.get(Plugin, id)`).
#[derive(Debug, FromMysqlRow)]
#[allow(
    dead_code,
    reason = "every mapped column is selected to match the source"
)]
pub(super) struct PluginRow {
    #[mysql(rename = "plugins_id")]
    pub(super) id: i64,
    #[mysql(rename = "plugins_catalog_namespace")]
    pub(super) catalog_namespace: String,
    #[mysql(rename = "plugins_slug")]
    pub(super) slug: String,
    #[mysql(rename = "plugins_name")]
    pub(super) name: String,
    #[mysql(rename = "plugins_display_name")]
    pub(super) display_name: String,
    #[mysql(rename = "plugins_summary")]
    pub(super) summary: String,
    #[mysql(rename = "plugins_description_md")]
    pub(super) description_md: String,
    #[mysql(rename = "plugins_listing_type")]
    pub(super) listing_type: String,
    #[mysql(rename = "plugins_source_type")]
    pub(super) source_type: String,
    #[mysql(rename = "plugins_source_provider")]
    pub(super) source_provider: String,
    #[mysql(rename = "plugins_owner_user_id")]
    pub(super) owner_user_id: i64,
    #[mysql(rename = "plugins_origin_plugin_id")]
    pub(super) origin_plugin_id: i64,
    #[mysql(rename = "plugins_category")]
    pub(super) category: String,
    #[mysql(rename = "plugins_keywords_json")]
    pub(super) keywords_json: Json<OpaqueJson>,
    #[mysql(rename = "plugins_interface_json")]
    pub(super) interface_json: Json<OpaqueJson>,
    #[mysql(rename = "plugins_visibility")]
    pub(super) visibility: String,
    #[mysql(rename = "plugins_allow_copy")]
    pub(super) allow_copy: bool,
    #[mysql(rename = "plugins_status")]
    pub(super) status: String,
    #[mysql(rename = "plugins_latest_release_id")]
    pub(super) latest_release_id: i64,
    #[mysql(rename = "plugins_featured_rank")]
    pub(super) featured_rank: i64,
    #[mysql(rename = "plugins_created_at")]
    pub(super) created_at: NaiveDateTime,
    #[mysql(rename = "plugins_updated_at")]
    pub(super) updated_at: NaiveDateTime,
    #[mysql(rename = "plugins_published_at")]
    pub(super) published_at: NaiveDateTime,
}

/// One `plugin_publication_revisions` row (`_current_revision`).
#[derive(Debug, FromMysqlRow)]
#[allow(
    dead_code,
    reason = "every mapped column is selected to match the source"
)]
pub(super) struct RevisionRow {
    #[mysql(rename = "plugin_publication_revisions_id")]
    pub(super) id: i64,
    #[mysql(rename = "plugin_publication_revisions_request_id")]
    pub(super) request_id: i64,
    #[mysql(rename = "plugin_publication_revisions_revision")]
    pub(super) revision: i64,
    #[mysql(rename = "plugin_publication_revisions_source_release_id")]
    pub(super) source_release_id: i64,
    #[mysql(rename = "plugin_publication_revisions_requested_version")]
    pub(super) requested_version: String,
    #[mysql(rename = "plugin_publication_revisions_snapshot_sha256")]
    pub(super) snapshot_sha256: String,
    #[mysql(rename = "plugin_publication_revisions_source_tree_sha256")]
    pub(super) source_tree_sha256: String,
    #[mysql(rename = "plugin_publication_revisions_storage_key")]
    pub(super) storage_key: String,
    #[mysql(rename = "plugin_publication_revisions_staging_storage_key")]
    pub(super) staging_storage_key: String,
    #[mysql(rename = "plugin_publication_revisions_filename")]
    pub(super) filename: String,
    #[mysql(rename = "plugin_publication_revisions_size_bytes")]
    pub(super) size_bytes: i64,
    #[mysql(rename = "plugin_publication_revisions_manifest_snapshot")]
    pub(super) manifest_snapshot: Json<OpaqueJson>,
    #[mysql(rename = "plugin_publication_revisions_package_entries_json")]
    pub(super) package_entries_json: Json<OpaqueJson>,
    #[mysql(rename = "plugin_publication_revisions_package_entry_count")]
    pub(super) package_entry_count: i64,
    #[mysql(rename = "plugin_publication_revisions_capabilities_json")]
    pub(super) capabilities_json: Json<OpaqueJson>,
    #[mysql(rename = "plugin_publication_revisions_risk_declaration")]
    pub(super) risk_declaration: Json<OpaqueJson>,
    #[mysql(rename = "plugin_publication_revisions_release_notes")]
    pub(super) release_notes: String,
    #[mysql(rename = "plugin_publication_revisions_test_notes")]
    pub(super) test_notes: String,
    #[mysql(rename = "plugin_publication_revisions_source_updated_at")]
    pub(super) source_updated_at: NaiveDateTime,
    #[mysql(rename = "plugin_publication_revisions_status")]
    pub(super) status: String,
    #[mysql(rename = "plugin_publication_revisions_gitlab_project_id")]
    pub(super) gitlab_project_id: String,
    #[mysql(rename = "plugin_publication_revisions_gitlab_project_url")]
    pub(super) gitlab_project_url: String,
    #[mysql(rename = "plugin_publication_revisions_source_branch")]
    pub(super) source_branch: String,
    #[mysql(rename = "plugin_publication_revisions_merge_request_iid")]
    pub(super) merge_request_iid: i64,
    #[mysql(rename = "plugin_publication_revisions_merge_request_url")]
    pub(super) merge_request_url: String,
    #[mysql(rename = "plugin_publication_revisions_merge_request_status")]
    pub(super) merge_request_status: String,
    #[mysql(rename = "plugin_publication_revisions_pipeline_id")]
    pub(super) pipeline_id: i64,
    #[mysql(rename = "plugin_publication_revisions_pipeline_url")]
    pub(super) pipeline_url: String,
    #[mysql(rename = "plugin_publication_revisions_pipeline_status")]
    pub(super) pipeline_status: String,
    #[mysql(rename = "plugin_publication_revisions_commit_sha")]
    pub(super) commit_sha: String,
    #[mysql(rename = "plugin_publication_revisions_created_by_user_id")]
    pub(super) created_by_user_id: i64,
    #[mysql(rename = "plugin_publication_revisions_completed_at")]
    pub(super) completed_at: NaiveDateTime,
    #[mysql(rename = "plugin_publication_revisions_created_at")]
    pub(super) created_at: NaiveDateTime,
    #[mysql(rename = "plugin_publication_revisions_updated_at")]
    pub(super) updated_at: NaiveDateTime,
}

/// One `users` row (`db.get(User, id)`), aliased like `db.query(User)`.
#[derive(Debug, FromMysqlRow)]
#[allow(
    dead_code,
    reason = "every mapped column is selected to match the source"
)]
pub(super) struct UserRow {
    #[mysql(rename = "users_id")]
    pub(super) id: i64,
    #[mysql(rename = "users_user_name")]
    pub(super) user_name: String,
    #[mysql(rename = "users_password_hash")]
    pub(super) password_hash: String,
    #[mysql(rename = "users_email")]
    pub(super) email: Option<String>,
    #[mysql(rename = "users_git_info")]
    pub(super) git_info: Json<OpaqueJson>,
    #[mysql(rename = "users_is_active")]
    pub(super) is_active: bool,
    #[mysql(rename = "users_role")]
    pub(super) role: String,
    #[mysql(rename = "users_auth_source")]
    pub(super) auth_source: String,
    #[mysql(rename = "users_preferences")]
    pub(super) preferences: String,
    #[mysql(rename = "users_created_at")]
    pub(super) created_at: NaiveDateTime,
    #[mysql(rename = "users_updated_at")]
    pub(super) updated_at: NaiveDateTime,
}

/// One `plugin_publication_checks` row (`_checks`).
#[derive(Debug, FromMysqlRow)]
#[allow(
    dead_code,
    reason = "every mapped column is selected to match the source"
)]
pub(super) struct CheckRow {
    #[mysql(rename = "plugin_publication_checks_id")]
    pub(super) id: i64,
    #[mysql(rename = "plugin_publication_checks_revision_id")]
    pub(super) revision_id: i64,
    #[mysql(rename = "plugin_publication_checks_stage")]
    pub(super) stage: String,
    #[mysql(rename = "plugin_publication_checks_check_code")]
    pub(super) check_code: String,
    #[mysql(rename = "plugin_publication_checks_title")]
    pub(super) title: String,
    #[mysql(rename = "plugin_publication_checks_severity")]
    pub(super) severity: String,
    #[mysql(rename = "plugin_publication_checks_status")]
    pub(super) status: String,
    #[mysql(rename = "plugin_publication_checks_summary")]
    pub(super) summary: String,
    #[mysql(rename = "plugin_publication_checks_evidence_json")]
    pub(super) evidence_json: Json<OpaqueJson>,
    #[mysql(rename = "plugin_publication_checks_execution_environment")]
    pub(super) execution_environment: String,
    #[mysql(rename = "plugin_publication_checks_job_url")]
    pub(super) job_url: String,
    #[mysql(rename = "plugin_publication_checks_acknowledgement_required")]
    pub(super) acknowledgement_required: bool,
    #[mysql(rename = "plugin_publication_checks_acknowledged")]
    pub(super) acknowledged: bool,
    #[mysql(rename = "plugin_publication_checks_acknowledged_by_user_id")]
    pub(super) acknowledged_by_user_id: i64,
    #[mysql(rename = "plugin_publication_checks_created_at")]
    pub(super) created_at: NaiveDateTime,
    #[mysql(rename = "plugin_publication_checks_updated_at")]
    pub(super) updated_at: NaiveDateTime,
}

/// The single-row `count(*)` result of `rows_query.count()`.
#[derive(Debug, FromMysqlRow)]
pub(super) struct CountRow {
    pub(super) count_1: i64,
}

/// One `users.id` scalar of the `submitter` text filter.
#[derive(Debug, FromMysqlRow)]
pub(super) struct UserIdRow {
    #[mysql(rename = "users_id")]
    pub(super) id: i64,
}

/// One `plugins.id` scalar of the `query` text filter.
#[derive(Debug, FromMysqlRow)]
pub(super) struct PluginIdRow {
    #[mysql(rename = "plugins_id")]
    pub(super) id: i64,
}

/// The SQLAlchemy `PluginPublicationRequest` labeled column projection.
const REQUEST_COLUMNS: &str = "plugin_publication_requests.id AS plugin_publication_requests_id, \
     plugin_publication_requests.source_plugin_id AS plugin_publication_requests_source_plugin_id, \
     plugin_publication_requests.target_plugin_id AS plugin_publication_requests_target_plugin_id, \
     plugin_publication_requests.submitter_user_id AS plugin_publication_requests_submitter_user_id, \
     plugin_publication_requests.current_revision_id AS plugin_publication_requests_current_revision_id, \
     plugin_publication_requests.current_revision AS plugin_publication_requests_current_revision, \
     plugin_publication_requests.aggregate_status AS plugin_publication_requests_aggregate_status, \
     plugin_publication_requests.risk_level AS plugin_publication_requests_risk_level, \
     plugin_publication_requests.submitted_at AS plugin_publication_requests_submitted_at, \
     plugin_publication_requests.created_at AS plugin_publication_requests_created_at, \
     plugin_publication_requests.updated_at AS plugin_publication_requests_updated_at";

/// The SQLAlchemy `Plugin` labeled column projection.
const PLUGIN_COLUMNS: &str = "plugins.id AS plugins_id, \
     plugins.catalog_namespace AS plugins_catalog_namespace, plugins.slug AS plugins_slug, \
     plugins.name AS plugins_name, plugins.display_name AS plugins_display_name, \
     plugins.summary AS plugins_summary, plugins.description_md AS plugins_description_md, \
     plugins.listing_type AS plugins_listing_type, plugins.source_type AS plugins_source_type, \
     plugins.source_provider AS plugins_source_provider, \
     plugins.owner_user_id AS plugins_owner_user_id, \
     plugins.origin_plugin_id AS plugins_origin_plugin_id, plugins.category AS plugins_category, \
     plugins.keywords_json AS plugins_keywords_json, \
     plugins.interface_json AS plugins_interface_json, plugins.visibility AS plugins_visibility, \
     plugins.allow_copy AS plugins_allow_copy, plugins.status AS plugins_status, \
     plugins.latest_release_id AS plugins_latest_release_id, \
     plugins.featured_rank AS plugins_featured_rank, plugins.created_at AS plugins_created_at, \
     plugins.updated_at AS plugins_updated_at, plugins.published_at AS plugins_published_at";

/// The SQLAlchemy `PluginPublicationRevision` labeled column projection.
const REVISION_COLUMNS: &str = "plugin_publication_revisions.id AS plugin_publication_revisions_id, \
     plugin_publication_revisions.request_id AS plugin_publication_revisions_request_id, \
     plugin_publication_revisions.revision AS plugin_publication_revisions_revision, \
     plugin_publication_revisions.source_release_id AS plugin_publication_revisions_source_release_id, \
     plugin_publication_revisions.requested_version AS plugin_publication_revisions_requested_version, \
     plugin_publication_revisions.snapshot_sha256 AS plugin_publication_revisions_snapshot_sha256, \
     plugin_publication_revisions.source_tree_sha256 AS plugin_publication_revisions_source_tree_sha256, \
     plugin_publication_revisions.storage_key AS plugin_publication_revisions_storage_key, \
     plugin_publication_revisions.staging_storage_key AS plugin_publication_revisions_staging_storage_key, \
     plugin_publication_revisions.filename AS plugin_publication_revisions_filename, \
     plugin_publication_revisions.size_bytes AS plugin_publication_revisions_size_bytes, \
     plugin_publication_revisions.manifest_snapshot AS plugin_publication_revisions_manifest_snapshot, \
     plugin_publication_revisions.package_entries_json AS plugin_publication_revisions_package_entries_json, \
     plugin_publication_revisions.package_entry_count AS plugin_publication_revisions_package_entry_count, \
     plugin_publication_revisions.capabilities_json AS plugin_publication_revisions_capabilities_json, \
     plugin_publication_revisions.risk_declaration AS plugin_publication_revisions_risk_declaration, \
     plugin_publication_revisions.release_notes AS plugin_publication_revisions_release_notes, \
     plugin_publication_revisions.test_notes AS plugin_publication_revisions_test_notes, \
     plugin_publication_revisions.source_updated_at AS plugin_publication_revisions_source_updated_at, \
     plugin_publication_revisions.status AS plugin_publication_revisions_status, \
     plugin_publication_revisions.gitlab_project_id AS plugin_publication_revisions_gitlab_project_id, \
     plugin_publication_revisions.gitlab_project_url AS plugin_publication_revisions_gitlab_project_url, \
     plugin_publication_revisions.source_branch AS plugin_publication_revisions_source_branch, \
     plugin_publication_revisions.merge_request_iid AS plugin_publication_revisions_merge_request_iid, \
     plugin_publication_revisions.merge_request_url AS plugin_publication_revisions_merge_request_url, \
     plugin_publication_revisions.merge_request_status AS plugin_publication_revisions_merge_request_status, \
     plugin_publication_revisions.pipeline_id AS plugin_publication_revisions_pipeline_id, \
     plugin_publication_revisions.pipeline_url AS plugin_publication_revisions_pipeline_url, \
     plugin_publication_revisions.pipeline_status AS plugin_publication_revisions_pipeline_status, \
     plugin_publication_revisions.commit_sha AS plugin_publication_revisions_commit_sha, \
     plugin_publication_revisions.created_by_user_id AS plugin_publication_revisions_created_by_user_id, \
     plugin_publication_revisions.completed_at AS plugin_publication_revisions_completed_at, \
     plugin_publication_revisions.created_at AS plugin_publication_revisions_created_at, \
     plugin_publication_revisions.updated_at AS plugin_publication_revisions_updated_at";

/// The SQLAlchemy `PluginPublicationCheck` labeled column projection.
const CHECK_COLUMNS: &str = "plugin_publication_checks.id AS plugin_publication_checks_id, \
     plugin_publication_checks.revision_id AS plugin_publication_checks_revision_id, \
     plugin_publication_checks.stage AS plugin_publication_checks_stage, \
     plugin_publication_checks.check_code AS plugin_publication_checks_check_code, \
     plugin_publication_checks.title AS plugin_publication_checks_title, \
     plugin_publication_checks.severity AS plugin_publication_checks_severity, \
     plugin_publication_checks.status AS plugin_publication_checks_status, \
     plugin_publication_checks.summary AS plugin_publication_checks_summary, \
     plugin_publication_checks.evidence_json AS plugin_publication_checks_evidence_json, \
     plugin_publication_checks.execution_environment AS plugin_publication_checks_execution_environment, \
     plugin_publication_checks.job_url AS plugin_publication_checks_job_url, \
     plugin_publication_checks.acknowledgement_required AS plugin_publication_checks_acknowledgement_required, \
     plugin_publication_checks.acknowledged AS plugin_publication_checks_acknowledged, \
     plugin_publication_checks.acknowledged_by_user_id AS plugin_publication_checks_acknowledged_by_user_id, \
     plugin_publication_checks.created_at AS plugin_publication_checks_created_at, \
     plugin_publication_checks.updated_at AS plugin_publication_checks_updated_at";

/// The SQLAlchemy `User` labeled column projection.
const USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at";

/// `case((submitted_at == EPOCH_TIME, created_at), else_=submitted_at)`.
const EFFECTIVE_SUBMITTED_AT: &str = "CASE WHEN (plugin_publication_requests.submitted_at = \
     '1970-01-01 00:00:00') THEN plugin_publication_requests.created_at ELSE \
     plugin_publication_requests.submitted_at END";

/// `is_terminal = aggregate_status.in_(TERMINAL_PUBLICATION_STATUSES)`.
const TERMINAL_PREDICATE: &str =
    "plugin_publication_requests.aggregate_status IN ('published', 'withdrawn', 'closed')";

/// The text-filter values resolved by earlier lookups.
#[derive(Debug, Default)]
pub(super) struct Filters {
    pub(super) submitter_ids: Option<Vec<i64>>,
    pub(super) plugin_ids: Option<Vec<i64>>,
}

/// `rows_query.count()`: the filtered projection wrapped in `count(*)`.
pub(super) async fn count_requests<M: Mysql>(
    mysql: &M,
    params: &ListParams,
    filters: &Filters,
) -> MysqlResult<i64> {
    let (statement, args) = count_sql(params, filters);
    let rows: Vec<CountRow> = mysql.fetch_all(statement, args).await?;
    Ok(rows.first().map_or(0, |row| row.count_1))
}

/// The paginated, ordered list query executed against the database.
pub(super) async fn select_requests<M: Mysql>(
    mysql: &M,
    params: &ListParams,
    filters: &Filters,
) -> MysqlResult<Vec<RequestRow>> {
    let (statement, args) = select_sql(params, filters);
    mysql.fetch_all(statement, args).await
}

/// The `count(*)` statement and its bound arguments.
pub(super) fn count_sql(params: &ListParams, filters: &Filters) -> (String, Vec<SqlArg>) {
    let (clause, args) = where_clause(params, filters);
    (
        format!(
            "SELECT count(*) AS count_1 FROM (SELECT {REQUEST_COLUMNS} \
             FROM plugin_publication_requests{clause}) AS anon_1"
        ),
        args,
    )
}

/// The paginated, ordered list query.
pub(super) fn select_sql(params: &ListParams, filters: &Filters) -> (String, Vec<SqlArg>) {
    let (clause, mut args) = where_clause(params, filters);
    args.push(SqlArg::Int((params.page - 1) * params.limit));
    args.push(SqlArg::Int(params.limit));
    let order = order_by();
    (
        format!(
            "SELECT {REQUEST_COLUMNS} FROM plugin_publication_requests{clause} \
             ORDER BY {order} LIMIT ?, ?"
        ),
        args,
    )
}

/// The source `order_by(terminal_rank.asc(), pending.asc(), terminal.desc(), id.asc())`.
fn order_by() -> String {
    format!(
        "CASE WHEN ({TERMINAL_PREDICATE}) THEN 1 ELSE 0 END ASC, \
         CASE WHEN ({TERMINAL_PREDICATE}) THEN NULL ELSE {EFFECTIVE_SUBMITTED_AT} END ASC, \
         CASE WHEN ({TERMINAL_PREDICATE}) THEN {EFFECTIVE_SUBMITTED_AT} END DESC, \
         plugin_publication_requests.id ASC"
    )
}

/// The SQLAlchemy `WHERE` chain applied by `list_requests`.
fn where_clause(params: &ListParams, filters: &Filters) -> (String, Vec<SqlArg>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut args: Vec<SqlArg> = Vec::new();
    if let Some(status) = &params.status {
        conditions.push("plugin_publication_requests.aggregate_status = ?".to_string());
        args.push(SqlArg::Str(status.clone()));
    }
    if let Some(risk_level) = &params.risk_level {
        conditions.push("plugin_publication_requests.risk_level = ?".to_string());
        args.push(SqlArg::Str(risk_level.clone()));
    }
    if let Some(ids) = &filters.submitter_ids {
        conditions.push(format!(
            "plugin_publication_requests.submitter_user_id IN ({})",
            placeholders(ids.len())
        ));
        args.extend(ids.iter().map(|id| SqlArg::Int(*id)));
    }
    if let Some(ids) = &filters.plugin_ids {
        conditions.push(format!(
            "plugin_publication_requests.source_plugin_id IN ({})",
            placeholders(ids.len())
        ));
        args.extend(ids.iter().map(|id| SqlArg::Int(*id)));
    }
    if let Some(after) = params.submitted_after {
        conditions.push(format!("{EFFECTIVE_SUBMITTED_AT} >= ?"));
        args.push(SqlArg::DateTime(after));
    }
    if let Some(before) = params.submitted_before {
        conditions.push(format!("{EFFECTIVE_SUBMITTED_AT} <= ?"));
        args.push(SqlArg::DateTime(before));
    }
    let clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    (clause, args)
}

/// A bound-value placeholder list; SQLAlchemy renders an empty `in_` as `(NULL)`.
fn placeholders(len: usize) -> String {
    if len == 0 {
        "NULL".to_string()
    } else {
        vec!["?"; len].join(", ")
    }
}

/// `db.get(Plugin, request.source_plugin_id)`.
pub(super) async fn get_plugin<M: Mysql>(
    mysql: &M,
    plugin_id: i64,
) -> MysqlResult<Option<PluginRow>> {
    mysql
        .fetch_optional(
            format!("SELECT {PLUGIN_COLUMNS} FROM plugins WHERE plugins.id = ?"),
            (plugin_id,),
        )
        .await
}

/// `_current_revision`: the aggregate pointer resolved within its request.
pub(super) async fn current_revision<M: Mysql>(
    mysql: &M,
    request_id: i64,
    revision_id: i64,
) -> MysqlResult<Option<RevisionRow>> {
    mysql
        .fetch_optional(
            format!(
                "SELECT {REVISION_COLUMNS} FROM plugin_publication_revisions \
                 WHERE plugin_publication_revisions.id = ? \
                 AND plugin_publication_revisions.request_id = ? LIMIT 1"
            ),
            (revision_id, request_id),
        )
        .await
}

/// `db.get(User, request.submitter_user_id)`.
pub(super) async fn get_user<M: Mysql>(mysql: &M, user_id: i64) -> MysqlResult<Option<UserRow>> {
    mysql
        .fetch_optional(
            format!("SELECT {USER_COLUMNS} FROM users WHERE users.id = ?"),
            (user_id,),
        )
        .await
}

/// `_checks`: the revision's checks ordered by id.
pub(super) async fn checks_for_revision<M: Mysql>(
    mysql: &M,
    revision_id: i64,
) -> MysqlResult<Vec<CheckRow>> {
    mysql
        .fetch_all(
            format!(
                "SELECT {CHECK_COLUMNS} FROM plugin_publication_checks \
                 WHERE plugin_publication_checks.revision_id = ? \
                 ORDER BY plugin_publication_checks.id"
            ),
            (revision_id,),
        )
        .await
}

/// `db.query(User.id).filter(User.user_name.ilike(...))`.
pub(super) async fn user_ids_like<M: Mysql>(mysql: &M, pattern: &str) -> MysqlResult<Vec<i64>> {
    let rows: Vec<UserIdRow> = mysql
        .fetch_all(
            "SELECT users.id AS users_id FROM users \
             WHERE lower(users.user_name) LIKE lower(?)",
            (pattern,),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.id).collect())
}

/// `db.query(Plugin.id).filter(or_(slug.ilike, display_name.ilike))`.
pub(super) async fn plugin_ids_like<M: Mysql>(mysql: &M, pattern: &str) -> MysqlResult<Vec<i64>> {
    let rows: Vec<PluginIdRow> = mysql
        .fetch_all(
            "SELECT plugins.id AS plugins_id FROM plugins \
             WHERE lower(plugins.slug) LIKE lower(?) \
             OR lower(plugins.display_name) LIKE lower(?)",
            (pattern, pattern),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.id).collect())
}
