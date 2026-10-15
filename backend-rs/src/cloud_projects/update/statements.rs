// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL statements for `PATCH /api/v1/cloud-projects/{project_id}`.
//!
//! Each constant reproduces the statement SQLAlchemy renders for the source
//! operation (`cloud_project_service.update`), including the labeled column
//! projections and the inline schema literals the recorder captured.

/// The full labeled `resource_members` projection SQLAlchemy renders for
/// `db.query(ResourceMember).filter(...).one_or_none()` in the visibility
/// branch.
pub(super) const RESOURCE_MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
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
     resource_members.updated_at AS resource_members_updated_at";

/// `db.query(ResourceMember).filter(<authenticated_users grant>).one_or_none()`.
/// The project id is bound as a string, matching the source's string project
/// key.
pub(super) fn grant_select_sql() -> String {
    format!(
        "SELECT {RESOURCE_MEMBER_COLUMNS} \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' \
         AND resource_members.resource_id = ? \
         AND resource_members.entity_type = 'authenticated_users' \
         AND resource_members.entity_id = '*'"
    )
}

/// `ResourceMember.create(...)` flushed by `db.commit()`. The constant columns
/// (entity type/id, the empty display name, the zero counters, the epoch
/// review time) stay inline; the project id, role and request time are bound.
pub(super) const INSERT_GRANT_SQL: &str = "INSERT INTO resource_members \
     (resource_type, resource_id, entity_type, entity_id, entity_display_name, \
     user_id, `role`, status, invited_by_user_id, share_link_id, \
     reviewed_by_user_id, reviewed_at, copied_resource_id, requested_at, \
     created_at, updated_at) \
     VALUES ('CloudProject', ?, 'authenticated_users', '*', '', 0, ?, 'approved', \
     0, 0, 0, '1970-01-01 00:00:00', 0, ?, now(), now())";

/// `db.refresh(project)`: the unlabeled `loop_items` entity projection with no
/// `LIMIT`, scoped to the `project` polymorphic identity. The id is bound.
pub(super) fn entity_project_sql() -> String {
    format!(
        "SELECT {}\nFROM loop_items \n\
         WHERE loop_items.id = ? AND loop_items.resource_type IN ('project')",
        crate::cloud_projects::entity_columns(),
    )
}

/// `db.query(CloudProject).filter(id ==, version ==).update({..})`.
///
/// `columns` renders the direct `loop_items` columns the request set (`name`,
/// `description`) in the source's `model_dump` order. `with_metadata` adds the
/// `metadata` assignment the merge folds in (the key is absent when no
/// metadata-backed field was set); `version=(loop_items.version + 1)` and the
/// column's `onupdate` `updated_at=now()` follow.
pub(super) fn project_update_sql(columns: &[&str], with_metadata: bool) -> String {
    let mut assignments: Vec<String> = columns.iter().map(|column| format!("{column}=?")).collect();
    if with_metadata {
        assignments.push("metadata=?".to_owned());
    }
    assignments.push("version=(loop_items.version + 1)".to_owned());
    assignments.push("updated_at=now()".to_owned());
    format!(
        "UPDATE loop_items SET {} \
         WHERE loop_items.id = ? AND loop_items.version = ? \
         AND loop_items.resource_type IN ('project')",
        assignments.join(", "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_select_is_one_bound_project_id() {
        let sql = grant_select_sql();
        assert!(sql.contains("resource_members.resource_id = ?"));
        assert!(sql.contains("entity_type = 'authenticated_users'"));
        assert!(sql.contains("entity_id = '*'"));
        assert_eq!(sql.matches('?').count(), 1);
    }

    #[test]
    fn insert_grant_binds_the_three_source_values() {
        assert_eq!(INSERT_GRANT_SQL.matches('?').count(), 3);
        assert!(INSERT_GRANT_SQL.contains("'CloudProject'"));
        assert!(INSERT_GRANT_SQL.contains("'1970-01-01 00:00:00'"));
        assert!(INSERT_GRANT_SQL.contains("now(), now())"));
    }

    #[test]
    fn update_statement_orders_columns_then_metadata() {
        assert_eq!(
            project_update_sql(&["name", "description"], true),
            "UPDATE loop_items SET name=?, description=?, metadata=?, \
             version=(loop_items.version + 1), updated_at=now() \
             WHERE loop_items.id = ? AND loop_items.version = ? \
             AND loop_items.resource_type IN ('project')"
        );
        assert_eq!(
            project_update_sql(&[], true),
            "UPDATE loop_items SET metadata=?, version=(loop_items.version + 1), \
             updated_at=now() WHERE loop_items.id = ? AND loop_items.version = ? \
             AND loop_items.resource_type IN ('project')"
        );
    }

    #[test]
    fn update_statement_omits_metadata_without_a_merge() {
        assert_eq!(
            project_update_sql(&["name"], false),
            "UPDATE loop_items SET name=?, version=(loop_items.version + 1), \
             updated_at=now() WHERE loop_items.id = ? AND loop_items.version = ? \
             AND loop_items.resource_type IN ('project')"
        );
    }

    #[test]
    fn entity_project_sql_is_the_unlabeled_entity_projection() {
        let sql = entity_project_sql();
        assert!(sql.starts_with("SELECT loop_items.id, loop_items.resource_type"));
        assert!(!sql.contains(" AS loop_items_"));
        assert!(
            sql.contains("WHERE loop_items.id = ? AND loop_items.resource_type IN ('project')")
        );
    }
}
