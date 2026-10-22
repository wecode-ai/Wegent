// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Database access for the administrator connector-app catalog listing.
//!
//! `admin_response` counts the app's active `ConnectorConnection` kinds with
//! the source `db.query(Kind).filter(...).count()`, which SQLAlchemy renders
//! as a `count(*)` over the full `kinds` projection wrapped in an `anon_1`
//! subquery with the slug as a bound parameter. The column list and aliases
//! mirror `shared/models/db/kind.py`.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

/// `ConnectorAppService.admin_response`'s connection-count statement
/// (`db.query(Kind).filter(...).count()`); the app slug is the single bound
/// parameter.
const CONNECTION_COUNT_SQL: &str = "SELECT count(*) AS count_1 \n\
     FROM (SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \n\
     FROM kinds \n\
     WHERE kinds.kind = 'ConnectorConnection' AND kinds.namespace = 'system' \
     AND kinds.name = ? AND kinds.is_active = 1) AS anon_1";

/// The `SELECT count(*) AS count_1` row produced by a SQLAlchemy `.count()`.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    count_1: i64,
}

/// The number of active `ConnectorConnection` kinds for one app slug.
pub async fn count_connector_connections<M>(mysql: &M, slug: &str) -> MysqlResult<i64>
where
    M: Mysql,
{
    let row: CountRow = mysql.fetch_one(CONNECTION_COUNT_SQL, (slug,)).await?;
    Ok(row.count_1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The statement must keep SQLAlchemy's `count(*)`-over-subquery shape and
    /// bind exactly one parameter, so the recorded exchange matches.
    #[test]
    fn connection_count_statement_matches_the_source_render() {
        let sql = CONNECTION_COUNT_SQL;
        assert!(sql.starts_with("SELECT count(*) AS count_1 \nFROM (SELECT kinds.id AS kinds_id"));
        assert!(sql.ends_with("AS anon_1"));
        assert!(sql.contains("FROM kinds \nWHERE kinds.kind = 'ConnectorConnection'"));
        assert!(sql.contains("kinds.namespace = 'system'"));
        assert!(sql.contains("kinds.name = ?"));
        assert!(sql.contains("kinds.is_active = 1"));
    }
}
