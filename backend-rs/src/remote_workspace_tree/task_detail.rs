// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task detail loading for the remote-workspace tree endpoint.
//!
//! Mirrors the source call chain used by
//! `remote_workspace_service.list_tree` ->
//! `task_kinds_service.get_task_detail` -> `get_task_by_id`
//! (active non-deleted task + membership) plus the workspace-by-ref, team,
//! fork-lineage subtask/context, and group-chat member loads. The tree
//! endpoint consumes only the access-control outcome (404/409), but the
//! same call sequence produces the recorded dependency traffic.
use brz_mysql::{FromMysqlRow, Json};
use brz_redis::Redis;
#[cfg(test)]
use serde_json::Value;

use super::error::{ApiError, database_query_failed as internal_mysql};
use super::kind_refs::{SummaryCaches, convert_team_dict, get_bot_summary_for_subtask};
use super::kinds::KindStore;
use super::user_cache;
use crate::crd::{CrdDocument, reference_parts};
use crate::json_compat::{JsonProjection, OpaqueJson};
use crate::py_set_order::SetOrder;

/// `add_group_chat_info_to_task` (`task_detail_helpers`): the approved
/// `resource_members` read for the task, in source filter order
/// `ResourceType.TASK`, `resource_id`, `MemberStatus.APPROVED`, and
/// `copied_resource_id == 0`. Share recipients keep a row with a nonzero
/// `copied_resource_id`, so the trailing condition belongs to the query.
const GROUP_CHAT_MEMBERS_SQL: &str = "SELECT resource_members.id AS resource_members_id, \
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
        resource_members.updated_at AS resource_members_updated_at \
    FROM resource_members \
    WHERE resource_members.resource_type = 'Task' \
    AND resource_members.resource_id = ? \
    AND resource_members.status = 'approved' \
    AND resource_members.copied_resource_id = 0";

/// `task_fork_history.resolve_for_task`'s `limit` at the
/// `get_task_detail` call site: the fork-history window the source builds
/// `all_bot_ids` and the returned subtask list from.
const FORK_HISTORY_LIMIT: usize = 100;

/// One `tasks`/`tasks_{:04}` row projection used by the detail flow. The
/// column list mirrors the source SQLAlchemy `TaskResource` labeled query so
/// the prepared statement matches the recorded exchange for replay. Rows are
/// decoded through [`decode_task_row`] using unqualified column names.
#[derive(Debug)]
pub(crate) struct TaskRow {
    #[allow(dead_code)]
    id: i64,
    pub(crate) user_id: i64,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    namespace: String,
    json: Json<JsonProjection<CrdDocument>>,
    #[allow(dead_code)]
    is_active: i64,
    #[allow(dead_code)]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code)]
    updated_at: chrono::NaiveDateTime,
    #[allow(dead_code)]
    project_id: Option<i64>,
    #[allow(dead_code)]
    client_origin: Option<String>,
    #[allow(dead_code)]
    is_group_chat: bool,
}

/// Decode one row of the task projection (unqualified column names).
fn decode_task_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<TaskRow> {
    Ok(TaskRow {
        id: row.get_required("id")?,
        user_id: row.get_required("user_id")?,
        kind: row.get_required("kind")?,
        name: row.get_required("name")?,
        namespace: row.get_required("namespace")?,
        json: row.get_required("json")?,
        is_active: row.get_required("is_active")?,
        created_at: row.get_required("created_at")?,
        updated_at: row.get_required("updated_at")?,
        project_id: row.get("project_id")?,
        client_origin: row.get("client_origin")?,
        is_group_chat: row.get_required("is_group_chat")?,
    })
}

#[derive(Debug, FromMysqlRow)]
struct MemberIdRow {
    #[mysql(rename = "resource_members_id")]
    #[allow(dead_code)]
    id: i64,
}

