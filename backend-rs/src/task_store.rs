// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Deployment extension point for task and subtask row reads.
//!
//! The public store ([`DefaultTaskStore`]) reads the single `tasks` and
//! `subtasks` tables directly. An application whose deployment resolves task
//! storage differently registers its own [`TaskStore`] implementation through
//! `AppState::task_store` before route construction, the same way
//! `AppState::user_reader` selects the user lookup strategy.
//!
//! Methods return raw rows so each caller keeps its own typed projection; the
//! store owns which statement runs and which parameters it binds. Stores are
//! generic over the handle, so the application picks it and tests can drive the
//! store with a recording one.
use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult, MysqlRow};

use crate::tasks_search::statements::{
    owned_task_count_statement, owned_task_ids_statement, tasks_by_ids_statement,
};

/// How `list_subtasks_by_task` treats the batched subtask-context load that
/// follows the row read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextPolicy {
    /// Never load contexts with the rows.
    Never,
    /// Load contexts whenever the row read returned rows.
    WhenRowsExist,
    /// Load contexts only when the row read resolved a non-default table.
    OnlyWhenResolved,
}

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

/// `SqlAlchemyTaskStore.list_active_project_tasks`: the active project tasks
/// owned by `owner_user_id`, newest `updated_at` first, read from `table`.
///
/// The recorded rendering qualifies every column with the table name and binds
/// the project id and owner as integers; the optional origin binds as a string.
pub fn project_tasks_statement(table: &str, client_origin: bool) -> String {
    let mut sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active,
                created_at, updated_at, project_id, client_origin, is_group_chat
         FROM {table}
         WHERE project_id = ? AND kind = 'Task' AND is_active = 1 AND user_id = ?"
    );
    if client_origin {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" ORDER BY updated_at DESC");
    sql
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

/// The `subtask_contexts` labeling projection the context reads share
/// (`context_columns`): every column labelled with its own table name, in the
/// recorded order.
pub fn subtask_context_columns() -> String {
    [
        "id",
        "subtask_id",
        "user_id",
        "context_type",
        "name",
        "status",
        "error_message",
        "binary_data",
        "image_base64",
        "extracted_text",
        "text_length",
        "type_data",
        "created_at",
        "updated_at",
    ]
    .iter()
    .map(|column| format!("subtask_contexts.{column} AS subtask_contexts_{column}"))
    .collect::<Vec<_>>()
    .join(", ")
}

/// One subtask listing from `subtask_store.list_by_task_ordered`.
///
/// The source attaches the subtask contexts to a listing whose rows came from
/// a table the deployment resolved itself, so `contexts` carries that batch
/// there and is `None` on the path where the source leaves the contexts to be
/// loaded later. A caller that only reads the rows ignores it.
#[derive(Debug)]
pub struct SubtaskListing {
    pub rows: Vec<MysqlRow>,
    pub contexts: Option<Vec<MysqlRow>>,
}

/// One `task_store.list_owned_task_ids` page: the source total and the page's
/// task ids in the store's own order.
#[derive(Debug)]
pub struct OwnedTaskPage {
    pub total: i64,
    pub ids: Vec<i64>,
}

