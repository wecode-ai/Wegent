// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused compatibility tests for the terminal task-completion subsystem.
use super::Tables;
use super::collect::{is_blank_text_value, merge_blocks};
use super::sql::{assistant_subtasks, update_subtask_terminal};
use super::terminal_status;
use serde_json::json;

fn tables() -> Tables {
    Tables {
        tasks: "tasks_0030",
        subtasks: "subtasks_0030",
    }
}

#[test]
fn terminal_event_types_map_to_subtask_statuses() {
    assert_eq!(terminal_status("done"), Some("COMPLETED"));
    assert_eq!(terminal_status("error"), Some("FAILED"));
    assert_eq!(terminal_status("cancelled"), Some("CANCELLED"));
    assert_eq!(terminal_status("chunk"), None);
}

#[test]
fn assistant_subtasks_statement_matches_the_source_shape() {
    assert_eq!(
        assistant_subtasks(tables()),
        "SELECT subtasks_0030.id AS subtasks_0030_id, subtasks_0030.user_id AS subtasks_0030_user_id, \
         subtasks_0030.task_id AS subtasks_0030_task_id, subtasks_0030.team_id AS subtasks_0030_team_id, \
         subtasks_0030.title AS subtasks_0030_title, subtasks_0030.bot_ids AS subtasks_0030_bot_ids, \
         subtasks_0030.`role` AS subtasks_0030_role, subtasks_0030.executor_namespace AS subtasks_0030_executor_namespace, \
         subtasks_0030.executor_name AS subtasks_0030_executor_name, subtasks_0030.executor_deleted_at AS subtasks_0030_executor_deleted_at, \
         subtasks_0030.prompt AS subtasks_0030_prompt, subtasks_0030.message_id AS subtasks_0030_message_id, \
         subtasks_0030.parent_id AS subtasks_0030_parent_id, subtasks_0030.status AS subtasks_0030_status, \
         subtasks_0030.progress AS subtasks_0030_progress, subtasks_0030.result AS subtasks_0030_result, \
         subtasks_0030.error_message AS subtasks_0030_error_message, subtasks_0030.created_at AS subtasks_0030_created_at, \
         subtasks_0030.updated_at AS subtasks_0030_updated_at, subtasks_0030.completed_at AS subtasks_0030_completed_at, \
         subtasks_0030.sender_type AS subtasks_0030_sender_type, subtasks_0030.sender_user_id AS subtasks_0030_sender_user_id, \
         subtasks_0030.reply_to_subtask_id AS subtasks_0030_reply_to_subtask_id \nFROM subtasks_0030 \n\
         WHERE subtasks_0030.task_id = ? AND subtasks_0030.`role` = 'ASSISTANT' \n\
         ORDER BY subtasks_0030.message_id ASC"
    );
}

#[test]
fn subtask_terminal_update_follows_the_mapper_column_order() {
    assert_eq!(
        update_subtask_terminal(tables(), true, true),
        "UPDATE subtasks_0030 SET executor_namespace=?, executor_name=?, status=?, result=?, \
         error_message=?, updated_at=?, completed_at=? WHERE subtasks_0030.id = ?"
    );
    assert_eq!(
        update_subtask_terminal(tables(), false, false),
        "UPDATE subtasks_0030 SET status=?, result=?, updated_at=?, completed_at=? \
         WHERE subtasks_0030.id = ?"
    );
}

#[test]
fn merge_blocks_preserves_first_seen_order_and_merges_by_id() {
    let existing =
        json!([{"id": "a", "type": "text", "content": "old"}, {"id": "b", "type": "tool"}]);
    let new = json!([{"id": "a", "type": "text", "content": "new", "status": "done"}]);
    let merged = merge_blocks(&existing, &new);
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].get("content"), Some(&json!("new")));
    assert_eq!(merged[0].get("status"), Some(&json!("done")));
    assert_eq!(merged[1].get("id"), Some(&json!("b")));
}

