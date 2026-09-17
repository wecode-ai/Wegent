// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task detail loading for the remote-workspace status endpoint.
//!
//! Mirrors the source call chain
//! `remote_workspace_service.get_status` -> `_get_task_detail` ->
//! `task_kinds_service.get_task_detail` -> `get_task_by_id`
//! (active non-deleted task + membership) plus the workspace-by-ref, team
//! resolution, user-cache reads, fork-lineage subtask/context, bot, and
//! group-chat member loads. The status endpoint consumes only the executor
//! bindings from the resolved subtasks, but the same call sequence produces
//! the recorded request-owned dependency traffic.
use brz_mysql::{Mysql, MysqlRow};
#[cfg(test)]
use serde_json::Value;

use super::app_state::AppState;
use crate::crd::{CrdDocument, CrdMember};
use crate::json_compat::JsonProjection;
use crate::remote_workspace_tree::kinds::KindStore;
use crate::task_routing::{ByTaskId, ByUserId};

const TASK_BY_OWNER_SQL: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE id = ? AND user_id = ? \
    LIMIT 1";
const WORKSPACE_BY_REF_SQL: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE user_id = ? AND kind = 'Workspace' AND name = ? AND namespace = ? AND is_active = 1 \
    LIMIT 1";
const SUBTASKS_BY_TASK_SQL: &str = "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, \
        executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, \
        created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id \
    FROM {{subtasks}} \
    WHERE task_id = ? \
    ORDER BY message_id ASC, created_at ASC";

/// Convert a [`crate::remote_workspace_tree::error::ApiError`] into an
/// `anyhow` error, preserving its message.
fn kind_error<E: std::fmt::Debug>(error: E) -> anyhow::Error {
    anyhow::anyhow!("{error:?}")
}

/// One `tasks`/`tasks_{:04}` row; only the owner and JSON payload are
/// consumed by the status flow, so only those columns are decoded.
#[derive(Debug)]
pub struct TaskRow {
    #[allow(dead_code)]
    pub id: i64,
    pub user_id: i64,
    pub json: JsonProjection<CrdDocument>,
}

/// The executor bindings plus task payload produced by the detail load.
pub struct TaskDetail {
    #[allow(dead_code)]
    pub task: TaskRow,
    pub subtasks: Vec<SubtaskRow>,
}

fn decode_task_row(row: &MysqlRow) -> brz_mysql::MysqlResult<TaskRow> {
    Ok(TaskRow {
        id: row.get_required("id")?,
        user_id: row.get_required("user_id")?,
        json: row
            .get_required::<brz_mysql::Json<JsonProjection<CrdDocument>>>("json")?
            .0,
    })
}

fn active_task_sql(task_id: i64, task_policy: crate::task_routing::TaskPolicy) -> String {
    let mut sql = String::from(
        "SELECT id, user_id, kind, name, namespace, json, is_active,
                created_at, updated_at, project_id, client_origin, is_group_chat
         FROM {{tasks}}
         WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)",
    );
    if !(task_policy.is_scoped_id)(task_id as u64) {
        sql.push_str(" AND JSON_EXTRACT(json, '$.status.status') != 'DELETE'");
    }
    sql.push_str(" LIMIT 1");
    sql
}

/// `ShardedTaskStore.get_active_non_deleted_task`: the ORM entity query on
/// the shard model for the task id, filtered to active states, with the
/// JSON `status.status != 'DELETE'` exclusion applied in the application.
/// Legacy ids query the base `tasks` table with the DELETE filter pushed
/// into SQL (the unsharded `SqlAlchemyTaskStore` render).
async fn get_active_non_deleted_task(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
) -> anyhow::Result<Option<TaskRow>> {
    let sql = active_task_sql(task_id, state.task_policy);
    let row: Option<MysqlRow> = state
        .mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(&sql, (task_id,))
        .await?;
    let task = row.as_ref().map(decode_task_row).transpose()?;
    Ok(task.filter(|task| {
        !task
            .json
            .value
            .as_ref()
            .is_some_and(CrdDocument::is_deleted)
    }))
}

/// `ShardedTaskStore._is_json_deleted`.
#[cfg(test)]
pub fn json_status_is_delete(payload: &Value) -> bool {
    crate::crd::json_status_is_delete(payload)
}

