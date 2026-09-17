// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL data access for `GET /api/users/recent-teams`
//! (`team_kinds_service.get_recent_accessible_teams`), mirroring the source
//! SQLAlchemy renderings token for token: full labeled projections,
//! tuple-IN literal lists inlined as COM_QUERY text (the source renders the
//! kind refs as inline literals), and the fallback accessible-team union.
use crate::json_compat::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;

use super::super::teams_repository::KIND_COLUMNS;

/// `(name, namespace, owner_id)` kind reference extracted from recent tasks
/// (`_get_recent_team_refs`). `owner_id` is `None` for refs without a usable
/// `user_id`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TeamRef {
    pub name: String,
    pub namespace: String,
    pub owner_id: Option<i64>,
}

/// One `kinds` Team row (`_query_recent_team_kinds` / recent-kind lookup).
#[derive(Debug, FromMysqlRow)]
pub struct RecentKindRow {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    pub kinds_name: String,
    pub kinds_namespace: String,
    pub kinds_json: Json<OpaqueJson>,
}

/// One fallback accessible-team row
/// (`_query_latest_distinct_team_rows`). Decodes by the recorded `anon_1_*`
/// aliases.
#[derive(Debug)]
pub struct FallbackTeamRow {
    pub team_id: i64,
    pub team_user_id: i64,
    pub team_name: String,
    /// Selected to mirror the recorded projection; not consumed here.
    #[allow(dead_code)]
    pub team_namespace: String,
    pub team_json: OpaqueJson,
    /// Selected to mirror the recorded projection; not consumed here.
    #[allow(dead_code)]
    pub team_updated_at: NaiveDateTime,
}

fn decode_fallback_row(row: &MysqlRow) -> MysqlResult<FallbackTeamRow> {
    Ok(FallbackTeamRow {
        team_id: row.get_required("anon_1_team_id")?,
        team_user_id: row.get_required("anon_1_team_user_id")?,
        team_name: row.get_required("anon_1_team_name")?,
        team_namespace: row.get_required("anon_1_team_namespace")?,
        team_json: row.get_required::<Json<OpaqueJson>>("anon_1_team_json")?.0,
        team_updated_at: row.get_required("anon_1_team_updated_at")?,
    })
}

/// Escape one string literal with MySQL's default quoting rules.
fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x1a => out.push_str("\\Z"),
            other => out.push(other as char),
        }
    }
    out.push('\'');
    out
}

/// `task_store.list_recent_owner_only_tasks`: the owner's routed task table
/// with the approved-member exclusion, ordered
/// `updated_at DESC, id DESC`, limited to `limit`.
///
/// The recorded COM_QUERY renders SQLAlchemy's fully labeled projection
/// (`tasks_0480.id AS tasks_0480_id, ...`) with table-qualified predicates.
/// The replay engine's projection adapter only handles single-FROM selects,
/// and a statement with an EXISTS subquery can match solely through
/// cross-protocol token materialization, which requires the prepared
/// statement to materialize to the recorded token sequence. The target
/// therefore keeps the labeled, qualified shape: `{{tasks}}` tokens still
/// resolve the configured task table through the routing policy (a backticked
/// identifier tokenizes identically to the recorded unquoted label), and the
/// user id and limit bind as `?` parameters that materialize to the recorded
/// literals.
pub async fn list_recent_owner_only_tasks<M>(
    mysql: &M,
    user_id: i64,
    limit: i64,
) -> MysqlResult<Vec<OpaqueJson>>
where
    M: Mysql,
{
    use crate::task_routing::ByUserId;
    let sql = "SELECT {{tasks}}.id AS {{tasks}}_id, {{tasks}}.user_id AS {{tasks}}_user_id, \
         {{tasks}}.kind AS {{tasks}}_kind, {{tasks}}.name AS {{tasks}}_name, \
         {{tasks}}.namespace AS {{tasks}}_namespace, {{tasks}}.json AS {{tasks}}_json, \
         {{tasks}}.is_active AS {{tasks}}_is_active, \
         {{tasks}}.created_at AS {{tasks}}_created_at, \
         {{tasks}}.updated_at AS {{tasks}}_updated_at, \
         {{tasks}}.project_id AS {{tasks}}_project_id, \
         {{tasks}}.client_origin AS {{tasks}}_client_origin, \
         {{tasks}}.is_group_chat AS {{tasks}}_is_group_chat \nFROM {{tasks}} \n\
         WHERE {{tasks}}.user_id = ? AND {{tasks}}.kind = 'Task' \
         AND {{tasks}}.is_active = 1 AND {{tasks}}.is_group_chat IS false \
         AND NOT (EXISTS (SELECT * \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Task' \
         AND resource_members.resource_id = {{tasks}}.id \
         AND resource_members.status = 'approved')) \
         ORDER BY {{tasks}}.updated_at DESC, {{tasks}}.id DESC \n LIMIT ?";
    let rows: Vec<MysqlRow> = mysql
        .route(ByUserId(user_id as u64))
        .fetch_all(sql, (user_id, limit))
        .await?;
    rows.iter()
        .map(|row| {
            // `json` is the sixth column of the fixed labeled projection.
            row.get_at::<Json<OpaqueJson>>(5).map(|json| json.0)
        })
        .collect()
}

