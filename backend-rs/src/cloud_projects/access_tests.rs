//! Shape guards for the shared `project_access_query` rendering.
//!
//! The list form is the unified collaboration catalog CTE; the point form is
//! the same permission contract rendered with the caller and project ids
//! inlined for `require_cloud_project_role`. These tests pin both shapes so a
//! lost predicate, a reordered union branch, or a changed inlined grant value
//! fails here.

use super::*;

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn list_sql_raw(workspace_id: Option<i64>) -> String {
    super::super::collaboration_access::access_sql(52, None, workspace_id)
}

fn list_sql(workspace_id: Option<i64>) -> String {
    normalize(&list_sql_raw(workspace_id))
}

fn point_sql() -> String {
    normalize(&project_access_point_statement(52, 8308220868516891581))
}

#[test]
fn cp02_cp03_cp04_cp06_sources_are_explicit_and_public_is_read_only() {
    let sql = list_sql(None);
    assert!(sql.contains("HAVING COUNT(DISTINCT entity_id) = 1"));
    assert!(sql.contains("WHEN 'Owner' THEN 1"));
    assert!(sql.contains("WHEN 'Reporter' THEN 4"));
    assert!(sql.contains("THEN 4 END AS public_priority"));
    assert!(!sql.contains("loop_items.created_by_user_id = 52"));
    assert!(sql.contains("caller.is_active = true"));
    assert!(sql.contains("kinds.is_active = true"));
}
/// The shared projection must carry every mapped `loop_items` column in the
/// source's order. A dropped column — for example `start_at`, which sits
/// between `priority` and `due_at` in the recorded rendering — makes every
/// recorded `loop_items` read stop matching during replay, so the whole
/// request fails with a 500.
#[test]
fn projection_matches_the_source_loop_items_column_list() {
    let expected = [
        "loop_items.id AS loop_items_id",
        "loop_items.resource_type AS loop_items_resource_type",
        "loop_items.project_space AS loop_items_project_space",
        "loop_items.cloud_project_id AS loop_items_cloud_project_id",
        "loop_items.parent_id AS loop_items_parent_id",
        "loop_items.loop_item_id AS loop_items_loop_item_id",
        "loop_items.delivery_id AS loop_items_delivery_id",
        "loop_items.public_id AS loop_items_public_id",
        "loop_items.project_key AS loop_items_project_key",
        "loop_items.name AS loop_items_name",
        "loop_items.title AS loop_items_title",
        "loop_items.description AS loop_items_description",
        "loop_items.storage_prefix AS loop_items_storage_prefix",
        "loop_items.sequence_number AS loop_items_sequence_number",
        "loop_items.next_item_number AS loop_items_next_item_number",
        "loop_items.created_by_user_id AS loop_items_created_by_user_id",
        "loop_items.updated_by_user_id AS loop_items_updated_by_user_id",
        "loop_items.assignee_user_id AS loop_items_assignee_user_id",
        "loop_items.user_id AS loop_items_user_id",
        "loop_items.added_by_user_id AS loop_items_added_by_user_id",
        "loop_items.source AS loop_items_source",
        "loop_items.status AS loop_items_status",
        "loop_items.priority AS loop_items_priority",
        "loop_items.start_at AS loop_items_start_at",
        "loop_items.due_at AS loop_items_due_at",
        "loop_items.sort_order AS loop_items_sort_order",
        "loop_items.current_delivery_id AS loop_items_current_delivery_id",
        "loop_items.local_project_id AS loop_items_local_project_id",
        "loop_items.device_id AS loop_items_device_id",
        "loop_items.is_default AS loop_items_is_default",
        "loop_items.task_user_id AS loop_items_task_user_id",
        "loop_items.assignee_agent_id AS loop_items_assignee_agent_id",
        "loop_items.assignee_team_id AS loop_items_assignee_team_id",
        "loop_items.task_id AS loop_items_task_id",
        "loop_items.task_title AS loop_items_task_title",
        "loop_items.backend_task_id AS loop_items_backend_task_id",
        "loop_items.linked_by_user_id AS loop_items_linked_by_user_id",
        "loop_items.linked_at AS loop_items_linked_at",
        "loop_items.unlinked_at AS loop_items_unlinked_at",
        "loop_items.path AS loop_items_path",
        "loop_items.kind AS loop_items_kind",
        "loop_items.display_name AS loop_items_display_name",
        "loop_items.relative_path AS loop_items_relative_path",
        "loop_items.object_key AS loop_items_object_key",
        "loop_items.content_type AS loop_items_content_type",
        "loop_items.size_bytes AS loop_items_size_bytes",
        "loop_items.sha256 AS loop_items_sha256",
        "loop_items.source_task_binding_id AS loop_items_source_task_binding_id",
        "loop_items.source_task_snapshot AS loop_items_source_task_snapshot",
        "loop_items.markdown_object_key AS loop_items_markdown_object_key",
        "loop_items.chat_object_key AS loop_items_chat_object_key",
        "loop_items.manifest_object_key AS loop_items_manifest_object_key",
        "loop_items.metadata AS loop_items_metadata",
        "loop_items.version AS loop_items_version",
        "loop_items.created_at AS loop_items_created_at",
        "loop_items.updated_at AS loop_items_updated_at",
        "loop_items.completed_at AS loop_items_completed_at",
        "loop_items.delivered_at AS loop_items_delivered_at",
        "loop_items.deleted_at AS loop_items_deleted_at",
    ]
    .join(", ");
    assert_eq!(normalize(LOOP_ITEMS_COLUMNS), expected);
}

