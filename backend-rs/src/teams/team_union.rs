// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The accessible-team UNION queries and related kinds/user lookups for
//! `GET /api/teams` (`_build_accessible_teams_query`, `count_user_teams`,
//! and the preload lookups over `kinds` / `users`).
//!
//! Split from `teams_repository` to keep each file under the 1000-line
//! source-review limit; the statements and their ordering contracts are
//! unchanged.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use super::teams_repository::{
    KIND_COLUMNS, KindRow, TeamRow, USER_COLUMNS, UserSummaryRow, placeholders,
};

/// The deduplicated accessible-team union with pagination
/// (`_build_accessible_teams_query` + `final_query`).
///
/// `skip` and `limit` must be pre-validated by `validate_pagination`; they
/// are inlined as literals exactly like the source's rendered
/// `LIMIT offset, limit` clause.
pub async fn accessible_teams<M>(
    mysql: &M,
    user_id: i64,
    scope: &str,
    group_namespaces: &[String],
    authorized_namespace_ids: &[i64],
    skip: i64,
    limit: i64,
) -> MysqlResult<Vec<TeamRow>>
where
    M: Mysql,
{
    let Some(sql) = union_sql(
        user_id,
        scope,
        group_namespaces,
        authorized_namespace_ids,
        Some((skip, limit)),
    ) else {
        return Ok(Vec::new());
    };
    let args = union_arguments(
        user_id,
        scope,
        group_namespaces,
        authorized_namespace_ids,
        true,
    );
    mysql.fetch_all(sql.as_str(), args).await
}

/// Count of distinct accessible team ids (`count_user_teams`).
///
/// Unlike `_build_accessible_teams_query` (which renders one branch with
/// `kinds.namespace IN (...)`), the source's `count_user_teams` loops over
/// `namespaces_to_count` and appends one branch per group namespace with a
/// single `kinds.namespace = ?` predicate, labels the union
/// `combined_team_counts`, and selects `count(distinct(...)) AS count_1`.
/// A single-branch count renders the bare subquery alias `anon_1` instead.
/// The recorded exchanges are plain COM_QUERY with inline literals; the
/// target binds the same values as prepared-statement parameters, which the
/// replay engine matches cross-protocol exactly like the main team query.
pub async fn count_user_teams<M>(
    mysql: &M,
    user_id: i64,
    scope: &str,
    group_namespaces: &[String],
    authorized_namespace_ids: &[i64],
) -> MysqlResult<i64>
where
    M: Mysql,
{
    let Some((alias, union)) = count_union_sql(scope, group_namespaces, authorized_namespace_ids)
    else {
        // `if not count_queries: return 0` — no SQL is issued.
        return Ok(0);
    };
    let sql = format!(
        "SELECT count(distinct({alias}.team_id)) AS count_1 \
         FROM ({union}) AS {alias}"
    );
    #[derive(Debug, FromMysqlRow)]
    struct CountRow {
        count_1: i64,
    }
    let args = count_union_arguments(user_id, scope, group_namespaces, authorized_namespace_ids);
    let row: CountRow = mysql.fetch_one(sql.as_str(), args).await?;
    Ok(row.count_1)
}