/// One `resource_members` row from the group-chat membership load. The
/// projection mirrors the source SQLAlchemy labeled query.
#[derive(Debug, FromMysqlRow)]
struct MembersRow {
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_id")]
    id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_resource_type")]
    resource_type: String,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_resource_id")]
    resource_id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_entity_type")]
    entity_type: String,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_entity_id")]
    entity_id: String,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_entity_display_name")]
    entity_display_name: Option<String>,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_user_id")]
    user_id: i32,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_role")]
    role: String,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_status")]
    status: String,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_invited_by_user_id")]
    invited_by_user_id: Option<i32>,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_share_link_id")]
    share_link_id: Option<i32>,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_reviewed_by_user_id")]
    reviewed_by_user_id: Option<i32>,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_reviewed_at")]
    reviewed_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_copied_resource_id")]
    copied_resource_id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_requested_at")]
    requested_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_created_at")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code)]
    #[mysql(rename = "resource_members_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// One `subtasks_{:04}` row. The column list mirrors the source SQLAlchemy
/// `SubtaskResource` labeled query so the prepared statement matches the
/// recorded exchange for replay. Rows are decoded through
/// [`decode_subtask_row`] because the alias prefix depends on the physical
/// shard table.
#[derive(Debug)]
pub(crate) struct SubtaskRow {
    #[allow(dead_code)]
    id: i64,
    #[allow(dead_code)]
    user_id: i32,
    #[allow(dead_code)]
    task_id: i64,
    #[allow(dead_code)]
    team_id: i32,
    #[allow(dead_code)]
    title: String,
    #[allow(dead_code)]
    bot_ids: Json<JsonProjection<Vec<Option<i64>>>>,
    #[allow(dead_code)]
    role: String,
    pub(crate) executor_namespace: String,
    pub(crate) executor_name: String,
    pub(crate) executor_deleted_at: i8,
    #[allow(dead_code)]
    prompt: String,
    #[allow(dead_code)]
    message_id: i32,
    #[allow(dead_code)]
    parent_id: i64,
    #[allow(dead_code)]
    status: String,
    #[allow(dead_code)]
    progress: i32,
    #[allow(dead_code)]
    result: Json<OpaqueJson>,
    #[allow(dead_code)]
    error_message: Option<String>,
    #[allow(dead_code)]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code)]
    updated_at: chrono::NaiveDateTime,
    #[allow(dead_code)]
    completed_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    sender_type: String,
    #[allow(dead_code)]
    sender_user_id: i32,
    #[allow(dead_code)]
    reply_to_subtask_id: i64,
}

fn not_found() -> ApiError {
    ApiError::not_found("Task not found")
}

/// `task_store.get_by_id(db, task_id=..., owner_user_id=...)`: the sharded
/// store resolves the physical task table first (the legacy owner and
/// migrated-copy probes), then loads the owned row from it.
async fn load_task_by_owner(
    task_store: &dyn crate::task_store::TaskStore,
    task_id: u64,
    owner_user_id: i64,
) -> Result<Option<brz_mysql::MysqlRow>, ApiError> {
    task_store
        .get_task_owned(task_id as i64, owner_user_id)
        .await
        .map_err(internal_mysql)
}

/// `resolve_task_ref_team`'s selector for the task CRD's `teamRef`: a
/// non-null `user_id` (including 0) returns the owner id the direct `kinds`
/// query filters by, and an absent or JSON `null` one returns `None` for the
/// reader's `_get_team` resolution.
fn team_ref_owner_id(reference: &crate::crd::ResourceReference) -> Option<i64> {
    match reference.user_id.as_ref() {
        Some(owner) if !owner.is_null() => Some(owner.json_integer().unwrap_or(0)),
        _ => None,
    }
}

/// Full task-detail load. Returns the loaded task row (owner user id and
/// JSON payload) plus its subtask rows so callers can resolve the workspace
/// ref and executor bindings, and produces the source dependency-call
/// sequence.
pub(crate) struct TaskDetail {
    #[allow(dead_code)]
    pub(crate) task: TaskRow,
    pub(crate) subtasks: Vec<SubtaskRow>,
}

/// The request's clients and the deployed reader state are injected
/// explicitly, like the sibling dependency-carrying loaders.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn load_task_detail<M, R: Redis>(
    mysql: &M,
    redis: Option<&R>,
    task_store: &dyn crate::task_store::TaskStore,
    erp: &crate::teams::group_membership::ErpContext<'_, R>,
    kinds: &KindStore<'_, M, R>,
    resolvers: Option<&crate::permissions::EntityResolvers<R>>,
    video_refresh: &crate::remote_workspace_status::app_state::VideoRefresh,
    task_id: u64,
    user_id: i64,
) -> Result<TaskDetail, ApiError>
where
    M: brz_mysql::Mysql,
{
    // 1. `get_active_non_deleted_task`: kind Task, is_active IN (1, 2). A
    //    legacy id pushes the JSON DELETE check into the base-table render;
    //    a shard read applies it after the row load.
    let task_row: Option<brz_mysql::MysqlRow> = task_store
        .get_active_task_by_id(task_id as i64, None)
        .await
        .map_err(internal_mysql)?;
    let task = task_row
        .as_ref()
        .map(decode_task_row)
        .transpose()
        .map_err(internal_mysql)?;
    let Some(mut task) = task.filter(|task| {
        !task
            .json
            .0
            .value
            .as_ref()
            .is_some_and(CrdDocument::is_deleted)
    }) else {
        return Err(not_found());
    };

    // 2. `is_member`: `task_access_store.is_member` first re-loads the
    //    accessible task (`_get_accessible_task`: id + kind Task +
    //    is_active IN (1, 2), no JSON DELETE filter), then returns true for
    //    the owner or an approved resource member.
    //
    //    `task_store.get_task_owner_id` returns the store's owner
    //    projection, which carries `id` and `user_id` only, so the check
    //    reads the owner id directly — the same way the status detail,
    //    task-detail and docx-export callers consume this store method. The
    //    task-detail decode below must not be applied to it.
    let accessible_row: Option<brz_mysql::MysqlRow> = task_store
        .get_task_owner_id(task_id as i64)
        .await
        .map_err(internal_mysql)?;
    let accessible_owner = accessible_row
        .as_ref()
        .map(|row| row.get_required::<i64>("user_id"))
        .transpose()
        .map_err(internal_mysql)?;
    let Some(accessible_owner) = accessible_owner else {
        return Err(not_found());
    };
    if accessible_owner != user_id && !is_approved_member(mysql, task_id, user_id).await? {
        return Err(not_found());
    }

    // 3. `convert_to_task_dict`: workspace-by-ref on the owner's shard,
    //    then `resolve_task_ref_team` for the task CRD's teamRef. When
    //    `teamRef.user_id` is set the source queries the `kinds` table
    //    directly by owner (no cached-reader index lookup); otherwise it
    //    goes through `kindReader.get_by_name_and_namespace`. The resolved
    //    team's id becomes `task_dict["team_id"]` consumed by step 6.
    let typed_spec = task
        .json
        .0
        .value
        .as_ref()
        .and_then(|task| task.spec.as_ref());
    if let Some((name, namespace)) =
        typed_spec.and_then(|spec| reference_parts(&spec.workspace_ref))
    {
        let workspace_row: Option<brz_mysql::MysqlRow> = task_store
            .get_workspace_by_ref(task.user_id, &name, &namespace)
            .await
            .map_err(internal_mysql)?;
        let _workspace = workspace_row
            .as_ref()
            .map(decode_task_row)
            .transpose()
            .map_err(internal_mysql)?;
    }
    let mut resolved_team_id: Option<i64> = None;
    if let Some((name, namespace)) = typed_spec
        .and_then(|spec| spec.team_ref.as_ref())
        .and_then(|reference| reference.nonempty_parts())
    {
        // `resolve_task_ref_team`: an explicit `teamRef.user_id` (even 0)
        // selects the direct owner query; an absent or JSON `null` one runs
        // `kindReader.get_by_name_and_namespace`, whose Team branch
        // (`_get_team`) resolves through the deployment's cached reader:
        // personal index -> shared-team list -> share-permission candidates
        // -> public. A public-only lookup would skip the earlier cache
        // documents and re-resolve the Team with a direct SQL read the
        // source never issues.
        resolved_team_id = match typed_spec
            .and_then(|spec| spec.team_ref.as_ref())
            .and_then(team_ref_owner_id)
        {
            Some(owner_id) => kinds
                .get_team_by_owner(owner_id, &namespace, &name)
                .await?
                .map(|record| record.id),
            None => {
                crate::task_skills::kinds::KindCacheStore {
                    mysql,
                    redis: kinds.redis,
                    erp: Some(erp.erp),
                    resolvers,
                }
                .get_team_id_by_name_and_namespace(user_id, &namespace, &name)
                .await?
            }
        };
    }

    // 3b. `convert_to_task_dict`'s own `userReader.get_by_id` (the
    //     deployment-configured reader; the source's cached reader serves
    //     the read from `user:v2:data` when the client is available).
    user_cache::get_by_id(mysql, redis, task.user_id).await?;

    // 4. Requested-skills raw task load (`task_store.get_by_id` with the
    //    owner filter): the sharded store resolves the physical table before
    //    the row load.
    let skills_row = load_task_by_owner(task_store, task_id, task.user_id).await?;
    let _skills_task = skills_row
        .as_ref()
        .map(decode_task_row)
        .transpose()
        .map_err(internal_mysql)?;

    // 5. `userReader.get_by_id` again (the deployment-configured reader).
    // The user row is not needed for the tree response.
    user_cache::get_by_id(mysql, redis, task.user_id).await?;

    // 6. Team detail: `kindReader.get_by_id` (only when the task dict
    //    resolved a team_id in step 3), then the source's own `if team:`
    //    block: `task_access_store.get_task_owner_id` (active task
    //    re-query) and `team_kinds_service._convert_to_team_dict`
    //    (per-member bot lookup through the cached reader, then the
    //    agent-type lookup). The tree response discards the converted team,
    //    but the recorded request-owned kind-cache reads happen in this
    //    order.
    let team_record = match resolved_team_id {
        Some(team_id) => kinds.get_by_id("Team", team_id).await?,
        None => None,
    };
    convert_team_detail(
        mysql,
        erp,
        kinds,
        task_store,
        user_id,
        task_id,
        team_record.as_ref(),
    )
    .await?;

    // 7. Fork lineage: `_lineage_task` (get_by_id with owner filter), then
    //    `subtask_store.list_by_task_ordered` (owner match, subtasks,
    //    contexts). Forked parents are not followed when the task has no
    //    `fork` spec (the recorded cases had none).
    let lineage_row = load_task_by_owner(task_store, task_id, task.user_id).await?;
    let _lineage_task = lineage_row
        .as_ref()
        .map(decode_task_row)
        .transpose()
        .map_err(internal_mysql)?;

    // `list_by_task_ordered` guards with `_owner_matches_task_id` only for
    // the ids the sharded store routes by task id; a legacy id resolves the
    // subtask table through `_subtask_model_for_task_lookup` directly (the
    // owner and migrated-copy probes), and a deployment without the sharded
    // store keeps the base table.
    // The store runs the new-format owner guard and the attached context load
    // itself; this flow consumes only the rows.
    let listing = task_store
        .list_subtasks_by_task_ordered(task_id as i64, task.user_id)
        .await
        .map_err(internal_mysql)?;
    let mut subtasks: Vec<SubtaskRow> = listing
        .rows
        .iter()
        .map(decode_subtask_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal_mysql)?;
    // `get_task_detail` consumes `resolve_for_task(..., limit=100)`, i.e. the
    // fork-history window — not the full `list_by_task_ordered` result. The
    // window owns `all_bot_ids`, the returned subtask list and
    // `_get_connected_executor_binding`'s reverse scan, so it has to be
    // applied before the bot ids are collected: a task with more than 100
    // subtasks otherwise probes bot ids the source never read, and the
    // recorded kind-cache lane cannot serve the extra `data:Bot:{id}` read.
    window_fork_history(&mut subtasks);

    // 8. `get_bots_for_subtasks`: bot ids from the subtask rows
    //    (`subtask.bot_ids` JSON array), resolved through
    //    `kindReader.get_by_ids`, then per bot the model lookup
    //    (`spec.modelRef`, by `bot.user_id`) and the shell lookup
    //    (`spec.shellRef`, by `bot.user_id`) through the cached reader —
    //    model BEFORE shell, matching the source helper's statement order
    //    (the recorded tail is Model idx/data then Shell idx/data, both
    //    public-only because the bot is public, `bot.user_id = 0`).
    //    The resolved bot summaries feed only task-detail fields the tree
    //    response discards, but the recorded reads happen here.
    //
    //    Source collects the ids into a Python `set` and passes
    //    `list(all_bot_ids)` to the reader, so the read order (cache GET
    //    sequence and the MySQL `IN (...)` parameter order on a miss) is
    //    CPython's set iteration order, not the subtask insertion order:
    //    `all_bot_ids = set()` + `update(subtask.bot_ids)` in
    //    `queries.get_task_detail`, consumed by `list(all_bot_ids)` in
    //    `task_detail_helpers.get_bots_for_subtasks`. `SetOrder` reproduces
    //    that deterministic order (integer hashes are the identity).
    let mut bot_ids = SetOrder::new();
    for subtask in &subtasks {
        if let Some(ids) = subtask.bot_ids.0.value.as_ref() {
            for id in ids.iter().flatten() {
                bot_ids.add(*id);
            }
        }
    }
    let bot_ids = bot_ids.order();
    let bots = kinds.get_by_ids("Bot", &bot_ids).await?;
    // `get_bots_for_subtasks`'s `model_cache`/`shell_type_cache` live for
    // one helper invocation: two bots sharing the same (user_id,
    // namespace, name) ref read the model/shell caches only once.
    let mut summary_caches = SummaryCaches::default();
    for bot in &bots {
        get_bot_summary_for_subtask(kinds, bot, &mut summary_caches).await?;
    }

    // 9. `add_group_chat_info_to_task`: approved resource members.
    let _members: Option<MembersRow> = mysql
        .fetch_optional(GROUP_CHAT_MEMBERS_SQL, (task_id as i64,))
        .await
        .map_err(internal_mysql)?;

    // `refresh_extended_video_result_urls` (`get_task_detail`'s last
    // dependency step): request-owned signing of the discarded playback URLs.
    super::video_refresh::refresh_video_result_urls(video_refresh, &mut task, &mut subtasks)
        .await?;

    Ok(TaskDetail { task, subtasks })
}

