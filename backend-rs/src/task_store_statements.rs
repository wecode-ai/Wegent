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

/// `task_store.list_recent_task_team_refs` (`recent_team_refs.py`): the owner's
/// recent non-group tasks carrying no approved member, projected to the two
/// JSON extracts SQLAlchemy labels `anon_1` (`metadata.labels.taskType`) and
/// `anon_2` (`spec.teamRef`), ordered `updated_at DESC, id DESC`, limited to one
/// page.
///
/// The source reads the base `tasks` table for this picker and selects only the
/// two extracts, so the projection keeps SQLAlchemy's unquoted `JSON_EXTRACT`
/// rendering (the extract's table and column are unquoted while each path
/// segment is double-quoted). Parameters bind in source order: the owner id,
/// then the page size.
pub fn recent_task_team_refs_statement(table: &str) -> String {
    format!(
        "SELECT JSON_EXTRACT({table}.json, '$.\"metadata\".\"labels\".\"taskType\"') AS anon_1, \
         JSON_EXTRACT({table}.json, '$.\"spec\".\"teamRef\"') AS anon_2 \nFROM {table} \n\
         WHERE {table}.kind = 'Task' AND {table}.user_id = ? AND {table}.is_active = 1 \
         AND {table}.is_group_chat IS false \
         AND NOT (EXISTS (SELECT * \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Task' \
         AND resource_members.resource_id = {table}.id \
         AND resource_members.status = 'approved')) \
         ORDER BY {table}.updated_at DESC, {table}.id DESC \n LIMIT ?"
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

/// `task_store.get_task_by_states` with `states =
/// TaskResource.is_active_query()` — `[STATE_ACTIVE, STATE_SUBSCRIPTION]`, so
/// active *and* subscription tasks — and no owner (the internal
/// workspace-archive endpoints' `_get_active_task`), read from `table`. The
/// caller passes no `user_id`/`owner_user_id`/`client_origin`, so the statement
/// carries `id`, `kind`, and the two-state `is_active` list alone.
pub fn active_task_no_owner_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \n    FROM `{table}` \n    \
        WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2) \n LIMIT 1"
    )
}

/// `SubtaskStore.get_latest_assistant_for_user_by_statuses`: the newest
/// assistant subtask of `task_id`/`user_id` whose status is one of `statuses`,
/// read from `table`. The status list is inlined in the caller's order, like
/// SQLAlchemy's `status.in_(...)` rendering.
pub fn latest_assistant_for_user_by_statuses_statement(table: &str, statuses: &[&str]) -> String {
    let list = statuses
        .iter()
        .map(|status| format!("'{status}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {SUBTASK_COLUMNS} \nFROM `{table}` \n\
         WHERE task_id = ? AND user_id = ? AND `role` = 'ASSISTANT' \
         AND status IN ({list}) \nORDER BY id DESC \n LIMIT 1"
    )
}

/// `subtask_store.update_fields` for the cancel flow: persist the terminal
/// status, progress, partial result, and timestamps on one subtask. The `SET`
/// column order matches the source model's mapped-column order.
pub fn update_subtask_completed_statement(table: &str) -> String {
    format!(
        "UPDATE {table} SET status=?, progress=?, result=?, updated_at=?, completed_at=? \
         WHERE {table}.id = ?"
    )
}

/// `db.refresh(subtask)`: re-read the whole subtask row by primary key, read
/// from `table`. The source session refresh emits the full mapped projection
/// without a limit.
pub fn subtask_by_id_refresh_statement(table: &str) -> String {
    format!("SELECT {SUBTASK_COLUMNS} \nFROM `{table}` \nWHERE {table}.id = ?")
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

/// `task_store.get_task_by_states` with `states = TaskResource.is_active_query()`
/// (`[STATE_ACTIVE, STATE_SUBSCRIPTION]`) and an explicit `user_id`, read from
/// `table` (`SharedTaskService.get_public_shared_task`). Unlike
/// [`active_task_owned_statement`], the state filter keeps both active states.
pub fn active_states_task_owned_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \n    FROM `{table}` \n    \
        WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2) AND user_id = ? \n    \
        LIMIT 1"
    )
}

/// `subtask_store.get_by_id`: the full subtask projection of one id, read from
/// `table`. The source resolves the row with `db.query(Subtask)`, so every
/// mapped column is selected (the same list as [`subtasks_by_task_statement`]);
/// `get_subtask_ref`'s decoder reads only `(id, user_id, task_id)`.
pub fn subtask_ref_statement(table: &str) -> String {
    format!("SELECT {SUBTASK_COLUMNS} \nFROM `{table}` \nWHERE id = ? \n LIMIT 1")
}

