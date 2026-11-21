// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The create flow's subtask bot resolution
//! (`TaskRequestBuilder._get_bot_for_subtask`,
//! `app/services/execution/request_builder.py:1103-1156`).
//!
//! `build()` re-reads the Bot named by the subtask's first `bot_ids` entry
//! before it builds the workspace and the model config, and only falls back to
//! the team's first member when that id is absent or its row is missing. The
//! recorded create cases therefore carry one `kinds` read with the
//! `id + kind = 'Bot' + is_active = 1` predicate, distinct from the cached
//! batch Bot/Ghost reads the ghost chain performs.
use brz_mysql::{Mysql, MysqlResult};

use super::resolution::{KIND_COLUMNS, KindRow};

/// `_get_bot_for_subtask`'s Bot read: `kinds.id + kind = 'Bot' + is_active`
/// (the bare truthy filter renders `is_active = 1`, not `IS true`).
///
/// Recorded: `SELECT kinds.id AS kinds_id, ... \nFROM kinds \nWHERE
/// kinds.id = 302290 AND kinds.kind = 'Bot' AND kinds.is_active = 1
/// \n LIMIT 1`.
pub fn bot_by_id_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = ? \
         AND kinds.kind = 'Bot' AND kinds.is_active = 1 \n LIMIT 1"
    )
}

/// `_get_bot_for_subtask`'s first branch: the Bot row of `bot_id`.
pub async fn bot_by_id<M: Mysql>(mysql: &M, bot_id: Option<i64>) -> MysqlResult<Option<KindRow>> {
    let Some(bot_id) = bot_id else {
        return Ok(None);
    };
    mysql.fetch_optional(bot_by_id_statement(), (bot_id,)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    #[test]
    fn the_bot_read_matches_the_recorded_statement() {
        let sql = bot_by_id_statement();
        assert!(sql.starts_with(
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, "
        ));
        assert!(sql.contains(
            "kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.id = ? \
             AND kinds.kind = 'Bot' AND kinds.is_active = 1 \n LIMIT 1"
        ));
        assert!(!sql.contains("IS true"));
    }

    #[tokio::test]
    async fn a_missing_id_issues_no_read() {
        let mysql = KindQueryCapture::default();
        let row = bot_by_id(&mysql, None).await.expect("no read");
        assert!(row.is_none());
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn the_id_read_binds_the_bot_id() {
        let mysql = KindQueryCapture::default();
        let row = bot_by_id(&mysql, Some(302_290)).await.expect("read");
        assert!(row.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 1);
    }
}
