// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Table-parameterized task/subtask statements shared by the store
//! implementations and by the endpoints that render them directly.

/// The `tasks` table the single-table store reads.
pub const TASKS_TABLE: &str = "tasks";

/// `task_store.list_by_ids` (`db.query(TaskResource).filter(TaskResource.id.in_(task_ids))`):
/// the 12-column `tasks` projection read from `table`, with one `?` per id in
/// the source's textual order. The caller issues no statement at all for an
/// empty id list.
pub fn running_tasks_by_ids_statement(table: &str, task_ids: usize) -> String {
    let placeholders = vec!["?"; task_ids].join(", ");
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \nFROM `{table}` \nWHERE id IN ({placeholders})"
    )
}

/// `task_store.get_active_task`
/// (`db.query(TaskResource).filter(id == task_id, kind == 'Task', is_active.in_((1, 2))).first()`):
/// the 12-column `tasks` projection read from `table`.
pub fn active_task_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         \nFROM `{table}` \nWHERE id = ? \
         AND kind = 'Task' AND is_active IN (1, 2) \n LIMIT 1"
    )
}

/// `task_access_store.get_runtime_state` (`sqlalchemy_access_store.py`): the
/// authorized runtime checkpoint for one task, read from `table`.
///
/// The projection keeps SQLAlchemy's labels (the two JSON status projections
/// become `anon_1` / `anon_2`, the row timestamp keeps the task table's
/// `_updated_at` label) and inlines the owner/approved-member visibility
/// policy. Parameters bind in the source's literal order: the task id, the
/// viewer user id, the task id again for the membership probe, then the viewer
/// id as the membership record's text `entity_id`.
///
/// Both projections read `status.updatedAt` through the *same* rendered parent
/// value: SQLAlchemy reuses the cached SQL of `TaskResource.json["status"]` for
/// the inner `JSON_EXTRACT` of the second column, so the recorded statement
/// repeats `$."status"` as the inner path and uses `$."updatedAt"` only for the
/// outer one. Extracting the top-level `updatedAt` instead would drop the
/// status object's microsecond timestamp and fall back to the row timestamp.
pub fn runtime_state_statement(table: &str) -> String {
    format!(
        "SELECT \
        CASE JSON_EXTRACT(JSON_EXTRACT(`{table}`.json, '$.\"status\"'), '$.\"status\"') \
        WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(`{table}`.json, '$.\"status\"'), '$.\"status\"')) END AS anon_1, \
        CASE JSON_EXTRACT(JSON_EXTRACT(`{table}`.json, '$.\"status\"'), '$.\"updatedAt\"') \
        WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(`{table}`.json, '$.\"status\"'), '$.\"updatedAt\"')) END AS anon_2, \
        `{table}`.updated_at AS `{table}_updated_at` \
        FROM `{table}` \
        WHERE `{table}`.id = ? AND `{table}`.kind = 'Task' AND `{table}`.is_active IN (1, 2) \
        AND CASE JSON_EXTRACT(JSON_EXTRACT(`{table}`.json, '$.\"status\"'), '$.\"status\"') \
        WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(`{table}`.json, '$.\"status\"'), '$.\"status\"')) END != 'DELETE' \
        AND (`{table}`.user_id = ? OR (EXISTS (SELECT 1 \
        FROM resource_members \
        WHERE resource_members.resource_type = 'Task' AND resource_members.resource_id = ? \
        AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? \
        AND resource_members.status = 'approved' AND resource_members.copied_resource_id = 0))) \
        LIMIT 1"
    )
}

/// The `subtasks` table the single-table store reads.
pub const SUBTASKS_TABLE: &str = "subtasks";

/// `_get_accessible_task`'s owner projection of an active task, read from
/// `table`: the membership pre-check.
pub fn task_owner_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id \nFROM `{table}` \n\
         WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2) \n LIMIT 1"
    )
}

/// `subtask_store.list_by_task_ordered` with `order_by="id"` and the optional
/// `message_ids` filter, read from `table`. The ids are inlined as literals,
/// as the source's own rendering does.
pub fn subtasks_ordered_statement(table: &str, message_ids: &[i64]) -> String {
    let mut sql = format!(
        "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, \
         executor_namespace, executor_name, executor_deleted_at, prompt, \
         message_id, parent_id, status, progress, result, error_message, \
         created_at, updated_at, completed_at, sender_type, sender_user_id, \
         reply_to_subtask_id \
         FROM `{table}` \
         WHERE task_id = ?"
    );
    if !message_ids.is_empty() {
        let list = message_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" AND message_id IN ({list})"));
    }
    sql.push_str(" ORDER BY id ASC");
    sql
}

