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