impl TaskRow {
    /// `convert_to_task_dict`'s `result` (`task_crd.status.result`).
    pub(crate) fn take_status_result(&mut self) -> OpaqueJson {
        self.json
            .0
            .value
            .as_mut()
            .and_then(|task| task.status.as_mut())
            .and_then(|status| status.result.take())
            .unwrap_or_else(|| OpaqueJson::from_serializable(serde_json::Value::Null))
    }
}

impl SubtaskRow {
    /// `convert_subtasks_to_dict`'s per-subtask `result` payload.
    pub(crate) fn take_result(&mut self) -> OpaqueJson {
        std::mem::replace(
            &mut self.result.0,
            OpaqueJson::from_serializable(serde_json::Value::Null),
        )
    }
}

/// Step 6's source `if team:` block: the accessible-task owner re-read, then
/// `_convert_to_team_dict`, in that order.
///
/// The owner re-read belongs to the branch. A task whose `teamRef` resolves
/// no Team row skips the block entirely, so `get_task_detail` issues only the
/// two active-task reads of steps 1-2. Reading the owner id outside the
/// branch adds a third active-task read with no recorded counterpart; Replay
/// then cannot serve the round's later `is_member` read and the endpoint
/// answers 500 `database query failed` (re-run 20260928020001, task
/// 131803956530390: its `teamRef.user_id = 405` has no `kinds` row, so
/// `get_team_by_owner` resolves none).
async fn convert_team_detail<M, R: Redis>(
    mysql: &M,
    erp: &crate::teams::group_membership::ErpContext<'_, R>,
    kinds: &KindStore<'_, M, R>,
    task_store: &dyn crate::task_store::TaskStore,
    user_id: i64,
    task_id: u64,
    team_record: Option<&super::kinds::KindRecord>,
) -> Result<(), ApiError>
where
    M: brz_mysql::Mysql,
{
    let Some(team) = team_record else {
        return Ok(());
    };
    let owner_row: Option<brz_mysql::MysqlRow> = task_store
        .get_task_owner_id(task_id as i64)
        .await
        .map_err(internal_mysql)?;
    let owner_id = owner_row
        .as_ref()
        .map(|row| row.get_required::<i64>("user_id"))
        .transpose()
        .map_err(internal_mysql)?;
    let Some(owner_id) = owner_id else {
        return Ok(());
    };
    // `should_redact_team_for_user` runs BEFORE `_convert_to_team_dict`; the
    // tree response discards the redacted team, but the membership resolution
    // traffic is request-owned.
    crate::teams::group_membership::should_redact_team_for_user(
        mysql,
        erp,
        user_id,
        team.id,
        team.user_id,
        &team.namespace,
    )
    .await
    .map_err(internal_mysql)?;
    convert_team_dict(kinds, team, owner_id).await
}