/// Render the UNION ALL branches of the count query. Returns the subquery
/// alias (`combined_team_counts`, or `anon_1` for a single branch) and the
/// joined branch SQL; `None` when no branch applies.
fn count_union_sql(
    scope: &str,
    group_namespaces: &[String],
    authorized_namespace_ids: &[i64],
) -> Option<(&'static str, String)> {
    // `namespaces_to_count` contains "default" for personal/all scopes.
    let has_default = scope == "personal" || scope == "all";
    let include_shared = scope == "personal" || scope == "all";
    let mut branches: Vec<String> = Vec::new();

    if has_default {
        // Own teams.
        branches.push(
            "SELECT kinds.id AS team_id \
             FROM kinds \
             WHERE kinds.user_id = ? AND kinds.kind = 'Team' \
             AND kinds.namespace = 'default' AND kinds.is_active = true"
                .to_string(),
        );
        if include_shared {
            branches.push(
                "SELECT kinds.id AS team_id \
                 FROM resource_members INNER JOIN kinds \
                 ON resource_members.resource_id = kinds.id \
                 AND resource_members.resource_type IN ('Team', 'TEAM') \
                 WHERE resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = ? \
                 AND resource_members.status IN ('approved', 'APPROVED') \
                 AND kinds.is_active = true AND kinds.kind = 'Team'"
                    .to_string(),
            );
        }
        // Public (system-owned) teams.
        branches.push(
            "SELECT kinds.id AS team_id \
             FROM kinds \
             WHERE kinds.user_id = 0 AND kinds.kind = 'Team' \
             AND kinds.namespace = 'default' AND kinds.is_active = true"
                .to_string(),
        );
    }

    // One branch per group namespace (`for namespace in namespaces_to_count`).
    for _ in group_namespaces {
        branches.push(
            "SELECT kinds.id AS team_id \
             FROM kinds \
             WHERE kinds.kind = 'Team' AND kinds.namespace = ? \
             AND kinds.is_active = true"
                .to_string(),
        );
    }

    if !authorized_namespace_ids.is_empty() {
        // The authorized branch always follows group namespaces in the
        // source (`~Kind.namespace.in_(group_namespaces)`), and authorized
        // ids only exist when group namespaces do.
        branches.push(format!(
            "SELECT kinds.id AS team_id \
             FROM kinds \
             WHERE (EXISTS (SELECT 1 \
             FROM resource_members \
             WHERE resource_members.resource_id = kinds.id \
             AND resource_members.resource_type IN ('Team', 'TEAM') \
             AND resource_members.entity_type = 'namespace' \
             AND resource_members.entity_id IN ({entity_list}) \
             AND resource_members.status IN ('approved', 'APPROVED'))) \
             AND kinds.kind = 'Team' AND kinds.is_active IS true \
             AND (kinds.namespace NOT IN ({not_in}))",
            entity_list = placeholders(authorized_namespace_ids.len()),
            not_in = placeholders(group_namespaces.len()),
        ));
    }

    if branches.is_empty() {
        return None;
    }
    if branches.len() == 1 {
        // `count_queries[0].subquery()` renders the default `anon_1` alias.
        Some(("anon_1", branches.join(" UNION ALL ")))
    } else {
        Some(("combined_team_counts", branches.join(" UNION ALL ")))
    }
}

/// Bind the count-query arguments in branch order: the own branch's integer
/// user id, the shared branch's string entity id, one string per group
/// namespace branch, the authorized entity ids, then the group namespaces
/// again for the NOT IN list.
fn count_union_arguments(
    user_id: i64,
    scope: &str,
    group_namespaces: &[String],
    authorized_namespace_ids: &[i64],
) -> Vec<UnionArg> {
    let has_default = scope == "personal" || scope == "all";
    let include_shared = scope == "personal" || scope == "all";
    let mut args: Vec<UnionArg> = Vec::new();
    if has_default {
        args.push(UnionArg::Int(user_id));
        if include_shared {
            args.push(UnionArg::Str(user_id.to_string()));
        }
    }
    args.extend(group_namespaces.iter().cloned().map(UnionArg::Str));
    args.extend(
        authorized_namespace_ids
            .iter()
            .map(|id| UnionArg::Str(id.to_string())),
    );
    if !authorized_namespace_ids.is_empty() {
        args.extend(group_namespaces.iter().cloned().map(UnionArg::Str));
    }
    args
}

