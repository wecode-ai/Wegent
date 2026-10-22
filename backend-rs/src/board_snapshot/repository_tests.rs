//! Shape guards for the board-snapshot repository reads.
//!
//! Extracted from [`super`] to keep the module within the file-size bound.

use super::*;
use serde_json::json;

/// Whitespace-insensitive SQL comparison: Replay matches the statement
/// structure, not the source's line breaks.
fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `require_cloud_project_role` issues the source's single
/// `project_access_query` statement with every value inlined, so it binds
/// no parameters. The recorded source renders the union with the creator
/// grant: direct, workspace-inherited, public, and owned branches with the
/// project id pushed into each one.
#[tokio::test]
async fn require_cloud_project_role_runs_the_source_access_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let repository = BoardSnapshotRepository::new(&mysql);
    let access = repository
        .require_cloud_project_role(1712605396200092385, 3060)
        .await
        .expect("access query is captured");
    assert!(access.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let sql = normalize(&queries[0].sql);
    assert!(sql.contains("resource_members.entity_id = '3060'"));
    assert!(sql.contains("AND resource_members.resource_id = 1712605396200092385"));
    assert!(sql.contains("AND loop_items.id = '1712605396200092385'"));
    assert!(sql.contains("UNION ALL SELECT loop_items.id AS project_id, 0 AS priority"));
    assert!(sql.contains("loop_items.created_by_user_id = 3060"));
    assert!(sql.contains("kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true"));
    assert!(sql.contains(
        "resource_members.entity_type = 'authenticated_users' \
         AND resource_members.entity_id = '*'"
    ));
    assert!(sql.contains("anon_1.priority AS anon_1_priority"));
    assert!(sql.contains("GROUP BY anon_2.project_id"));
    assert!(sql.contains(
        "WHERE loop_items.status = 'active' AND loop_items.resource_type IN ('project')"
    ));
    assert!(sql.ends_with("LIMIT 1"));
    // The point read is the inline-literal union, not the later CTE form.
    assert!(!sql.contains("WITH parents"));
    assert_eq!(queries[0].args, 0);
}

/// `require_cloud_project_role` maps the aggregated priority back to the
/// role hierarchy and rejects a value the query cannot produce.
#[test]
fn role_priorities_map_to_the_role_hierarchy() {
    assert_eq!(role_by_priority(0).unwrap(), "Owner");
    assert_eq!(role_by_priority(1).unwrap(), "Maintainer");
    assert_eq!(role_by_priority(2).unwrap(), "Developer");
    assert_eq!(role_by_priority(3).unwrap(), "Reporter");
    assert_eq!(role_by_priority(4).unwrap(), "Viewer");
    assert_eq!(role_by_priority(5).unwrap(), "RestrictedAnalyst");
    assert!(role_by_priority(6).is_err());
}

fn to_agent_metadata(value: serde_json::Value) -> Option<Json<serde_json::Value>> {
    Some(Json(value))
}

#[test]
fn role_hierarchy() {
    assert!(has_permission("Owner", "RestrictedAnalyst"));
    assert!(has_permission("Maintainer", "Reporter"));
    assert!(!has_permission("Reporter", "Developer"));
    assert!(!has_permission("Unknown", "Reporter"));
}

#[test]
fn agent_visibility_defaults_to_creator_admin() {
    let agent = |metadata: serde_json::Value| AgentRow {
        id: "1".to_string(),
        cloud_project_id: "p".to_string(),
        title: None,
        name: None,
        description: None,
        status: Some("active".to_string()),
        created_by_user_id: Some(5),
        device_id: None,
        local_project_id: None,
        created_at: None,
        updated_at: None,
        deleted_at: None,
        version: Some(1),
        metadata: to_agent_metadata(metadata),
    };
    assert_eq!(agent(json!({})).visibility(), "creator_admin");
    assert_eq!(
        agent(json!({"visibility": "public"})).visibility(),
        "public"
    );
    assert_eq!(
        agent(json!({"visibility": "weird"})).visibility(),
        "creator_admin"
    );
}

/// `list_project_task_bindings` selects the full labeled `loop_items`
/// projection and inlines every id, matching the recorded execution read.
#[tokio::test]
async fn list_project_task_bindings_matches_the_recorded_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let repository = BoardSnapshotRepository::new(&mysql);
    let bindings = repository
        .list_project_task_bindings("8308220868516891581", &["item-b".into(), "item-a".into()])
        .await
        .expect("bindings query is captured");
    assert!(bindings.is_empty());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].args, 0);
    assert_eq!(
        queries[0].sql,
        normalize(&format!(
            "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
             WHERE loop_items.cloud_project_id = 8308220868516891581 \
             AND loop_items.loop_item_id IN ('item-b', 'item-a') \
             AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
                 ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND loop_items.resource_type IN ('execution') \
             ORDER BY loop_items.loop_item_id ASC, loop_items.linked_at DESC, loop_items.id DESC",
        ))
    );
}

