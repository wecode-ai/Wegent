// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn complete_subtask_load_bounds_every_prepared_statement() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let ids: Vec<i64> = (1..=65_536).rev().collect();
    assert!(
        load_subtasks_by_ids(&mysql, "subtasks", &ids)
            .await
            .unwrap()
            .is_empty()
    );
    let queries = mysql.queries();
    assert!(queries.len() > 1);
    assert_eq!(
        queries.iter().map(|query| query.args).sum::<usize>(),
        ids.len()
    );
    let mut offset = 0;
    for query in queries {
        assert!(query.args > 0 && query.args <= SUBTASK_IDS_PER_BATCH);
        assert_eq!(query.first_integer, Some(ids[offset]));
        assert_eq!(query.sql.matches('?').count(), query.args);
        assert!(
            !query.sql.contains("ORDER BY"),
            "large JSON must never enter filesort"
        );
        offset += query.args;
    }
}

#[tokio::test]
async fn empty_subtask_ids_do_not_issue_a_statement() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    assert!(
        load_subtasks_by_ids(&mysql, "subtasks", &[])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(mysql.queries().is_empty());
}