/// Render the UNION ALL branches of the accessible-team query. `pagination`
/// appends the ranked outer query with `LIMIT offset, limit`.
///
/// The statement mirrors the recorded SQLAlchemy rendering token for token:
/// every branch selects the same labeled columns, the ranked subquery keeps
/// `row_number() OVER (PARTITION BY ... ) AS access_row_number`, and the
/// outer query filters `anon_1.access_row_number = 1` before the
/// `ORDER BY ... LIMIT offset, limit`.
fn union_sql(
    user_id: i64,
    scope: &str,
    group_namespaces: &[String],
    authorized_namespace_ids: &[i64],
    pagination: Option<(i64, i64)>,
) -> Option<String> {
    let _ = user_id;
    let has_default = scope == "personal" || scope == "all";
    let include_shared = scope == "personal" || scope == "all";
    let mut branches: Vec<String> = Vec::new();

    if has_default {
        // Own teams: context_user_id is the requesting user; the source
        // inlines both user_id occurrences as bound parameters.
        branches.push(
            "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
             kinds.name AS team_name, kinds.namespace AS team_namespace, \
             kinds.json AS team_json, kinds.created_at AS team_created_at, \
             kinds.updated_at AS team_updated_at, 0 AS share_status, \
             ? AS context_user_id, 'native' AS access_source, 0 AS access_rank \
             FROM kinds \
             WHERE kinds.user_id = ? AND kinds.kind = 'Team' \
             AND kinds.namespace = 'default' AND kinds.is_active = true"
                .to_string(),
        );
        if include_shared {
            branches.push(
                "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
                 kinds.name AS team_name, kinds.namespace AS team_namespace, \
                 kinds.json AS team_json, kinds.created_at AS team_created_at, \
                 kinds.updated_at AS team_updated_at, 2 AS share_status, \
                 kinds.user_id AS context_user_id, 'user_share' AS access_source, \
                 1 AS access_rank FROM kinds INNER JOIN resource_members \
                 ON resource_members.resource_id = kinds.id \
                 AND resource_members.resource_type IN ('Team', 'TEAM') \
                 WHERE resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = ? \
                 AND resource_members.status IN ('approved', 'APPROVED') \
                 AND kinds.is_active = true AND kinds.kind = 'Team'"
                    .to_string(),
            );
        }
        branches.push(
            "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
             kinds.name AS team_name, kinds.namespace AS team_namespace, \
             kinds.json AS team_json, kinds.created_at AS team_created_at, \
             kinds.updated_at AS team_updated_at, 0 AS share_status, \
             0 AS context_user_id, 'native' AS access_source, 0 AS access_rank \
             FROM kinds \
             WHERE kinds.user_id = 0 AND kinds.kind = 'Team' \
             AND kinds.namespace = 'default' AND kinds.is_active = true"
                .to_string(),
        );
    }

    if !group_namespaces.is_empty() {
        branches.push(format!(
            "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
             kinds.name AS team_name, kinds.namespace AS team_namespace, \
             kinds.json AS team_json, kinds.created_at AS team_created_at, \
             kinds.updated_at AS team_updated_at, 0 AS share_status, \
             kinds.user_id AS context_user_id, 'native' AS access_source, \
             0 AS access_rank FROM kinds \
             WHERE kinds.kind = 'Team' \
             AND kinds.namespace IN ({}) AND kinds.is_active = true",
            placeholders(group_namespaces.len()),
        ));
    }

    if !authorized_namespace_ids.is_empty() {
        let entity_list = placeholders(authorized_namespace_ids.len());
        let not_in = if group_namespaces.is_empty() {
            String::new()
        } else {
            format!(
                " AND (kinds.namespace NOT IN ({}))",
                placeholders(group_namespaces.len())
            )
        };
        branches.push(format!(
            "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
             kinds.name AS team_name, kinds.namespace AS team_namespace, \
             kinds.json AS team_json, kinds.created_at AS team_created_at, \
             kinds.updated_at AS team_updated_at, 2 AS share_status, \
             kinds.user_id AS context_user_id, \
             'namespace_authorization' AS access_source, 2 AS access_rank \
             FROM kinds WHERE (EXISTS (SELECT 1 \
             FROM resource_members \
             WHERE resource_members.resource_id = kinds.id \
             AND resource_members.resource_type IN ('Team', 'TEAM') \
             AND resource_members.entity_type = 'namespace' \
             AND resource_members.entity_id IN ({entity_list}) \
             AND resource_members.status IN ('approved', 'APPROVED'))) \
             AND kinds.kind = 'Team' AND kinds.is_active IS true{not_in}"
        ));
    }

    if branches.is_empty() {
        return None;
    }
    let combined = branches.join(" UNION ALL ");
    match pagination {
        Some((skip, limit)) => Some(format!(
            "SELECT anon_1.team_id AS anon_1_team_id, \
             anon_1.team_user_id AS anon_1_team_user_id, \
             anon_1.team_name AS anon_1_team_name, \
             anon_1.team_namespace AS anon_1_team_namespace, \
             anon_1.team_json AS anon_1_team_json, \
             anon_1.team_created_at AS anon_1_team_created_at, \
             anon_1.team_updated_at AS anon_1_team_updated_at, \
             anon_1.share_status AS anon_1_share_status, \
             anon_1.context_user_id AS anon_1_context_user_id, \
             anon_1.access_source AS anon_1_access_source \
             FROM (SELECT combined_teams.team_id AS team_id, \
             combined_teams.team_user_id AS team_user_id, \
             combined_teams.team_name AS team_name, \
             combined_teams.team_namespace AS team_namespace, \
             combined_teams.team_json AS team_json, \
             combined_teams.team_created_at AS team_created_at, \
             combined_teams.team_updated_at AS team_updated_at, \
             combined_teams.share_status AS share_status, \
             combined_teams.context_user_id AS context_user_id, \
             combined_teams.access_source AS access_source, \
             row_number() OVER (PARTITION BY combined_teams.team_id \
             ORDER BY combined_teams.access_rank ASC, \
             combined_teams.team_updated_at DESC, \
             combined_teams.team_id DESC) AS access_row_number \
             FROM ({combined}) AS combined_teams) AS anon_1 \
             WHERE anon_1.access_row_number = 1 \
             ORDER BY anon_1.team_updated_at DESC, anon_1.team_id DESC \
             LIMIT {skip}, {limit}"
        )),
        None => Some(combined),
    }
}