/// The `subtasks` columns in the ORM mapper's order
/// (`Subtask.__table__`), as [`subtask_by_id_statement`] labels them.
///
/// `role` is the only reserved word, so only its qualified form is
/// backticked; the alias uses the bare column name.
const SUBTASK_MAPPED_COLUMNS: [&str; 23] = [
    "id",
    "user_id",
    "task_id",
    "team_id",
    "title",
    "bot_ids",
    "role",
    "executor_namespace",
    "executor_name",
    "executor_deleted_at",
    "prompt",
    "message_id",
    "parent_id",
    "status",
    "progress",
    "result",
    "error_message",
    "created_at",
    "updated_at",
    "completed_at",
    "sender_type",
    "sender_user_id",
    "reply_to_subtask_id",
];

/// Zero-based position of `column` inside [`subtask_by_id_statement`]'s
/// projection, so a caller can decode a labeled row positionally without
/// knowing the resolved physical table name. `None` for a column the
/// projection does not select.
pub fn subtask_column_index(column: &str) -> Option<usize> {
    SUBTASK_MAPPED_COLUMNS
        .iter()
        .position(|name| *name == column)
}

/// `subtask_store.get_by_id` (`db.query(Subtask).filter(model.id == id)`): the
/// full subtask row of one id, read from `table`.
///
/// The source query loads the ORM entity, so every mapped column is selected
/// and labeled `{table}_{column}` in mapper order; `role` renders backticked
/// because it is a reserved word.
pub fn subtask_by_id_statement(table: &str) -> String {
    let projection = subtask_projection(table);
    format!("SELECT {projection} \nFROM {table} \nWHERE {table}.id = ? \n LIMIT 1")
}

/// `subtask_store.update_fields` for the message-content update: the single
/// flushed UPDATE that sets the one dirty content column (when present) and
/// `updated_at`, keyed by the primary key. `content_column` is `prompt` or
/// `result`; the mapper orders `prompt` before `result` before `updated_at`,
/// which the callers' single-column writes preserve.
pub fn subtask_content_update_statement(table: &str, content_column: Option<&str>) -> String {
    let mut sets = String::new();
    if let Some(column) = content_column {
        sets.push_str(column);
        sets.push_str("=?, ");
    }
    sets.push_str("updated_at=?");
    format!("UPDATE {table} SET {sets} WHERE {table}.id = ?")
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

/// `subtask_store.list_by_task` (`db.query(Subtask.id)`), read from `table`:
/// the ordered id page. `owner_filter` adds the non-member `user_id`
/// predicate; `before_message_id` adds the older-than bound; `from_latest`
/// selects the descending direction. The two page bounds bind last as the
/// source's `LIMIT <skip>, <limit>`.
pub fn subtask_ids_for_task_page_statement(
    table: &str,
    owner_filter: bool,
    before_message_id: bool,
    from_latest: bool,
) -> String {
    let mut sql = format!("SELECT id \nFROM {table} \nWHERE task_id = ?");
    if owner_filter {
        sql.push_str(" AND user_id = ?");
    }
    if before_message_id {
        sql.push_str(" AND message_id < ?");
    }
    let direction = if from_latest { "DESC" } else { "ASC" };
    sql.push_str(&format!(
        " ORDER BY message_id {direction}, created_at {direction} \n LIMIT ?, ?"
    ));
    sql
}

/// `subtask_store._load_ordered` / `_load_ordered_from_model`
/// (`db.query(Subtask).filter(Subtask.id.in_(subtask_ids))`), read from
/// `table`: the full subtask projection for `count` ids. The caller re-orders
/// the rows by its own id list, so no `ORDER BY` is emitted.
pub fn subtasks_by_ids_statement(table: &str, count: usize) -> String {
    let placeholders = vec!["?"; count].join(", ");
    format!("SELECT {SUBTASK_COLUMNS} \nFROM {table} \nWHERE id IN ({placeholders})")
}

/// `subtask_store.count_by_task_for_user` (`db.query(Subtask).filter(...).count()`),
/// read from `table`. SQLAlchemy renders `.count()` as `count(*)` over a
/// subquery carrying the full labeled projection, so the inner select keeps
/// the `{table}_{column}` labels and qualifies the `task_id`/`user_id`
/// predicate with the table. `owner_filter` adds the non-member `user_id`
/// predicate.
pub fn subtask_count_for_task_statement(table: &str, owner_filter: bool) -> String {
    let columns = SUBTASK_LABELED_COLUMNS.replace("{t}", table);
    let mut inner = format!("SELECT {columns} \nFROM {table} \nWHERE {table}.task_id = ?");
    if owner_filter {
        inner.push_str(&format!(" AND {table}.user_id = ?"));
    }
    format!("SELECT count(*) AS count_1 \nFROM ({inner}) AS anon_1")
}

/// The labeled `subtasks` projection SQLAlchemy renders for `db.query(Subtask)`
/// (the `count_by_task_for_user` subquery). `{t}` is replaced with the table
/// name; the `table_column` labels are what the source's own rendering uses.
const SUBTASK_LABELED_COLUMNS: &str = "{t}.id AS {t}_id, {t}.user_id AS {t}_user_id, \
    {t}.task_id AS {t}_task_id, {t}.team_id AS {t}_team_id, {t}.title AS {t}_title, \
    {t}.bot_ids AS {t}_bot_ids, {t}.`role` AS {t}_role, \
    {t}.executor_namespace AS {t}_executor_namespace, {t}.executor_name AS {t}_executor_name, \
    {t}.executor_deleted_at AS {t}_executor_deleted_at, {t}.prompt AS {t}_prompt, \
    {t}.message_id AS {t}_message_id, {t}.parent_id AS {t}_parent_id, {t}.status AS {t}_status, \
    {t}.progress AS {t}_progress, {t}.result AS {t}_result, {t}.error_message AS {t}_error_message, \
    {t}.created_at AS {t}_created_at, {t}.updated_at AS {t}_updated_at, \
    {t}.completed_at AS {t}_completed_at, {t}.sender_type AS {t}_sender_type, \
    {t}.sender_user_id AS {t}_sender_user_id, {t}.reply_to_subtask_id AS {t}_reply_to_subtask_id";

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

/// `subtask_store.list_by_task_ordered` with `exclude_deleted=True` and the
/// default `order_by` (`message_id`, `created_at`), read from `table`
/// (`SharedTaskService.get_public_shared_task`): the source adds the
/// `Subtask.status != DELETE` predicate before ordering.
pub fn non_deleted_subtasks_by_message_ordered_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, \
        executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, \
        created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id \n    \
        FROM {table} \n    \
        WHERE task_id = ? AND status != 'DELETE' \n    \
        ORDER BY message_id ASC, created_at ASC"
    )
}

