// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The accessible-team UNION query and related kinds/user lookups for
//! `GET /api/teams` (`_build_accessible_teams_query`, its `.count()` form,
//! and the preload lookups over `kinds` / `users`).
//!
//! Split from `teams_repository` to keep each file under the 1000-line
//! source-review limit; the statements and their ordering contracts are
//! unchanged.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use super::teams_repository::{
    BindingArg, KIND_COLUMNS, KindRow, TeamRow, USER_COLUMNS, UserSummaryRow, placeholders,
};

/// One source `build_team_list_filters` predicate, appended to every union
/// branch after its own predicates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeamListFilter {
    /// `source_filter in ("mine", "personal")`: `Kind.user_id == user_id`.
    OwnerUserId,
    /// `source_filter == "personal"`: `Kind.namespace == "default"`.
    DefaultNamespace,
    /// `source_filter == "system"`: `Kind.user_id == 0`.
    SystemOwner,
    /// `mode is not None`: the bind-mode text must not be an empty list.
    HasBindMode,
    /// `mode != "all"`: the bind-mode text carries the mode name.
    BindModeLike(String),
}

/// `_resource_json_text(db, "$.spec.bind_mode")` on MySQL.
const BIND_MODE_TEXT: &str =
    "coalesce(json_unquote(json_extract(kinds.json, '$.spec.bind_mode')), '')";

impl TeamListFilter {
    /// `build_team_list_filters`: the predicates the endpoint derives from the
    /// `source_filter` and `mode` query parameters, in source order.
    pub fn for_query(source_filter: Option<&str>, mode: Option<&str>) -> Vec<Self> {
        let mut filters = Vec::new();
        if matches!(source_filter, Some("mine" | "personal")) {
            filters.push(Self::OwnerUserId);
        }
        if source_filter == Some("personal") {
            filters.push(Self::DefaultNamespace);
        } else if source_filter == Some("system") {
            filters.push(Self::SystemOwner);
        }
        if let Some(mode) = mode {
            filters.push(Self::HasBindMode);
            if mode != "all" {
                filters.push(Self::BindModeLike(mode.to_string()));
            }
        }
        filters
    }

    /// The predicate SQL, in source filter order, with `?` per bound value.
    fn sql(&self) -> String {
        match self {
            Self::OwnerUserId => "kinds.user_id = ?".to_string(),
            Self::DefaultNamespace => "kinds.namespace = 'default'".to_string(),
            Self::SystemOwner => "kinds.user_id = 0".to_string(),
            Self::HasBindMode => format!("{BIND_MODE_TEXT} != '[]'"),
            Self::BindModeLike(_) => {
                format!("({BIND_MODE_TEXT} IN (?, ?) OR {BIND_MODE_TEXT} LIKE ?)")
            }
        }
    }

    /// The values bound by `sql`, in placeholder order.
    fn args(&self, user_id: i64) -> Vec<BindingArg> {
        match self {
            Self::OwnerUserId => vec![BindingArg::Int(user_id)],
            Self::BindModeLike(mode) => vec![
                BindingArg::Str(String::new()),
                BindingArg::Str("null".to_string()),
                BindingArg::Str(format!("%\"{mode}\"%")),
            ],
            Self::DefaultNamespace | Self::SystemOwner | Self::HasBindMode => Vec::new(),
        }
    }
}

/// The resolved selection of the accessible-team union: the scope the source
/// expands, the group namespaces it expands to, the namespace-authorization
/// ids, the restricted group namespaces the `restricted_guest_access` label
/// compares against, and the resolved `build_team_list_filters` predicates.
#[derive(Clone, Copy)]
pub struct AccessibleTeamsQuery<'a> {
    pub user_id: i64,
    pub scope: &'a str,
    pub group_namespaces: &'a [String],
    pub authorized_namespace_ids: &'a [i64],
    pub restricted_namespaces: &'a [String],
    pub filters: &'a [TeamListFilter],
    /// `source_filter == "group"` (`shared_only`): the ranked query keeps only
    /// non-default namespaces or shared teams.
    pub shared_only: bool,
    pub skip: i64,
    pub limit: i64,
}

