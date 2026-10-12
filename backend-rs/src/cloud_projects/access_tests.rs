//! Shape guards for the shared `project_access_query` rendering.
//!
//! The point form's full recorded text is asserted in
//! `board_snapshot::repository`; these tests pin the list form and the
//! relationship between the two modes, so a lost predicate, a reordered union
//! branch, or a changed placeholder count fails here.

use super::*;

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn list_sql_raw(workspace_filtered: bool) -> String {
    project_access_statement(ProjectAccessMode::List { workspace_filtered })
}

fn list_sql(workspace_filtered: bool) -> String {
    normalize(&list_sql_raw(workspace_filtered))
}

fn point_sql() -> String {
    normalize(&project_access_statement(ProjectAccessMode::Point))
}

/// The list form is the union with no per-branch project push-down, ordered
/// newest first.
#[test]
fn list_form_keeps_every_source_grant_branch() {
    let sql = list_sql(false);
    assert!(sql.starts_with("SELECT loop_items.id AS loop_items_id, "));
    assert!(sql.contains(
        "loop_items.deleted_at AS loop_items_deleted_at, anon_1.priority AS anon_1_priority"
    ));
    assert!(sql.ends_with(
        "WHERE loop_items.status = 'active' AND loop_items.resource_type IN ('project') \
         ORDER BY loop_items.updated_at DESC, loop_items.id"
    ));
    // direct membership, inherited workspace grants, public visibility,
    // caller ownership.
    assert_eq!(sql.matches("UNION ALL").count(), 3);
    // The two entity ids and the creator id bind positionally in text order.
    assert_eq!(sql.matches('?').count(), 3);
    assert!(sql.contains("CASE resource_members.`role` WHEN 'Owner' THEN 0"));
    assert!(sql.contains("min(anon_2.priority) AS priority"));
    assert!(sql.contains("anon_1.priority AS anon_1_priority"));
    assert!(sql.contains("kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true"));
    assert!(sql.contains("resource_members.`role` != 'RestrictedAnalyst'"));
    assert!(sql.contains("END IN ('public_restricted', 'public')"));
    // The driver escapes the JSON-path double quotes inside the string
    // literals; the recorded statements carry the escaped form.
    assert!(sql.contains(r#"'$.\"visibility\"'"#));
}

/// A `workspace_id` filter adds the grant restriction before the ordering.
#[test]
fn workspace_filter_adds_the_grant_restriction_before_ordering() {
    // Compared unnormalized: the restriction must carry the source fragment
    // verbatim, including its internal line breaks.
    let raw = list_sql_raw(true);
    assert!(raw.contains(&format!(
        " AND loop_items.id IN ({WORKSPACE_PROJECT_IDS_SQL})"
    )));
    // The unrestricted form never carries the restriction.
    assert!(!list_sql_raw(false).contains(WORKSPACE_PROJECT_IDS_SQL));

    let sql = list_sql(true);
    assert!(sql.ends_with("ORDER BY loop_items.updated_at DESC, loop_items.id"));
    assert_eq!(sql.matches('?').count(), 4);
}

/// The point form pushes the requested project into each of the four branches
/// and keeps a single row. Each push-down sits at the same position the
/// source's `query.filter(...)` call does.
#[test]
fn point_form_narrows_every_branch() {
    let sql = point_sql();
    assert!(sql.ends_with(
        "WHERE loop_items.status = 'active' AND loop_items.resource_type IN ('project') LIMIT 1"
    ));
    assert_eq!(sql.matches("UNION ALL").count(), 3);
    // direct entity id, direct project, inherited entity id, inherited project,
    // public project, creator id, creator project.
    assert_eq!(sql.matches('?').count(), 7);
    // The direct and inherited branches narrow on the membership resource id;
    // the public and owned branches narrow on the project row itself.
    assert!(sql.contains(
        "resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter', 'RestrictedAnalyst') AND resource_members.resource_id = ?"
    ));
    let inherited_branch = &sql[sql.find("entity_type = 'workspace'").unwrap()..];
    assert!(inherited_branch
        .starts_with("entity_type = 'workspace' AND resource_members.status = 'approved' AND resource_members.resource_id = ?"));
    assert!(sql.contains("END IN ('public_restricted', 'public') AND loop_items.id = ? AND loop_items.resource_type IN ('project')"));
    assert!(sql.contains("loop_items.created_by_user_id = ? AND loop_items.status = 'active' AND loop_items.id = ? AND loop_items.resource_type IN ('project')"));
}

/// The two modes are one statement: stripping the permitted per-mode segments
/// must leave byte-identical token streams. This is the property that lets the
/// shared builder replace the two hand-written renderings.
#[test]
fn the_two_modes_differ_only_by_the_pushdowns_and_the_tail() {
    let list = list_sql(false)
        .strip_suffix(" ORDER BY loop_items.updated_at DESC, loop_items.id")
        .expect("list form ends with the source ordering")
        .to_owned();
    let point = point_sql()
        .strip_suffix(" LIMIT 1")
        .expect("point form ends with LIMIT 1")
        .replace(" AND resource_members.resource_id = ?", "")
        .replace(" AND loop_items.id = ?", "");
    assert_eq!(list, point);
}

/// `ROLES_BY_PRIORITY` maps the five aggregated priorities and nothing else.
#[test]
fn role_priorities_map_to_the_role_hierarchy() {
    for (priority, role) in [
        (0, "Owner"),
        (1, "Maintainer"),
        (2, "Developer"),
        (3, "Reporter"),
        (4, "RestrictedAnalyst"),
    ] {
        assert_eq!(role_for_priority(priority), Some(role));
    }
    assert_eq!(role_for_priority(5), None);
}
