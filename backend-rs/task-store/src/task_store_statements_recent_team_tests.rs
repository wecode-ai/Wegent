// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `recent_owner_only_query`'s `mode` rendering for the single-table picker.

use super::{TASKS_TABLE, recent_task_team_refs_statement, recent_team_mode_predicate};

#[test]
fn the_mode_predicate_keeps_the_chat_default_and_compares_against_the_mode() {
    // `func.coalesce(func.nullif(<taskType>, ""), "chat") == mode`: the
    // fallback stays `'chat'` for every mode; only the comparison side carries
    // the requested literal. Using the mode as the default fails Replay for
    // `mode=task` (recorded `coalesce(..., 'chat') = 'task'`).
    let predicate = recent_team_mode_predicate(TASKS_TABLE, "task");
    assert_eq!(
        predicate,
        " AND coalesce(nullif(CASE JSON_EXTRACT(tasks.json, \
         '$.\"metadata\".\"labels\".\"taskType\"') WHEN 'null' THEN NULL ELSE \
         JSON_UNQUOTE(JSON_EXTRACT(tasks.json, \
         '$.\"metadata\".\"labels\".\"taskType\"')) END, ''), 'chat') = 'task'"
    );
}

#[test]
fn the_chat_mode_predicate_matches_the_recorded_shape() {
    let predicate = recent_team_mode_predicate(TASKS_TABLE, "chat");
    assert!(
        predicate.ends_with("END, ''), 'chat') = 'chat'"),
        "{predicate}"
    );
}

#[test]
fn the_statement_applies_the_mode_filter_before_the_page_limit() {
    let statement = recent_task_team_refs_statement(TASKS_TABLE, Some("task"));
    assert!(
        statement.contains(&recent_team_mode_predicate(TASKS_TABLE, "task")),
        "{statement}"
    );
    let mode_at = statement
        .find("coalesce(nullif(CASE")
        .expect("mode predicate");
    let order_at = statement.find("ORDER BY").expect("order clause");
    assert!(mode_at < order_at);
    assert_eq!(statement.matches("LIMIT ?").count(), 1);
    assert_eq!(statement.matches('?').count(), 2);
}

#[test]
fn without_a_mode_the_statement_keeps_the_recorded_shape() {
    let statement = recent_task_team_refs_statement(TASKS_TABLE, None);
    assert!(!statement.contains("coalesce(nullif(CASE"));
    assert!(statement.contains(
        "AND resource_members.status = 'approved')) ORDER BY tasks.updated_at DESC, \
         tasks.id DESC \n LIMIT ?"
    ));
    assert_eq!(statement.matches('?').count(), 2);
}