/// `task_fork_history.resolve_for_task`'s window: the collected items are
/// sorted by `(message_id, created_at, id)` and only the last
/// [`FORK_HISTORY_LIMIT`] are returned (`items[-limit:]`). `_attach_contexts`
/// already ran inside `list_by_task_ordered`, so the caller must apply this
/// after the subtask and context loads.
fn window_fork_history(subtasks: &mut Vec<SubtaskRow>) {
    subtasks.sort_by(|left, right| {
        left.message_id
            .cmp(&right.message_id)
            .then(left.created_at.cmp(&right.created_at))
            .then(left.id.cmp(&right.id))
    });
    if subtasks.len() > FORK_HISTORY_LIMIT {
        subtasks.drain(..subtasks.len() - FORK_HISTORY_LIMIT);
    }
}

/// Decode one row of the subtask projection (unqualified column names).
fn decode_subtask_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<SubtaskRow> {
    Ok(SubtaskRow {
        id: row.get_required("id")?,
        user_id: row.get_required("user_id")?,
        task_id: row.get_required("task_id")?,
        team_id: row.get_required("team_id")?,
        title: row.get_required("title")?,
        bot_ids: row.get_required("bot_ids")?,
        role: row.get_required("role")?,
        executor_namespace: row.get_required("executor_namespace")?,
        executor_name: row.get_required("executor_name")?,
        executor_deleted_at: row.get_required("executor_deleted_at")?,
        prompt: row.get_required("prompt")?,
        message_id: row.get_required("message_id")?,
        parent_id: row.get_required("parent_id")?,
        status: row.get_required("status")?,
        progress: row.get_required("progress")?,
        result: row.get_required("result")?,
        error_message: row.get("error_message")?,
        created_at: row.get_required("created_at")?,
        updated_at: row.get_required("updated_at")?,
        completed_at: row.get("completed_at")?,
        sender_type: row.get_required("sender_type")?,
        sender_user_id: row.get_required("sender_user_id")?,
        reply_to_subtask_id: row.get_required("reply_to_subtask_id")?,
    })
}