/// `list_members` joins the full labeled `users` projection and inlines the
/// numeric project id.
#[tokio::test]
async fn list_members_matches_the_recorded_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let repository = BoardSnapshotRepository::new(&mysql);
    let _ = repository
        .list_members("8308220868516891581")
        .await
        .expect("members query is captured");

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].args, 0);
    assert_eq!(
        queries[0].sql,
        normalize(&format!(
            "SELECT resource_members.id AS resource_members_id, \
             resource_members.resource_type AS resource_members_resource_type, \
             resource_members.resource_id AS resource_members_resource_id, \
             resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, \
             resource_members.entity_display_name AS resource_members_entity_display_name, \
             resource_members.user_id AS resource_members_user_id, \
             resource_members.`role` AS resource_members_role, \
             resource_members.status AS resource_members_status, \
             resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
             resource_members.share_link_id AS resource_members_share_link_id, \
             resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
             resource_members.reviewed_at AS resource_members_reviewed_at, \
             resource_members.copied_resource_id AS resource_members_copied_resource_id, \
             resource_members.requested_at AS resource_members_requested_at, \
             resource_members.created_at AS resource_members_created_at, \
             resource_members.updated_at AS resource_members_updated_at, \
             {} \
             FROM resource_members INNER JOIN users \
             ON users.id = resource_members.user_id \
             WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = 8308220868516891581 \
             AND resource_members.entity_type = 'user' \
             AND resource_members.status = 'approved' \
             ORDER BY resource_members.id",
            crate::user_reader::users_projection(),
        ))
    );
}

/// `explicit_member_ids` inlines the project id as the source's string
/// primary key, matching the recorded grant read.
#[tokio::test]
async fn explicit_member_ids_matches_the_recorded_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let repository = BoardSnapshotRepository::new(&mysql);
    let _ = repository
        .explicit_member_ids("8308220868516891581")
        .await
        .expect("member id query is captured");

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].args, 0);
    assert_eq!(
        queries[0].sql,
        normalize(
            "SELECT resource_members.entity_id AS resource_members_entity_id \n\
             FROM resource_members \n\
             WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = '8308220868516891581' \
             AND resource_members.entity_type = 'user' \
             AND resource_members.status = 'approved' \
             AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer')",
        )
    );
}

/// `loop_item_service.list` renders the active task rows with the inlined
/// numeric project id and no `visible_item_filter` for a maintainer+ caller.
#[tokio::test]
async fn list_project_task_items_matches_the_recorded_query() {
    use crate::loop_tasks::loop_repository::LoopItemRepository;
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let repository = LoopItemRepository::new(&mysql);
    let items = repository
        .list_project_task_items("8308220868516891581", 52, None)
        .await
        .expect("items query is captured");
    assert!(items.is_empty());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].args, 0);
    assert_eq!(
        queries[0].sql,
        normalize(&format!(
            "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
             WHERE loop_items.cloud_project_id = 8308220868516891581 \
             AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                 ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND loop_items.resource_type IN ('task') \
             ORDER BY loop_items.sort_order, loop_items.updated_at DESC",
        ))
    );
}

/// A caller below `Maintainer` gains the source `visible_item_filter`.
#[tokio::test]
async fn list_project_task_items_adds_the_visible_filter() {
    use crate::loop_tasks::loop_repository::LoopItemRepository;
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let repository = LoopItemRepository::new(&mysql);
    let _ = repository
        .list_project_task_items("8308220868516891581", 52, Some("related"))
        .await
        .expect("items query is captured");

    let sql = &mysql.queries()[0].sql;
    // The recorded rendering: the CASE/JSON_EXTRACT coalesce form and the
    // single-table-inheritance subqueries with their resource_type guards.
    assert!(
        sql.contains(
            "coalesce(CASE JSON_EXTRACT(loop_items.metadata, '$.\"security_level\"') \\
WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, \\
'$.\"security_level\"')) END, 'related') = 'open'"
        ) || sql.contains("WHEN 'null' THEN NULL ELSE JSON_UNQUOTE")
    );
    assert!(sql.contains("loop_items.created_by_user_id = 52"));
    assert!(
        sql.contains("loop_items.user_id = 52 AND loop_items.resource_type IN ('collaborator')")
    );
    assert!(sql.contains(
        "AND loop_items.resource_type IN ('execution')) OR loop_items.id IN (SELECT loop_items.loop_item_id"
    ));
    assert!(sql.contains("AND loop_items.resource_type IN ('chat_agent'))"));
}
