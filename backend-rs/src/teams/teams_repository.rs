// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL data access for `GET /api/teams`, mirroring
//! `team_kinds_service.get_user_teams` / `get_user_teams_page` and the
//! group-membership resolution they share (`group_permission`,
//! `group_member_helper`, entity resolvers).
//!
//! Every statement reproduces the source SQLAlchemy ORM rendering exactly —
//! full column lists with `table_column` aliases, the same predicate order,
//! and the same value binding — because the replay engine matches MySQL
//! exchanges by normalized SQL token stream: a different projection or alias
//! set is an unmatched (erroring) dependency, not just a cosmetic difference.
//! Variable values are bound as `?` parameters; the replay matcher
//! materializes them against the recorded inline literals.
//!
//! Order-sensitive literal lists reproduce the source construction:
//! - list-derived orders keep insertion order (including duplicates);
//! - `users.id IN (...)` reproduces the source's Python `set` iteration for
//!   small integers (hash(i) == i), which is deterministic;
//! - string/tuple-set derived orders (group bots, shells, models) are
//!   hash-seed dependent in the source; the target keeps first-seen order.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use brz_json::OpaqueJson;

/// `users` column list rendered by `db.query(User)` (SQLAlchemy labels every
/// column `users_<name>`).
pub const USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at";

/// `resource_members` column list rendered by `db.query(ResourceMember)`.
pub const MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
     resource_members.resource_type AS resource_members_resource_type, \
     resource_members.resource_id AS resource_members_resource_id, \
     resource_members.entity_type AS resource_members_entity_type, \
     resource_members.entity_id AS resource_members_entity_id, \
     resource_members.entity_display_name AS resource_members_entity_display_name, \
     resource_members.user_id AS resource_members_user_id, \
     resource_members.`role` AS resource_members_role, \
     resource_members.status AS resource_members_status, \
     resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
     resource_members.share_link_id AS resource_members_share_link_id, \
     resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
     resource_members.reviewed_at AS resource_members_reviewed_at, \
     resource_members.copied_resource_id AS resource_members_copied_resource_id, \
     resource_members.requested_at AS resource_members_requested_at, \
     resource_members.created_at AS resource_members_created_at, \
     resource_members.updated_at AS resource_members_updated_at";

/// Re-export of the team-union query functions for the teams modules'
/// existing `repo::` call sites.
pub use super::team_union::{
    AccessibleTeamsQuery, TeamListFilter, accessible_default_team, accessible_teams,
    latest_distinct_team_rows, team_count,
};
pub use super::team_union_lookups::{
    kinds_by_refs, public_kinds_by_names, user_by_id, users_by_ids,
};

/// `namespace` column list rendered by `db.query(Namespace)`.
pub const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, \
     namespace.name AS namespace_name, namespace.display_name AS namespace_display_name, \
     namespace.owner_user_id AS namespace_owner_user_id, \
     namespace.visibility AS namespace_visibility, \
     namespace.description AS namespace_description, \
     namespace.level AS namespace_level, namespace.is_active AS namespace_is_active, \
     namespace.created_at AS namespace_created_at, \
     namespace.updated_at AS namespace_updated_at";

/// `kinds` column list rendered by `db.query(Kind)`.
pub const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One row of the deduplicated accessible-team union
/// (`_build_accessible_teams_query`). The outer SQLAlchemy query aliases every
/// column `anon_1_<name>`; the replay engine matches and delivers those
/// recorded aliases, so each field decodes by its recorded alias.
#[derive(Debug, FromMysqlRow)]
pub struct TeamRow {
    #[mysql(rename = "anon_1_team_id")]
    pub team_id: i64,
    #[mysql(rename = "anon_1_team_user_id")]
    pub team_user_id: i64,
    #[mysql(rename = "anon_1_team_name")]
    pub team_name: String,
    #[mysql(rename = "anon_1_team_namespace")]
    pub team_namespace: String,
    #[mysql(rename = "anon_1_team_json")]
    pub team_json: Json<OpaqueJson>,
    #[mysql(rename = "anon_1_team_created_at")]
    pub team_created_at: NaiveDateTime,
    #[mysql(rename = "anon_1_team_updated_at")]
    pub team_updated_at: NaiveDateTime,
    /// 0 own/public, 2 shared.
    #[mysql(rename = "anon_1_share_status")]
    pub share_status: i64,
    /// Owner user for shared/group teams, the requesting user for own teams,
    /// 0 for public teams.
    #[mysql(rename = "anon_1_context_user_id")]
    pub context_user_id: i64,
    /// Restricted group access requires response filtering unless the requester owns it.
    #[mysql(rename = "anon_1_restricted_guest_access")]
    pub restricted_guest_access: i64,
    /// `native` / `user_share` / `namespace_authorization`.
    #[mysql(rename = "anon_1_access_source")]
    pub access_source: String,
}