/// `SqlAlchemyTaskAccessStore._get_accessible_task`: the active-task query
/// behind `is_member` and `get_task_owner_id`.
async fn get_accessible_task_owner(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
) -> anyhow::Result<Option<i64>> {
    let row: Option<MysqlRow> = state
        .mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(
            "SELECT id, user_id \nFROM {{tasks}} \n\
             WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2) \n LIMIT 1",
            (task_id,),
        )
        .await?;
    Ok(row
        .as_ref()
        .and_then(|row| row.get_required::<i64>("user_id").ok()))
}

/// `ShardedTaskStore._migrated_legacy_task_model`: for a legacy id, resolve
/// the owner from the base `tasks` index (optionally owner-filtered), then
/// confirm the migrated copy exists on the owner's shard table. Returns
/// `true` when the migrated row exists.
async fn migrated_legacy_task_exists(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: Option<i64>,
) -> anyhow::Result<bool> {
    // `_legacy_task_owner_user_id`: base-table owner lookup.
    let owner = legacy_task_owner_user_id(state, task_id, owner_user_id).await?;
    let Some(owner) = owner else {
        return Ok(false);
    };
    // `db.query(model.id).filter(model.id == task_id).first()`.
    let exists: Option<MysqlRow> = state
        .mysql
        .route(ByUserId(owner as u64))
        .fetch_optional(
            "SELECT id \nFROM {{tasks}} \nWHERE id = ? \n LIMIT 1",
            (task_id,),
        )
        .await?;
    Ok(exists.is_some())
}

/// `ShardedSubtaskStore._subtask_model_for_task_lookup`: legacy ids resolve
/// the migrated subtask shard through the base-table owner, else the base
/// `subtasks` table. Returns the routing key for the subtask lookup.
async fn subtask_lookup_key(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: Option<i64>,
) -> anyhow::Result<SubtaskRoute> {
    if (state.task_policy.is_scoped_id)(task_id as u64)
        || !state.task_policy.resolve_migrated_legacy
    {
        return Ok(SubtaskRoute::ByTaskId);
    }
    let owner = legacy_task_owner_user_id(state, task_id, owner_user_id).await?;
    let Some(owner) = owner else {
        return Ok(SubtaskRoute::ByTaskId);
    };
    let exists: Option<MysqlRow> = state
        .mysql
        .route(ByUserId(owner as u64))
        .fetch_optional(
            "SELECT id \nFROM {{tasks}} \nWHERE id = ? \n LIMIT 1",
            (task_id,),
        )
        .await?;
    Ok(if exists.is_some() {
        SubtaskRoute::ByUserId(owner)
    } else {
        SubtaskRoute::ByTaskId
    })
}

/// Routing selector for a subtask lookup.
enum SubtaskRoute {
    ByTaskId,
    ByUserId(i64),
}

/// `ShardedTaskStore._legacy_task_owner_user_id` /
/// `ShardedSubtaskStore._legacy_task_owner_user_id`: the base-table owner
/// lookup with an optional owner filter.
async fn legacy_task_owner_user_id(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: Option<i64>,
) -> anyhow::Result<Option<i64>> {
    let mut sql = "SELECT user_id \nFROM {{tasks}} \n\
                   WHERE id = ?"
        .to_owned();
    if owner_user_id.is_some() {
        sql.push_str(" AND user_id = ?");
    }
    sql.push_str(" \n LIMIT 1");
    let row: Option<MysqlRow> = if let Some(owner_user_id) = owner_user_id {
        state
            .mysql
            .route(ByTaskId(task_id as u64))
            .fetch_optional(&sql, (task_id, owner_user_id))
            .await?
    } else {
        state
            .mysql
            .route(ByTaskId(task_id as u64))
            .fetch_optional(&sql, (task_id,))
            .await?
    };
    Ok(row
        .as_ref()
        .and_then(|row| row.get_required::<i64>("user_id").ok()))
}