#[cfg(test)]
fn json_status_is_delete(payload: &Value) -> bool {
    crate::crd::json_status_is_delete(payload)
}

/// Approved `resource_members` check from `SqlAlchemyTaskAccessStore.is_member`
/// (entity_id is the stringified user id in the source query).
async fn is_approved_member<M>(mysql: &M, task_id: u64, user_id: i64) -> Result<bool, ApiError>
where
    M: brz_mysql::Mysql,
{
    let member: Option<MemberIdRow> = mysql
        .fetch_optional(
            "SELECT resource_members.id AS resource_members_id \
             FROM resource_members \
             WHERE resource_members.resource_type = 'Task' \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' \
             AND resource_members.copied_resource_id = 0 \
             LIMIT 1",
            (task_id as i64, user_id.to_string()),
        )
        .await
        .map_err(internal_mysql)?;
    Ok(member.is_some())
}

/// Test-only constructor for executor-binding tests in the sibling module.
#[cfg(test)]
pub(crate) fn test_subtask_row(executor_name: &str, executor_deleted_at: i8) -> SubtaskRow {
    SubtaskRow {
        id: 1,
        user_id: 1,
        task_id: 1,
        team_id: 1,
        title: String::new(),
        bot_ids: Json(serde_json::Value::Null.into()),
        role: String::new(),
        executor_namespace: String::new(),
        executor_name: executor_name.to_owned(),
        executor_deleted_at,
        prompt: String::new(),
        message_id: 1,
        parent_id: 0,
        status: String::new(),
        progress: 0,
        result: Json(OpaqueJson::from_serializable(())),
        error_message: None,
        created_at: chrono::NaiveDateTime::default(),
        updated_at: chrono::NaiveDateTime::default(),
        completed_at: None,
        sender_type: String::new(),
        sender_user_id: 1,
        reply_to_subtask_id: 0,
    }
}