/// One bound union-query argument, preserving the recorded literal's token
/// kind: integer user ids bind as `Int` (recorded `2927`), and every
/// identifier the source renders as a quoted string (`'2927'`,
/// `'Player_FAQ'`) binds as `Str`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UnionArg {
    Int(i64),
    Str(String),
}

impl brz_mysql::MysqlValue for UnionArg {
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

/// Bind the union query arguments in branch order.
fn union_arguments(
    user_id: i64,
    scope: &str,
    group_namespaces: &[String],
    authorized_namespace_ids: &[i64],
    with_pagination: bool,
) -> Vec<UnionArg> {
    let has_default = scope == "personal" || scope == "all";
    let include_shared = scope == "personal" || scope == "all";
    let mut args: Vec<UnionArg> = Vec::new();
    if has_default {
        // own branch: context_user_id and user_id render as integer literals
        args.push(UnionArg::Int(user_id));
        args.push(UnionArg::Int(user_id));
        if include_shared {
            // shared branch: entity_id renders as a quoted string
            args.push(UnionArg::Str(user_id.to_string()));
        }
    }
    args.extend(group_namespaces.iter().cloned().map(UnionArg::Str));
    args.extend(
        authorized_namespace_ids
            .iter()
            .map(|id| UnionArg::Str(id.to_string())),
    );
    if !authorized_namespace_ids.is_empty() && !group_namespaces.is_empty() {
        args.extend(group_namespaces.iter().cloned().map(UnionArg::Str));
    }
    let _ = with_pagination;
    args
}

/// Team-owner user summaries. `ids` must be in the source's Python-set
/// order; the SQL renders the same full column
/// list `db.query(User)` produces.
pub async fn users_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<UserSummaryRow>>
where
    M: Mysql,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {USER_COLUMNS} \
         FROM users \
         WHERE users.id IN ({})",
        placeholders(ids.len()),
    );
    mysql.fetch_all(sql.as_str(), ids.to_vec()).await
}

/// Bots by `(user_id, name, namespace)` triples (personal bots) or
/// `(name, namespace)` pairs (group bots). `refs` keeps the caller's
/// construction order, duplicates included, exactly like the source's
/// `all_bot_refs` list.
/// One bound argument of a `kinds_by_refs` query. The source renders
/// `kinds.user_id` as an integer literal and `kinds.name` / `kinds.namespace`
/// as quoted strings; the replay matcher compares bound values by token kind,
/// so the user id must bind as an integer exactly like the recorded rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
enum KindRefArg {
    Int(i64),
    Str(String),
}

impl brz_mysql::MysqlValue for KindRefArg {
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

/// Bot/shell/model kinds by `(user_id, name, namespace)` triples (personal
/// kinds) or `(name, namespace)` pairs (group kinds). `refs` keeps the
/// caller's construction order, duplicates included, exactly like the source's
/// `all_bot_refs` list.
pub async fn kinds_by_refs<M>(
    mysql: &M,
    kind: &str,
    refs: &[(i64, String, String)],
    with_user: bool,
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let mut conditions = Vec::with_capacity(refs.len());
    for _ in refs {
        conditions.push(if with_user {
            "kinds.user_id = ? AND kinds.name = ? AND kinds.namespace = ?"
        } else {
            "kinds.name = ? AND kinds.namespace = ?"
        });
    }
    // SQLAlchemy renders `or_(*conditions)` without parentheses when there is
    // exactly one condition (recorded single group-bot / single-ref queries),
    // and with parentheses around the joined group otherwise.
    let joined = conditions.join(" OR ");
    let condition_sql = if conditions.len() == 1 {
        joined
    } else {
        format!("({joined})")
    };
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = ? AND kinds.is_active = true AND {condition_sql}"
    );
    let mut args: Vec<KindRefArg> = Vec::with_capacity(refs.len() * 3 + 1);
    args.push(KindRefArg::Str(kind.to_string()));
    for (user_id, name, namespace) in refs {
        if with_user {
            args.push(KindRefArg::Int(*user_id));
        }
        args.push(KindRefArg::Str(name.clone()));
        args.push(KindRefArg::Str(namespace.clone()));
    }
    mysql.fetch_all(sql.as_str(), args).await
}

