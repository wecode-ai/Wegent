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
use super::subtask_history::{SubtaskRow, list_subtask_history};
use crate::crd::CrdDocument;
use crate::json_compat::{JsonNull, JsonProjection, OpaqueJson};
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
pub(super) async fn migrated_legacy_task_exists(
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

/// `ShardedTaskStore._model_for_task_id_lookup` and
/// `ShardedSubtaskStore._subtask_model_for_task_lookup`: a new-format id
/// carries its own shard, so it routes by task id; a legacy id resolves the
/// migrated owner's shard through the base-table owner lookup and the
/// shard-row existence probe, and otherwise stays on the base table. Returns
/// the routing key the `tasks`/`subtasks` lookup must bind.
pub(super) async fn task_lookup_route(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: Option<i64>,
) -> anyhow::Result<TaskRoute> {
    if (state.task_policy.is_scoped_id)(task_id as u64)
        || !state.task_policy.resolve_migrated_legacy
    {
        return Ok(TaskRoute::ByTaskId);
    }
    let owner = legacy_task_owner_user_id(state, task_id, owner_user_id).await?;
    let Some(owner) = owner else {
        return Ok(TaskRoute::ByTaskId);
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
        TaskRoute::ByUserId(owner)
    } else {
        TaskRoute::ByTaskId
    })
}

