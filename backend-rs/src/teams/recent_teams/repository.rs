// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL data access for `GET /api/users/recent-teams`
//! (`team_kinds_service.get_recent_accessible_teams`), mirroring the source
//! SQLAlchemy renderings token for token: the two-extract recent-task
//! projection and the tuple-IN literal lists inlined as COM_QUERY text (the
//! source renders the kind refs as inline literals). The accessible-team
//! fallback reuses the shared `team_union` renderer.
use crate::sql_support::quote_sql_literal;
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlRow};

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

/// One `list_recent_task_team_refs` row: the two JSON extracts SQLAlchemy
/// labels `anon_1` (`metadata.labels.taskType`) and `anon_2` (`spec.teamRef`),
/// each the raw JSON value or absent when its path is SQL NULL.
pub(crate) struct RecentTaskTeamRef {
    pub(crate) task_type: Option<OpaqueJson>,
    pub(crate) team_ref: Option<OpaqueJson>,
}

/// Decode one recent-team-ref row by the two JSON extracts, in SELECT order.
pub(crate) fn decode_recent_task_team_ref(row: &MysqlRow) -> MysqlResult<RecentTaskTeamRef> {
    Ok(RecentTaskTeamRef {
        task_type: row
            .get_at::<Option<Json<OpaqueJson>>>(0)?
            .map(|json| json.0),
        team_ref: row
            .get_at::<Option<Json<OpaqueJson>>>(1)?
            .map(|json| json.0),
    })
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
                    quote_sql_literal("Team"),
                    quote_sql_literal(&r.namespace),
                    quote_sql_literal(&r.name)
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
    fn quoted_literals_keep_non_ascii_text() {
        assert_eq!(quote_sql_literal("default"), "'default'");
        assert_eq!(quote_sql_literal("a'b\\c"), "'a\\'b\\\\c'");
        // Every byte of a UTF-8 literal must survive: a byte-wise renderer that
        // pushes `byte as char` turns `平台架构周报` into Latin-1 mojibake.
        assert_eq!(quote_sql_literal("平台架构周报"), "'平台架构周报'");
    }

    #[test]
    fn exact_ref_tuples_inline_quoted_literals() {
        // `_query_recent_team_kinds` renders each exact ref as one inline
        // `(user_id, 'Team', namespace, 1, name)` tuple.
        let refs = [reference("wegent-chat", "default", Some(0))];
        let rendered = refs
            .iter()
            .map(|r| {
                format!(
                    "({}, {}, {}, 1, {})",
                    r.owner_id.unwrap_or_default(),
                    quote_sql_literal("Team"),
                    quote_sql_literal(&r.namespace),
                    quote_sql_literal(&r.name)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        assert_eq!(rendered, "(0, 'Team', 'default', 1, 'wegent-chat')");
    }
}