/// The `subtasks` column projection every subtask statement selects.
pub(crate) const SUBTASK_COLUMNS: &str = "id, user_id, task_id, team_id, title, bot_ids, `role`, \
    executor_namespace, executor_name, executor_deleted_at, prompt, message_id, parent_id, \
    status, progress, result, error_message, created_at, updated_at, completed_at, \
    sender_type, sender_user_id, reply_to_subtask_id";

/// The owner-filtered predicate prefix the ORM renders: both `task_id`
/// references stay qualified (`{table}.task_id`), and the `IN` subquery
/// spans three lines.
fn qualified_task_predicate(table: &str) -> String {
    format!(
        "{table}.task_id = ? AND {table}.task_id IN (SELECT tasks.id \nFROM tasks \nWHERE tasks.user_id = ?)"
    )
}

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
    if owner_filter {
        // The base store's ORM query: labeled projection and qualified
        // predicates (`db.query(Subtask)`), compared token-exactly in Replay.
        return format!(
            "SELECT {projection} \nFROM {table} \nWHERE {predicate}",
            projection = subtask_projection(table),
            predicate = qualified_task_predicate(table)
        );
    }
    format!("SELECT {SUBTASK_COLUMNS} \nFROM {table} \nWHERE task_id = ?")
}

// Replay contract for the failed-assistant read below: `owner_filter` is set
// only on the legacy-id path. The task id there is a legacy id resolved by the
// sharded store through the base owner index and the migrated-copy probe, so
// the read targets the base `subtasks` table and adds the
// `task_id IN (SELECT tasks.id ...)` owner subquery. The nested SELECT
// disables Replay's projection pass, so the owner-filtered variant keeps the
// source ORM's token-exact rendering; the plain variant is matched through
// the projection pass and keeps the compact rendering.
/// `_queue_bulk_status_metrics`: the failed assistant subtasks of the task the
/// caller is about to mark deleted, read from `table`.
pub fn failed_assistant_subtasks_statement(table: &str, owner_filter: bool) -> String {
    if owner_filter {
        return format!(
            "SELECT {projection} \nFROM {table} \nWHERE {predicate} \
             AND {table}.`role` = 'ASSISTANT' AND {table}.status = 'FAILED'",
            projection = subtask_projection(table),
            predicate = qualified_task_predicate(table)
        );
    }
    let mut sql = format!("SELECT {SUBTASK_COLUMNS} \nFROM {table} \nWHERE task_id = ?");
    sql.push_str(" AND `role` = 'ASSISTANT' AND status = 'FAILED'");
    sql
}

