// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The queued/background response render's subtask read
//! (`openapi_responses._query_subtasks`).
//!
//! Recorded a4130073 seq80: the Source reads the task/user subtask list with
//! SQLAlchemy's labeled `{table}_{column}` projection, table-qualified
//! predicates, and `message_id ASC` ordering.

use super::*;

fn normalized(sql: String) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn queued_response_subtask_list_matches_the_source_projection() {
    let sql = normalized(subtasks_by_task_for_user_ordered_statement("subtasks_0025"));
    assert!(
        sql.starts_with(
            "SELECT subtasks_0025.id AS subtasks_0025_id, \
             subtasks_0025.user_id AS subtasks_0025_user_id"
        ),
        "{sql}"
    );
    assert!(
        sql.contains("subtasks_0025.`role` AS subtasks_0025_role"),
        "{sql}"
    );
    assert!(
        sql.contains("subtasks_0025.reply_to_subtask_id AS subtasks_0025_reply_to_subtask_id"),
        "{sql}"
    );
    assert!(
        sql.contains(
            "FROM subtasks_0025 WHERE subtasks_0025.task_id = ? \
             AND subtasks_0025.user_id = ? ORDER BY subtasks_0025.message_id ASC"
        ),
        "{sql}"
    );
    // The id-IN batch behind `load_subtasks_by_ids` is a different Source
    // statement and must not be used for this read.
    assert!(!sql.contains("id IN ("), "{sql}");
}

#[test]
fn sharded_template_labels_follow_the_physical_table() {
    // A routed store renders `{{subtasks}}` to the physical shard table, so
    // both the projection and the label prefix come from the same template.
    let sql = subtasks_by_task_for_user_ordered_statement("{{subtasks}}");
    assert!(sql.contains("{{subtasks}}.id AS {{subtasks}}_id"), "{sql}");
    assert!(
        sql.contains("WHERE {{subtasks}}.task_id = ? AND {{subtasks}}.user_id = ?"),
        "{sql}"
    );
}