#[test]
fn list_and_point_filters_keep_their_recorded_contracts() {
    let list = list_sql(None);
    let point = point_sql();
    // The list read keeps the unified catalog CTE; the point read keeps the
    // unified permission union with the project id pushed into each branch.
    assert!(list.contains("WITH parents AS ("));
    assert!(list.contains("ORDER BY loop_items.updated_at DESC, loop_items.id"));
    assert!(list_sql(Some(1200)).contains("AND access.workspace_id = 1200"));
    assert!(point.contains("AND resource_members.resource_id = 8308220868516891581"));
    assert!(point.contains("AND loop_items.id = '8308220868516891581'"));
    assert!(point.ends_with("LIMIT 1"));
}

/// The point form renders the unified permission contract: the direct grant,
/// the workspace-inherited grant (admins keep `Maintainer`; inherited members
/// only apply in `inherit` mode), and the public grant, reduced to
/// `min(priority)` and joined to the active project row plus its active parent
/// workspace. Creators are no longer implicit administrators. A reordered
/// branch or a lost predicate stops matching the recorded dependency during
/// replay and fails the whole request.
#[test]
fn point_form_renders_the_unified_permission_contract() {
    let sql = point_sql();
    let branches: Vec<&str> = sql.matches("UNION ALL").collect();
    assert_eq!(branches.len(), 2);
    let direct = sql.find("FROM resource_members").expect("direct branch");
    let inherited = sql
        .find("CASE WHEN (kinds.user_id = 52 OR anon_5.`role` = 'Maintainer')")
        .expect("inherited branch");
    let public = sql
        .find("entity_type = 'authenticated_users'")
        .expect("public branch");
    assert!(direct < inherited && inherited < public);
    assert!(sql.contains("resource_members.entity_id = '52'"));
    assert!(!sql.contains("loop_items.created_by_user_id = 52"));
    assert!(!sql.contains("WITH parents AS ("));
    assert!(sql.contains("kinds.kind = 'CollaborationWorkspace'"));
    assert!(sql.contains("kinds.is_active IS true"));
    assert!(sql.contains("GROUP BY anon_4.project_id"));
    assert!(sql.contains("min(anon_4.priority)"));
    assert!(sql.contains(
        "AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')"
    ));
    // The unified contract applies the collaboration aliases and the
    // `membership_mode` inheritance predicate.
    assert!(sql.contains("WHEN 'Owner' THEN 'Maintainer' WHEN 'Reporter' THEN 'Viewer'"));
    assert!(sql.contains("'$.\"membership_mode\"'"));
    // The project row carries its parent workspace id and effective role.
    assert!(sql.contains(") AS anon_1,"));
    assert!(sql.contains("anon_3.priority AS anon_3_priority"));
    assert!(sql.contains("EXISTS (SELECT users.id"));
    assert!(sql.contains("users.id = 52 AND users.is_active IS true"));
    assert!(sql.contains("AND loop_items.id = '8308220868516891581'"));
}

/// `ROLES_BY_PRIORITY` maps the aggregated priorities and nothing else.
#[test]
fn role_priorities_map_to_the_role_hierarchy() {
    for (priority, role) in [
        (0, "Owner"),
        (1, "Maintainer"),
        (2, "Developer"),
        (3, "Reporter"),
        (4, "Viewer"),
        (5, "RestrictedAnalyst"),
    ] {
        assert_eq!(role_for_priority(priority), Some(role));
    }
    assert_eq!(role_for_priority(6), None);
}
