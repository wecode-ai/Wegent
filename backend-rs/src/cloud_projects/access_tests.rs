//! Shape guards for the shared `project_access_query` rendering.
//!
//! The point form's full recorded text is asserted in
//! `board_snapshot::repository`; these tests pin the list form and the
//! relationship between the two modes, so a lost predicate, a reordered union
//! branch, or a changed inlined grant value fails here.

use super::*;

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn list_sql_raw(workspace_id: Option<i64>) -> String {
    project_access_statement(ProjectAccessMode::List { workspace_id }, 52, None)
}

fn list_sql(workspace_id: Option<i64>) -> String {
    normalize(&list_sql_raw(workspace_id))
}

fn point_sql() -> String {
    normalize(&project_access_statement(
        ProjectAccessMode::Point,
        52,
        Some(8308220868516891581),
    ))
}

/// The list form is the union with no per-branch project push-down, ordered
/// newest first. Every grant value is inlined, so it carries no bind markers.
#[test]
fn list_form_keeps_every_source_grant_branch() {
    let sql = list_sql(None);
    assert!(sql.starts_with("SELECT loop_items.id AS loop_items_id, "));
    assert!(sql.contains(
        "loop_items.deleted_at AS loop_items_deleted_at, anon_1.priority AS anon_1_priority"
    ));
    assert!(sql.ends_with(
        "WHERE loop_items.status = 'active' AND loop_items.resource_type IN ('project') \
         ORDER BY loop_items.updated_at DESC, loop_items.id"
    ));
    // direct membership, inherited workspace grants, public grants,
    // caller ownership.
    assert_eq!(sql.matches("UNION ALL").count(), 3);
    // No bind parameters: the source inlines every grant value.
    assert_eq!(sql.matches('?').count(), 0);
    assert!(sql.contains(
        "CASE resource_members.`role` WHEN 'Owner' THEN 0 WHEN 'Maintainer' THEN 1 WHEN 'Developer' THEN 2 WHEN 'Reporter' THEN 3 WHEN 'Viewer' THEN 4 WHEN 'RestrictedAnalyst' THEN 5 END"
    ));
    assert!(sql.contains("min(anon_2.priority) AS priority"));
    assert!(sql.contains("anon_1.priority AS anon_1_priority"));
    assert!(sql.contains("kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true"));
    // Direct grants admit the four project member roles (Viewer only).
    assert!(
        sql.contains("resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer')")
    );
    // Inherited workspace grants stop at Reporter, after the active-workspace
    // predicates.
    assert!(sql.contains(
        "kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter')) AS anon_3 ON CAST(resource_members.entity_id AS SIGNED INTEGER) = anon_3.resource_id"
    ));
    // Public grants are held by every signed-in user.
    assert!(sql.contains(
        "resource_members.entity_type = 'authenticated_users' AND resource_members.entity_id = '*'"
    ));
    assert!(sql.contains("resource_members.`role` IN ('Developer', 'Viewer')"));
    // The caller id is inlined as a string for `entity_id` and as an integer
    // for `created_by_user_id`.
    assert!(sql.contains("resource_members.entity_id = '52'"));
    assert!(sql.contains("loop_items.created_by_user_id = 52"));
}

/// A `workspace_id` filter adds the grant restriction before the ordering.
#[test]
fn workspace_filter_adds_the_grant_restriction_before_ordering() {
    // Compared unnormalized: the restriction must carry the source fragment
    // verbatim, including its internal line breaks.
    let raw = list_sql_raw(Some(1200));
    assert!(raw.contains(&format!(
        " AND loop_items.id IN ({})",
        workspace_project_ids_statement(1200)
    )));
    // The unrestricted form never carries the restriction.
    assert!(!list_sql_raw(None).contains("workspace_project_ids"));

    let sql = list_sql(Some(1200));
    assert!(sql.ends_with("ORDER BY loop_items.updated_at DESC, loop_items.id"));
    assert_eq!(sql.matches('?').count(), 0);
}

/// The point form pushes the requested project into each of the four branches
/// and keeps a single row.
#[test]
fn point_form_narrows_every_branch() {
    let sql = point_sql();
    assert!(sql.ends_with(
        "WHERE loop_items.status = 'active' AND loop_items.resource_type IN ('project') LIMIT 1"
    ));
    assert_eq!(sql.matches("UNION ALL").count(), 3);
    assert_eq!(sql.matches('?').count(), 0);
    // The direct and inherited branches narrow on the numeric membership
    // resource id; the public branch does too; the owned branch narrows on the
    // string project primary key.
    assert!(sql.contains(
        "resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer') AND resource_members.resource_id = 8308220868516891581"
    ));
    let inherited_branch = &sql[sql.find("entity_type = 'workspace'").unwrap()..];
    assert!(inherited_branch.starts_with(
        "entity_type = 'workspace' AND resource_members.status = 'approved' AND resource_members.resource_id = 8308220868516891581"
    ));
    assert!(sql.contains(
        "resource_members.`role` IN ('Developer', 'Viewer') AND resource_members.resource_id = 8308220868516891581"
    ));
    assert!(sql.contains(
        "loop_items.created_by_user_id = 52 AND loop_items.status = 'active' AND loop_items.id = '8308220868516891581' AND loop_items.resource_type IN ('project')"
    ));
}

/// The two modes are one statement: stripping the permitted per-mode segments
/// must leave identical token streams. This is the property that lets the
/// shared builder replace the two hand-written renderings.
#[test]
fn the_two_modes_differ_only_by_the_pushdowns_and_the_tail() {
    let list = list_sql(None)
        .strip_suffix(" ORDER BY loop_items.updated_at DESC, loop_items.id")
        .expect("list form ends with the source ordering")
        .to_owned();
    let point = point_sql()
        .strip_suffix(" LIMIT 1")
        .expect("point form ends with LIMIT 1")
        .replace(
            " AND resource_members.resource_id = 8308220868516891581",
            "",
        )
        .replace(" AND loop_items.id = '8308220868516891581'", "");
    assert_eq!(list, point);
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