#[async_trait]
pub trait TaskStore: Send + Sync {
    /// `task_store.list_by_ids` for the running task ids reported by one
    /// device: `user_id` owns the tasks, `task_ids` are the reported ids. An
    /// empty `task_ids` issues no statement.
    async fn list_running_tasks(
        &self,
        user_id: i64,
        task_ids: &[i64],
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.get_active_task`: the task row for `task_id` when its kind
    /// is `Task` and it is active.
    async fn get_active_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `task_access_store._get_accessible_task`: the active task row the
    /// access store authorizes a viewer against. Unlike `get_active_task`,
    /// this read is not preceded by the store's legacy owner/migrated-copy
    /// probes: the access store reads the table the id's own encoding
    /// selects, so an id that the owner-probed read resolves to another
    /// table still reads the id's own table here.
    async fn get_accessible_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `task_access_store.get_runtime_state`: the viewer-authorized runtime
    /// checkpoint for `task_id`, or no row when the task is absent, inactive,
    /// JSON-deleted, or not visible to `user_id`.
    async fn get_runtime_state(&self, task_id: i64, user_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `_get_accessible_task`'s owner projection of an active task.
    async fn get_task_owner_id(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_task_ordered` with `order_by="id"` and the
    /// optional `message_ids` filter. `Some(empty)` issues no statement.
    async fn list_subtasks_ordered(
        &self,
        task_id: i64,
        message_ids: Option<&[i64]>,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.list_recent_owner_only_tasks`: the owner's own tasks that
    /// carry no approved member, one page at a time.
    async fn list_recent_owner_only_tasks(
        &self,
        user_id: i64,
        limit: i64,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `_batch_query_workspaces`: workspace rows by `(user_id, namespace,
    /// name)` reference. An empty ref list issues no statement.
    async fn list_workspaces_by_ref(
        &self,
        user_id: i64,
        refs: &[(String, String)],
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `list_personal_task_candidates_after`: one page of the owner's personal
    /// task candidates with the keyset cursor.
    async fn list_personal_task_candidates(
        &self,
        user_id: i64,
        limit: i64,
        cursor: Option<(chrono::NaiveDateTime, i64)>,
        client_origin: Option<&str>,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.list_owned_task_ids`: one page of the user's owned active
    /// non-system tasks, newest `(created_at, id)` first, plus the source
    /// total. The caller passes `limit + extra_limit` as `limit`; a sharded
    /// deployment merges the base and owner-shard tables.
    async fn list_owned_task_ids(
        &self,
        user_id: i64,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<OwnedTaskPage>;

    /// `task_store.list_by_ids`: the full task projection for `task_ids` with
    /// no owner filter. An empty `task_ids` issues no statement.
    async fn list_tasks_by_ids(&self, task_ids: &[i64]) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.get_workspace_by_ref`: the owner's workspace row for that
    /// reference, or no row when the deployment resolves none.
    async fn get_workspace_by_ref(
        &self,
        owner_user_id: i64,
        name: &str,
        namespace: &str,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `SubtaskStore.list_by_task_for_user_ordered`: the task's subtasks that
    /// belong to one user, ordered by `message_id`.
    async fn list_subtasks_for_user(
        &self,
        task_id: i64,
        user_id: i32,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.get_task_by_states` with `states = [STATE_ACTIVE]` and an
    /// explicit owner.
    async fn get_active_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i32,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.get_by_id`: one subtask's `(id, user_id, task_id)`.
    async fn get_subtask_ref(&self, subtask_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_user` (limit 1): the newest subtask of one user.
    async fn get_latest_subtask_ref_for_user(&self, user_id: i32) -> MysqlResult<Option<MysqlRow>>;

    /// `task_store.get_by_id`: one task's `(id, user_id, kind)`.
    async fn get_task_ref(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `TaskStore.get_by_id`: the full task projection.
    async fn get_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_by_task` (`query.all()`, no ordering): the task's
    /// subtasks.
    async fn list_subtasks_by_task(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.list_active_project_tasks`: the active tasks of one project
    /// owned by `owner_user_id`, newest `updated_at` first.
    async fn list_active_project_tasks(
        &self,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Vec<MysqlRow>>;

    /// `task_store.get_by_id` restricted to one owner: the full task
    /// projection of that owner's task.
    async fn get_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `subtask_store.list_ids_by_task`: the task's subtask ids.
    async fn list_subtask_ids_by_task(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>>;

    /// `subtask_store.list_by_task_ordered` with the source's default
    /// `order_by`: the task's subtasks ordered `message_id`, `created_at`,
    /// with the contexts the source attaches on the path that reads a table
    /// the deployment resolved itself.
    async fn list_subtasks_by_task_ordered(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<SubtaskListing>;

    /// `task_store.get_active_non_deleted_task`: the active task of one id,
    /// before the caller's `_is_json_deleted` filter.
    async fn get_active_task_by_id(
        &self,
        task_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>>;

    /// `_owner_matches_task_id`: whether `owner_user_id` owns the task, or is
    /// the only user its subtasks belong to.
    async fn task_owner_matches(&self, task_id: i64, owner_user_id: i64) -> MysqlResult<bool>;
}

/// The single-table store: every statement reads the base `tasks` /
/// `subtasks` tables on the handle it was built with.
pub struct DefaultTaskStore<M: Mysql> {
    pub(crate) mysql: M,
}

impl<M: Mysql> DefaultTaskStore<M> {
    pub fn new(mysql: M) -> Self {
        Self { mysql }
    }
}

#[async_trait]
impl<M: Mysql> TaskStore for DefaultTaskStore<M> {
    async fn list_running_tasks(
        &self,
        _user_id: i64,
        task_ids: &[i64],
    ) -> MysqlResult<Vec<MysqlRow>> {
        if task_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.mysql
            .fetch_all(
                running_tasks_by_ids_statement(TASKS_TABLE, task_ids.len()),
                task_ids.to_vec(),
            )
            .await
    }

    async fn get_active_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(active_task_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn get_accessible_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        // The single-table store has one table to resolve, so the access
        // store's read is the same statement as `get_active_task`.
        self.get_active_task(task_id).await
    }

    async fn get_runtime_state(&self, task_id: i64, user_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                runtime_state_statement(TASKS_TABLE),
                (task_id, user_id, task_id, user_id.to_string()),
            )
            .await
    }

    async fn get_task_owner_id(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(task_owner_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn list_subtasks_ordered(
        &self,
        task_id: i64,
        message_ids: Option<&[i64]>,
    ) -> MysqlResult<Vec<MysqlRow>> {
        if message_ids.is_some_and(|ids| ids.is_empty()) {
            return Ok(Vec::new());
        }
        self.mysql
            .fetch_all(
                subtasks_ordered_statement(SUBTASKS_TABLE, message_ids.unwrap_or_default()),
                (task_id,),
            )
            .await
    }

    async fn list_recent_owner_only_tasks(
        &self,
        user_id: i64,
        limit: i64,
    ) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(
                recent_owner_only_tasks_statement(TASKS_TABLE),
                (user_id, limit),
            )
            .await
    }

    async fn list_workspaces_by_ref(
        &self,
        user_id: i64,
        refs: &[(String, String)],
    ) -> MysqlResult<Vec<MysqlRow>> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        self.mysql
            .fetch_all(workspaces_by_ref_statement(TASKS_TABLE, user_id, refs), ())
            .await
    }

    async fn list_personal_task_candidates(
        &self,
        user_id: i64,
        limit: i64,
        cursor: Option<(chrono::NaiveDateTime, i64)>,
        client_origin: Option<&str>,
    ) -> MysqlResult<Vec<MysqlRow>> {
        // Argument order follows the predicate order: `user_id`, the optional
        // origin, the optional keyset (`created_at` twice, then `id`), `limit`.
        let mut args: Vec<StatementArg> = vec![StatementArg::Int(user_id)];
        if let Some(origin) = client_origin {
            args.push(StatementArg::Str(origin.to_string()));
        }
        if let Some((created_at, id)) = cursor {
            args.push(StatementArg::DateTime(created_at));
            args.push(StatementArg::DateTime(created_at));
            args.push(StatementArg::Int(id));
        }
        args.push(StatementArg::Int(limit));
        self.mysql
            .fetch_all(
                personal_task_candidates_statement(
                    TASKS_TABLE,
                    client_origin.is_some(),
                    cursor.is_some(),
                ),
                args,
            )
            .await
    }

    async fn list_owned_task_ids(
        &self,
        user_id: i64,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<OwnedTaskPage> {
        let totals = self
            .mysql
            .fetch_all(owned_task_count_statement(TASKS_TABLE), (user_id,))
            .await?;
        let total = totals
            .first()
            .map_or(Ok(0), |row: &MysqlRow| row.get_required::<i64>("count_1"))?;
        let rows = self
            .mysql
            .fetch_all(
                owned_task_ids_statement(TASKS_TABLE, skip > 0),
                (user_id, limit, skip),
            )
            .await?;
        let ids = rows
            .iter()
            .map(|row: &MysqlRow| row.get_required::<i64>("id"))
            .collect::<MysqlResult<Vec<_>>>()?;
        Ok(OwnedTaskPage { total, ids })
    }

    async fn list_tasks_by_ids(&self, task_ids: &[i64]) -> MysqlResult<Vec<MysqlRow>> {
        if task_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.mysql
            .fetch_all(
                tasks_by_ids_statement(TASKS_TABLE, task_ids.len()),
                task_ids.to_vec(),
            )
            .await
    }

    async fn get_workspace_by_ref(
        &self,
        owner_user_id: i64,
        name: &str,
        namespace: &str,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                workspace_by_ref_statement(TASKS_TABLE),
                (owner_user_id, name, namespace),
            )
            .await
    }

    async fn list_subtasks_for_user(
        &self,
        task_id: i64,
        user_id: i32,
    ) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(
                subtasks_by_owner_statement(SUBTASKS_TABLE),
                (task_id, user_id),
            )
            .await
    }

    async fn get_active_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i32,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                active_task_owned_statement(TASKS_TABLE),
                (task_id, owner_user_id),
            )
            .await
    }

    async fn get_subtask_ref(&self, subtask_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(subtask_ref_statement(SUBTASKS_TABLE), (subtask_id,))
            .await
    }

    async fn get_latest_subtask_ref_for_user(&self, user_id: i32) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(latest_subtask_ref_statement(SUBTASKS_TABLE), (user_id,))
            .await
    }

    async fn get_task_ref(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(task_ref_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn get_task(&self, task_id: i64) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(task_by_id_statement(TASKS_TABLE), (task_id,))
            .await
    }

    async fn list_subtasks_by_task(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(subtasks_by_task_statement(SUBTASKS_TABLE), (task_id,))
            .await
    }

    async fn list_active_project_tasks(
        &self,
        project_id: i64,
        owner_user_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Vec<MysqlRow>> {
        let sql = project_tasks_statement(TASKS_TABLE, client_origin.is_some());
        match client_origin {
            Some(origin) => {
                self.mysql
                    .fetch_all(sql, (project_id, owner_user_id, origin))
                    .await
            }
            None => self.mysql.fetch_all(sql, (project_id, owner_user_id)).await,
        }
    }

    async fn get_task_owned(
        &self,
        task_id: i64,
        owner_user_id: i64,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.mysql
            .fetch_optional(
                task_by_id_owned_statement(TASKS_TABLE),
                (task_id, owner_user_id),
            )
            .await
    }

    async fn list_subtask_ids_by_task(&self, task_id: i64) -> MysqlResult<Vec<MysqlRow>> {
        self.mysql
            .fetch_all(subtask_ids_by_task_statement(SUBTASKS_TABLE), (task_id,))
            .await
    }

    async fn list_subtasks_by_task_ordered(
        &self,
        task_id: i64,
        _owner_user_id: i64,
    ) -> MysqlResult<SubtaskListing> {
        let rows = self
            .mysql
            .fetch_all(
                subtasks_by_message_ordered_statement(SUBTASKS_TABLE),
                (task_id,),
            )
            .await?;
        // The open-source store leaves the contexts to its callers, as the
        // base store does.
        Ok(SubtaskListing {
            rows,
            contexts: None,
        })
    }

    async fn get_active_task_by_id(
        &self,
        task_id: i64,
        client_origin: Option<&str>,
    ) -> MysqlResult<Option<MysqlRow>> {
        let sql = active_task_by_id_statement(TASKS_TABLE, true, client_origin.is_some());
        match client_origin {
            Some(origin) => self.mysql.fetch_optional(sql, (task_id, origin)).await,
            None => self.mysql.fetch_optional(sql, (task_id,)).await,
        }
    }

    async fn task_owner_matches(&self, task_id: i64, owner_user_id: i64) -> MysqlResult<bool> {
        let row: Option<MysqlRow> = self
            .mysql
            .fetch_optional(
                owner_matches_task_id_statement(TASKS_TABLE),
                (task_id, owner_user_id),
            )
            .await?;
        if row.is_some() {
            return Ok(true);
        }
        let owners: Vec<MysqlRow> = self
            .mysql
            .fetch_all(
                distinct_subtask_owners_statement(SUBTASKS_TABLE),
                (task_id,),
            )
            .await?;
        if owners.len() != 1 {
            return Ok(false);
        }
        Ok(owners[0].get_required::<i64>("user_id")? == owner_user_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The store stays usable behind `Arc<dyn TaskStore>` for any handle.
    #[test]
    fn the_store_is_send_and_sync_for_any_handle() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<DefaultTaskStore<brz_mysql::MysqlService>>();
        assert_send_sync::<MysqlRow>();
    }

    /// The single-table store's access read resolves no other table, so it
    /// issues the same active-task statement as `get_active_task`.
    #[tokio::test]
    async fn the_single_table_store_reads_the_same_statement_for_both_active_reads() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let store = DefaultTaskStore::new(mysql.clone());
        assert!(store.get_active_task(7).await.unwrap().is_none());
        assert!(store.get_accessible_task(7).await.unwrap().is_none());
        let queries: Vec<String> = mysql.queries().into_iter().map(|query| query.sql).collect();
        assert_eq!(queries.len(), 2, "{queries:?}");
        assert_eq!(queries[0], queries[1]);
        assert!(queries[0].contains("FROM `tasks`"), "{queries:?}");
    }

    /// The recorded `get_runtime_state` rendering reads `status.updatedAt`
    /// through the cached `TaskResource.json["status"]` parent, so the second
    /// `CASE` repeats `$."status"` as its inner path in both the subject and the
    /// `JSON_UNQUOTE` branch. Extracting the top-level `updatedAt` instead
    /// returns SQL NULL for the status timestamp and silently falls back to the
    /// task row's second-precision `updated_at`.
    #[test]
    fn runtime_state_statement_reads_the_status_timestamp_through_the_status_object() {
        let sql = runtime_state_statement(TASKS_TABLE);
        assert_eq!(
            sql.matches(r#"JSON_EXTRACT(`tasks`.json, '$."status"'), '$."updatedAt"'"#)
                .count(),
            2,
            "{sql}"
        );
        assert!(!sql.contains(r#"`tasks`.json, '$."updatedAt"'"#), "{sql}");
    }
}
