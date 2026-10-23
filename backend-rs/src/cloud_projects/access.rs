//! Shared project permission projection and approved catalog query dispatch.

/// The source's full column projection (all mapped `loop_items` columns,
/// labeled like SQLAlchemy's query rendering). Selected to match the
/// recorded statement; the typed row consumes only the response fields.
pub(crate) const LOOP_ITEMS_COLUMNS: &str = "loop_items.id AS loop_items_id, \
     loop_items.resource_type AS loop_items_resource_type, \
     loop_items.project_space AS loop_items_project_space, \
     loop_items.cloud_project_id AS loop_items_cloud_project_id, \
     loop_items.parent_id AS loop_items_parent_id, \
     loop_items.loop_item_id AS loop_items_loop_item_id, \
     loop_items.delivery_id AS loop_items_delivery_id, \
     loop_items.public_id AS loop_items_public_id, \
     loop_items.project_key AS loop_items_project_key, \
     loop_items.name AS loop_items_name, \
     loop_items.title AS loop_items_title, \
     loop_items.description AS loop_items_description, \
     loop_items.storage_prefix AS loop_items_storage_prefix, \
     loop_items.sequence_number AS loop_items_sequence_number, \
     loop_items.next_item_number AS loop_items_next_item_number, \
     loop_items.created_by_user_id AS loop_items_created_by_user_id, \
     loop_items.updated_by_user_id AS loop_items_updated_by_user_id, \
     loop_items.assignee_user_id AS loop_items_assignee_user_id, \
     loop_items.user_id AS loop_items_user_id, \
     loop_items.added_by_user_id AS loop_items_added_by_user_id, \
     loop_items.source AS loop_items_source, \
     loop_items.status AS loop_items_status, \
     loop_items.priority AS loop_items_priority, \
     loop_items.start_at AS loop_items_start_at, \
     loop_items.due_at AS loop_items_due_at, \
     loop_items.sort_order AS loop_items_sort_order, \
     loop_items.current_delivery_id AS loop_items_current_delivery_id, \
     loop_items.local_project_id AS loop_items_local_project_id, \
     loop_items.device_id AS loop_items_device_id, \
     loop_items.is_default AS loop_items_is_default, \
     loop_items.task_user_id AS loop_items_task_user_id, \
     loop_items.assignee_agent_id AS loop_items_assignee_agent_id, \
     loop_items.assignee_team_id AS loop_items_assignee_team_id, \
     loop_items.task_id AS loop_items_task_id, \
     loop_items.task_title AS loop_items_task_title, \
     loop_items.backend_task_id AS loop_items_backend_task_id, \
     loop_items.linked_by_user_id AS loop_items_linked_by_user_id, \
     loop_items.linked_at AS loop_items_linked_at, \
     loop_items.unlinked_at AS loop_items_unlinked_at, \
     loop_items.path AS loop_items_path, \
     loop_items.kind AS loop_items_kind, \
     loop_items.display_name AS loop_items_display_name, \
     loop_items.relative_path AS loop_items_relative_path, \
     loop_items.object_key AS loop_items_object_key, \
     loop_items.content_type AS loop_items_content_type, \
     loop_items.size_bytes AS loop_items_size_bytes, \
     loop_items.sha256 AS loop_items_sha256, \
     loop_items.source_task_binding_id AS loop_items_source_task_binding_id, \
     loop_items.source_task_snapshot AS loop_items_source_task_snapshot, \
     loop_items.markdown_object_key AS loop_items_markdown_object_key, \
     loop_items.chat_object_key AS loop_items_chat_object_key, \
     loop_items.manifest_object_key AS loop_items_manifest_object_key, \
     loop_items.metadata AS loop_items_metadata, \
     loop_items.version AS loop_items_version, \
     loop_items.created_at AS loop_items_created_at, \
     loop_items.updated_at AS loop_items_updated_at, \
     loop_items.completed_at AS loop_items_completed_at, \
     loop_items.delivered_at AS loop_items_delivered_at, \
     loop_items.deleted_at AS loop_items_deleted_at";

/// The unlabeled `loop_items` entity projection that SQLAlchemy renders for a
/// `Session.get`/`db.get` lookup: the legacy `Query` API labels columns
/// `loop_items_<column>`, while `db.get` selects the bare columns. Derived
/// from [`LOOP_ITEMS_COLUMNS`] so the column list stays defined once.
pub(crate) fn entity_columns() -> String {
    LOOP_ITEMS_COLUMNS
        .split(", ")
        .map(|column| column.split(" AS ").next().unwrap_or(column))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `cloud_project_visibility.ROLES_BY_PRIORITY`: lower number is the higher
/// privilege. `None` for a priority the union cannot emit, which the source
/// indexes as a missing key. The hierarchy is `Owner`, `Maintainer`,
/// `Developer`, `Reporter`, `Viewer`, `RestrictedAnalyst`, so priority `4` is
/// `Viewer` and `5` is `RestrictedAnalyst`.
pub(crate) fn role_for_priority(priority: i64) -> Option<&'static str> {
    match priority {
        0 => Some("Owner"),
        1 => Some("Maintainer"),
        2 => Some("Developer"),
        3 => Some("Reporter"),
        4 => Some("Viewer"),
        5 => Some("RestrictedAnalyst"),
        _ => None,
    }
}