/// Routing selector for a `tasks`/`subtasks` lookup by task id.
pub(super) enum TaskRoute {
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
/// requested-skills raw load). `SqlAlchemyTaskStore.get_by_id` resolves the
/// physical table through `_model_for_task_id_lookup`, so a legacy id whose
/// owner shard holds the migrated row reads the shard table, not the base
/// `tasks` table.
async fn get_task_by_id_with_owner(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    owner_user_id: i64,
) -> anyhow::Result<Option<TaskRow>> {
    let sql = TASK_BY_OWNER_SQL;
    let row: Option<MysqlRow> = match task_lookup_route(state, task_id, Some(owner_user_id)).await?
    {
        TaskRoute::ByTaskId => {
            state
                .mysql
                .route(ByTaskId(task_id as u64))
                .fetch_optional(sql, (task_id, owner_user_id))
                .await?
        }
        TaskRoute::ByUserId(owner) => {
            state
                .mysql
                .route(ByUserId(owner as u64))
                .fetch_optional(sql, (task_id, owner_user_id))
                .await?
        }
    };
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

/// Full task-detail load for `get_status`; produces the source dependency
/// call sequence and returns the task payload plus the resolved subtasks
/// (the executor bindings and bot ids the status flow consumes).
pub async fn load_task_detail(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    user_id: i64,
) -> anyhow::Result<TaskDetail> {
    // `get_task_by_id`: active non-deleted task, then `is_member`.
    let Some(mut task) = get_active_non_deleted_task(state, task_id).await? else {
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

    // Team detail: `kindReader.get_by_id`, then `should_redact_team_for_user`
    // and `_convert_to_team_dict` (member bots and the first bot's agent
    // type). The conversion is shared with the tree flow: it resolves each
    // member bot with the resolved Team row's own owner (`team.user_id`) and
    // group-resource test (`team.namespace`), never with the task CRD's
    // teamRef, whose `user_id` is only the lookup owner.
    let kinds = KindStore {
        mysql: &state.mysql,
        redis: state.cache.kinds_cache(),
    };
    let team_record = match resolved_team_id {
        Some(team_id) => kinds.get_by_id("Team", team_id).await.map_err(kind_error)?,
        None => None,
    };
    if let Some(team) = team_record.as_ref() {
        // `should_redact_team_for_user` runs BEFORE `_convert_to_team_dict`
        // (`get_task_detail`); the status response discards the outcome, but
        // the membership resolution traffic is request-owned.
        crate::teams::group_membership::should_redact_team_for_user(
            &state.mysql,
            &crate::teams::group_membership::ErpContext {
                erp: state.erp.as_ref(),
                redis: state.cache.kinds_cache(),
            },
            user_id,
            team.id,
            team.user_id,
            &team.namespace,
        )
        .await
        .map_err(crate::remote_workspace_tree::error::database_query_failed)
        .map_err(kind_error)?;
    }
    let task_owner_id = get_accessible_task_owner(state, task_id).await?;
    if let (Some(owner_id), Some(team)) = (task_owner_id, team_record.as_ref()) {
        crate::remote_workspace_tree::kind_refs::convert_team_dict(&kinds, team, owner_id)
            .await
            .map_err(kind_error)?;
    }

    // Fork lineage: `_lineage_task` (depth 0: get_by_id with the owner
    // filter), then `resolve_for_task` (owner guard, subtasks, contexts, and
    // the 100-item fork-history window). Forked parents are not followed when
    // the task has no `fork` spec (the recorded case had none).
    let _lineage_task = get_task_by_id_with_owner(state, task_id, task.user_id).await?;
    let owner_id = task.user_id;
    let mut subtasks = list_subtask_history(state, task_id, owner_id).await?;

    // `get_bots_for_subtasks`: the subtasks' bot ids through the cached kind
    // reader, then each bot's model and shell refs (public lookups with the
    // bot owner's user id).
    //
    // `all_bot_ids = set()` with `all_bot_ids.update(subtask.bot_ids)` per
    // subtask in the fork-history window, then `list(all_bot_ids)`: the id
    // order is CPython `set[int]` slot order, which the kinds lane consumes in
    // that exact order (recording: 110592 first because the oldest subtasks
    // referenced 110593 and fell outside the window). Reuse the faithful
    // emulator the remote-workspace-tree module already ships for the same
    // source path.
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

    // `refresh_extended_video_result_urls`: the registered video integration
    // re-signs the temporary playback URLs of the task-level result and of
    // every subtask result, in that order. The status response discards the
    // rewritten payloads, but the signing calls are request-owned.
    refresh_video_result_urls(state, &mut task, &mut subtasks).await?;

    Ok(TaskDetail { task, subtasks })
}

/// `refresh_extended_video_result_urls` (`get_task_detail`'s last dependency
/// step): `refresh_result_urls` walks `task_dict["result"]` first and then
/// every `subtask["result"]`, so the extension receives the task-level
/// `status.result` followed by the subtask rows' `result` documents in
/// subtask order.
///
/// The source's `refresh_task_image_download_urls` only rebuilds attachment
/// download URLs from the rows it already holds (no dependency call), so it
/// is not observable here.
///
/// An error from the integration is the source's uncaught refresh failure
/// (the source's `try` covers only the signing call itself, after
/// `_media_uid()`), which fails the request.
async fn refresh_video_result_urls(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task: &mut TaskRow,
    subtasks: &mut [SubtaskRow],
) -> anyhow::Result<()> {
    let payloads = video_refresh_payloads(task, subtasks);
    let mut results: Vec<_> = payloads.iter().map(OpaqueJson::to_raw_value).collect();
    let mut results: Vec<&mut _> = results.iter_mut().collect();
    state
        .video_refresh
        .extension
        .refresh_result_urls(&state.video_refresh.client, &mut results)
        .await
}

/// `_video_blocks`' inputs (`convert_to_task_dict`'s `result` and
/// `convert_subtasks_to_dict`'s per-subtask `result`): the task-level
/// `status.result` document first, then every subtask `result` document in
/// subtask order. A document the row does not carry is JSON `null`, which
/// contributes no video block.
///
/// The documents are moved out of the rows: the refresh rewrites copies
/// whose result the status response discards, and nothing reads a result
/// again after this step.
fn video_refresh_payloads(task: &mut TaskRow, subtasks: &mut [SubtaskRow]) -> Vec<OpaqueJson> {
    let mut payloads = Vec::with_capacity(subtasks.len() + 1);
    payloads.push(
        task.json
            .value
            .as_mut()
            .and_then(|task| task.status.as_mut())
            .and_then(|status| status.result.take())
            .unwrap_or_else(|| OpaqueJson::from_serializable(JsonNull)),
    );
    for subtask in subtasks {
        payloads.push(
            subtask
                .result
                .take()
                .unwrap_or_else(|| OpaqueJson::from_serializable(JsonNull)),
        );
    }
    payloads
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

    fn task_with_result(result: Value) -> TaskRow {
        TaskRow {
            id: 1,
            user_id: 7,
            json: JsonProjection::from(serde_json::json!({"status": {"result": result}})),
        }
    }

    fn subtask_with_result(result: Option<Value>) -> SubtaskRow {
        SubtaskRow {
            id: 11,
            message_id: 1,
            created_at: chrono::NaiveDateTime::default(),
            bot_ids: JsonProjection {
                value: Some(Vec::new()),
            },
            result: result.map(OpaqueJson::from),
            executor_namespace: None,
            executor_name: None,
            executor_deleted_at: false,
        }
    }

    #[test]
    fn video_refresh_payloads_follow_task_then_subtask_order() {
        // `_video_blocks` walks `task["result"]["blocks"]` first and then every
        // `task["subtasks"][i]["result"]["blocks"]`, so the signing request
        // sees the task-level URL before the subtask URLs.
        let mut task = task_with_result(serde_json::json!({
            "blocks": [{"type": "video", "media_id": "1", "video_url": "http://a"}]
        }));
        let mut subtasks = vec![
            subtask_with_result(Some(serde_json::json!({
                "blocks": [{"type": "video", "media_id": "2", "video_url": "http://b"}]
            }))),
            subtask_with_result(None),
            subtask_with_result(Some(serde_json::json!({"blocks": []}))),
        ];
        let payloads: Vec<Value> = video_refresh_payloads(&mut task, &mut subtasks)
            .iter()
            .map(OpaqueJson::to_value)
            .collect();
        assert_eq!(
            payloads,
            vec![
                serde_json::json!({
                    "blocks": [{"type": "video", "media_id": "1", "video_url": "http://a"}]
                }),
                serde_json::json!({
                    "blocks": [{"type": "video", "media_id": "2", "video_url": "http://b"}]
                }),
                Value::Null,
                serde_json::json!({"blocks": []}),
            ]
        );
    }

    #[test]
    fn video_refresh_payloads_keep_a_missing_task_result_as_null() {
        let mut task = TaskRow {
            id: 1,
            user_id: 7,
            json: JsonProjection::from(serde_json::json!({"spec": {}})),
        };
        let payloads: Vec<Value> = video_refresh_payloads(&mut task, &mut [])
            .iter()
            .map(OpaqueJson::to_value)
            .collect();
        assert_eq!(payloads, vec![Value::Null]);
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
        for (sql, args) in [(TASK_BY_OWNER_SQL, 2), (WORKSPACE_BY_REF_SQL, 3)] {
            assert_routed_sql(sql, args);
        }
    }
}