/// The deduplicated accessible-team union page
/// (`_build_accessible_teams_query` + `_load_teams_from_query`).
///
/// Returns `None` when the source builds no union branch
/// (`accessible_query is None`): no SQL is issued and the caller reports zero
/// items and a zero total. `skip` and `limit` must be pre-validated by
/// `validate_pagination`; they are inlined as literals exactly like the
/// source's rendered `LIMIT offset, limit` clause.
pub async fn accessible_teams<M>(
    mysql: &M,
    query: AccessibleTeamsQuery<'_>,
) -> MysqlResult<Option<Vec<TeamRow>>>
where
    M: Mysql,
{
    let Some(body) = union_body(&query) else {
        return Ok(None);
    };
    let sql = format!(
        "{} ORDER BY anon_1.team_updated_at DESC, anon_1.team_id DESC LIMIT {}, {}",
        base_query_sql(&body, "anon_1", query.shared_only),
        query.skip,
        query.limit,
    );
    mysql.fetch_all(sql.as_str(), body.args).await.map(Some)
}

/// `accessible_query[0].count()`: the same ranked query wrapped in
/// `SELECT count(*)`, with the ranked alias renamed `anon_2` and the count
/// subquery aliased `anon_1`. Returns `None` when there is no branch, which
/// the caller reports as a zero total.
pub async fn team_count<M>(mysql: &M, query: AccessibleTeamsQuery<'_>) -> MysqlResult<Option<i64>>
where
    M: Mysql,
{
    let Some(body) = union_body(&query) else {
        return Ok(None);
    };
    let sql = format!(
        "SELECT count(*) AS count_1 FROM ({}) AS anon_1",
        base_query_sql(&body, "anon_2", query.shared_only),
    );
    #[derive(Debug, FromMysqlRow)]
    struct CountRow {
        count_1: i64,
    }
    let row: CountRow = mysql.fetch_one(sql.as_str(), body.args).await?;
    Ok(Some(row.count_1))
}

/// Render the `restricted_guest_access` label of a union branch.
///
/// The source computes the label from a Python `set` with
/// `column.in_(namespaces)`. SQLAlchemy renders that as the ordinary
/// parameter list when the set is non-empty, and as the always-false
/// `IN (NULL) AND (1 != 1)` when it is empty.
fn restricted_label(column: &str, namespaces: &[String]) -> String {
    if namespaces.is_empty() {
        format!("{column} IN (NULL) AND (1 != 1)")
    } else {
        format!("{column} IN ({})", placeholders(namespaces.len()))
    }
}

/// A rendered union body: the `UNION ALL` branches and their bound values in
/// placeholder order.
struct UnionBody {
    sql: String,
    args: Vec<BindingArg>,
}

/// Render the UNION ALL branches of the accessible-team query. Returns `None`
/// when the source appends no branch (`if not queries: return None`).
///
/// The statement mirrors the recorded SQLAlchemy rendering token for token:
/// every branch selects the same labeled columns, including the
/// `restricted_guest_access` label the source derives from
/// `restricted_group_namespaces`; the ranked subquery keeps
/// `row_number() OVER (PARTITION BY ... ) AS access_row_number` ordered by
/// `access_rank`, `restricted_guest_access`, `team_updated_at` and `team_id`;
/// and the outer query filters `anon_1.access_row_number = 1`.
fn union_body(query: &AccessibleTeamsQuery<'_>) -> Option<UnionBody> {
    let has_default = query.scope == "personal" || query.scope == "all";
    let include_shared = query.scope == "personal" || query.scope == "all";
    let mut branches: Vec<(String, Vec<BindingArg>)> = Vec::new();

    // `query.filter(*filters)` appends the list filters after the branch's own
    // predicates, so their placeholders follow the branch's own values.
    let filter_sql = query
        .filters
        .iter()
        .map(TeamListFilter::sql)
        .collect::<Vec<String>>()
        .join(" AND ");
    let filter_args = |user_id: i64| -> Vec<BindingArg> {
        query
            .filters
            .iter()
            .flat_map(|filter| filter.args(user_id))
            .collect()
    };
    let with_filters = |mut args: Vec<BindingArg>, user_id: i64| -> Vec<BindingArg> {
        args.extend(filter_args(user_id));
        args
    };
    let suffix = if filter_sql.is_empty() {
        String::new()
    } else {
        format!(" AND {filter_sql}")
    };

    if has_default {
        // Own teams: context_user_id is the requesting user; the source
        // inlines both user_id occurrences as bound parameters.
        branches.push((
            format!(
                "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
                 kinds.name AS team_name, kinds.namespace AS team_namespace, \
                 kinds.json AS team_json, kinds.created_at AS team_created_at, \
                 kinds.updated_at AS team_updated_at, 0 AS share_status, \
                 ? AS context_user_id, 0 AS restricted_guest_access, \
                 'native' AS access_source, 0 AS access_rank \
                 FROM kinds \
                 WHERE kinds.user_id = ? AND kinds.kind = 'Team' \
                 AND kinds.namespace = 'default' AND kinds.is_active = true{suffix}"
            ),
            vec![
                BindingArg::Int(query.user_id),
                BindingArg::Int(query.user_id),
            ],
        ));
        if include_shared {
            branches.push((
                format!(
                    "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
                     kinds.name AS team_name, kinds.namespace AS team_namespace, \
                     kinds.json AS team_json, kinds.created_at AS team_created_at, \
                     kinds.updated_at AS team_updated_at, 2 AS share_status, \
                     kinds.user_id AS context_user_id, 0 AS restricted_guest_access, \
                     'user_share' AS access_source, \
                     1 AS access_rank FROM kinds INNER JOIN resource_members \
                     ON resource_members.resource_id = kinds.id \
                     AND resource_members.resource_type IN ('Team', 'TEAM') \
                     WHERE resource_members.entity_type = 'user' \
                     AND resource_members.entity_id = ? \
                     AND resource_members.status IN ('approved', 'APPROVED') \
                     AND kinds.is_active = true AND kinds.kind = 'Team'{suffix}"
                ),
                vec![BindingArg::Str(query.user_id.to_string())],
            ));
        }
        branches.push((
            format!(
                "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
                 kinds.name AS team_name, kinds.namespace AS team_namespace, \
                 kinds.json AS team_json, kinds.created_at AS team_created_at, \
                 kinds.updated_at AS team_updated_at, 0 AS share_status, \
                 0 AS context_user_id, 0 AS restricted_guest_access, \
                 'native' AS access_source, 0 AS access_rank \
                 FROM kinds \
                 WHERE kinds.user_id = 0 AND kinds.kind = 'Team' \
                 AND kinds.namespace = 'default' AND kinds.is_active = true{suffix}"
            ),
            Vec::new(),
        ));
    }

    if !query.group_namespaces.is_empty() {
        // Group teams: the label compares `kinds.namespace` against the
        // restricted group namespaces, the filter against all of them.
        let mut args: Vec<BindingArg> = query
            .restricted_namespaces
            .iter()
            .cloned()
            .map(BindingArg::Str)
            .collect();
        args.extend(query.group_namespaces.iter().cloned().map(BindingArg::Str));
        branches.push((
            format!(
                "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
                 kinds.name AS team_name, kinds.namespace AS team_namespace, \
                 kinds.json AS team_json, kinds.created_at AS team_created_at, \
                 kinds.updated_at AS team_updated_at, 0 AS share_status, \
                 kinds.user_id AS context_user_id, {} AS restricted_guest_access, \
                 'native' AS access_source, \
                 0 AS access_rank FROM kinds \
                 WHERE kinds.kind = 'Team' \
                 AND kinds.namespace IN ({}) AND kinds.is_active = true{suffix}",
                restricted_label("kinds.namespace", query.restricted_namespaces),
                placeholders(query.group_namespaces.len()),
            ),
            args,
        ));
    }

    if !query.authorized_namespace_ids.is_empty() {
        let entity_list = placeholders(query.authorized_namespace_ids.len());
        let not_in = if query.group_namespaces.is_empty() {
            String::new()
        } else {
            format!(
                " AND (kinds.namespace NOT IN ({}))",
                placeholders(query.group_namespaces.len())
            )
        };
        let mut args: Vec<BindingArg> = query
            .restricted_namespaces
            .iter()
            .cloned()
            .map(BindingArg::Str)
            .collect();
        args.extend(
            query
                .authorized_namespace_ids
                .iter()
                .map(|id| BindingArg::Str(id.to_string())),
        );
        if !query.group_namespaces.is_empty() {
            args.extend(query.group_namespaces.iter().cloned().map(BindingArg::Str));
        }
        // The source joins `namespace` so the label can compare
        // `namespace.name` and the filter can require an active namespace. It
        // compares the ids as integers
        // (`ResourceMember.entity_id.cast(Integer) == Namespace.id`) so the
        // string column never inherits the connection collation.
        branches.push((
            format!(
                "SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
                 kinds.name AS team_name, kinds.namespace AS team_namespace, \
                 kinds.json AS team_json, kinds.created_at AS team_created_at, \
                 kinds.updated_at AS team_updated_at, 2 AS share_status, \
                 kinds.user_id AS context_user_id, {} AS restricted_guest_access, \
                 'namespace_authorization' AS access_source, 2 AS access_rank \
                 FROM kinds INNER JOIN resource_members \
                 ON resource_members.resource_id = kinds.id \
                 AND resource_members.resource_type IN ('Team', 'TEAM') \
                 INNER JOIN namespace \
                 ON CAST(resource_members.entity_id AS SIGNED INTEGER) = namespace.id \
                 WHERE resource_members.entity_type = 'namespace' \
                 AND resource_members.entity_id IN ({entity_list}) \
                 AND resource_members.status IN ('approved', 'APPROVED') \
                 AND namespace.is_active IS true AND kinds.kind = 'Team' \
                 AND kinds.is_active IS true{not_in}{suffix}",
                restricted_label("namespace.name", query.restricted_namespaces),
            ),
            args,
        ));
    }

    if branches.is_empty() {
        return None;
    }
    let mut sql_parts: Vec<String> = Vec::with_capacity(branches.len());
    let mut args: Vec<BindingArg> = Vec::new();
    let user_id = query.user_id;
    for (branch_sql, branch_args) in branches {
        sql_parts.push(branch_sql);
        args.extend(with_filters(branch_args, user_id));
    }
    Some(UnionBody {
        sql: sql_parts.join(" UNION ALL "),
        args,
    })
}

/// The source's `base_query`: the ranked query minus pagination, optionally
/// restricted to shared or non-default teams (`shared_only`).
///
/// `alias` is the ranked subquery's alias: `anon_1` for the page query and
/// `anon_2` when the whole base query is wrapped by `count(*)`.
fn base_query_sql(body: &UnionBody, alias: &str, shared_only: bool) -> String {
    let shared_only_filter = if shared_only {
        format!(" AND ({alias}.team_namespace != 'default' OR {alias}.share_status = 2)")
    } else {
        String::new()
    };
    format!(
        "SELECT {alias}.team_id AS {alias}_team_id, \
         {alias}.team_user_id AS {alias}_team_user_id, \
         {alias}.team_name AS {alias}_team_name, \
         {alias}.team_namespace AS {alias}_team_namespace, \
         {alias}.team_json AS {alias}_team_json, \
         {alias}.team_created_at AS {alias}_team_created_at, \
         {alias}.team_updated_at AS {alias}_team_updated_at, \
         {alias}.share_status AS {alias}_share_status, \
         {alias}.context_user_id AS {alias}_context_user_id, \
         {alias}.restricted_guest_access AS {alias}_restricted_guest_access, \
         {alias}.access_source AS {alias}_access_source \
         FROM (SELECT combined_teams.team_id AS team_id, \
         combined_teams.team_user_id AS team_user_id, \
         combined_teams.team_name AS team_name, \
         combined_teams.team_namespace AS team_namespace, \
         combined_teams.team_json AS team_json, \
         combined_teams.team_created_at AS team_created_at, \
         combined_teams.team_updated_at AS team_updated_at, \
         combined_teams.share_status AS share_status, \
         combined_teams.context_user_id AS context_user_id, \
         combined_teams.restricted_guest_access AS restricted_guest_access, \
         combined_teams.access_source AS access_source, \
         row_number() OVER (PARTITION BY combined_teams.team_id \
         ORDER BY combined_teams.access_rank ASC, \
         combined_teams.restricted_guest_access DESC, \
         combined_teams.team_updated_at DESC, \
         combined_teams.team_id DESC) AS access_row_number \
         FROM ({}) AS combined_teams) AS {alias} \
         WHERE {alias}.access_row_number = 1{shared_only_filter}",
        body.sql
    )
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

    fn query<'a>(
        scope: &'a str,
        groups: &'a [String],
        authorized: &'a [i64],
        restricted: &'a [String],
        filters: &'a [TeamListFilter],
    ) -> AccessibleTeamsQuery<'a> {
        AccessibleTeamsQuery {
            user_id: 229,
            scope,
            group_namespaces: groups,
            authorized_namespace_ids: authorized,
            restricted_namespaces: restricted,
            filters,
            shared_only: false,
            skip: 0,
            limit: 100,
        }
    }

    fn page_sql(query: &AccessibleTeamsQuery<'_>) -> String {
        let body = union_body(query).unwrap();
        format!(
            "{} ORDER BY anon_1.team_updated_at DESC, anon_1.team_id DESC LIMIT {}, {}",
            base_query_sql(&body, "anon_1", query.shared_only),
            query.skip,
            query.limit,
        )
    }

    fn count_sql(query: &AccessibleTeamsQuery<'_>) -> String {
        let body = union_body(query).unwrap();
        format!(
            "SELECT count(*) AS count_1 FROM ({}) AS anon_1",
            base_query_sql(&body, "anon_2", query.shared_only),
        )
    }

    #[test]
    fn union_body_binds_values_in_placeholder_order() {
        let groups = vec!["alpha".to_string(), "beta".to_string()];
        let restricted = vec!["alpha".to_string()];
        let filters: Vec<TeamListFilter> = Vec::new();
        let body = union_body(&query("all", &groups, &[7, 9], &restricted, &filters)).unwrap();
        // own(2) + shared(1) + group restricted(1) + groups(2)
        // + authorized restricted(1) + authorized(2) + groups again(2)
        assert_eq!(
            body.args,
            vec![
                BindingArg::Int(229),
                BindingArg::Int(229),
                BindingArg::Str("229".to_string()),
                BindingArg::Str("alpha".to_string()),
                BindingArg::Str("alpha".to_string()),
                BindingArg::Str("beta".to_string()),
                BindingArg::Str("alpha".to_string()),
                BindingArg::Str("7".to_string()),
                BindingArg::Str("9".to_string()),
                BindingArg::Str("alpha".to_string()),
                BindingArg::Str("beta".to_string()),
            ]
        );
    }

    #[test]
    fn empty_restricted_list_renders_always_false_label() {
        let groups = vec!["alpha".to_string()];
        let filters: Vec<TeamListFilter> = Vec::new();
        let body = union_body(&query("all", &groups, &[7, 9], &[], &filters)).unwrap();
        // No value is bound for the empty label, so only the own(2) + shared(1)
        // + groups(1) + authorized(2) + groups again(1) values remain.
        assert_eq!(body.args.len(), 7);
        assert_eq!(
            restricted_label("kinds.namespace", &[]),
            "kinds.namespace IN (NULL) AND (1 != 1)"
        );
        assert_eq!(
            restricted_label("namespace.name", &["alpha".to_string()]),
            "namespace.name IN (?)"
        );
    }

    #[test]
    fn union_and_count_render_the_source_statement_shapes() {
        let groups = vec!["alpha".to_string()];
        let filters: Vec<TeamListFilter> = Vec::new();
        let query = query("all", &groups, &[3], &[], &filters);
        let page = page_sql(&query);
        assert!(page.contains("'user_share' AS access_source"));
        assert!(page.contains("'namespace_authorization' AS access_source"));
        assert!(page.contains("kinds.namespace NOT IN (?)"));
        assert!(
            page.ends_with(
                "ORDER BY anon_1.team_updated_at DESC, anon_1.team_id DESC LIMIT 0, 100"
            )
        );
        assert!(page.contains("row_number() OVER (PARTITION BY combined_teams.team_id"));
        assert!(page.contains("WHERE anon_1.access_row_number = 1"));
        assert!(page.contains("resource_members.entity_id IN (?)"));
        assert!(page.contains("0 AS restricted_guest_access"));
        assert!(page.contains("kinds.namespace IN (NULL) AND (1 != 1) AS restricted_guest_access"));
        assert!(page.contains("namespace.name IN (NULL) AND (1 != 1) AS restricted_guest_access"));
        assert!(page.contains("combined_teams.restricted_guest_access AS restricted_guest_access"));
        assert!(page.contains("combined_teams.restricted_guest_access DESC"));
        assert!(page.contains("anon_1.restricted_guest_access AS anon_1_restricted_guest_access"));
        assert!(page.contains(
            "INNER JOIN namespace ON CAST(resource_members.entity_id AS SIGNED INTEGER) = namespace.id"
        ));
        // The ids compare as integers, so `namespace.id` is never cast to a
        // string and the join cannot inherit the connection collation.
        assert!(!page.contains("CAST(namespace.id AS CHAR)"));
        assert!(page.contains("namespace.is_active IS true"));
        assert!(
            page.find("0 AS restricted_guest_access").unwrap()
                < page.find("'native' AS access_source").unwrap()
        );
        assert!(
            page.find("combined_teams.access_rank ASC").unwrap()
                < page
                    .find("combined_teams.restricted_guest_access DESC")
                    .unwrap()
        );

        // `accessible_query[0].count()` keeps the same ranked query, renames
        // its alias to `anon_2`, and drops the page's ordering and limit.
        let count = count_sql(&query);
        assert!(count.starts_with("SELECT count(*) AS count_1 FROM (SELECT anon_2.team_id"));
        assert!(count.contains("WHERE anon_2.access_row_number = 1) AS anon_1"));
        assert!(count.contains("anon_2.restricted_guest_access AS anon_2_restricted_guest_access"));
        assert!(!count.contains("ORDER BY anon_2"));
        assert!(!count.contains("LIMIT"));
    }

    #[test]
    fn list_filters_append_to_every_branch() {
        let groups = vec!["alpha".to_string()];
        let filters = vec![TeamListFilter::OwnerUserId, TeamListFilter::HasBindMode];
        let query = query("all", &groups, &[3], &[], &filters);
        let body = union_body(&query).unwrap();
        // Four branches (own, shared, public, group, authorized) -> five with
        // this scope; each carries the same filter predicates.
        assert_eq!(body.sql.matches(BIND_MODE_TEXT).count(), 5);
        // The own branch's own predicate plus one filter per branch.
        assert_eq!(body.sql.matches("kinds.user_id = ?").count(), 6);
        // The own branch binds the user twice; each of the five branches binds
        // it once more through `OwnerUserId`.
        assert_eq!(
            body.args
                .iter()
                .filter(|a| **a == BindingArg::Int(229))
                .count(),
            7
        );
    }

    #[test]
    fn bind_mode_filter_renders_the_source_like_predicate() {
        let filters = vec![TeamListFilter::BindModeLike("chat".to_string())];
        let query = query("personal", &[], &[], &[], &filters);
        let body = union_body(&query).unwrap();
        assert!(body.sql.contains(&format!(
            "{BIND_MODE_TEXT} IN (?, ?) OR {BIND_MODE_TEXT} LIKE ?"
        )));
        assert!(body.args.contains(&BindingArg::Str(String::new())));
        assert!(body.args.contains(&BindingArg::Str("null".to_string())));
        assert!(
            body.args
                .contains(&BindingArg::Str("%\"chat\"%".to_string()))
        );
    }

    #[test]
    fn shared_only_restricts_the_base_query() {
        let groups = ["alpha".to_string()];
        let mut query = query("group", &groups, &[], &[], &[]);
        query.shared_only = true;
        let page = page_sql(&query);
        assert!(page.contains(
            "WHERE anon_1.access_row_number = 1 AND (anon_1.team_namespace != 'default' OR anon_1.share_status = 2)"
        ));
        let count = count_sql(&query);
        assert!(count.contains(
            "WHERE anon_2.access_row_number = 1 AND (anon_2.team_namespace != 'default' OR anon_2.share_status = 2)"
        ));
    }

    #[test]
    fn group_scope_without_namespaces_builds_no_query() {
        let filters: Vec<TeamListFilter> = Vec::new();
        assert!(union_body(&query("group", &[], &[], &[], &filters)).is_none());
    }

    /// The namespace-authorization branch only appears for users with
    /// namespace grants, so a wrong JOIN expression there is invisible to the
    /// other scope shapes. Pin the source rendering
    /// (`ResourceMember.entity_id.cast(Integer) == Namespace.id`) exactly.
    #[test]
    fn authorization_branch_compares_namespace_ids_as_integers() {
        let groups = vec![
            "PM_agent".to_string(),
            "test-dev".to_string(),
            "tqt-analyze-group".to_string(),
            "tqt-server".to_string(),
        ];
        let authorized = vec![569, 557, 746, 613];
        let query = query("all", &groups, &authorized, &[], &[]);
        let page = page_sql(&query);
        assert!(page.contains(
            "INNER JOIN namespace ON CAST(resource_members.entity_id AS SIGNED INTEGER) = namespace.id"
        ));
        assert!(!page.contains("CAST(namespace.id AS CHAR)"));
        // `namespace.is_active.is_(True)` keeps `IS true`, and the branch
        // excludes the group namespaces already covered above.
        assert!(page.contains(
            "INNER JOIN namespace ON CAST(resource_members.entity_id AS SIGNED INTEGER) = \
             namespace.id WHERE resource_members.entity_type = 'namespace' \
             AND resource_members.entity_id IN (?, ?, ?, ?) \
             AND resource_members.status IN ('approved', 'APPROVED') \
             AND namespace.is_active IS true AND kinds.kind = 'Team' \
             AND kinds.is_active IS true AND (kinds.namespace NOT IN (?, ?, ?, ?))"
        ));
        // The same statement backs the count form.
        assert!(count_sql(&query).contains("CAST(resource_members.entity_id AS SIGNED INTEGER)"));
    }
}
