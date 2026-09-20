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

use crate::json_compat::OpaqueJson;

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
    AccessibleTeamsQuery, TeamListFilter, accessible_teams, kinds_by_refs, public_kinds_by_names,
    team_count, users_by_ids,
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
///
/// Decoding is field-driven, so the union's `restricted_guest_access` column
/// stays projected for statement identity without a field here: the source
/// only consumes it for `team_usage_summary`, whose effect is not observable
/// in the recorded traffic.
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
    /// `native` / `user_share` / `namespace_authorization`.
    #[mysql(rename = "anon_1_access_source")]
    pub access_source: String,
}

/// `namespace` row (full column list, matching `db.query(Namespace)`).
#[derive(Debug, FromMysqlRow)]
pub struct NamespaceRow {
    pub namespace_id: i64,
    pub namespace_name: String,
}

/// `resource_members` row (full column list, matching
/// `db.query(ResourceMember)`).
#[derive(Debug, FromMysqlRow)]
pub struct MemberRow {
    pub resource_members_resource_id: i64,
    /// Selected to match the source column list; the value is not read here.
    #[allow(dead_code)]
    pub resource_members_entity_id: String,
    #[mysql(rename = "resource_members_role")]
    pub resource_members_role: String,
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
    pub users_git_info: brz_mysql::Json<crate::json_compat::OpaqueJson>,
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
pub async fn namespaces_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<NamespaceRow>>
where
    M: Mysql,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {NAMESPACE_COLUMNS} \
         FROM namespace \
         WHERE namespace.id IN ({}) AND namespace.is_active = 1",
        placeholders(ids.len()),
    );
    mysql.fetch_all(sql.as_str(), ids.to_vec()).await
}

/// Direct user memberships of namespaces
/// (`iter_user_groups_with_roles` step 1).
pub async fn direct_namespace_memberships<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<MemberRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            "SELECT {MEMBER_COLUMNS} \
             FROM resource_members \
             WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved'"
                .replace("{MEMBER_COLUMNS}", MEMBER_COLUMNS)
                .as_str(),
            (user_id.to_string(),),
        )
        .await
}

/// Resource ids for direct user memberships
/// (`NamespaceEntityResolver.get_resource_ids_by_entity` step 1).
pub async fn direct_namespace_resource_ids<M>(mysql: &M, user_id: i64) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_resource_id: i64,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            "SELECT resource_members.resource_id AS resource_members_resource_id \
             FROM resource_members \
             WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved'",
            (user_id.to_string(),),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// Namespace ids bound to an external entity type
/// (`NamespaceEntityResolver.get_resource_ids_by_entity` step 2).
pub async fn external_namespace_bindings<M>(
    mysql: &M,
    entity_type: &str,
) -> MysqlResult<Vec<(i64, String)>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_resource_id: i64,
        resource_members_entity_id: String,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            "SELECT resource_members.resource_id AS resource_members_resource_id, \
             resource_members.entity_id AS resource_members_entity_id \
             FROM resource_members \
             WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.entity_type = ? \
             AND resource_members.status = 'approved'",
            (entity_type,),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.resource_members_resource_id,
                row.resource_members_entity_id,
            )
        })
        .collect())
}

/// Namespace-grant members (`entity_type='namespace'`) for the given
/// namespace ids. `ids` keeps the source's `set` iteration order
/// (`list(set(direct) | entity)`), reproduced by the caller.
pub async fn namespace_entity_resource_ids<M>(
    mysql: &M,
    namespace_ids: &[i64],
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if namespace_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_resource_id: i64,
    }
    let sql = format!(
        "SELECT resource_members.resource_id AS resource_members_resource_id \
         FROM resource_members \
         WHERE resource_members.resource_type IN ('Namespace') \
         AND resource_members.entity_type = 'namespace' \
         AND resource_members.entity_id IN ({}) \
         AND resource_members.status = 'approved'",
        placeholders(namespace_ids.len()),
    );
    let rows: Vec<Row> = mysql
        .fetch_all(
            sql.as_str(),
            namespace_ids
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<String>>(),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// Distinct external entity ids bound to any namespace
/// (`EntityResolver.get_resource_ids_by_entity` step 1).
pub async fn distinct_external_entity_ids<M>(
    mysql: &M,
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
             FROM resource_members \
             WHERE resource_members.resource_type = 'Namespace' \
             AND resource_members.entity_type = ? \
             AND resource_members.entity_id IS NOT NULL \
             AND resource_members.status = 'approved'",
            (entity_type,),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_entity_id)
        .collect())
}

/// Distinct namespace ids bound to the matched external entities
/// (`list_resources_by_entity_match`).
pub async fn namespace_ids_for_external_entities<M>(
    mysql: &M,
    entity_type: &str,
    entity_ids: &[String],
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_resource_id: i64,
    }
    let sql = format!(
        "SELECT DISTINCT resource_members.resource_id AS resource_members_resource_id \
         FROM resource_members \
         WHERE resource_members.resource_type = 'Namespace' \
         AND resource_members.entity_type = ? \
         AND resource_members.entity_id IN ({}) \
         AND resource_members.status = 'approved'",
        placeholders(entity_ids.len()),
    );
    let rows: Vec<Row> = mysql
        .fetch_all(sql.as_str(), {
            let mut args = vec![entity_type.to_owned()];
            args.extend(entity_ids.iter().cloned());
            args
        })
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// External entity members of the given namespaces
/// (`iter_user_groups_with_roles` step 2).
///
/// `resource_members.resource_id` is an integer column: the source builds the
/// IN list from the resolver's integer resource ids, so the target binds them
/// as integers and only `entity_type` as a string.
pub async fn external_members_for_namespaces<M>(
    mysql: &M,
    entity_type: &str,
    namespace_ids: &[i64],
) -> MysqlResult<Vec<MemberRow>>
where
    M: Mysql,
{
    if namespace_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {MEMBER_COLUMNS} \
         FROM resource_members \
         WHERE resource_members.resource_type = 'Namespace' \
         AND resource_members.resource_id IN ({}) \
         AND resource_members.entity_type = ? \
         AND resource_members.status = 'approved'",
        placeholders(namespace_ids.len()),
    );
    mysql
        .fetch_all(
            sql.as_str(),
            external_member_args(entity_type, namespace_ids),
        )
        .await
}

/// The external-members query's bound values: the integer namespace ids in the
/// caller's order, then the string entity type.
fn external_member_args(entity_type: &str, namespace_ids: &[i64]) -> Vec<BindingArg> {
    let mut args: Vec<BindingArg> = namespace_ids.iter().copied().map(BindingArg::Int).collect();
    args.push(BindingArg::Str(entity_type.to_owned()));
    args
}

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
    fn namespace_member_ids_bind_as_integers() {
        // The recorded statement renders `resource_members.resource_id IN (245)`
        // as an integer literal, so the target must not bind a string.
        assert_eq!(
            external_member_args("org_department", &[245]),
            vec![
                BindingArg::Int(245),
                BindingArg::Str("org_department".to_string()),
            ]
        );
        assert_eq!(
            external_member_args("org_department", &[703, 660]),
            vec![
                BindingArg::Int(703),
                BindingArg::Int(660),
                BindingArg::Str("org_department".to_string()),
            ]
        );
    }

    #[test]
    fn pagination_bounds() {
        assert!(validate_pagination(1, 100).is_ok());
        assert!(validate_pagination(0, 10).is_err());
        assert!(validate_pagination(1, 101).is_err());
        assert!(validate_pagination(1, 0).is_err());
    }
}
