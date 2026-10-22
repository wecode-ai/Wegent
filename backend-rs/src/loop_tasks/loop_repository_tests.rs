//! Shape guards for the loop-item repository reads.
//!
//! Extracted from [`super`] to keep the module within the file-size bound.

use super::*;

#[test]
fn splits_external_item_ids() {
    assert_eq!(
        split_external_item_id("WEWORKC2FA61-507"),
        Some(("WEWORKC2FA61", 507))
    );
    assert_eq!(split_external_item_id("plain"), None);
    assert_eq!(split_external_item_id("KEY-abc"), None);
    assert_eq!(split_external_item_id("-507"), None);
}

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[tokio::test]
async fn related_issue_uses_the_current_collaborator_table_and_bound_item_id() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    assert!(
        !LoopItemRepository::new(&mysql)
            .is_related_item("EXAMPLE-'quoted", 86)
            .await
            .unwrap()
    );
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].args, 1);
    let sql = &queries[0].sql;
    assert!(sql.contains("WHERE loop_items.id = ?"));
    assert!(!sql.contains("EXAMPLE-'quoted"));
    assert!(!sql.contains("loop_item_collaborators"));
    for kind in ["execution", "collaborator", "chat_agent"] {
        assert!(sql.contains(&format!("loop_items.resource_type IN ('{kind}')")));
    }
    assert!(sql.contains("loop_items.user_id = 86"));
    assert!(sql.contains("loop_items.unlinked_at IS NULL"));
}

/// `_find_project` selects the full labeled `loop_items` projection (the
/// `db.query(CloudProject)` rendering), not a narrowed column list.
#[tokio::test]
async fn find_external_project_uses_the_labeled_projection() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let repository = LoopItemRepository::new(&mysql);
    let project = repository
        .find_external_project("WEWORKBU7D045F-5")
        .await
        .expect("captured");
    assert!(project.is_none());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(
        queries[0].sql,
        normalize(&format!(
            "SELECT {LOOP_ITEMS_COLUMNS} FROM loop_items \
             WHERE loop_items.project_key = ? \
             AND loop_items.resource_type IN ('project') LIMIT 1"
        ))
    );
}

/// The full labeled projection must carry every mapped `loop_items` column so
/// the prepared statement matches the recorded `db.query(...)` exchange.
/// `start_at` sits between `priority` and `due_at`; dropping it makes the
/// Replay dependency matcher reject the statement.
#[test]
fn cloud_context_projection_carries_start_at() {
    assert!(CLOUD_CONTEXT_COLUMNS.contains(
        "loop_items.priority AS loop_items_priority, loop_items.start_at AS loop_items_start_at, loop_items.due_at AS loop_items_due_at"
    ));
}

#[tokio::test]
async fn assignment_activities_are_scoped_to_project_and_issue_newest_first() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let activities = LoopItemRepository::new(&mysql)
        .item_activity_metadata("41", "EXAMPLE-10")
        .await
        .expect("captured");
    assert!(activities.is_empty());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].args, 2);
    assert!(
        queries[0]
            .sql
            .contains("project_chat_messages.project_id = ?")
    );
    assert!(queries[0].sql.contains("project_chat_messages.task_id = ?"));
    assert!(queries[0].sql.ends_with(
        "ORDER BY project_chat_messages.created_at DESC, project_chat_messages.id DESC"
    ));
}

#[test]
fn cloud_context_binds_owner_aliases_and_task_without_interpolating_values() {
    let aliases = ["electron-app".to_owned(), "app-record-7".to_owned()];
    let (sql, args) = cloud_context_binding_statement(19, &aliases, "task-'quoted");
    assert!(sql.contains("loop_items.task_user_id = ?"));
    assert!(sql.contains("loop_items.device_id IN (?, ?)"));
    assert!(sql.contains("loop_items.task_id = ?"));
    assert!(sql.contains("loop_items.deleted_at IS NULL"));
    assert!(sql.contains("loop_items.unlinked_at IS NULL"));
    assert!(sql.contains("loop_items.resource_type IN ('execution')"));
    assert!(sql.contains("ORDER BY loop_items.linked_at DESC, loop_items.id DESC"));
    assert!(!sql.contains("task-'quoted"));
    assert!(matches!(args.as_slice(), [
        StatementArg::Int(19), StatementArg::Str(first),
        StatementArg::Str(second), StatementArg::Str(task),
    ] if first == "electron-app" && second == "app-record-7" && task == "task-'quoted"));
}

#[tokio::test]
async fn missing_cloud_context_uses_scoped_alias_lookup_and_returns_none() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let binding = LoopItemRepository::new(&mysql)
        .find_cloud_context_binding(19, "electron-app", "task-1")
        .await
        .unwrap();
    assert!(binding.is_none());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[0].first_integer, Some(19));
    assert_eq!(queries[1].args, 3);
    assert!(queries[1].sql.contains("loop_items.device_id IN (?)"));
}

#[test]
fn role_hierarchy() {
    assert!(has_permission("Owner", "RestrictedAnalyst"));
    assert!(has_permission("Maintainer", "Reporter"));
    assert!(!has_permission("Reporter", "Developer"));
    assert!(!has_permission("Unknown", "Reporter"));
}

#[test]
fn workflow_node_id_reads_metadata() {
    let binding = |metadata: Value| BindingRow {
        id: "1".to_string(),
        cloud_project_id: "2".to_string(),
        loop_item_id: Some("3".to_string()),
        task_user_id: 1,
        device_id: "d".to_string(),
        task_id: "t".to_string(),
        task_title: None,
        backend_task_id: 0,
        linked_by_user_id: 1,
        linked_at: None,
        unlinked_at: None,
        metadata: Some(Json(metadata.into())),
    };
    assert_eq!(
        binding(serde_json::json!({"workflow_node_id": "node-1"})).workflow_node_id(),
        Some("node-1".to_string())
    );
    assert_eq!(
        binding(serde_json::json!({"workflow_node_id": ""})).workflow_node_id(),
        None
    );
    assert_eq!(binding(serde_json::json!({})).workflow_node_id(), None);
}
