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

/// Which shape of `project_access_query` to render.
pub(crate) enum ProjectAccessMode {
    /// `project_access_query(db, user_id)`: every accessible project, newest
    /// first. `workspace_id` adds the `workspace_project_ids` restriction
    /// before the ordering.
    List { workspace_id: Option<i64> },
    /// `project_access_query(db, user_id, project_id)`: the same union with the
    /// project id pushed into each branch, reduced to one row.
    Point,
}

/// Use the approved permission contract for list and point reads.
pub(crate) fn project_access_statement(
    mode: ProjectAccessMode,
    user_id: i32,
    project_id: Option<i64>,
) -> String {
    match mode {
        ProjectAccessMode::List { workspace_id } => {
            super::collaboration_access::access_sql(user_id, None, workspace_id)
        }
        ProjectAccessMode::Point => format!(
            "{} LIMIT 1",
            super::collaboration_access::access_sql(user_id, project_id, None)
        ),
    }
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