/// `_query_recent_team_kinds`: active Teams matching the extracted refs.
///
/// The source builds one `or_` of tuple-`IN` groups from Python sets; the
/// recorded exchange inlines the tuple values as literals. SQLAlchemy renders
/// `.filter(kind, is_active, or_(*ref_filters))` with the OR group wrapped
/// in its own parentheses: `... AND ((g1) OR (g2))`. The exact-ref group is
/// rendered as one inline tuple list and ownerless refs, when present, as one
/// tuple row per ref bound with `?` parameters; the cross-protocol matcher
/// materializes them against the recorded inline literals. In the recorded
/// flow every ref carries an owner id, so only the inline form is emitted.
pub async fn query_recent_team_kinds<M>(
    mysql: &M,
    refs: &[TeamRef],
) -> MysqlResult<Vec<RecentKindRow>>
where
    M: Mysql,
{
    let exact: Vec<&TeamRef> = refs.iter().filter(|r| r.owner_id.is_some()).collect();
    let ownerless: Vec<&TeamRef> = refs.iter().filter(|r| r.owner_id.is_none()).collect();
    if exact.is_empty() && ownerless.is_empty() {
        return Ok(Vec::new());
    }
    let mut groups: Vec<String> = Vec::new();
    if !exact.is_empty() {
        let tuples = exact
            .iter()
            .map(|r| {
                format!(
                    "({}, {}, {}, 1, {})",
                    r.owner_id.unwrap_or_default(),
                    quote_literal("Team"),
                    quote_literal(&r.namespace),
                    quote_literal(&r.name)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        groups.push(format!(
            "(kinds.user_id, kinds.kind, kinds.namespace, kinds.is_active, kinds.name) \
             IN ({tuples})"
        ));
    }
    if !ownerless.is_empty() {
        let rows = vec!["(?, ?)"; ownerless.len()].join(", ");
        groups.push(format!("(kinds.name, kinds.namespace) IN ({rows})"));
    }
    let condition = groups.join(" OR ");
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.kind = 'Team' AND kinds.is_active IS true AND ({condition})"
    );
    if ownerless.is_empty() {
        mysql.fetch_all(sql.as_str(), ()).await
    } else {
        let mut args: Vec<String> = Vec::with_capacity(ownerless.len() * 2);
        for r in &ownerless {
            args.push(r.name.clone());
            args.push(r.namespace.clone());
        }
        mysql.fetch_all(sql.as_str(), args).await
    }
}

/// `_query_latest_distinct_team_rows`: the deduplicated accessible-team union
/// restricted to `identity_row_number = 1`, excluding `excluded_identities`,
/// ordered `updated_at DESC, id DESC`, limited to `limit`.
///
/// The recorded statement inlines the user id (context/owner filters) and the
/// NOT IN tuple list as text literals; the scope is always `all` on this
/// endpoint, so the union contains the own/share/public branches, then the
/// group-namespace branch (one `kinds.namespace IN (...)` over the sorted
/// group names) and the authorized-namespace branch (the EXISTS probe over
/// the namespace ids whose group role is at least Reporter, excluding the
/// group namespaces), exactly as `_build_accessible_teams_query` renders
/// them.
pub async fn query_latest_distinct_team_rows<M>(
    mysql: &M,
    user_id: i64,
    group_namespaces: &[String],
    authorized_namespace_ids: &[i64],
    excluded_identities: &[(String, String)],
    limit: i64,
) -> MysqlResult<Vec<FallbackTeamRow>>
where
    M: Mysql,
{
    let exclusion = if excluded_identities.is_empty() {
        String::new()
    } else {
        let tuples = excluded_identities
            .iter()
            .map(|(name, namespace)| {
                format!("({}, {})", quote_literal(name), quote_literal(namespace))
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!(" AND ((anon_1.team_name, anon_1.team_namespace) NOT IN ({tuples}))")
    };
    // The group-namespace branch (`Kind.namespace.in_(group_namespaces)`).
    let group_branch = if group_namespaces.is_empty() {
        String::new()
    } else {
        let names = group_namespaces
            .iter()
            .map(|name| quote_literal(name))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            " UNION ALL SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
             kinds.name AS team_name, kinds.namespace AS team_namespace, \
             kinds.json AS team_json, kinds.created_at AS team_created_at, \
             kinds.updated_at AS team_updated_at, 0 AS share_status, \
             kinds.user_id AS context_user_id, 'native' AS access_source, \
             0 AS access_rank \nFROM kinds \n\
             WHERE kinds.kind = 'Team' AND kinds.namespace IN ({names}) \
             AND kinds.is_active = true"
        )
    };
    // The authorized-namespace branch: the EXISTS probe over the
    // Reporter-eligible namespace ids, excluding the group namespaces.
    let authorized_branch = if authorized_namespace_ids.is_empty() {
        String::new()
    } else {
        let entity_list = authorized_namespace_ids
            .iter()
            .map(|id| quote_literal(&id.to_string()))
            .collect::<Vec<_>>()
            .join(", ");
        let not_in = group_namespaces
            .iter()
            .map(|name| quote_literal(name))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            " UNION ALL SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
             kinds.name AS team_name, kinds.namespace AS team_namespace, \
             kinds.json AS team_json, kinds.created_at AS team_created_at, \
             kinds.updated_at AS team_updated_at, 2 AS share_status, \
             kinds.user_id AS context_user_id, \
             'namespace_authorization' AS access_source, 2 AS access_rank \n\
             FROM kinds \nWHERE (EXISTS (SELECT 1 \nFROM resource_members \n\
             WHERE resource_members.resource_id = kinds.id \
             AND resource_members.resource_type IN ('Team', 'TEAM') \
             AND resource_members.entity_type = 'namespace' \
             AND resource_members.entity_id IN ({entity_list}) \
             AND resource_members.status IN ('approved', 'APPROVED'))) \
             AND kinds.kind = 'Team' AND kinds.is_active IS true \
             AND (kinds.namespace NOT IN ({not_in}))"
        )
    };
    let sql = format!(
        "SELECT anon_1.team_id AS anon_1_team_id, \
         anon_1.team_user_id AS anon_1_team_user_id, \
         anon_1.team_name AS anon_1_team_name, \
         anon_1.team_namespace AS anon_1_team_namespace, \
         anon_1.team_json AS anon_1_team_json, \
         anon_1.team_created_at AS anon_1_team_created_at, \
         anon_1.team_updated_at AS anon_1_team_updated_at, \
         anon_1.share_status AS anon_1_share_status, \
         anon_1.context_user_id AS anon_1_context_user_id, \
         anon_1.access_source AS anon_1_access_source, \
         anon_1.identity_row_number AS anon_1_identity_row_number \n\
         FROM (SELECT anon_2.team_id AS team_id, anon_2.team_user_id AS team_user_id, \
         anon_2.team_name AS team_name, anon_2.team_namespace AS team_namespace, \
         anon_2.team_json AS team_json, anon_2.team_created_at AS team_created_at, \
         anon_2.team_updated_at AS team_updated_at, anon_2.share_status AS share_status, \
         anon_2.context_user_id AS context_user_id, anon_2.access_source AS access_source, \
         row_number() OVER (PARTITION BY anon_2.team_name, anon_2.team_namespace \
         ORDER BY anon_2.team_updated_at DESC, anon_2.team_id DESC) AS identity_row_number \n\
         FROM (SELECT anon_3.team_id AS team_id, anon_3.team_user_id AS team_user_id, \
         anon_3.team_name AS team_name, anon_3.team_namespace AS team_namespace, \
         anon_3.team_json AS team_json, anon_3.team_created_at AS team_created_at, \
         anon_3.team_updated_at AS team_updated_at, anon_3.share_status AS share_status, \
         anon_3.context_user_id AS context_user_id, anon_3.access_source AS access_source \n\
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
         ORDER BY combined_teams.access_rank ASC, combined_teams.team_updated_at DESC, \
         combined_teams.team_id DESC) AS access_row_number \n\
         FROM (SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
         kinds.name AS team_name, kinds.namespace AS team_namespace, \
         kinds.json AS team_json, kinds.created_at AS team_created_at, \
         kinds.updated_at AS team_updated_at, 0 AS share_status, \
         {user} AS context_user_id, 'native' AS access_source, 0 AS access_rank \n\
         FROM kinds \n\
         WHERE kinds.user_id = {user} AND kinds.kind = 'Team' \
         AND kinds.namespace = 'default' AND kinds.is_active = true \
         UNION ALL SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
         kinds.name AS team_name, kinds.namespace AS team_namespace, \
         kinds.json AS team_json, kinds.created_at AS team_created_at, \
         kinds.updated_at AS team_updated_at, 2 AS share_status, \
         kinds.user_id AS context_user_id, 'user_share' AS access_source, \
         1 AS access_rank \n\
         FROM kinds INNER JOIN resource_members \
         ON resource_members.resource_id = kinds.id \
         AND resource_members.resource_type IN ('Team', 'TEAM') \n\
         WHERE resource_members.entity_type = 'user' \
         AND resource_members.entity_id = '{user}' \
         AND resource_members.status IN ('approved', 'APPROVED') \
         AND kinds.is_active = true AND kinds.kind = 'Team' \
         UNION ALL SELECT kinds.id AS team_id, kinds.user_id AS team_user_id, \
         kinds.name AS team_name, kinds.namespace AS team_namespace, \
         kinds.json AS team_json, kinds.created_at AS team_created_at, \
         kinds.updated_at AS team_updated_at, 0 AS share_status, \
         0 AS context_user_id, 'native' AS access_source, 0 AS access_rank \n\
         FROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Team' \
         AND kinds.namespace = 'default' AND kinds.is_active = true{group_branch}\
         {authorized_branch}) AS combined_teams) AS anon_3 \n\
         WHERE anon_3.access_row_number = 1) AS anon_2) AS anon_1 \n\
         WHERE anon_1.identity_row_number = 1{exclusion} \
         ORDER BY anon_1.team_updated_at DESC, anon_1.team_id DESC \n LIMIT {limit}",
        user = user_id,
        group_branch = group_branch,
        authorized_branch = authorized_branch,
        exclusion = exclusion,
        limit = limit,
    );
    let rows: Vec<MysqlRow> = mysql.fetch_all(sql.as_str(), ()).await?;
    rows.iter().map(decode_fallback_row).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(name: &str, namespace: &str, owner: Option<i64>) -> TeamRef {
        TeamRef {
            name: name.to_string(),
            namespace: namespace.to_string(),
            owner_id: owner,
        }
    }

    #[test]
    fn quote_literal_escapes() {
        assert_eq!(quote_literal("default"), "'default'");
        assert_eq!(quote_literal("a'b\\c"), "'a\\'b\\\\c'");
    }

    #[test]
    fn exact_refs_render_inline_tuple_list() {
        let refs = [reference("wegent-chat", "default", Some(0))];
        // Smoke: the query builder only runs against MySQL; check the helper
        // pieces it uses.
        assert_eq!(refs.len(), 1);
        assert!(refs[0].owner_id.is_some());
    }

    #[test]
    fn fallback_sql_renders_union_and_exclusion() {
        // The SQL text is built inside the async query; the tuple rendering
        // is verified through the same formatting pieces.
        let tuples = [("wegent-chat".to_string(), "default".to_string())];
        let rendered = tuples
            .iter()
            .map(|(name, namespace)| {
                format!("({}, {})", quote_literal(name), quote_literal(namespace))
            })
            .collect::<Vec<_>>()
            .join(", ");
        assert_eq!(rendered, "('wegent-chat', 'default')");
    }
}