/// `subtask_store.list_ids_by_task`: the task's subtask ids, read from `table`.
/// SQLAlchemy issues this read itself before a `synchronize_session='fetch'`
/// bulk update, so the caller repeats it ahead of the update.
pub fn subtask_ids_for_update_statement(table: &str, owner_filter: bool) -> String {
    if owner_filter {
        return format!(
            "SELECT {table}.id \nFROM {table} \nWHERE {predicate}",
            predicate = qualified_task_predicate(table)
        );
    }
    format!("SELECT id \nFROM {table} \nWHERE task_id = ?")
}

/// `subtask_store.mark_task_subtasks_deleted`: the bulk update that sets every
/// subtask of the task to `DELETE`.
pub fn mark_subtasks_deleted_statement(table: &str, owner_filter: bool) -> String {
    let mut sql = format!(
        "UPDATE {table} SET executor_deleted_at=?, status=?, updated_at=? WHERE {table}.task_id = ?"
    );
    if owner_filter {
        sql.push_str(&format!(
            " AND {table}.task_id IN (SELECT tasks.id \nFROM tasks \nWHERE tasks.user_id = ?)"
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

/// `SqlAlchemyTaskStore.create_pending_task_shell` / `create_workspace`: the
/// `tasks` row insert. With `with_id`, the deployment assigns the id before the
/// insert (the sharded store's user-scoped id); without
/// it the single-table store leaves the autoincrement id to MySQL.
///
/// Recorded (sharded): `INSERT INTO tasks_0383 (id, user_id, kind, name,
/// namespace, json, is_active, created_at, updated_at, project_id,
/// client_origin, is_group_chat) VALUES (?, ?, ..., ?)`.
pub fn insert_task_shell_statement(table: &str, with_id: bool) -> String {
    if with_id {
        format!(
            "INSERT INTO {table} (id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, client_origin, is_group_chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
    } else {
        format!(
            "INSERT INTO {table} (user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, client_origin, is_group_chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
    }
}

/// `task_store.update_fields(name=...)` followed by `update_json(payload)` on a
/// freshly created task: the single UPDATE SQLAlchemy flushes for the columns
/// that changed (`name`, `json`, `updated_at`).
///
/// Recorded: `UPDATE tasks_0383 SET name=?, json=?, updated_at=? WHERE
/// tasks_0383.id = ?`.
pub fn update_task_name_and_json_statement(table: &str) -> String {
    format!("UPDATE {table} SET name=?, json=?, updated_at=? WHERE {table}.id = ?")
}

/// `SqlAlchemySubtaskStore.create_user_and_assistant_subtasks`: the subtask row
/// insert. `created_at` / `updated_at` render the source model's SQL `now()`
/// defaults; every other column is bound.
///
/// Recorded: `INSERT INTO subtasks_0383 (id, user_id, task_id, team_id, title,
/// bot_ids, `role`, executor_namespace, executor_name, executor_deleted_at,
/// prompt, message_id, parent_id, status, progress, result, error_message,
/// created_at, updated_at, completed_at, sender_type, sender_user_id,
/// reply_to_subtask_id) VALUES (..., now(), now(), ...)`.
pub fn insert_subtask_statement(table: &str, with_id: bool) -> String {
    const COLUMNS: &str = "user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id";
    const VALUES: &str = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now(), ?, ?, ?, ?";
    if with_id {
        format!("INSERT INTO {table} (id, {COLUMNS}) VALUES (?, {VALUES})")
    } else {
        format!("INSERT INTO {table} ({COLUMNS}) VALUES ({VALUES})")
    }
}

/// `task_store` message-id continuation read: `SELECT max(subtasks.message_id)`
/// for one task, used to number the next pair of subtasks.
///
/// Recorded: `SELECT max(subtasks_0383.message_id) AS max_1 \nFROM
/// subtasks_0383 \nWHERE subtasks_0383.task_id = ?` (an empty table yields
/// `NULL`, which the caller maps to `next_message_id = 1`).
pub fn max_subtask_message_id_statement(table: &str) -> String {
    format!("SELECT max({table}.message_id) AS max_1 \nFROM {table} \nWHERE {table}.task_id = ?")
}

/// The `tasks` columns in the ORM mapper's order (`TaskResource.__table__`),
/// as the task projections select them.
pub const TASK_MAPPED_COLUMNS: [&str; 12] = [
    "id",
    "user_id",
    "kind",
    "name",
    "namespace",
    "json",
    "is_active",
    "created_at",
    "updated_at",
    "project_id",
    "client_origin",
    "is_group_chat",
];

/// Zero-based position of `column` inside a task projection, so a caller can
/// decode a row positionally: the recorded source query aliases every column
/// with the resolved physical table name, which a caller cannot know.
pub fn task_column_index(column: &str) -> Option<usize> {
    TASK_MAPPED_COLUMNS.iter().position(|name| *name == column)
}

/// The `tasks` projection of one table, with every mapped column labeled
/// `{table}_{column}` in mapper order — the ORM rendering SQLAlchemy emits for
/// `db.query(TaskResource)`.
pub fn task_projection(table: &str) -> String {
    TASK_MAPPED_COLUMNS
        .iter()
        .map(|column| format!("{table}.{column} AS {table}_{column}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The active, non-system `Task` row of one id, read from `table`, matching
/// `app/stores/tasks/sqlalchemy_task_store.py`.
///
/// `CollaborationStrategyFactory.get_strategy_for_task`
/// (`app/services/adapters/collaboration_strategy.py:418`) issues this read on
/// every terminal status update.
pub fn regular_active_task_statement(table: &str) -> String {
    format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \n\
         FROM `{table}` \n\
         WHERE id = ? AND kind = 'Task' AND namespace != 'system' AND is_active = 1 \n LIMIT 1"
    )
}

/// The completion flow emits [`owner_matches_task_id_statement`] before an
/// owner-scoped assistant-subtask listing.
///
/// The `subtasks` projection of one table, with every mapped column labeled
/// `{table}_{column}` in mapper order.
pub fn subtask_projection(table: &str) -> String {
    SUBTASK_MAPPED_COLUMNS
        .iter()
        .map(|column| {
            let qualified = if *column == "role" {
                format!("`{column}`")
            } else {
                (*column).to_owned()
            };
            format!("{table}.{qualified} AS {table}_{column}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `subtask_store.list_assistant_by_task`: the task's ASSISTANT subtasks in
/// message order, read from `table`.
pub fn assistant_subtasks_by_task_statement(table: &str) -> String {
    let projection = subtask_projection(table);
    format!(
        "SELECT {projection} \nFROM {table} \n\
         WHERE {table}.task_id = ? AND {table}.`role` = 'ASSISTANT' \n\
         ORDER BY {table}.message_id ASC"
    )
}

/// `subtask_store.update_fields(status=RUNNING)` (`execution/dispatcher.py:347`
/// → `chat/storage/db.py:199`): the status-only flush. SQLAlchemy's `onupdate`
/// also refreshes `updated_at`, which is why the recorded statement carries
/// both columns.
pub fn update_subtask_running_statement(table: &str) -> String {
    format!("UPDATE {table} SET status=?, updated_at=? WHERE {table}.id = ?")
}

/// `subtask_store.update_fields` flush for a terminal subtask update
/// (`app/services/chat/storage/db.py:199`): the mapped columns that changed,
/// in SQLAlchemy's mapper order — `executor_namespace`, `executor_name`,
/// `status`, `result`, `error_message`, `updated_at`, `completed_at`.
///
/// `with_executor` mirrors the source's "only save executor info when it is
/// provided and the row has none" branch; `with_error` mirrors the `FAILED`
/// branch that also writes `error_message`.
pub fn update_subtask_terminal_statement(
    table: &str,
    with_error: bool,
    with_executor: bool,
) -> String {
    let mut sets: Vec<&str> = Vec::new();
    if with_executor {
        sets.push("executor_namespace=?");
        sets.push("executor_name=?");
    }
    sets.push("status=?");
    sets.push("result=?");
    if with_error {
        sets.push("error_message=?");
    }
    sets.push("updated_at=?");
    sets.push("completed_at=?");
    format!(
        "UPDATE {table} SET {} WHERE {table}.id = ?",
        sets.join(", ")
    )
}

#[cfg(test)]
#[path = "task_store_statements_creation_tests.rs"]
mod task_creation_statement_tests;

#[cfg(test)]
#[path = "task_store_statements_group_tests.rs"]
mod group_list_statement_tests;