#[test]
fn blank_text_values_follow_the_source_predicate() {
    assert!(is_blank_text_value(None));
    assert!(is_blank_text_value(Some(&json!(null))));
    assert!(is_blank_text_value(Some(&json!("  "))));
    assert!(!is_blank_text_value(Some(&json!("x"))));
    assert!(!is_blank_text_value(Some(&json!(0))));
}

/// The ORM subtask projection labels each column `{table}_{column}`, so the
/// completion flow decodes the stored result by its mapped position: a by-name
/// lookup can never resolve it.
#[test]
fn subtask_column_index_tracks_the_projection_order() {
    use crate::task_store::subtask_column_index;
    assert_eq!(subtask_column_index("id"), Some(0));
    assert_eq!(subtask_column_index("status"), Some(13));
    assert_eq!(subtask_column_index("result"), Some(15));
    assert_eq!(subtask_column_index("subtasks_0030_result"), None);
}

#[test]
fn task_column_index_tracks_the_projection_order() {
    use crate::task_store::task_column_index;
    assert_eq!(task_column_index("id"), Some(0));
    assert_eq!(task_column_index("user_id"), Some(1));
    assert_eq!(task_column_index("json"), Some(5));
    assert_eq!(task_column_index("is_group_chat"), Some(11));
    assert_eq!(task_column_index("missing"), None);
}

#[tokio::test]
async fn task_status_user_id_reads_the_active_task_row() {
    let capture = crate::sql_test_support::KindQueryCapture::default();
    let _ = super::task_status_user_id(&capture, tables(), 426335633820493).await;
    let sqls: Vec<String> = capture
        .queries()
        .into_iter()
        .map(|query| query.sql)
        .collect();
    let owner_read = sqls
        .iter()
        .find(|sql| sql.contains("kind = 'Task'") && sql.contains("tasks_0030"))
        .unwrap_or_else(|| panic!("owner read not issued: {sqls:?}"));
    assert!(owner_read.contains("is_active IN (1) "), "{owner_read}");
    assert!(!owner_read.contains("is_active IN (1, 2)"), "{owner_read}");
}

/// `_publish_task_completed_event` resolves its own owner with the two-state
/// `is_active_query()` predicate, a different read from the handler's
/// single-state one, and issues no further call when the row is absent.
#[tokio::test]
async fn the_completed_event_owner_read_uses_the_two_state_predicate() {
    let capture = crate::sql_test_support::KindQueryCapture::default();
    let owner = super::events::resolve_owner_user_id(&capture, tables(), 426335633820493).await;
    assert_eq!(owner, None);
    let sqls: Vec<String> = capture
        .queries()
        .into_iter()
        .map(|query| query.sql)
        .collect();
    assert_eq!(sqls.len(), 1, "{sqls:?}");
    assert!(
        sqls[0].contains("tasks_0030")
            && sqls[0].contains("WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)"),
        "{sqls:?}"
    );
}

/// `add_chat_experience`'s post-commit `db.refresh(pet)`: the ORM primary-key
/// load renders the mapped columns unlabeled.
#[test]
fn the_pet_refresh_statement_is_the_unlabeled_primary_key_load() {
    assert_eq!(
        super::sql::kind_refresh_by_id(),
        "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, kinds.json, \
         kinds.is_active, kinds.created_at, kinds.updated_at \nFROM kinds WHERE kinds.id = ?"
    );
}

/// `SubtaskStore.get_by_id`'s eager `subqueryload(Subtask.contexts)` read, which
/// both the collect and the persist step issue.
#[test]
fn the_eager_context_read_matches_the_recorded_subquery_shape() {
    let sql = super::sql::contexts_by_subtask();
    let flattened = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        flattened.starts_with("SELECT subtask_contexts.id AS subtask_contexts_id"),
        "{flattened}"
    );
    assert!(
        flattened
            .ends_with("WHERE subtask_contexts.subtask_id IN (?) ORDER BY subtask_contexts.id ASC"),
        "{flattened}"
    );
}