/// `task_store.list_recent_owner_only_tasks`: the owner's task table with the
/// approved-member exclusion, ordered `updated_at DESC, id DESC`, limited to
/// one page.
///
/// The labels keep the table's own name (`<table>_<column>`), as the source's
/// labeled rendering does, and every predicate is table-qualified.
pub fn recent_owner_only_tasks_statement(table: &str) -> String {
    format!(
        "SELECT `{table}`.id AS `{table}_id`, `{table}`.user_id AS `{table}_user_id`, \
         `{table}`.kind AS `{table}_kind`, `{table}`.name AS `{table}_name`, \
         `{table}`.namespace AS `{table}_namespace`, `{table}`.json AS `{table}_json`, \
         `{table}`.is_active AS `{table}_is_active`, \
         `{table}`.created_at AS `{table}_created_at`, \
         `{table}`.updated_at AS `{table}_updated_at`, \
         `{table}`.project_id AS `{table}_project_id`, \
         `{table}`.client_origin AS `{table}_client_origin`, \
         `{table}`.is_group_chat AS `{table}_is_group_chat` \nFROM `{table}` \n\
         WHERE `{table}`.user_id = ? AND `{table}`.kind = 'Task' \
         AND `{table}`.is_active = 1 AND `{table}`.is_group_chat IS false \
         AND NOT (EXISTS (SELECT * \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Task' \
         AND resource_members.resource_id = `{table}`.id \
         AND resource_members.status = 'approved')) \
         ORDER BY `{table}`.updated_at DESC, `{table}`.id DESC \n LIMIT ?"
    )
}

pub use crate::sql_support::StatementArg;
pub(crate) use crate::sql_support::quote_sql_literal;

/// `_batch_query_workspaces`: workspace rows by `(user_id, namespace, name)`
/// reference, read from `table`.
///
/// The source renders the tuples as inline literals in one text `COM_QUERY`
/// rather than as a prepared parameter list, so the values are inlined with
/// the same escaping.
pub fn workspaces_by_ref_statement(table: &str, user_id: i64, refs: &[(String, String)]) -> String {
    let conditions = refs
        .iter()
        .map(|(name, namespace)| {
            format!(
                "({user_id}, {}, {})",
                quote_sql_literal(namespace),
                quote_sql_literal(name)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
                created_at, updated_at, project_id, client_origin, is_group_chat \
         FROM `{table}` \
         WHERE kind = 'Workspace' AND is_active = 1 \
         AND (user_id, namespace, name) IN ({conditions})"
    )
}

/// `list_personal_task_candidates_after`: the owner's task table read from
/// `table`, ordered `created_at DESC, id DESC`, with the keyset cursor and the
/// optional client-origin filter. The predicate order matches the source.
pub fn personal_task_candidates_statement(
    table: &str,
    client_origin: bool,
    cursor: bool,
) -> String {
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, \
                updated_at, project_id, client_origin, is_group_chat \
         FROM `{table}` \
         WHERE user_id = ? AND kind = 'Task' AND is_active = 1 \
         AND namespace != 'system' AND is_group_chat = false"
    );
    if client_origin {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" AND project_id = 0");
    if cursor {
        sql.push_str(" AND (created_at < ? OR (created_at = ? AND id < ?))");
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");
    sql
}

/// `task_store.get_workspace_by_ref`: one workspace row by
/// `(owner, name, namespace)`, read from `table`.
pub fn workspace_by_ref_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \n    FROM `{table}` \n    \
        WHERE user_id = ? AND kind = 'Workspace' AND name = ? AND namespace = ? AND is_active = 1 \n    \
        LIMIT 1"
    )
}

/// `SubtaskStore.list_by_task_for_user_ordered`: the rows of `table` filtered
/// by `task_id` and `user_id`, ordered by `message_id`.
pub fn subtasks_by_owner_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, \
        executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, \
        created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id \n    \
        FROM `{table}` \n    \
        WHERE task_id = ? AND user_id = ? \n    \
        ORDER BY message_id ASC"
    )
}

/// `task_store.get_task_by_states` with `states = [STATE_ACTIVE]` and an
/// explicit owner, read from `table`.
pub fn active_task_owned_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \n    FROM `{table}` \n    \
        WHERE id = ? AND kind = 'Task' AND is_active IN (1) AND user_id = ? \n    \
        LIMIT 1"
    )
}