/// `kinds` row for bots, shells, and models.
#[derive(Debug, Clone, FromMysqlRow)]
pub struct KindRow {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    pub kinds_name: String,
    pub kinds_namespace: String,
    pub kinds_json: Json<OpaqueJson>,
}

/// `users` row for team-owner summaries. The full column list matches the
/// source `db.query(User)` rendering; `users.git_info` is a JSON column and
/// decodes as JSON. Fields the endpoint does not read carry
/// `#[allow(dead_code)]`.
#[derive(Debug, FromMysqlRow)]
pub struct UserSummaryRow {
    pub users_id: i64,
    pub users_user_name: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code)]
    pub users_email: Option<String>,
    #[allow(dead_code)]
    pub users_git_info: brz_mysql::Json<brz_json::OpaqueJson>,
    #[allow(dead_code)]
    pub users_is_active: i8,
    #[allow(dead_code)]
    #[mysql(rename = "users_role")]
    pub users_role: String,
    #[allow(dead_code)]
    pub users_auth_source: String,
    #[allow(dead_code)]
    pub users_preferences: String,
    #[allow(dead_code)]
    pub users_created_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    pub users_updated_at: Option<chrono::NaiveDateTime>,
}

/// Expand `?, ?, ...` with `count` placeholders.
pub fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// One bound SQL argument that preserves the recorded literal's token kind.
///
/// The replay matcher compares bound values by type as well as by value, so an
/// integer column (`kinds.user_id`, `resource_members.resource_id`) must bind as
/// `Int` and everything the source renders as a quoted string (entity ids,
/// namespaces, database names) as `Str`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingArg {
    Int(i64),
    Str(String),
}

impl brz_mysql::MysqlValue for BindingArg {
    fn write(self, writer: &mut brz_mysql::MysqlValueWriter) -> MysqlResult<()> {
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

/// Validate a pagination literal (`page >= 1`, `limit` in `1..=100`).
#[allow(dead_code)]
pub fn validate_pagination(page: i64, limit: i64) -> Result<(), &'static str> {
    if page < 1 {
        return Err("page must be at least 1");
    }
    if !(1..=100).contains(&limit) {
        return Err("limit must be between 1 and 100");
    }
    Ok(())
}

/// All active namespace names
/// (`get_user_group_roles`: `db.query(Namespace.name).filter(is_active)`).
pub async fn active_namespace_names<M>(mysql: &M) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        namespace_name: String,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            "SELECT namespace.name AS namespace_name \
             FROM namespace \
             WHERE namespace.is_active IS true",
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.namespace_name).collect())
}

/// Namespace rows by id (`iter_user_groups_with_roles` step 1 tail). `ids`
/// keeps the caller's order (the source passes the raw membership row ids,
/// duplicates included).
/// Resource ids for direct user memberships
/// (`NamespaceEntityResolver.get_resource_ids_by_entity` step 1).
/// Namespace ids bound to an external entity type
/// (`NamespaceEntityResolver.get_resource_ids_by_entity` step 2).
/// Distinct namespace ids bound to the matched external entities
/// (`list_resources_by_entity_match`).
/// External entity members of the given namespaces
/// (`iter_user_groups_with_roles` step 2).
///
/// `resource_members.resource_id` is an integer column: the source builds the
/// IN list from the resolver's integer resource ids, so the target binds them
/// as integers and only `entity_type` as a string.
/// The external-members query's bound values: the integer namespace ids in the
/// caller's order, then the string entity type.
/// Namespace ids by names, active only
/// (`_get_accessible_authorization_namespace_ids` tail). `names` is sorted by
/// the caller exactly like the source's `sorted(effective_roles)`.
pub async fn namespace_ids_by_names<M>(mysql: &M, names: &[String]) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if names.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        namespace_id: i64,
    }
    let sql = format!(
        "SELECT namespace.id AS namespace_id \
         FROM namespace \
         WHERE namespace.name IN ({}) AND namespace.is_active IS true",
        placeholders(names.len()),
    );
    let rows: Vec<Row> = mysql.fetch_all(sql.as_str(), names.to_vec()).await?;
    Ok(rows.into_iter().map(|row| row.namespace_id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_render() {
        assert_eq!(placeholders(1), "?");
        assert_eq!(placeholders(3), "?, ?, ?");
    }

    #[test]
    fn pagination_bounds() {
        assert!(validate_pagination(1, 100).is_ok());
        assert!(validate_pagination(0, 10).is_err());
        assert!(validate_pagination(1, 101).is_err());
        assert!(validate_pagination(1, 0).is_err());
    }
}