/// `SqlAlchemyTaskAccessStore.is_member` member-row check (only reached
/// when the requesting user is not the task owner).
async fn is_approved_member(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    user_id: i64,
) -> anyhow::Result<bool> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct MemberId {
        #[allow(dead_code)]
        id: i64,
    }
    let row: Option<MemberId> = Mysql::fetch_optional(
        &state.mysql,
        "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Task' AND resource_members.resource_id = ? \
         AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? \
         AND resource_members.status = 'approved' AND resource_members.copied_resource_id = 0 \n\
         LIMIT 1",
        (task_id, user_id.to_string()),
    )
    .await?;
    Ok(row.is_some())
}

/// `task_store.get_by_id` with the owner filter (`_lineage_task` and the
/// requested-skills raw load).
async fn get_task_by_id_with_owner(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: i64,
) -> anyhow::Result<Option<TaskRow>> {
    let sql = TASK_BY_OWNER_SQL;
    let row: Option<MysqlRow> = state
        .mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(sql, (task_id, owner_user_id))
        .await?;
    Ok(row.as_ref().map(decode_task_row).transpose()?)
}

/// `task_store.get_workspace_by_ref` on the owner's shard table.
async fn get_workspace_by_ref(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    owner_user_id: i64,
    name: &str,
    namespace: &str,
) -> anyhow::Result<()> {
    // `task_model_for_user`: the physical table is selected from the owner
    // user id's slot (`user_id % SLOT_COUNT`), not from a task id.
    let sql = WORKSPACE_BY_REF_SQL;
    let row: Option<MysqlRow> = state
        .mysql
        .route(ByUserId(owner_user_id.unsigned_abs()))
        .fetch_optional(sql, (owner_user_id, name, namespace))
        .await?;
    let _ = row.as_ref().map(decode_task_row).transpose()?;
    Ok(())
}

/// One `subtasks_{:04}` row; only the bot ids and executor binding are
/// consumed.
#[derive(Debug)]
pub struct SubtaskRow {
    pub id: i64,
    pub bot_ids: JsonProjection<Vec<Option<i64>>>,
    pub executor_namespace: Option<String>,
    pub executor_name: Option<String>,
    pub executor_deleted_at: bool,
}

fn decode_subtask_row(row: &MysqlRow) -> brz_mysql::MysqlResult<SubtaskRow> {
    Ok(SubtaskRow {
        id: row.get_required("id")?,
        bot_ids: row
            .get_required::<brz_mysql::Json<JsonProjection<Vec<Option<i64>>>>>("bot_ids")?
            .0,
        executor_namespace: row.get("executor_namespace")?,
        executor_name: row.get("executor_name")?,
        executor_deleted_at: row.get_required("executor_deleted_at")?,
    })
}

/// `ShardedSubtaskStore._owner_matches_task_id` guard query: the task table
/// for the task id, then a subtask-owner fallback when the task row is
/// absent. Only reached for new-format task ids; `list_by_task_ordered`
/// skips the guard entirely for legacy ids.
async fn owner_matches_task_id(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: i64,
) -> anyhow::Result<bool> {
    // New-format ids route directly to their shard table; legacy ids use the
    // migrated-owner lookup (`_migrated_legacy_task_model`).
    let task_exists = if (state.task_policy.is_scoped_id)(task_id as u64)
        || !state.task_policy.resolve_migrated_legacy
    {
        let row: Option<MysqlRow> = state
            .mysql
            .route(ByTaskId(task_id as u64))
            .fetch_optional(
                "SELECT id \nFROM {{tasks}} \nWHERE id = ? AND user_id = ? \n LIMIT 1",
                (task_id, owner_user_id),
            )
            .await?;
        row.is_some()
    } else {
        migrated_legacy_task_exists(state, task_id, Some(owner_user_id)).await?
    };
    if task_exists {
        return Ok(true);
    }
    // `subtask_model_for_task_id` distinct-user fallback.
    let route = subtask_lookup_key(state, task_id, Some(owner_user_id)).await?;
    let users: Vec<MysqlRow> =
        match route {
            SubtaskRoute::ByTaskId => state
                .mysql
                .route(ByTaskId(task_id as u64))
                .fetch_all(
                    "SELECT DISTINCT user_id \nFROM {{subtasks}} \nWHERE task_id = ? \n LIMIT 2",
                    (task_id,),
                )
                .await?,
            SubtaskRoute::ByUserId(owner) => state
                .mysql
                .route(ByUserId(owner as u64))
                .fetch_all(
                    "SELECT DISTINCT user_id \nFROM {{subtasks}} \nWHERE task_id = ? \n LIMIT 2",
                    (task_id,),
                )
                .await?,
        };
    if users.len() != 1 {
        return Ok(false);
    }
    Ok(users[0]
        .get_required::<i64>("user_id")
        .map(|user_id| user_id == owner_user_id)
        .unwrap_or(false))
}