/// `subtask_store.get_by_id`: one subtask's ownership columns, read from
/// `table`.
pub fn subtask_ref_statement(table: &str) -> String {
    format!("SELECT id, user_id, task_id FROM `{table}` WHERE id = ? LIMIT 1")
}

/// `subtask_store.list_by_user` (limit 1): the newest subtask of one user,
/// read from `table`.
pub fn latest_subtask_ref_statement(table: &str) -> String {
    format!("SELECT id, user_id, task_id FROM `{table}` WHERE user_id = ? ORDER BY id DESC LIMIT 1")
}

/// `task_store.get_by_id`: one task's ownership columns, read from `table`.
pub fn task_ref_statement(table: &str) -> String {
    format!("SELECT id, user_id, kind FROM `{table}` WHERE id = ? LIMIT 1")
}

/// `task_store.get_by_id`: the full task projection, read from `table`.
pub fn task_by_id_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
                       created_at, updated_at, project_id, client_origin, is_group_chat \
                       \nFROM {table} \nWHERE id = ? \n LIMIT 1"
    )
}

/// `subtask_store.list_by_task` (`query.all()`, no ordering): the full subtask
/// projection, read from `table`.
pub fn subtasks_by_task_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, task_id, team_id, title, bot_ids, \
                       `role`, executor_namespace, executor_name, \
                       executor_deleted_at, prompt, message_id, \
                       parent_id, status, progress, result, \
                       error_message, created_at, updated_at, completed_at, \
                       sender_type, sender_user_id, reply_to_subtask_id \
                       \nFROM {table} \n\
                       WHERE task_id = ?"
    )
}

/// `task_store.get_by_id` restricted to one owner, read from `table`: the full
/// task projection of that owner's task.
pub fn task_by_id_owned_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
                       created_at, updated_at, project_id, client_origin, is_group_chat \
                       \nFROM {table} \nWHERE id = ? AND user_id = ? \n LIMIT 1"
    )
}

/// `task_store.get_active_non_deleted_task` on `table`: the active task of one
/// id. `json_delete_filter` adds the base store's `text()` JSON deletion
/// predicate, which the sharded store applies in Rust instead; `client_origin`
/// adds the endpoint's optional origin filter.
pub fn active_task_by_id_statement(
    table: &str,
    json_delete_filter: bool,
    client_origin: bool,
) -> String {
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active,
                created_at, updated_at, project_id, client_origin, is_group_chat
         FROM {table}
         WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)"
    );
    if json_delete_filter {
        sql.push_str(" AND JSON_EXTRACT(json, '$.status.status') != 'DELETE'");
    }
    if client_origin {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" LIMIT 1");
    sql
}

/// `ShardedSubtaskStore._owner_matches_task_id`'s task-table probe on `table`.
pub fn owner_matches_task_id_statement(table: &str) -> String {
    format!("SELECT id \nFROM {table} \nWHERE id = ? AND user_id = ? \n LIMIT 1")
}

/// `_owner_matches_task_id`'s subtask-owner fallback on `table`: the distinct
/// owners of the task's subtasks, capped at two so the caller can tell "one
/// owner" from "several".
pub fn distinct_subtask_owners_statement(table: &str) -> String {
    format!("SELECT DISTINCT user_id \nFROM {table} \nWHERE task_id = ? \n LIMIT 2")
}

/// `subtask_store.list_ids_by_task`: the task's subtask ids, read from
/// `table`.
pub fn subtask_ids_by_task_statement(table: &str) -> String {
    format!("SELECT id \nFROM {table} \nWHERE task_id = ?")
}

/// `subtask_store.list_by_task_ordered` with the source's default `order_by`,
/// read from `table`: ordered `message_id ASC, created_at ASC`.
pub fn subtasks_by_message_ordered_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, \
        executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, \
        created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id \n    \
        FROM {table} \n    \
        WHERE task_id = ? \n    \
        ORDER BY message_id ASC, created_at ASC"
    )
}

/// The `subtasks` column projection every subtask statement selects.
const SUBTASK_COLUMNS: &str = "id, user_id, task_id, team_id, title, bot_ids, `role`, \
    executor_namespace, executor_name, executor_deleted_at, prompt, message_id, parent_id, \
    status, progress, result, error_message, created_at, updated_at, completed_at, \
    sender_type, sender_user_id, reply_to_subtask_id";

