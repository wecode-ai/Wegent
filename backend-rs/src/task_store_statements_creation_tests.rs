use super::*;

#[test]
fn task_shell_insert_carries_the_recorded_columns() {
    // Recorded (`POST /api/v1/responses` create):
    // INSERT INTO tasks_0383 (id, user_id, kind, name, namespace, json,
    // is_active, created_at, updated_at, project_id, client_origin,
    // is_group_chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    let sharded = insert_task_shell_statement("tasks_0383", true);
    assert_eq!(
        sharded,
        "INSERT INTO tasks_0383 \
             (id, user_id, kind, name, namespace, json, is_active, created_at, \
             updated_at, project_id, client_origin, is_group_chat) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    // The open-source single-table store lets MySQL assign the id.
    let base = insert_task_shell_statement(TASKS_TABLE, false);
    assert_eq!(
        base,
        "INSERT INTO tasks \
             (user_id, kind, name, namespace, json, is_active, created_at, \
             updated_at, project_id, client_origin, is_group_chat) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
}

#[test]
fn task_name_and_json_update_targets_the_row_id() {
    // Recorded: UPDATE tasks_0383 SET name='task-...', json='...',
    // updated_at='...' WHERE tasks_0383.id = 897064049841442
    assert_eq!(
        update_task_name_and_json_statement("tasks_0383"),
        "UPDATE tasks_0383 SET name=?, json=?, updated_at=? \
             WHERE tasks_0383.id = ?"
    );
}

#[test]
fn subtask_insert_carries_the_recorded_columns() {
    // Recorded: INSERT INTO subtasks_0383 (id, user_id, task_id, team_id,
    // title, bot_ids, `role`, executor_namespace, executor_name,
    // executor_deleted_at, prompt, message_id, parent_id, status, progress,
    // result, error_message, created_at, updated_at, completed_at,
    // sender_type, sender_user_id, reply_to_subtask_id) VALUES (...)
    // with created_at/updated_at rendered as the SQL `now()` function.
    assert_eq!(
        insert_subtask_statement("subtasks_0383", true),
        "INSERT INTO subtasks_0383 \
             (id, user_id, task_id, team_id, title, bot_ids, `role`, \
             executor_namespace, executor_name, executor_deleted_at, prompt, \
             message_id, parent_id, status, progress, result, error_message, \
             created_at, updated_at, completed_at, sender_type, sender_user_id, \
             reply_to_subtask_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now(), \
             ?, ?, ?, ?)"
    );

    let base = insert_subtask_statement(SUBTASKS_TABLE, false);
    assert!(base.starts_with("INSERT INTO subtasks (user_id, task_id"));
    // 22 columns without the id, two of them the SQL `now()` default, so
    // 20 bound parameters (one fewer than the explicit-id variant).
    assert_eq!(base.matches('?').count(), 20);
    assert_eq!(
        insert_subtask_statement("subtasks_0383", true)
            .matches('?')
            .count(),
        21
    );
}

#[test]
fn max_message_id_matches_the_recorded_statement() {
    // Recorded: SELECT max(subtasks_0383.message_id) AS max_1
    // FROM subtasks_0383
    // WHERE subtasks_0383.task_id = 897064049841442
    assert_eq!(
        max_subtask_message_id_statement("subtasks_0383"),
        "SELECT max(subtasks_0383.message_id) AS max_1 \nFROM subtasks_0383 \
             \nWHERE subtasks_0383.task_id = ?"
    );
}