/// `ShardedSubtaskStore.list_by_task_ordered` plus `_attach_contexts`.
async fn list_subtasks_by_task(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: Option<i64>,
) -> anyhow::Result<Vec<SubtaskRow>> {
    let sql = SUBTASKS_BY_TASK_SQL;
    let route = subtask_lookup_key(state, task_id, owner_user_id).await?;
    let rows: Vec<MysqlRow> = match route {
        SubtaskRoute::ByTaskId => {
            state
                .mysql
                .route(ByTaskId(task_id as u64))
                .fetch_all(sql, (task_id,))
                .await?
        }
        SubtaskRoute::ByUserId(owner) => {
            state
                .mysql
                .route(ByUserId(owner as u64))
                .fetch_all(sql, (task_id,))
                .await?
        }
    };
    let subtasks = rows
        .iter()
        .map(decode_subtask_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
    if !subtasks.is_empty() {
        let ids = subtasks
            .iter()
            .map(|subtask| subtask.id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let _contexts: Vec<MysqlRow> = Mysql::fetch_all(
            &state.mysql,
            &format!(
                "SELECT subtask_contexts.id AS subtask_contexts_id, \
                 subtask_contexts.subtask_id AS subtask_contexts_subtask_id, \
                 subtask_contexts.user_id AS subtask_contexts_user_id, \
                 subtask_contexts.context_type AS subtask_contexts_context_type, \
                 subtask_contexts.name AS subtask_contexts_name, \
                 subtask_contexts.status AS subtask_contexts_status, \
                 subtask_contexts.error_message AS subtask_contexts_error_message, \
                 subtask_contexts.binary_data AS subtask_contexts_binary_data, \
                 subtask_contexts.image_base64 AS subtask_contexts_image_base64, \
                 subtask_contexts.extracted_text AS subtask_contexts_extracted_text, \
                 subtask_contexts.text_length AS subtask_contexts_text_length, \
                 subtask_contexts.type_data AS subtask_contexts_type_data, \
                 subtask_contexts.created_at AS subtask_contexts_created_at, \
                 subtask_contexts.updated_at AS subtask_contexts_updated_at \n\
                 FROM subtask_contexts \nWHERE subtask_contexts.subtask_id IN ({ids}) \
                 ORDER BY subtask_contexts.id ASC"
            ),
            (),
        )
        .await?;
    }
    Ok(subtasks)
}

/// `_get_bot_summary` (`team_kinds`): shell then model resolution through
/// the cached kind reader with the summary user's id (personal index first,
/// public fallback).
async fn bot_summary_lookups(
    kinds: &KindStore<'_, impl Mysql, impl brz_redis::Redis>,
    user_id: i64,
    shell: Option<(String, String)>,
    model: Option<(String, String)>,
) -> anyhow::Result<()> {
    if let Some((namespace, name)) = shell {
        kinds
            .get_by_name_and_namespace(user_id, "Shell", &namespace, &name)
            .await
            .map_err(kind_error)?;
    }
    if let Some((namespace, name)) = model {
        kinds
            .get_by_name_and_namespace(user_id, "Model", &namespace, &name)
            .await
            .map_err(kind_error)?;
    }
    Ok(())
}

/// Full task-detail load for `get_status`; produces the source dependency
/// call sequence and returns the task payload plus the resolved subtasks
/// (the executor bindings and bot ids the status flow consumes).
pub async fn load_task_detail(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    user_id: i64,
) -> anyhow::Result<TaskDetail> {
    // `get_task_by_id`: active non-deleted task, then `is_member`.
    let Some(task) = get_active_non_deleted_task(state, task_id).await? else {
        anyhow::bail!(TaskNotFound);
    };
    let accessible_owner = get_accessible_task_owner(state, task_id).await?;
    if accessible_owner.is_none() {
        anyhow::bail!(TaskNotFound);
    }
    if task.user_id != user_id && !is_approved_member(state, task_id, user_id).await? {
        anyhow::bail!(TaskNotFound);
    }

    // `convert_to_task_dict`: workspace-by-ref, then the task CRD's
    // teamRef (`resolve_task_ref_team`), then `userReader.get_by_id`.
    let spec = task.json.value.as_ref().and_then(|task| task.spec.as_ref());
    if let Some(workspace_ref) = spec.and_then(|spec| spec.workspace_ref.as_ref()) {
        let name = workspace_ref.name();
        let namespace = workspace_ref.namespace();
        get_workspace_by_ref(state, task.user_id, name, namespace).await?;
    }
    let team_ref = spec.and_then(|spec| spec.team_ref.as_ref());
    let mut resolved_team_id: Option<i64> = None;
    if let Some(team_ref) = team_ref
        && !team_ref.name().is_empty()
    {
        let name = team_ref.name();
        let namespace = team_ref.namespace();
        let kinds = KindStore {
            mysql: &state.mysql,
            redis: state.cache.kinds_cache(),
        };
        let team = match team_ref.user_id.as_ref() {
            Some(owner) if !owner.is_null() => kinds
                .get_team_by_owner(owner.json_integer().unwrap_or(0), namespace, name)
                .await
                .map_err(kind_error)?,
            _ if !team_ref.user_id.is_some()
                || team_ref.user_id.as_ref().is_some_and(|id| id.is_null()) =>
            {
                kinds
                    .get_by_name_and_namespace(user_id, "Team", namespace, name)
                    .await
                    .map_err(kind_error)?
            }
            _ => kinds
                .get_team_by_owner(0, namespace, name)
                .await
                .map_err(kind_error)?,
        };
        resolved_team_id = team.as_ref().map(|record| record.id);
    }
    // `convert_to_task_dict`'s `userReader.get_by_id` direct SQL lookup.
    super::users::cached_user_get_by_id(state, task.user_id).await?;

    // Requested-skills raw task load (`task_store.get_by_id` with the owner
    // filter), then `get_task_detail`'s own `userReader.get_by_id`.
    let _skills_task = get_task_by_id_with_owner(state, task_id, task.user_id).await?;
    super::users::cached_user_get_by_id(state, task.user_id).await?;

    // Team detail: `kindReader.get_by_id`, then `get_task_owner_id`, then
    // `_convert_to_team_dict` (member bots and the first bot's agent type).
    let kinds = KindStore {
        mysql: &state.mysql,
        redis: state.cache.kinds_cache(),
    };
    let mut team_members: Vec<CrdMember> = Vec::new();
    if let Some(team_id) = resolved_team_id
        && let Some(team) = kinds.get_by_id("Team", team_id).await.map_err(kind_error)?
    {
        team_members = CrdDocument::project(&team.json.0)
            .spec
            .and_then(|spec| spec.members)
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .collect();
    }
    let task_owner_id = get_accessible_task_owner(state, task_id).await?;
    if task_owner_id.is_some() && resolved_team_id.is_some() {
        // `_convert_to_team_dict`: `is_group_resource = team.namespace != 'default'`
        // — group teams resolve components by the bot's user id, personal teams
        // by the user id passed in (the task owner). The teamRef's own user_id
        // is only the lookup owner, not the group-resource test.
        let is_group_resource =
            team_ref.is_some_and(|reference| reference.namespace() != "default");
        let summary_user_id = |bot: &crate::remote_workspace_tree::kinds::KindRecord| {
            if is_group_resource {
                bot.user_id
            } else {
                task_owner_id.unwrap_or(0)
            }
        };
        let mut first_bot_id: Option<i64> = None;
        for member in &team_members {
            let Some(bot_ref) = member.bot_ref.as_ref() else {
                continue;
            };
            let name = bot_ref.name();
            let namespace = bot_ref.namespace();
            if name.is_empty() {
                continue;
            }
            // Member bot lookup with the team owner's user id (public team:
            // user_id = 0, so the personal index is skipped).
            let team_owner = team_ref
                .and_then(|reference| reference.user_id.as_ref())
                .and_then(|id| id.json_integer())
                .unwrap_or_default();
            let bot = kinds
                .get_by_name_and_namespace(team_owner, "Bot", namespace, name)
                .await
                .map_err(kind_error)?;
            let Some(bot) = bot else {
                continue;
            };
            if first_bot_id.is_none() {
                first_bot_id = Some(bot.id);
            }
            // `_get_bot_summary`: shell then model, resolved with the
            // summary user id (the task owner for non-group teams).
            let bot_crd = CrdDocument::project(&bot.json.0);
            let bot_spec = bot_crd.spec.as_ref();
            let shell = bot_spec
                .and_then(|spec| spec.shell_ref.as_ref())
                .and_then(|reference| reference.nonempty_parts())
                .map(|(name, namespace)| (namespace, name));
            let model = bot_spec
                .and_then(|spec| spec.model_ref.as_ref())
                .and_then(|reference| reference.nonempty_parts())
                .map(|(name, namespace)| (namespace, name));
            bot_summary_lookups(&kinds, summary_user_id(&bot), shell, model)
                .await
                .map_err(kind_error)?;
        }
        // First bot's agent-type lookup: `kindReader.get_by_id`, then the
        // shell resolved with the shell owner's user id (`shell_user_id =
        // first_bot.user_id if is_group_resource else user_id`).
        if let Some(first_bot_id) = first_bot_id
            && let Some(first_bot) = kinds
                .get_by_id("Bot", first_bot_id)
                .await
                .map_err(kind_error)?
        {
            let bot_crd = CrdDocument::project(&first_bot.json.0);
            let shell_user_id = summary_user_id(&first_bot);
            if let Some((name, namespace)) = bot_crd
                .spec
                .as_ref()
                .and_then(|spec| spec.shell_ref.as_ref())
                .and_then(|reference| reference.nonempty_parts())
            {
                kinds
                    .get_by_name_and_namespace(shell_user_id, "Shell", &namespace, &name)
                    .await
                    .map_err(kind_error)?;
            }
        }
    }

    // Fork lineage: `_lineage_task` (depth 0: get_by_id with the owner
    // filter), then `list_by_task_ordered` (owner match, subtasks,
    // contexts). Forked parents are not followed when the task has no
    // `fork` spec (the recorded case had none).
    let _lineage_task = get_task_by_id_with_owner(state, task_id, task.user_id).await?;
    let owner_id = task.user_id;
    let mut subtasks: Vec<SubtaskRow> = Vec::new();
    // `list_by_task_ordered` guards with `_owner_matches_task_id` only for
    // new-format ids (`if is_new_task_id(task_id) and not ...`); legacy ids
    // list subtasks directly through `_subtask_model_for_task_lookup`.
    if !state.task_policy.resolve_migrated_legacy
        || !(state.task_policy.is_scoped_id)(task_id as u64)
        || owner_matches_task_id(state, task_id, owner_id).await?
    {
        subtasks = list_subtasks_by_task(state, task_id, Some(owner_id)).await?;
    }

    // `get_bots_for_subtasks`: the subtasks' bot ids through the cached kind
    // reader, then each bot's model and shell refs (public lookups with the
    // bot owner's user id).
    //
    // `all_bot_ids = set()` with `all_bot_ids.update(subtask.bot_ids)` per
    // subtask in message order, then `list(all_bot_ids)`: the id order is
    // CPython `set[int]` slot order, which the kinds lane consumes in that
    // exact order (recording: 110592 then 110593 although the first subtask
    // references 110593). Reuse the faithful emulator the
    // remote-workspace-tree module already ships for the same source path.
    let mut bot_ids = crate::remote_workspace_tree::py_set_order::PySetOrder::new();
    for subtask in &subtasks {
        if let Some(ids) = subtask.bot_ids.value.as_ref() {
            for id in ids.iter().flatten() {
                bot_ids.add(*id);
            }
        }
    }
    let bot_ids = bot_ids.order();
    let bots = kinds
        .get_by_ids("Bot", &bot_ids)
        .await
        .map_err(kind_error)?;
    // `model_cache` / `shell_type_cache` in `get_bots_for_subtasks`: refs are
    // resolved once per `(user_id, namespace, name)` key, so a second bot
    // with the same refs issues no further lookups (recording: only one
    // model+shell pair after both bot data GETs).
    let mut resolved_refs: std::collections::HashSet<(i64, String, String)> =
        std::collections::HashSet::new();
    for bot in &bots {
        let bot_crd = CrdDocument::project(&bot.json.0);
        let bot_spec = bot_crd.spec.as_ref();
        if let Some((name, namespace)) = bot_spec
            .and_then(|spec| spec.model_ref.as_ref())
            .and_then(|reference| reference.nonempty_parts())
        {
            let key = (bot.user_id, namespace, name);
            if resolved_refs.insert(key.clone()) {
                kinds
                    .get_by_name_and_namespace(key.0, "Model", &key.1, &key.2)
                    .await
                    .map_err(kind_error)?;
            }
        }
        if let Some((name, namespace)) = bot_spec
            .and_then(|spec| spec.shell_ref.as_ref())
            .and_then(|reference| reference.nonempty_parts())
        {
            let key = (bot.user_id, namespace, name);
            if resolved_refs.insert(key.clone()) {
                kinds
                    .get_by_name_and_namespace(key.0, "Shell", &key.1, &key.2)
                    .await
                    .map_err(kind_error)?;
            }
        }
    }

    // `add_group_chat_info_to_task`: approved resource members.
    let _members: Vec<MysqlRow> = Mysql::fetch_all(
        &state.mysql,
        "SELECT resource_members.id AS resource_members_id, \
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
         resource_members.updated_at AS resource_members_updated_at \n\
         FROM resource_members \nWHERE resource_members.resource_type = 'Task' \
         AND resource_members.resource_id = ? AND resource_members.status = 'approved'",
        (task_id,),
    )
    .await
    .map_err(kind_error)?;

    Ok(TaskDetail { task, subtasks })
}

/// Sentinel payload for the source 404 `Task not found` mapping: returned
/// as an `anyhow` error carrying this object, which the handler detects.
#[derive(Debug)]
pub struct TaskNotFound;

impl std::fmt::Display for TaskNotFound {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Task not found")
    }
}

impl std::error::Error for TaskNotFound {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_status_detected_in_json() {
        assert!(json_status_is_delete(
            &serde_json::json!({"status": {"status": "DELETE"}})
        ));
        assert!(!json_status_is_delete(
            &serde_json::json!({"status": {"status": "RUNNING"}})
        ));
    }

    #[test]
    fn subtask_projection_includes_every_labeled_column() {
        let columns = SUBTASKS_BY_TASK_SQL;
        assert!(columns.starts_with("SELECT id, user_id, task_id, team_id, title, bot_ids"));
        assert!(columns.contains("`role`"));
        assert!(columns.contains("executor_deleted_at"));
        assert!(columns.contains("reply_to_subtask_id"));
    }

    #[test]
    fn bot_id_union_follows_cpython_set_order() {
        // `all_bot_ids = set()` updated per subtask in message order: the
        // recorded case inserts 110593 six times then 110592 twice, and the
        // source's `list(all_bot_ids)` renders 110592 first (recording
        // sequences 658/659) because CPython set slots order consecutive
        // small integers ascending.
        let mut bot_ids = crate::remote_workspace_tree::py_set_order::PySetOrder::new();
        for id in [
            110593, 110593, 110593, 110593, 110593, 110593, 110592, 110592,
        ] {
            bot_ids.add(id);
        }
        assert_eq!(bot_ids.order(), vec![110592, 110593]);
    }
}

#[cfg(test)]
mod sql_tests {
    use super::*;
    use crate::sql_test_support::assert_routed_sql;

    #[test]
    fn active_task_sql_retains_legacy_deletion_filter() {
        for task_id in [42, 700_000_000_001_i64] {
            let sql = active_task_sql(
                task_id,
                crate::task_routing::TaskPolicy {
                    is_scoped_id: |id| id != 42,
                    resolve_migrated_legacy: true,
                },
            );
            assert_routed_sql(&sql, 1);
            assert_eq!(sql.contains("JSON_EXTRACT"), task_id == 42);
            assert!(sql.contains("is_active IN (1, 2)"));
            assert!(sql.ends_with("LIMIT 1"));
        }
        for (sql, args) in [
            (TASK_BY_OWNER_SQL, 2),
            (WORKSPACE_BY_REF_SQL, 3),
            (SUBTASKS_BY_TASK_SQL, 1),
        ] {
            assert_routed_sql(sql, args);
        }
    }
}