/// Test-only `TaskRow` with a `status.result` payload (video-refresh tests).
#[cfg(test)]
pub(crate) fn test_task_row(result: Value) -> TaskRow {
    TaskRow {
        id: 1,
        user_id: 7,
        kind: "Task".to_owned(),
        name: String::new(),
        namespace: String::new(),
        json: Json(JsonProjection::from(
            serde_json::json!({"status": {"result": result}}),
        )),
        is_active: 1,
        created_at: chrono::NaiveDateTime::default(),
        updated_at: chrono::NaiveDateTime::default(),
        project_id: None,
        client_origin: None,
        is_group_chat: false,
    }
}

/// Test-only `SubtaskRow` carrying an optional `result` payload.
#[cfg(test)]
pub(crate) fn test_subtask_with_result(result: Option<Value>) -> SubtaskRow {
    let mut subtask = test_subtask_row("", 0);
    subtask.result = Json(match result {
        Some(value) => OpaqueJson::from(value),
        None => OpaqueJson::from_serializable(serde_json::Value::Null),
    });
    subtask
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fork_history_subtask(id: i64, message_id: i32, bot_ids: Vec<Option<i64>>) -> SubtaskRow {
        let mut subtask = test_subtask_row("", 0);
        subtask.id = id;
        subtask.message_id = message_id;
        subtask.created_at =
            chrono::NaiveDateTime::default() + chrono::Duration::seconds(i64::from(message_id));
        subtask.bot_ids = Json(JsonProjection {
            value: Some(bot_ids),
        });
        subtask
    }

    /// `get_task_detail` consumes `resolve_for_task(limit=100)`: the items are
    /// sorted by `(message_id, created_at, id)` and only the last 100 are
    /// returned. Recorded case 9fba0c4d (task 11132555386195) has 140
    /// subtasks; the first 18 reference bot 110593 and the remaining 122
    /// reference 110592, so the windowed `all_bot_ids` is `{110592}` and the
    /// source probes only `kind:v2:data:Bot:110592`. Without the window the
    /// extra 110593 probe leaves the recorded kind-cache lane and the
    /// endpoint answers 500 `kind query failed` instead of 404.
    #[test]
    fn fork_history_window_keeps_the_last_hundred_rows() {
        let mut subtasks: Vec<SubtaskRow> = (1..=140_i64)
            .map(|index| {
                let bot_id = if index <= 18 { 110_593 } else { 110_592 };
                fork_history_subtask(index, index as i32, vec![Some(bot_id)])
            })
            .collect();
        // Feed the window the reverse of the query's `ORDER BY message_id`
        // order so the sort is exercised too.
        subtasks.reverse();

        window_fork_history(&mut subtasks);

        assert_eq!(subtasks.len(), 100);
        assert_eq!(subtasks.first().map(|row| row.message_id), Some(41));
        assert_eq!(subtasks.last().map(|row| row.message_id), Some(140));
        assert!(subtasks.iter().all(|row| {
            row.bot_ids
                .0
                .value
                .as_ref()
                .is_none_or(|ids| !ids.contains(&Some(110_593)))
        }));
    }

    /// `resolve_for_task` only slices when the collected items exceed the
    /// limit, and orders the retained rows by `(message_id, created_at, id)`.
    #[test]
    fn fork_history_window_keeps_short_lists_in_order() {
        let mut subtasks = vec![
            fork_history_subtask(7, 9, vec![Some(110_593)]),
            fork_history_subtask(5, 4, vec![Some(110_592)]),
        ];

        window_fork_history(&mut subtasks);

        assert_eq!(
            subtasks
                .iter()
                .map(|row| (row.message_id, row.id))
                .collect::<Vec<_>>(),
            vec![(4, 5), (9, 7)]
        );
    }

    #[test]
    fn delete_status_detected_in_json() {
        assert!(json_status_is_delete(
            &serde_json::json!({"status": {"status": "DELETE"}})
        ));
        assert!(!json_status_is_delete(
            &serde_json::json!({"status": {"status": "RUNNING"}})
        ));
    }

    fn team_record() -> crate::remote_workspace_tree::kinds::KindRecord {
        crate::remote_workspace_tree::kinds::KindRecord {
            id: 19_709,
            user_id: 405,
            kind: "Team".to_owned(),
            name: "AI工具数参助手".to_owned(),
            namespace: "default".to_owned(),
            json: brz_mysql::Json(serde_json::json!({
                "kind": "Team",
                "spec": {"members": [], "collaborationModel": "solo"},
                "metadata": {"name": "AI工具数参助手", "namespace": "default"},
                "apiVersion": "agent.wecode.io/v1"
            })),
            is_active: 1,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    /// Step 6's source `if team:` block owns the owner re-read, so a task
    /// whose `teamRef` resolved no Team row must issue no extra active-task
    /// read. Reading it outside the branch adds a third active-task read per
    /// `get_task_detail` round; Replay has no counterpart for it and then
    /// cannot serve the round's later `is_member` read, so re-run
    /// 20260928020001 answered the recorded tree case fbe38f07 (task
    /// 131803956530390) with 500 `database query failed`.
    #[tokio::test]
    async fn team_detail_skips_the_owner_read_when_no_team_resolves() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let store = crate::task_store::DefaultTaskStore::new(mysql.clone());
        let erp = crate::erp_provider::NoopErpProvider;
        let erp_context = crate::teams::group_membership::ErpContext {
            erp: &erp,
            redis: None::<&brz_redis::RedisService>,
        };
        let kinds: KindStore<'_, _, brz_redis::RedisService> = KindStore {
            mysql: &mysql,
            redis: None,
        };

        convert_team_detail(
            &mysql,
            &erp_context,
            &kinds,
            &store,
            959,
            131_803_956_530_390,
            None,
        )
        .await
        .expect("the absent team leaves step 6 a no-op");

        assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
    }

    /// With a resolved Team, step 6 issues the source's owner re-read exactly
    /// once; the kind lookups that follow belong to `_convert_to_team_dict`.
    #[tokio::test]
    async fn team_detail_reads_the_owner_once_when_a_team_resolves() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let store = crate::task_store::DefaultTaskStore::new(mysql.clone());
        let erp = crate::erp_provider::NoopErpProvider;
        let erp_context = crate::teams::group_membership::ErpContext {
            erp: &erp,
            redis: None::<&brz_redis::RedisService>,
        };
        let kinds: KindStore<'_, _, brz_redis::RedisService> = KindStore {
            mysql: &mysql,
            redis: None,
        };
        let team = team_record();

        convert_team_detail(
            &mysql,
            &erp_context,
            &kinds,
            &store,
            959,
            131_803_956_530_390,
            Some(&team),
        )
        .await
        .expect("the owner read resolves no row and ends the block");

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1, "{queries:?}");
        assert!(
            queries[0].sql.contains("SELECT id, user_id")
                && queries[0].sql.contains("is_active IN (1, 2)"),
            "{}",
            queries[0].sql
        );
    }

    /// `resolve_task_ref_team`: only a non-null `teamRef.user_id` selects the
    /// direct owner query. The recorded tree case (task 135365) carries
    /// `"user_id": null`, and the source there runs `_get_team` — the reader
    /// chain whose first cache document is
    /// `kind:v2:idx:personal:Team:2309:default:wegent-chat`. Resolving such a
    /// ref with the public lookup instead reads the public document first and
    /// then falls back to a direct SQL read the recording does not contain.
    #[test]
    fn absent_or_null_team_ref_owner_runs_the_reader_chain() {
        let reference = |user_id: Option<serde_json::Value>| {
            let mut document = serde_json::json!({
                "name": "wegent-chat",
                "namespace": "default",
            });
            if let Some(user_id) = user_id {
                document["user_id"] = user_id;
            }
            serde_json::from_value::<crate::crd::ResourceReference>(document)
                .expect("team ref decodes")
        };

        // Absent and JSON `null` both run `_get_team`.
        assert_eq!(team_ref_owner_id(&reference(None)), None);
        assert_eq!(
            team_ref_owner_id(&reference(Some(serde_json::Value::Null))),
            None
        );
        // An explicit id — including the public `0` — queries by owner.
        assert_eq!(
            team_ref_owner_id(&reference(Some(serde_json::json!(0)))),
            Some(0)
        );
        assert_eq!(
            team_ref_owner_id(&reference(Some(serde_json::json!(2309)))),
            Some(2309)
        );
    }
}

