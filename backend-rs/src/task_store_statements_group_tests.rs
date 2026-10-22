use super::*;

#[test]
fn single_table_owned_group_chat_ids_match_the_source_sql() {
    let sql = owned_group_chat_ids_statement("tasks");
    // `_OWNED_GROUP_CHAT_SQL`: id-only, predicate order preserved.
    assert!(sql.starts_with("SELECT id"));
    assert!(sql.contains("FROM tasks"));
    assert!(sql.contains("is_active = ?"));
    assert!(sql.contains("is_group_chat = 1"));
    assert!(sql.contains("namespace != 'system'"));
}

#[test]
fn single_table_member_ids_join_the_task_table() {
    let sql = member_task_ids_statement("tasks");
    // `_MEMBER_TASK_IDS_SQL`: the membership join plus the task filters.
    assert!(sql.contains("FROM resource_members tm"));
    assert!(sql.contains("JOIN tasks ON tasks.id = tm.resource_id"));
    assert!(sql.contains("tm.entity_id = ?"));
    assert!(sql.contains("tm.copied_resource_id = 0"));
}

#[test]
fn sharded_member_ids_inline_the_owner_as_a_string_literal() {
    // `ShardedTaskStore._member_task_ids`: no join, and the recorded
    // exchange renders `entity_id = '157'` inline.
    let sql = member_task_ids_only_statement(157);
    assert!(sql.contains("entity_id = '157'"));
    assert!(!sql.contains('?'));
    assert!(!sql.contains("JOIN"));
}

#[test]
fn sharded_member_ids_label_the_id_the_decoder_reads() {
    // `member_task_ids` decodes `resource_members_resource_id`; the replay
    // projection relabels the column from this statement's own label, so
    // the unaliased `resource_members.resource_id` would decode to
    // `resource_id` and fail.
    let sql = member_task_ids_only_statement(157);
    assert!(sql.contains("resource_members.resource_id AS resource_members_resource_id"));
}

#[test]
fn sharded_owned_group_chat_reads_the_full_projection() {
    let sql = owned_active_group_chat_statement("tasks_0157");
    // `_owned_active_task_query`: full 12-column projection and a single
    // `user_id` bind.
    assert!(sql.contains("SELECT id, user_id, kind, name, namespace, json, is_active"));
    assert!(sql.contains("FROM `tasks_0157`"));
    assert!(sql.contains("AND is_group_chat = true"));
}

#[test]
fn ordered_page_renders_delete_filter_and_bounds() {
    let sql = tasks_by_ids_ordered_statement("tasks", 2, "updated_at", true, true, true);
    assert!(sql.contains("id IN (?, ?)"));
    assert!(sql.contains(TASK_JSON_NOT_DELETED));
    assert!(sql.contains("ORDER BY updated_at DESC"));
    assert!(sql.trim_end().ends_with("LIMIT ? OFFSET ?"));
    let no_offset = tasks_by_ids_ordered_statement("tasks", 1, "id", false, false, false);
    assert!(no_offset.contains("ORDER BY id ASC"));
    assert!(!no_offset.contains("OFFSET"));
    assert!(!no_offset.contains("DELETE"));
}

#[test]
fn subtask_id_page_matches_the_recorded_member_render() {
    // Non-member, no `before_message_id`, `from_latest=false`: the
    // recorded `GET /api/subtasks` shape.
    let sql = subtask_ids_for_task_page_statement("subtasks_0086", true, false, false);
    assert_eq!(
        sql,
        "SELECT id \nFROM subtasks_0086 \nWHERE task_id = ? AND user_id = ? \
             ORDER BY message_id ASC, created_at ASC \n LIMIT ?, ?"
    );
    assert_eq!(sql.matches('?').count(), 4);
}

#[test]
fn subtask_id_page_preserves_predicate_and_direction_order() {
    let sql = subtask_ids_for_task_page_statement("subtasks", false, true, true);
    assert!(sql.contains("WHERE task_id = ? AND message_id < ?"));
    assert!(!sql.contains("user_id = ?"));
    assert!(sql.contains("ORDER BY message_id DESC, created_at DESC"));
}

#[test]
fn subtask_count_wraps_the_labeled_projection() {
    let sql = subtask_count_for_task_statement("subtasks_0086", true);
    assert!(sql.starts_with(
        "SELECT count(*) AS count_1 \nFROM (SELECT subtasks_0086.id AS subtasks_0086_id"
    ));
    assert!(sql.contains("subtasks_0086.`role` AS subtasks_0086_role"));
    assert!(
        sql.ends_with("WHERE subtasks_0086.task_id = ? AND subtasks_0086.user_id = ?) AS anon_1")
    );
    let member = subtask_count_for_task_statement("subtasks", false);
    assert!(member.ends_with("WHERE subtasks.task_id = ?) AS anon_1"));
}

#[test]
fn subtask_load_inlines_the_id_list() {
    let sql = subtasks_by_ids_statement("subtasks_0086", 3);
    assert!(sql.starts_with("SELECT id, user_id, task_id, team_id, title, bot_ids, `role`"));
    assert!(sql.contains("WHERE id IN (?, ?, ?)"));
    assert!(!sql.contains("ORDER BY"));
}