/// The owner filter the base subtask store appends when an owner is supplied
/// (`_filter_owner_user_id`): the task id must belong to that owner's tasks.
const SUBTASK_OWNER_FILTER: &str =
    " AND task_id IN (SELECT tasks.id FROM tasks WHERE tasks.user_id = ?)";

/// `task_store.get_active_or_archived_task`
/// (`db.query(TaskResource).filter(id == task_id, kind == 'Task',
/// is_active.in_((1, 3)))`): the 12-column `tasks` projection read from
/// `table`. `client_origin` adds the source's optional origin filter.
pub fn active_or_archived_task_statement(table: &str, client_origin: bool) -> String {
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         \nFROM `{table}` \nWHERE id = ? \
         AND kind = 'Task' AND is_active IN (1, 3)"
    );
    if client_origin {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" \n LIMIT 1");
    sql
}

/// `_handle_member_leave`'s `task_store.get_active_task`: the same projection
/// as [`active_task_statement`] with the source's optional origin filter.
pub fn active_task_for_origin_statement(table: &str, client_origin: bool) -> String {
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         \nFROM `{table}` \nWHERE id = ? \
         AND kind = 'Task' AND is_active IN (1, 2)"
    );
    if client_origin {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" \n LIMIT 1");
    sql
}

/// `task_store.get_owned_active_task`: the active task of one owner, read from
/// `table`.
pub fn owned_active_task_statement(table: &str, client_origin: bool) -> String {
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         \nFROM `{table}` \nWHERE id = ? \
         AND kind = 'Task' AND is_active IN (1) AND user_id = ?"
    );
    if client_origin {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" \n LIMIT 1");
    sql
}

/// `subtask_store.list_by_task_unfiltered` (`query.all()`): the task's
/// subtasks read from `table`, with the owner filter the base store appends.
pub fn subtasks_by_task_unfiltered_statement(table: &str, owner_filter: bool) -> String {
    let mut sql = format!("SELECT {SUBTASK_COLUMNS} \nFROM {table} \nWHERE task_id = ?");
    if owner_filter {
        sql.push_str(SUBTASK_OWNER_FILTER);
    }
    sql
}

// Replay contract for the failed-assistant read below: `owner_filter` is set
// only on the legacy-id path. The task id there is a legacy id resolved by the
// sharded store through the base owner index and the migrated-copy probe, so
// the read targets the base `subtasks` table and adds the
// `task_id IN (SELECT tasks.id ...)` owner subquery. Replay matches this
// statement by semantic SQL comparison, not by literal text.
/// `_queue_bulk_status_metrics`: the failed assistant subtasks of the task the
/// caller is about to mark deleted, read from `table`.
pub fn failed_assistant_subtasks_statement(table: &str, owner_filter: bool) -> String {
    let mut sql = format!("SELECT {SUBTASK_COLUMNS} \nFROM {table} \nWHERE task_id = ?");
    if owner_filter {
        sql.push_str(SUBTASK_OWNER_FILTER);
    }
    sql.push_str(" AND `role` = 'ASSISTANT' AND status = 'FAILED'");
    sql
}

/// `subtask_store.list_ids_by_task`: the task's subtask ids, read from `table`.
/// SQLAlchemy issues this read itself before a `synchronize_session='fetch'`
/// bulk update, so the caller repeats it ahead of the update.
pub fn subtask_ids_for_update_statement(table: &str, owner_filter: bool) -> String {
    let mut sql = format!("SELECT id \nFROM {table} \nWHERE task_id = ?");
    if owner_filter {
        sql.push_str(SUBTASK_OWNER_FILTER);
    }
    sql
}

/// `subtask_store.mark_task_subtasks_deleted`: the bulk update that sets every
/// subtask of the task to `DELETE`.
pub fn mark_subtasks_deleted_statement(table: &str, owner_filter: bool) -> String {
    let mut sql = format!(
        "UPDATE {table} SET executor_deleted_at=?, status=?, updated_at=? WHERE {table}.task_id = ?"
    );
    if owner_filter {
        sql.push_str(&format!(
            " AND {table}.task_id IN (SELECT tasks.id FROM tasks WHERE tasks.user_id = ?)"
        ));
    }
    sql
}

/// `task_store.soft_delete_task`: rewrite the task's json and clear its active
/// flag.
pub fn soft_delete_task_statement(table: &str) -> String {
    format!("UPDATE {table} SET json=?, is_active=?, updated_at=? WHERE {table}.id = ?")
}

