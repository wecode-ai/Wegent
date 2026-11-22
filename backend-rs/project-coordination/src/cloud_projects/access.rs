//! Shared project permission projection and approved catalog query dispatch.

pub use wegent_backend_persistence::project_projection::LOOP_ITEMS_COLUMNS;

/// The unlabeled `loop_items` entity projection that SQLAlchemy renders for a
/// `Session.get`/`db.get` lookup: the legacy `Query` API labels columns
/// `loop_items_<column>`, while `db.get` selects the bare columns. Derived
/// from [`LOOP_ITEMS_COLUMNS`] so the column list stays defined once.
pub fn entity_columns() -> String {
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
pub fn role_for_priority(priority: i64) -> Option<&'static str> {
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

// Keep the scalar's predicates shared with callers that use the ORM alias.
macro_rules! workspace_id_expression {
    ($alias:literal) => {
        concat!(
            "(SELECT CASE WHEN (count(distinct(resource_members.entity_id)) = 1) THEN CAST(min(resource_members.entity_id) AS SIGNED INTEGER) END",
            $alias,
            " \n\
     FROM resource_members \n\
     WHERE resource_members.resource_type = 'CloudProject' AND resource_members.resource_id = CAST(loop_items.id AS SIGNED INTEGER) AND resource_members.entity_type = 'workspace' AND resource_members.status = 'approved')"
        )
    };
}

/// The single approved workspace parent of the selected project.
pub const WORKSPACE_ID_COLUMN: &str = concat!(workspace_id_expression!(" AS anon_2"), " AS anon_1");
pub const WORKSPACE_ID_EXPRESSION: &str = workspace_id_expression!("");

/// `cloud_project_visibility.project_access_query(db, user_id, project_id)`:
/// the single-project form of the unified permission contract. The source
/// inlines every value as a literal, so the statement carries the caller and
/// project ids inline exactly as the recorded COM_QUERY shows.
///
/// Three grants are unioned — the direct `resource_members` grant (all five
/// collaboration roles, with the legacy `Owner`->`Maintainer` and
/// `Reporter`->`Viewer` aliases applied), the grant inherited through the
/// project's single approved parent `CollaborationWorkspace` (admins keep
/// `Maintainer`, other members inherit only when the project's
/// `membership_mode` is `inherit`), and the all-signed-in-users
/// (`authenticated_users`) grant at `Viewer` — each tagged with the authority
/// class the source assigns. The reduction keeps the best authority class and
/// then the best role within it (`coalesce(min(case authority ...))`),
/// matching `project_access_query`'s `priority` expression. Creators are not
/// implicit administrators. The outer statement loads the project's parent
/// workspace id (the `CloudProject.workspace_id` column property, rendered as
/// the leading `anon_1` scalar subquery), joins the active parent workspace,
/// and keeps the caller only while their `users` row is active.
pub fn project_access_point_statement(user_id: i32, project_id: i64) -> String {
    permission_statement(
        user_id,
        project_id,
        &format!("{WORKSPACE_ID_COLUMN}, {LOOP_ITEMS_COLUMNS}, anon_3.priority AS anon_3_priority"),
    )
}

pub fn project_permission_statement(user_id: i32, project_id: i64) -> String {
    permission_statement(
        user_id,
        project_id,
        "anon_7.workspace_id AS workspace_id, anon_3.priority AS priority",
    )
}

fn permission_statement(user_id: i32, project_id: i64, projection: &str) -> String {
    // Compare project identities as bytes across the grant union. Legacy
    // tables and the connection can have different utf8mb4 collations.
    // The inherited branch's effective role, rendered once per use: the
    // `priority` column and the `authority` class (inherited-admin vs
    // inherited-member) both embed it, exactly like the source's SQLAlchemy
    // rendering.
    let inherited_role = format!(
        "CASE WHEN (kinds.user_id = {user_id} OR anon_5.`role` = 'Maintainer') THEN 1 \
         ELSE CASE anon_5.`role` WHEN 'Owner' THEN 0 WHEN 'Maintainer' THEN 1 \
         WHEN 'Developer' THEN 2 WHEN 'Reporter' THEN 3 WHEN 'Viewer' THEN 4 \
         WHEN 'RestrictedAnalyst' THEN 5 END END"
    );
    format!(
        "SELECT {projection} \n\
         FROM loop_items INNER JOIN (SELECT anon_4.project_id AS project_id, \
         coalesce(min(CASE WHEN (anon_4.authority = 0) THEN anon_4.priority END), \
         min(CASE WHEN (anon_4.authority = 1) THEN anon_4.priority END), \
         min(CASE WHEN (anon_4.authority = 2) THEN anon_4.priority END), \
         min(CASE WHEN (anon_4.authority = 3) THEN anon_4.priority END)) AS priority \n\
         FROM (SELECT CAST(resource_members.resource_id AS BINARY) AS project_id, \
         CASE CASE resource_members.`role` WHEN 'Owner' THEN 'Maintainer' WHEN 'Reporter' THEN 'Viewer' ELSE resource_members.`role` END \
         WHEN 'Owner' THEN 0 WHEN 'Maintainer' THEN 1 WHEN 'Developer' THEN 2 \
         WHEN 'Reporter' THEN 3 WHEN 'Viewer' THEN 4 WHEN 'RestrictedAnalyst' THEN 5 END AS priority, \
         1 AS authority \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' \
         AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter') \
         AND resource_members.resource_id = {project_id} UNION ALL SELECT CAST(loop_items.id AS BINARY) AS project_id, \
         {inherited_role} AS priority, \
         CASE WHEN ({inherited_role} = 1) THEN 0 ELSE 2 END AS authority \n\
         FROM loop_items INNER JOIN (SELECT resource_members.resource_id AS project_id, \
         CAST(min(resource_members.entity_id) AS SIGNED INTEGER) AS workspace_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'workspace' \
         AND resource_members.status = 'approved' AND resource_members.resource_id = {project_id} \
         GROUP BY resource_members.resource_id \n\
         HAVING count(distinct(resource_members.entity_id)) = 1) AS anon_6 \
         ON anon_6.project_id = CAST(loop_items.id AS SIGNED INTEGER) INNER JOIN kinds ON kinds.id = anon_6.workspace_id \
         LEFT OUTER JOIN (SELECT resource_members.resource_id AS resource_id, \
         CASE resource_members.`role` WHEN 'Owner' THEN 'Maintainer' WHEN 'Reporter' THEN 'Viewer' \
         ELSE resource_members.`role` END AS `role` \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'Workspace' AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = '{user_id}' AND resource_members.status = 'approved' \
         AND resource_members.`role` IN ('Owner', 'Maintainer', 'Developer', 'Viewer', 'Reporter')) AS anon_5 \
         ON anon_5.resource_id = kinds.id \n\
         WHERE kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true \
         AND (kinds.user_id = {user_id} OR anon_5.`role` = 'Maintainer' OR anon_5.resource_id IS NOT NULL) \
         AND (kinds.user_id = {user_id} OR anon_5.`role` = 'Maintainer' OR \
         coalesce(CASE JSON_EXTRACT(loop_items.metadata, '$.\\\"membership_mode\\\"') WHEN 'null' THEN NULL \
         ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.\\\"membership_mode\\\"')) END, 'inherit') = 'inherit') \
         AND loop_items.id = '{project_id}' AND loop_items.resource_type IN ('project') UNION ALL \
         SELECT CAST(resource_members.resource_id AS BINARY) AS project_id, 4 AS priority, 3 AS authority \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'authenticated_users' \
         AND resource_members.entity_id = '*' AND resource_members.status = 'approved' \
         AND resource_members.`role` IN ('Viewer', 'Developer') \
         AND resource_members.resource_id = {project_id}) AS anon_4 GROUP BY anon_4.project_id) AS anon_3 \
         ON loop_items.id = anon_3.project_id INNER JOIN (SELECT resource_members.resource_id AS project_id, \
         CAST(min(resource_members.entity_id) AS SIGNED INTEGER) AS workspace_id \n\
         FROM resource_members \n\
         WHERE resource_members.resource_type = 'CloudProject' AND resource_members.entity_type = 'workspace' \
         AND resource_members.status = 'approved' AND resource_members.resource_id = {project_id} \
         GROUP BY resource_members.resource_id \n\
         HAVING count(distinct(resource_members.entity_id)) = 1) AS anon_7 \
         ON anon_7.project_id = CAST(loop_items.id AS SIGNED INTEGER) INNER JOIN kinds ON kinds.id = anon_7.workspace_id \n\
         WHERE loop_items.id = '{project_id}' AND loop_items.status = 'active' \
         AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true \
         AND (EXISTS (SELECT users.id \n\
         FROM users \n\
         WHERE users.id = {user_id} AND users.is_active IS true)) AND loop_items.resource_type IN ('project') \n LIMIT 1"
    )
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