#[cfg(test)]
mod sql_tests {
    use super::*;

    #[test]
    fn group_chat_members_read_keeps_the_source_predicates() {
        // Recorded source SQL for case b5648357 (`add_group_chat_info_to_task`):
        // the prepared statement must filter the task id, the approved status,
        // and `copied_resource_id = 0`. Without the last predicate Replay finds
        // no recorded counterpart and the endpoint answers 500.
        let sql = GROUP_CHAT_MEMBERS_SQL
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(sql.contains(
            "WHERE resource_members.resource_type = 'Task' \
             AND resource_members.resource_id = ? \
             AND resource_members.status = 'approved' \
             AND resource_members.copied_resource_id = 0"
        ));
        assert_eq!(sql.matches('?').count(), 1);
        let projection = sql.split(" FROM ").next().unwrap();
        assert_eq!(
            projection.trim_start_matches("SELECT ").split(", ").count(),
            17
        );
    }

    /// The tree flow's membership pre-check consumes
    /// `task_store.get_task_owner_id`'s owner projection, which carries `id`
    /// and `user_id` only — not the `TaskResource` entity this flow used to
    /// read through its own statement. Running [`decode_task_row`] over that
    /// projection fails on the first column it does not carry and the
    /// endpoint answers 500 `database query failed` (re-run 20260924073633,
    /// all 10 cases). The guard keeps the two shapes from drifting back
    /// together: a widened projection must be paired with the tree flow's
    /// read, not with a silent decode.
    #[test]
    fn the_owner_projection_is_not_a_task_row_projection() {
        let statement = crate::task_store::task_owner_statement(crate::task_store::TASKS_TABLE);
        let projection = statement
            .split("FROM ")
            .next()
            .expect("the owner read keeps a SELECT projection")
            .trim_start_matches("SELECT ")
            .split(", ")
            .map(str::trim)
            .collect::<Vec<_>>();
        assert_eq!(projection, ["id", "user_id"]);
    }
}