/// `CloudProject.workspace_id`: the single approved `workspace` parent of the
/// selected project, rendered as SQLAlchemy's leading column-property scalar
/// subquery (`anon_1`) on every `CloudProject` entity SELECT.
pub(crate) const WORKSPACE_ID_COLUMN: &str = "(SELECT CASE WHEN (count(distinct(resource_members.entity_id)) = 1) THEN CAST(min(resource_members.entity_id) AS SIGNED INTEGER) END AS anon_2 \n\
     FROM resource_members \n\
     WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id = CAST(loop_items.id AS SIGNED INTEGER) AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved') AS anon_1";

/// `cloud_project_visibility.project_access_query(db, user_id, project_id)`:
/// the point form used by `require_cloud_project_role`. The source inlines
/// every value as a literal, so the statement carries the caller and project
/// ids inline exactly as the recorded COM_QUERY shows.
///
/// The source's unified permission contract unions three grants — the direct
/// `resource_members` grant (all five collaboration roles, with the legacy
/// `Owner`→`Maintainer` and `Reporter`→`Viewer` aliases applied), the grant
/// inherited through the project's single approved parent
/// `CollaborationWorkspace` (admins keep `Maintainer`, other members inherit
/// only when the project's `membership_mode` is `inherit`), and the
/// all-signed-in-users (`authenticated_users`) grant at `Viewer` — reduced to
/// `min(priority)` per project. Creators are no longer implicit
/// administrators. The outer statement loads the project's parent workspace
/// id (the `CloudProject.workspace_id` column property, rendered as the
/// leading `anon_1` scalar subquery), joins the active parent workspace, and
/// keeps the caller only while their `users` row is active.
pub(crate) fn project_access_point_statement(user_id: i32, project_id: i64) -> String {
    format!(
        "SELECT {WORKSPACE_ID_COLUMN}, {LOOP_ITEMS_COLUMNS}, anon_3.priority AS anon_3_priority \n\
         FROM loop_items INNER JOIN (SELECT anon_4.project_id AS project_id, min(anon_4.priority) AS priority \n\
         FROM (SELECT CAST(resource_members.resource_id AS CHAR(64)) AS project_id, CASE CASE resource_members.`role` WHEN 'Owner' THEN 'Maintainer' WHEN 'Reporter' THEN 'Viewer' ELSE resource_members.`role` END WHEN 'Owner' THEN 0 WHEN 'Maintainer' THEN 1 WHEN 'Developer' THEN 2 WHEN 'Reporter' THEN 3 WHEN 'Viewer' THEN 4 WHEN 'RestrictedAnalyst' THEN 5 END AS priority \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter') AND resource_members.resource_id = {project_id} UNION ALL SELECT loop_items.id AS project_id, CASE WHEN (kinds.user_id = {user_id} OR anon_5.`role` = 'Maintainer') THEN 1 ELSE CASE anon_5.`role` WHEN 'Owner' THEN 0 WHEN 'Maintainer' THEN 1 WHEN 'Developer' THEN 2 WHEN 'Reporter' THEN 3 WHEN 'Viewer' THEN 4 WHEN 'RestrictedAnalyst' THEN 5 END END AS priority \n\
         FROM loop_items INNER JOIN (SELECT resource_members.resource_id AS project_id, CAST(min(resource_members.entity_id) AS SIGNED INTEGER) AS workspace_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' GROUP BY resource_members.resource_id \n\
         HAVING count(distinct(resource_members.entity_id)) = 1) AS anon_6 ON anon_6.project_id = CAST(loop_items.id AS SIGNED INTEGER) INNER JOIN kinds ON kinds.id = anon_6.workspace_id LEFT OUTER JOIN (SELECT resource_members.resource_id AS resource_id, CASE resource_members.`role` WHEN 'Owner' THEN 'Maintainer' WHEN 'Reporter' THEN 'Viewer' ELSE resource_members.`role` END AS `role` \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')) AS anon_5 ON anon_5.resource_id = kinds.id \n\
         WHERE kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND (kinds.user_id = {user_id} OR anon_5.`role` = 'Maintainer' OR anon_5.resource_id IS NOT NULL) AND (kinds.user_id = {user_id} OR anon_5.`role` = 'Maintainer' OR coalesce(CASE JSON_EXTRACT(loop_items.metadata, '$.\"membership_mode\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.\"membership_mode\"')) END, 'inherit') = 'inherit') AND loop_items.id = '{project_id}' AND loop_items.resource_type IN ('project') UNION ALL SELECT CAST(resource_members.resource_id AS CHAR(64)) AS project_id, 4 AS priority \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'authenticated_users' AND resource_members.entity_id = '*' AND resource_members.status = 'approved' AND resource_members.`role` IN ('Viewer', 'Developer') AND resource_members.resource_id = {project_id}) AS anon_4 GROUP BY anon_4.project_id) AS anon_3 ON loop_items.id = anon_3.project_id INNER JOIN (SELECT resource_members.resource_id AS project_id, CAST(min(resource_members.entity_id) AS SIGNED INTEGER) AS workspace_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved' GROUP BY resource_members.resource_id \n\
         HAVING count(distinct(resource_members.entity_id)) = 1) AS anon_7 ON anon_7.project_id = CAST(loop_items.id AS SIGNED INTEGER) INNER JOIN kinds ON kinds.id = anon_7.workspace_id \n\
         WHERE loop_items.status = 'active' AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND (EXISTS (SELECT users.id \n\
         FROM users \n\
         WHERE users.id = {user_id} AND users.is_active IS true)) AND loop_items.resource_type IN ('project') \n LIMIT 1"
    )
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
