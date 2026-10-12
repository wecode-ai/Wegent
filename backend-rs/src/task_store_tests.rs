// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// The store stays usable behind `Arc<dyn TaskStore>` for any handle.
#[test]
fn the_store_is_send_and_sync_for_any_handle() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<DefaultTaskStore<brz_mysql::MysqlService>>();
    assert_send_sync::<MysqlRow>();
}

/// The single-table store's access read resolves no other table, so it
/// issues the same active-task statement as `get_active_task`.
#[tokio::test]
async fn the_single_table_store_reads_the_same_statement_for_both_active_reads() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store = DefaultTaskStore::new(mysql.clone());
    assert!(store.get_active_task(7).await.unwrap().is_none());
    assert!(store.get_accessible_task(7).await.unwrap().is_none());
    let queries: Vec<String> = mysql.queries().into_iter().map(|query| query.sql).collect();
    assert_eq!(queries.len(), 2, "{queries:?}");
    assert_eq!(queries[0], queries[1]);
    assert!(queries[0].contains("FROM `tasks`"), "{queries:?}");
}

/// The recorded `get_runtime_state` rendering reads `status.updatedAt`
/// through the cached `TaskResource.json["status"]` parent, so the second
/// `CASE` repeats `$."status"` as its inner path in both the subject and the
/// `JSON_UNQUOTE` branch. Extracting the top-level `updatedAt` instead
/// returns SQL NULL for the status timestamp and silently falls back to the
/// task row's second-precision `updated_at`.
#[test]
fn runtime_state_statement_reads_the_status_timestamp_through_the_status_object() {
    let sql = runtime_state_statement(TASKS_TABLE);
    assert_eq!(
        sql.matches(r#"JSON_EXTRACT(`tasks`.json, '$."status"'), '$."updatedAt"'"#)
            .count(),
        2,
        "{sql}"
    );
    assert!(!sql.contains(r#"`tasks`.json, '$."updatedAt"'"#), "{sql}");
}

/// `get_active_project_task` predicates in the recorded order (id, project_id,
/// kind, is_active, user_id, then the optional origin) and reads the 12-column
/// task projection.
#[test]
fn active_project_task_statement_matches_the_recorded_predicate_order() {
    let with_origin = active_project_task_statement("tasks", true);
    let without_origin = active_project_task_statement("tasks", false);

    let expected = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, \
                    updated_at, project_id, client_origin, is_group_chat \nFROM tasks \n\
                    WHERE id = ? AND project_id = ? AND kind = 'Task' AND is_active = 1 \
                    AND user_id = ?";
    assert!(with_origin.starts_with(expected), "{with_origin}");
    assert!(
        with_origin.ends_with(" AND client_origin = ? \n LIMIT 1"),
        "{with_origin}"
    );
    assert!(
        without_origin.ends_with(" AND user_id = ? \n LIMIT 1"),
        "{without_origin}"
    );
    assert!(
        !without_origin.contains("client_origin = ?"),
        "{without_origin}"
    );
    // The id, project, and owner predicates bind before the origin.
    assert!(
        with_origin.contains("WHERE id = ? AND project_id = ?"),
        "{with_origin}"
    );
}

/// The update clears the project link and rewrites the JSON, ordered the way
/// SQLAlchemy flushes the dirty columns (the mapper's column order:
/// `json`, `updated_at`, `project_id`).
#[test]
fn task_project_update_statement_clears_the_project_and_rewrites_json() {
    let sql = task_project_update_statement("tasks");
    assert!(sql.starts_with("UPDATE tasks"), "{sql}");
    assert!(
        sql.contains("SET json = ?, updated_at = ?, project_id = ?"),
        "{sql}"
    );
    assert!(sql.ends_with("WHERE id = ?"), "{sql}");
}

/// The single-table store's project-task read binds the id, project, and owner
/// before the origin, and only adds the origin predicate when one is selected.
#[tokio::test]
async fn the_public_store_reads_the_project_task_from_the_base_table() {
    use crate::sql_test_support::KindQueryCapture;

    for origin in [None, Some("frontend")] {
        let mysql = KindQueryCapture::default();
        let row = DefaultTaskStore::new(mysql.clone())
            .get_active_project_task(21577915845249, 2180, 157, origin)
            .await
            .unwrap();
        assert!(row.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 3 + usize::from(origin.is_some()));
        assert_eq!(queries[0].first_integer, Some(21577915845249));
        assert!(queries[0].sql.starts_with("SELECT id, user_id, kind"));
        assert!(queries[0].sql.contains("FROM tasks"));
        assert!(queries[0].sql.contains("WHERE id = ? AND project_id = ?"));
        assert!(
            queries[0]
                .sql
                .contains("AND kind = 'Task' AND is_active = 1")
        );
        assert_eq!(
            queries[0].sql.contains("AND client_origin = ?"),
            origin.is_some()
        );
        assert!(queries[0].sql.ends_with("LIMIT 1"));
    }
}

/// The single-table store's project-link update issues the UPDATE and the
/// source's `COMMIT`, binding the JSON, timestamp, project, then the id.
#[tokio::test]
async fn the_public_store_updates_the_project_task_and_commits() {
    use crate::sql_test_support::KindQueryCapture;

    let mysql = KindQueryCapture::writing();
    let store = DefaultTaskStore::new(mysql.clone());
    let updated_at =
        chrono::NaiveDateTime::parse_from_str("2026-10-07 15:09:33", "%Y-%m-%d %H:%M:%S").unwrap();
    store
        .set_task_project_and_json(
            21577915845249,
            0,
            157,
            "{\"metadata\": {\"labels\": {}}}",
            updated_at,
        )
        .await
        .unwrap();

    assert!(
        mysql.queries().is_empty(),
        "the read path was not exercised"
    );
    let writes = mysql.writes();
    assert_eq!(writes.len(), 2, "{writes:?}");
    assert_eq!(
        writes[0].sql,
        "UPDATE tasks SET json = ?, updated_at = ?, project_id = ? WHERE id = ?"
    );
    assert_eq!(writes[0].args, 4);
    assert_eq!(writes[1].sql, "COMMIT");
}

/// The delete/update path's single-table statements: the active-or-archived
/// and owned-active reads, the unfiltered subtask listing, the subtask delete
/// sequence, and the two task json writes.
#[tokio::test]
async fn mutation_statements_match_the_recorded_single_table_shapes() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let store = DefaultTaskStore::new(mysql.clone());

    assert!(
        store
            .get_active_or_archived_task(7, Some("frontend"))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .get_active_task_for_origin(7, None)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .get_owned_active_task(7, 157, Some("frontend"))
            .await
            .unwrap()
            .is_none()
    );
    let _ = store
        .list_subtasks_by_task_unfiltered(7, 157)
        .await
        .unwrap();
    let _ = store
        .mark_task_subtasks_deleted(7, 157, "2026-10-07 00:00:00.000000")
        .await
        .unwrap();
    let _ = store
        .soft_delete_task(7, 157, "{}", "2026-10-07 00:00:00.000000")
        .await
        .unwrap();
    let _ = store
        .update_task_json(7, 157, "{}", "2026-10-07 00:00:00.000000")
        .await
        .unwrap();

    let reads: Vec<String> = mysql.queries().into_iter().map(|query| query.sql).collect();
    let writes: Vec<String> = mysql.writes().into_iter().map(|query| query.sql).collect();

    assert!(
        reads[0].contains("is_active IN (1, 3)") && reads[0].contains("client_origin = ?"),
        "{reads:?}"
    );
    assert!(reads[1].contains("is_active IN (1, 2)"), "{reads:?}");
    assert!(
        reads[2].contains("is_active IN (1)") && reads[2].contains("user_id = ?"),
        "{reads:?}"
    );
    assert!(
        reads[3].contains("task_id IN (SELECT tasks.id FROM tasks WHERE tasks.user_id = ?)"),
        "{reads:?}"
    );
    assert!(
        reads[4].contains("`role` = 'ASSISTANT' AND status = 'FAILED'"),
        "{reads:?}"
    );
    assert!(reads[5].starts_with("SELECT id "), "{reads:?}");
    assert_eq!(reads.len(), 6, "{reads:?}");

    assert!(
        writes[0].contains("UPDATE subtasks SET executor_deleted_at=?, status=?, updated_at=?"),
        "{writes:?}"
    );
    assert!(
        writes[0].contains("task_id IN (SELECT tasks.id FROM tasks WHERE tasks.user_id = ?)"),
        "{writes:?}"
    );
    assert_eq!(
        writes[1],
        "UPDATE tasks SET json=?, is_active=?, updated_at=? WHERE tasks.id = ?"
    );
    assert_eq!(
        writes[2],
        "UPDATE tasks SET json=?, updated_at=? WHERE tasks.id = ?"
    );
}