/// `task_store.update_json`: rewrite the task's json after an update.
pub fn update_task_json_statement(table: &str) -> String {
    format!("UPDATE {table} SET json=?, updated_at=? WHERE {table}.id = ?")
}

/// The JSON deletion predicate the store appends to a task read
/// (`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')), '') != 'DELETE'`).
pub const TASK_JSON_NOT_DELETED: &str =
    "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')), '') != 'DELETE'";

/// `SqlAlchemyTaskStore.list_group_task_ids_for_accessible_user`'s owned half
/// (`_OWNED_GROUP_CHAT_SQL`): the ids of the owner's active non-system
/// group-chat tasks, read from `table`.
pub fn owned_group_chat_ids_statement(table: &str) -> String {
    format!(
        "SELECT id \nFROM {table} \nWHERE kind = 'Task' \
         AND is_active = ? \nAND namespace != 'system' \nAND user_id = ? \nAND is_group_chat = 1"
    )
}

/// `SqlAlchemyTaskStore.list_group_task_ids_for_accessible_user`'s member half
/// (`_MEMBER_TASK_IDS_SQL`): the ids of the approved-member tasks of one user,
/// read from `table`. The membership `entity_id` is the user id as text.
pub fn member_task_ids_statement(table: &str) -> String {
    format!(
        "SELECT {table}.id \nFROM resource_members tm \nJOIN {table} ON {table}.id = tm.resource_id \
         \nWHERE tm.resource_type = 'Task' \nAND tm.entity_type = 'user' \nAND tm.entity_id = ? \
         \nAND tm.status = 'approved' \nAND tm.copied_resource_id = 0 \nAND {table}.kind = 'Task' \
         \nAND {table}.is_active = ? \nAND {table}.namespace != 'system'"
    )
}

/// `ShardedTaskStore._owned_active_task_query` with the group-chat list
/// filters (`exclude_system_namespace=True`, `is_group_chat=True`): the full
/// 12-column projection of one table.
pub fn owned_active_group_chat_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         \nFROM `{table}` \nWHERE user_id = ? AND kind = 'Task' AND is_active = 1 \
         AND namespace != 'system' AND is_group_chat = true"
    )
}

/// `ShardedTaskStore._member_task_ids`: the approved-member task ids of one
/// user. Unlike the single-table store's join, this reads `resource_members`
/// alone and resolves the task rows separately. The membership `entity_id` is
/// the user id as a quoted string literal, matching the source's rendering.
///
/// The projection keeps the source's `AS resource_members_resource_id` label:
/// the replay projection derives the result column name from this statement's
/// own label, so the column must be labelled the way the decoder reads it.
pub fn member_task_ids_only_statement(entity_id: i64) -> String {
    format!(
        "SELECT resource_members.resource_id AS resource_members_resource_id \
         \nFROM resource_members \nWHERE \
         resource_members.resource_type = 'Task' AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id = '{entity_id}' AND resource_members.status = 'approved' \
         AND resource_members.copied_resource_id = 0"
    )
}

/// `task_store.count_non_deleted_by_ids`: how many of `count` ids are not
/// JSON-deleted, read from `table`.
pub fn count_non_deleted_tasks_statement(table: &str, count: usize) -> String {
    let placeholders = vec!["?"; count].join(", ");
    format!(
        "SELECT count(*) AS count_1 \nFROM {table} \nWHERE {table}.id IN ({placeholders}) \
         \nAND {TASK_JSON_NOT_DELETED}"
    )
}

/// `task_store.list_by_ids_ordered`: the full projection of `count` ids, in
/// the source's order, with the optional `DELETE` exclusion and page bounds.
/// `order_field` is one of `id` / `created_at` / `updated_at` (validated by
/// the caller).
pub fn tasks_by_ids_ordered_statement(
    table: &str,
    count: usize,
    order_field: &str,
    descending: bool,
    exclude_deleted: bool,
    with_offset: bool,
) -> String {
    let placeholders = vec!["?"; count].join(", ");
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         \nFROM {table} \nWHERE {table}.id IN ({placeholders})"
    );
    if exclude_deleted {
        sql.push_str(&format!(" \nAND {TASK_JSON_NOT_DELETED}"));
    }
    sql.push_str(&format!(
        " ORDER BY {order_field} {}",
        if descending { "DESC" } else { "ASC" }
    ));
    sql.push_str(" \n LIMIT ?");
    if with_offset {
        sql.push_str(" OFFSET ?");
    }
    sql
}

#[cfg(test)]
mod group_list_statement_tests {
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
}
