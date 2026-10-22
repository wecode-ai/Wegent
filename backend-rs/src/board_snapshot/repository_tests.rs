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
/// no parameters. The source renders the unified permission union: the
/// direct, workspace-inherited, and public branches with the project id
/// pushed into each one, the parent workspace id column property, and the
/// caller-activity `EXISTS` guard. Creators are not implicit administrators.
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
    assert!(sql.contains("UNION ALL SELECT loop_items.id AS project_id"));
    assert!(!sql.contains("loop_items.created_by_user_id = 3060"));
    assert!(sql.contains("kinds.kind = 'CollaborationWorkspace' AND kinds.is_active IS true"));
    assert!(sql.contains(
        "resource_members.entity_type = 'authenticated_users' \
         AND resource_members.entity_id = '*'"
    ));
    assert!(sql.contains("anon_3.priority AS anon_3_priority"));
    assert!(sql.contains("GROUP BY anon_4.project_id"));
    assert!(sql.contains("EXISTS (SELECT users.id"));
    assert!(
        sql.contains(
            "WHERE loop_items.status = 'active' AND kinds.kind = 'CollaborationWorkspace'"
        )
    );
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
    assert_eq!(agent(json!({})).bot_config().visibility(), "creator_admin");
    assert_eq!(
        agent(json!({"visibility": "public"}))
            .bot_config()
            .visibility(),
        "public"
    );
    assert_eq!(
        agent(json!({"visibility": "weird"}))
            .bot_config()
            .visibility(),
        "creator_admin"
    );
    // `project_agent_visible` compares the raw value, so only `private`
    // restricts visibility.
    assert!(agent(json!({})).bot_config().not_private());
    assert!(
        !agent(json!({"visibility": "private"}))
            .bot_config()
            .not_private()
    );
    assert!(
        agent(json!({"visibility": "weird"}))
            .bot_config()
            .not_private()
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

/// `check` resolves `project_sources` after the role query: the parent
/// workspace row, the workspace membership for a non-owner, and the approved
/// direct project grant. The authenticated caller is already in the ORM
/// identity map, so their subject skips the `users` entity read.
#[tokio::test]
async fn record_project_sources_reads_the_parent_workspace_and_direct_grant() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    record_project_sources(&mysql, 4712514671486395195, 86, Some(353932), 86)
        .await
        .expect("source reads are captured");

    let queries = mysql.queries();
    assert_eq!(queries.len(), 2);
    assert_eq!(
        queries[0].sql,
        normalize(
            "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, \
             kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \n\
             FROM kinds \n\
             WHERE kinds.id = 353932",
        )
    );
    assert!(queries[1].sql.contains(
        "WHERE resource_members.resource_type = 'CloudProject' \
         AND resource_members.resource_id = 4712514671486395195 \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = '86' \
         AND resource_members.status = 'approved'"
    ));
    assert!(queries[1].sql.ends_with("LIMIT 1"));
}

/// A non-caller subject (the direct-human reviewer check) is read through
/// `db.get(User, user_id)` before the workspace role. The captured user row is
/// absent, so `workspace_role` returns before the parent kind and workspace
/// membership; the direct grant read remains.
#[tokio::test]
async fn record_project_sources_reads_a_non_caller_subject() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    record_project_sources(&mysql, 4712514671486395195, 52, Some(353932), 86)
        .await
        .expect("source reads are captured");

    let queries = mysql.queries();
    assert_eq!(queries.len(), 2);
    assert_eq!(
        queries[0].sql,
        normalize(
            "SELECT users.id, users.user_name, users.password_hash, users.email, \
             users.git_info, users.is_active, users.`role`, users.auth_source, \
             users.preferences, users.created_at, users.updated_at \n\
             FROM users \n\
             WHERE users.id = ?",
        )
    );
    assert_eq!(queries[0].args, 1);
    assert!(
        queries[1]
            .sql
            .contains("resource_members.resource_type = 'CloudProject'")
    );
}

/// `db.get(CloudProject, str(project_id))`: one unlabeled entity read with the
/// `workspace_id` column property, keyed by the inline string id.
#[tokio::test]
async fn project_entity_matches_the_recorded_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let entity = project_entity(&mysql, 4712514671486395195)
        .await
        .expect("project entity is captured");
    assert!(entity.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let sql = normalize(&queries[0].sql);
    assert!(
        sql.starts_with(
            "SELECT (SELECT CASE WHEN (count(distinct(resource_members.entity_id)) = 1)"
        )
    );
    assert!(sql.contains(
        "WHERE loop_items.id = '4712514671486395195' AND loop_items.resource_type IN ('project')"
    ));
    assert!(!sql.contains(" AS loop_items_"));
    assert!(!sql.ends_with("LIMIT 1"));
}

/// `require_project_agent`'s workspace `project_agent` grant: any status,
/// `LIMIT 1`, keyed by the agent id.
#[tokio::test]
async fn project_agent_grant_matches_the_recorded_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let grant = project_agent_grant(&mysql, 353932, "2029740299856048026")
        .await
        .expect("grant query is captured");
    assert!(grant.is_none());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let sql = normalize(&queries[0].sql);
    assert!(sql.contains(
        "WHERE resource_members.resource_type = 'Workspace' \
         AND resource_members.resource_id = 353932 \
         AND resource_members.entity_type = 'project_agent' \
         AND resource_members.entity_id = '2029740299856048026'"
    ));
    assert!(!sql.contains("resource_members.status = 'approved'"));
    assert!(sql.ends_with("LIMIT 1"));
}

/// `require_project_team`'s `Team` grant on the parent workspace.
#[tokio::test]
async fn team_grant_matches_the_recorded_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let grant = team_grant(&mysql, 2002909, 353932)
        .await
        .expect("team grant query is captured");
    assert!(grant.is_none());
    let sql = normalize(&mysql.queries()[0].sql);
    assert!(sql.contains(
        "WHERE resource_members.resource_type = 'Team' \
         AND resource_members.resource_id = 2002909 \
         AND resource_members.entity_type = 'workspace' \
         AND resource_members.entity_id = '353932'"
    ));
    assert!(sql.ends_with("LIMIT 1"));
}

/// The legacy-binding scan reads every active agent bound to the team with
/// the full labeled projection and no `LIMIT`.
#[tokio::test]
async fn team_bound_agents_matches_the_recorded_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let agents = team_bound_agents(&mysql, "8308220868516891581", 1769995)
        .await
        .expect("legacy binding query is captured");
    assert!(agents.is_empty());
    let sql = normalize(&mysql.queries()[0].sql);
    assert!(sql.contains(
        "CAST(CASE JSON_EXTRACT(loop_items.metadata, '$.\"wegent_team_id\"') \
         WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, \
         '$.\"wegent_team_id\"')) END AS SIGNED INTEGER) = 1769995"
    ));
    assert!(!sql.ends_with("LIMIT 1"));
}

/// `require_project_team(require_binding=True)`'s presence probe.
#[tokio::test]
async fn team_binding_exists_matches_the_recorded_query() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let exists = team_binding_exists(&mysql, "8308220868516891581", 1769995)
        .await
        .expect("binding probe is captured");
    assert!(!exists);
    let sql = normalize(&mysql.queries()[0].sql);
    assert!(sql.starts_with("SELECT loop_items.id AS loop_items_id"));
    assert!(sql.contains("CAST(CASE JSON_EXTRACT(loop_items.metadata"));
    assert!(sql.ends_with("LIMIT 1"));
}