/// Public kinds by name (`user_id = 0`). `names` keeps the caller's order.
pub async fn public_kinds_by_names<M>(
    mysql: &M,
    kind: &str,
    names: &[String],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = ? AND kinds.user_id = 0 \
         AND kinds.is_active = true AND kinds.name IN ({})",
        placeholders(names.len()),
    );
    let mut args: Vec<String> = Vec::with_capacity(names.len() + 1);
    args.push(kind.to_string());
    args.extend(names.iter().cloned());
    mysql.fetch_all(sql.as_str(), args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_argument_order_matches_branch_order() {
        let groups = vec!["alpha".to_string(), "beta".to_string()];
        let authorized = vec![7i64, 9];
        let args = union_arguments(229, "all", &groups, &authorized, true);
        // own(2) + shared(1) + groups(2) + authorized(2) + groups again(2)
        assert_eq!(
            args,
            vec![
                UnionArg::Int(229),
                UnionArg::Int(229),
                UnionArg::Str("229".to_string()),
                UnionArg::Str("alpha".to_string()),
                UnionArg::Str("beta".to_string()),
                UnionArg::Str("7".to_string()),
                UnionArg::Str("9".to_string()),
                UnionArg::Str("alpha".to_string()),
                UnionArg::Str("beta".to_string()),
            ]
        );
    }

    #[test]
    fn union_sql_contains_all_branches() {
        let groups = vec!["alpha".to_string()];
        let sql = union_sql(229, "all", &groups, &[3], Some((0, 100))).unwrap();
        assert!(sql.contains("'user_share' AS access_source"));
        assert!(sql.contains("'namespace_authorization' AS access_source"));
        assert!(sql.contains("kinds.namespace NOT IN (?)"));
        assert!(sql.ends_with("LIMIT 0, 100"));
        assert!(sql.contains("row_number() OVER (PARTITION BY combined_teams.team_id"));
        assert!(sql.contains("WHERE anon_1.access_row_number = 1"));
        // Entity ids bind as string placeholders like the source's
        // str(ns_id) rendering.
        assert!(sql.contains("resource_members.entity_id IN (?)"));
    }

    #[test]
    fn count_union_renders_one_branch_per_group() {
        let groups = vec!["alpha".to_string(), "beta".to_string()];
        let (alias, union) = count_union_sql("all", &groups, &[7, 9]).unwrap();
        assert_eq!(alias, "combined_team_counts");
        // own + shared + public + one per group + authorized = 6 branches.
        assert_eq!(union.matches(" UNION ALL ").count(), 5);
        // One `kinds.namespace = ?` predicate per group branch, no IN list.
        assert_eq!(union.matches("kinds.namespace = ?").count(), 2);
        assert!(!union.contains("kinds.namespace IN ("));
        // Authorized branch keeps the NOT IN list over the group namespaces.
        assert!(union.contains("kinds.namespace NOT IN (?, ?)"));
        assert!(union.contains("resource_members.entity_id IN (?, ?)"));
    }

    #[test]
    fn count_union_single_group_without_default() {
        // scope=group: no own/shared/public branches, only the group branch.
        let groups = vec!["alpha".to_string()];
        let (alias, union) = count_union_sql("group", &groups, &[]).unwrap();
        assert_eq!(alias, "anon_1");
        assert_eq!(union.matches(" UNION ALL ").count(), 0);
        assert!(union.contains("kinds.namespace = ?"));
    }

    #[test]
    fn count_union_personal_scope_only_default() {
        let (alias, union) = count_union_sql("personal", &[], &[]).unwrap();
        assert_eq!(alias, "combined_team_counts");
        assert_eq!(union.matches(" UNION ALL ").count(), 2);
        assert!(union.contains("kinds.user_id = ? AND kinds.kind = 'Team'"));
        assert!(union.contains("kinds.user_id = 0 AND kinds.kind = 'Team'"));
    }

    #[test]
    fn count_argument_order_matches_branch_order() {
        let groups = vec!["alpha".to_string(), "beta".to_string()];
        let authorized = vec![7i64, 9];
        let args = count_union_arguments(229, "all", &groups, &authorized);
        // own(1 int) + shared(1 str) + groups(2) + authorized(2) + groups again(2)
        assert_eq!(
            args,
            vec![
                UnionArg::Int(229),
                UnionArg::Str("229".to_string()),
                UnionArg::Str("alpha".to_string()),
                UnionArg::Str("beta".to_string()),
                UnionArg::Str("7".to_string()),
                UnionArg::Str("9".to_string()),
                UnionArg::Str("alpha".to_string()),
                UnionArg::Str("beta".to_string()),
            ]
        );
    }
}
