// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `loop_item_service.response_values` projection for the cloud-context
//! loop-item branch.
//!
//! Mirrors `app.services.loop_items.service.LoopItemService.response_values`
//! merged with the pydantic `LoopItemResponse` normalization
//! (`app.schemas.delivery.LoopItemResponse`): the item row fields, the
//! project-role permissions (`issue_permissions` / `can_view_item`), the
//! metadata-derived history and AI projections, and the newest execution
//! overlay (`loop_item_execution_service.latest_for_item`).
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::{Map, Value, json};

use brz_http_server::StatusCode;

use super::http_error::HttpError;
use super::loop_repository::{
    ChatAgentRow, ExecutionFullRow, ItemMetadata, LoopItemRepository, ProjectChatMessageRow,
    TaskItemFullRow, datetime_is_unset, has_permission,
};
use crate::LoopItemReads;
use crate::auth::UserRow;
use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectAccess};

/// The `LoopItemResponse` body (`app.schemas.delivery.LoopItemResponse`):
/// every field is always emitted (FastAPI has no `response_model_exclude_*`),
/// so `None` serializes as `null` rather than being skipped.
#[derive(Debug, Serialize)]
pub struct LoopItemResponse {
    pub id: String,
    pub cloud_project_id: String,
    pub sequence_number: i64,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: String,
    pub assignee_user_id: Option<i32>,
    pub assignee_group_id: Option<String>,
    pub assignee_group_name: Option<String>,
    pub assignee_name: Option<String>,
    pub assignee_agent_id: Option<String>,
    pub assignee_agent_name: Option<String>,
    pub assignee_team_id: Option<i32>,
    pub assignee_team_name: Option<String>,
    pub ai_state: Option<Value>,
    pub processing_actor: Option<Value>,
    pub human_waiting_since: Option<String>,
    pub human_requests: Vec<Value>,
    pub execution_id: Option<i64>,
    pub execution_state: Option<String>,
    pub execution_control_state: Option<String>,
    pub execution_observed_state: Option<String>,
    pub execution_sync_state: Option<String>,
    pub execution_attempt_no: Option<i64>,
    pub execution_last_event_seq: Option<i64>,
    pub can_approve: bool,
    pub assignment_history: Vec<Value>,
    pub status_history: Vec<Value>,
    pub approval: Option<Value>,
    pub human_task_binding: Option<Value>,
    pub queued_at: Option<String>,
    pub execution_note: Option<String>,
    pub execution_error: Option<String>,
    pub automation: Option<Value>,
    pub workflow: Option<Value>,
    pub execution_config: Option<Value>,
    pub priority: String,
    pub start_at: Option<String>,
    pub due_at: Option<String>,
    pub sort_order: i64,
    pub milestone_id: Option<String>,
    pub tags: Vec<String>,
    pub created_by_user_id: i64,
    pub created_by_user_name: Option<String>,
    pub invited_only: bool,
    pub can_view_detail: bool,
    pub security_level: &'static str,
    pub can_edit: bool,
    pub permissions: Permissions,
    pub detail_loaded: bool,
    pub badges: Vec<Value>,
    pub content_revision: i64,
    pub activity_read_sequence: i64,
    pub is_unread: bool,
    pub current_delivery_id: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

impl LoopItemResponse {
    /// The item's primary key, consumed by callers that need the ids of a
    /// projected list (for example the board-snapshot task-binding read).
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// `LoopItemPermissions` (`app.schemas.delivery`).
#[derive(Debug, Serialize)]
pub struct Permissions {
    pub edit_content: bool,
    pub comment: bool,
    pub assign: bool,
    pub execute: bool,
}

/// The execution-derived overlay fields. All fields are `None` when the item
/// has no execution row.
#[derive(Debug, Default)]
struct ExecutionOverlay {
    id: Option<i64>,
    display_state: Option<String>,
    control_state: Option<String>,
    observed_state: Option<String>,
    sync_state: Option<String>,
    attempt_no: Option<i64>,
    last_event_seq: Option<i64>,
    queued_at: Option<String>,
    note: Option<String>,
    error: Option<String>,
    can_approve: bool,
    approval: Option<Value>,
    ai_state: Option<Value>,
}

/// The owning project facts `response_values` needs: the numeric id (for the
/// fallback access re-read), the resolved visibility, whether the task
/// provider is local, the creator, and the project's default issue security.
/// Only `number` and `default_issue_security` are consumed by this projection;
/// the remaining fields are carried for sibling projections.
pub struct ProjectFacts<'a> {
    #[allow(dead_code, reason = "carried for sibling item projections")]
    pub number: i64,
    #[allow(dead_code, reason = "carried for sibling item projections")]
    pub visibility: &'a str,
    #[allow(dead_code, reason = "carried for sibling item projections")]
    pub provider_is_local: bool,
    #[allow(dead_code, reason = "carried for sibling item projections")]
    pub created_by_user_id: i32,
    pub default_issue_security: &'a str,
}

/// `LoopItemService.response_values`: project one task row to the
/// `LoopItemResponse` body. `access` is the source's optional pre-resolved
/// `CloudProjectAccess`; when `None` the guard re-reads it (the source's
/// `access = access or require_cloud_project_role(...)`).
pub async fn response_values(
    state: &LoopItemReads<'_>,
    item: &TaskItemFullRow,
    current_user: &UserRow,
    project: &ProjectFacts<'_>,
    access: Option<&ProjectAccess>,
) -> Result<LoopItemResponse, HttpError> {
    let repository = LoopItemRepository::new(state.mysql);
    let execution = load_latest_execution(&repository, &item.id).await?;
    response_values_with_execution(
        state,
        item,
        current_user,
        project,
        access,
        execution.as_ref(),
    )
    .await
}

/// `LoopItemService.response_values_many`: project every row with one shared
/// read context, so the newest-execution lookup runs once for the whole page
/// (`LoopItemReadContext.load` -> `_latest_executions`).
/// `LoopItemReadContext.load` (`app/services/loop_items/read_context.py:23-79`):
/// the batch inputs one projection pass shares. Every map is keyed like the
/// source's field of the same name so a lookup mirrors `context.<field>.get`.
#[derive(Default)]
pub struct SharedContext {
    executions: std::collections::HashMap<String, ExecutionFullRow>,
    users: std::collections::HashMap<i32, String>,
    agents: std::collections::HashMap<String, ChatAgentRow>,
    teams: std::collections::HashMap<i64, String>,
    messages: std::collections::HashMap<(String, String), ProjectChatMessageRow>,
    comments: std::collections::HashMap<String, Vec<super::loop_repository::CommentRow>>,
    related_ids: std::collections::HashSet<String>,
    invited_item_id: Option<String>,
    /// Items whose assignment comments were preloaded (the eligible set);
    /// `false` means the item keeps its own per-item read.
    comments_loaded: bool,
}

/// The single-item path's newest-run override: `response_values` resolves the
/// run itself, so it is not in a page-wide map.
struct SingleItem<'a> {
    execution: Option<&'a ExecutionFullRow>,
}

impl SharedContext {
    fn execution(&self, item_id: &str) -> Option<&ExecutionFullRow> {
        self.executions.get(item_id)
    }

    fn agent(&self, agent_id: &str) -> Option<&ChatAgentRow> {
        self.agents.get(agent_id)
    }

    fn team(&self, team_id: i64) -> Option<&String> {
        self.teams.get(&team_id)
    }

    fn message(&self, task_id: &str, message_id: &str) -> Option<&ProjectChatMessageRow> {
        self.messages
            .get(&(task_id.to_string(), message_id.to_string()))
    }

    fn is_related(&self, item_id: &str) -> bool {
        self.related_ids.contains(item_id)
    }
}

pub async fn response_values_many(
    state: &LoopItemReads<'_>,
    items: &[TaskItemFullRow],
    current_user: &UserRow,
    project: &ProjectFacts<'_>,
    access: Option<&ProjectAccess>,
) -> Result<Vec<LoopItemResponse>, HttpError> {
    response_values_many_with_invitation(state, items, current_user, project, access, None).await
}

pub async fn response_values_for_invited_item(
    state: &LoopItemReads<'_>,
    item: &TaskItemFullRow,
    current_user: &UserRow,
    project: &ProjectFacts<'_>,
) -> Result<LoopItemResponse, HttpError> {
    response_values_many_with_invitation(
        state,
        std::slice::from_ref(item),
        current_user,
        project,
        None,
        Some(&item.id),
    )
    .await?
    .pop()
    .ok_or_else(HttpError::internal_detail)
}

async fn response_values_many_with_invitation(
    state: &LoopItemReads<'_>,
    items: &[TaskItemFullRow],
    current_user: &UserRow,
    project: &ProjectFacts<'_>,
    access: Option<&ProjectAccess>,
    invited_item_id: Option<&str>,
) -> Result<Vec<LoopItemResponse>, HttpError> {
    let repository = LoopItemRepository::new(state.mysql);
    let item_ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();

    // `access = access or require_cloud_project_role(db, ..., Viewer)` runs
    // before `LoopItemReadContext.load` in the source, so the provider reads
    // for the context follow the access block.
    let resolved_access;
    let access = match (access, invited_item_id) {
        (Some(access), _) => Some(access),
        (None, Some(_)) => None,
        (None, None) => {
            // `require_cloud_project_role` (`app/services/cloud_projects/
            // access.py:132-155`) resolves the role, then its permission
            // sources, then `db.get(CloudProject, str(project_id))`. The
            // entity read is part of the source's access check, so it runs
            // here rather than only in callers that need the row.
            resolved_access = BoardSnapshotRepository::new(state.mysql)
                .require_cloud_project_role(project.number, current_user.id)
                .await
                .map_err(HttpError::internal)?
                .ok_or_else(HttpError::cloud_project_not_found)?;
            BoardSnapshotRepository::new(state.mysql)
                .project_entity(project.number)
                .await
                .map_err(HttpError::internal)?;
            Some(&resolved_access)
        }
    };

    // `LoopItemReadContext.load`: every batch input, read once for the page, in
    // the source's field order — executions, users, agents, teams, messages,
    // human bindings, visible ids.
    let mut context = SharedContext {
        executions: repository
            .latest_executions_for_items(&item_ids)
            .await
            .map_err(HttpError::internal)?,
        invited_item_id: invited_item_id.map(str::to_owned),
        ..SharedContext::default()
    };

    let mut user_ids: Vec<i32> = Vec::new();
    let mut agent_ids: Vec<String> = Vec::new();
    let mut team_ids: Vec<i64> = Vec::new();
    for item in items {
        for id in [item.assignee_user_id, item.created_by_user_id] {
            if let Some(id) = id.filter(|id| *id != 0)
                && !user_ids.contains(&id)
            {
                user_ids.push(id);
            }
        }
        if let Some(metadata) = item.metadata() {
            for id in history_user_ids(metadata) {
                if !user_ids.contains(&id) {
                    user_ids.push(id);
                }
            }
        }
        if let Some(agent_id) = nonempty(item.assignee_agent_id.as_deref()) {
            let agent_id = agent_id.to_string();
            if !agent_ids.contains(&agent_id) {
                agent_ids.push(agent_id);
            }
        }
        if let Some(team_id) = item.assignee_team_id.filter(|id| *id != 0) {
            let team_id = i64::from(team_id);
            if !team_ids.contains(&team_id) {
                team_ids.push(team_id);
            }
        }
    }
    // `agent_ids.update(row.agent_id ...)` / `team_ids.update(row.team_id ...)`:
    // the newest executions contribute their own agent and team ids.
    for execution in context.executions.values() {
        if let Some(agent_id) = nonempty(execution.agent_id.as_deref()) {
            let agent_id = agent_id.to_string();
            if !agent_ids.contains(&agent_id) {
                agent_ids.push(agent_id);
            }
        }
        if let Some(team_id) = execution.team_id.filter(|id| *id != 0)
            && !team_ids.contains(&team_id)
        {
            team_ids.push(team_id);
        }
    }
    context.users = repository
        .user_names_for_ids(&user_ids)
        .await
        .map_err(HttpError::internal)?;
    context.agents = repository
        .chat_agents_for_ids(&agent_ids)
        .await
        .map_err(HttpError::internal)?;
    context.teams = repository
        .team_names_for_ids(&team_ids)
        .await
        .map_err(HttpError::internal)?;

    // `_messages(db, items)`: the cached task messages named by each item's
    // `ai_state.project_chat_message_id`.
    let mut pairs: Vec<(String, String)> = Vec::new();
    for item in items {
        if let Some(message_id) = item
            .metadata()
            .and_then(|metadata| metadata.ai_state.as_ref())
            .and_then(|state| state.get("project_chat_message_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            pairs.push((item.id.clone(), message_id.to_string()));
        }
    }
    context.messages = repository
        .messages_for_items(&pairs)
        .await
        .map_err(HttpError::internal)?;

    // `human_task_bindings(db, items, user_id, projects=[project])` ->
    // `active_for_issues(db, [item.id for item in eligible])`.
    let eligible: Vec<String> = items
        .iter()
        .filter(|item| {
            item.assignee_user_id == Some(current_user.id)
                && project.provider_is_local
                && !has_blocking_human_metadata(item)
        })
        .map(|item| item.id.clone())
        .collect();
    context.comments_loaded = true;
    context.comments = repository
        .list_assignment_comments_for_items(&eligible)
        .await
        .map_err(HttpError::internal)?;

    // `_visible_ids(db, items, user_id, access)`: maintainers see every item;
    // everyone else needs an `open` item or a related one.
    if access.is_some_and(|access| !has_permission(&access.role, "Maintainer")) {
        context.related_ids = repository
            .related_item_ids(&item_ids, current_user.id)
            .await
            .map_err(HttpError::internal)?;
    }

    let empty: Vec<super::loop_repository::CommentRow> = Vec::new();
    let mut responses = Vec::with_capacity(items.len());
    for item in items {
        let comments = eligible
            .contains(&item.id)
            .then(|| context.comments.get(&item.id).unwrap_or(&empty).as_slice());
        responses.push(
            response_values_in_context(
                state,
                item,
                current_user,
                project,
                access,
                &context,
                comments,
                None,
            )
            .await?,
        );
    }
    Ok(responses)
}

/// `_human_binding_items`' metadata guard
/// (`app/services/collaboration_human_assignments.py:82-89`): a stored
/// `workflow`, `external_index`, or `external_shadow` disables the direct
/// human view.
fn has_blocking_human_metadata(item: &TaskItemFullRow) -> bool {
    item.metadata().is_some_and(|metadata| {
        [
            &metadata.workflow,
            &metadata.external_index,
            &metadata.external_shadow,
        ]
        .iter()
        .any(|value| {
            value
                .as_ref()
                .is_some_and(brz_json::adapters::python_truthy)
        })
    })
}

/// The source's `read_context.executions.get(item.id)`: the newest run for one
/// item through the batch `max(id)` projection `_latest_executions` uses, so a
/// single-item read renders the same statement as a list read.
async fn load_latest_execution(
    repository: &LoopItemRepository<'_, brz_mysql::MysqlService>,
    item_id: &str,
) -> Result<Option<ExecutionFullRow>, HttpError> {
    let mut executions = repository
        .latest_executions_for_items(std::slice::from_ref(&item_id.to_string()))
        .await
        .map_err(HttpError::internal)?;
    Ok(executions.remove(item_id))
}

/// [`response_values`] with the newest execution already resolved from the
/// shared read context (`None` when the item has no run).
async fn response_values_with_execution(
    state: &LoopItemReads<'_>,
    item: &TaskItemFullRow,
    current_user: &UserRow,
    project: &ProjectFacts<'_>,
    access: Option<&ProjectAccess>,
    execution: Option<&ExecutionFullRow>,
) -> Result<LoopItemResponse, HttpError> {
    let mut ids: Vec<_> = item
        .metadata()
        .into_iter()
        .flat_map(history_user_ids)
        .collect();
    ids.extend(item.created_by_user_id.filter(|id| *id > 0));
    ids.extend(item.assignee_user_id.filter(|id| *id != 0));
    ids.sort_unstable();
    ids.dedup();
    let context = SharedContext {
        users: LoopItemRepository::new(state.mysql)
            .user_names_for_ids(&ids)
            .await
            .map_err(HttpError::internal)?,
        ..SharedContext::default()
    };
    response_values_in_context(
        state,
        item,
        current_user,
        project,
        access,
        &context,
        None,
        Some(SingleItem { execution }),
    )
    .await
}

/// [`response_values_with_execution`] with an optional shared
/// `read_context.users` map. When present, assignee and creator names come
/// from the batch read instead of a per-id `db.get(User, ...)`.
#[allow(
    clippy::too_many_arguments,
    reason = "mirrors the source projection parameters"
)]
async fn response_values_in_context(
    state: &LoopItemReads<'_>,
    item: &TaskItemFullRow,
    current_user: &UserRow,
    project: &ProjectFacts<'_>,
    access: Option<&ProjectAccess>,
    context: &SharedContext,
    preloaded_comments: Option<&[super::loop_repository::CommentRow]>,
    single: Option<SingleItem<'_>>,
) -> Result<LoopItemResponse, HttpError> {
    // `read_context.executions.get(item.id)`: the page map, or the single-item
    // path's own newest-run read.
    let execution = single
        .as_ref()
        .and_then(|single| single.execution)
        .or_else(|| context.execution(&item.id));
    let user_names = Some(&context.users);
    let repository = LoopItemRepository::new(state.mysql);
    let project_number = project.number;

    // `access = access or require_cloud_project_role(db, item.cloud_project_id,
    // user_id, RestrictedAnalyst)`.
    let resolved_access;
    let invited_only = context.invited_item_id.as_deref() == Some(item.id.as_str());
    let role = match (access, invited_only) {
        (Some(access), _) => access.role.as_str(),
        (None, true) => "Developer",
        (None, false) => {
            resolved_access = BoardSnapshotRepository::new(state.mysql)
                .require_cloud_project_role(project_number, current_user.id)
                .await
                .map_err(HttpError::internal)?
                .ok_or_else(HttpError::cloud_project_not_found)?;
            resolved_access.role.as_str()
        }
    };
    let default_metadata = ItemMetadata::default();
    let metadata = item.metadata().unwrap_or(&default_metadata);

    // `item_security(item, access.project)` (`app.services.loop_items.access`):
    // the item's own `security_level` when set, else the project default.
    let security_level = match metadata_security_level(metadata) {
        Some(level) => level,
        None => {
            if project.default_issue_security == "related" {
                "related"
            } else {
                "open"
            }
        }
    };

    // `_item_permissions` -> `can_view_item`: maintainers and up always see
    // the item; otherwise an `open` item or an item related to the caller.
    let can_view_detail =
        if invited_only || has_permission(role, "Maintainer") || security_level == "open" {
            true
        } else if single.is_none() {
            // `read_context.visible_ids` already resolved the related set for the
            // whole page.
            context.is_related(&item.id)
        } else {
            repository
                .is_related_item(&item.id, current_user.id)
                .await
                .map_err(HttpError::internal)?
        };

    // `issue_permissions(access, issue_creator_user_id=item.created_by_user_id,
    // user_id=user_id)`: an invitation grants Issue management only.
    let permissions = issue_permissions(role, invited_only);

    // `db.get(User, item.assignee_user_id)`: the source identity map already
    // holds the session user, so the session name is used without a query.
    let assignee_name = match item.assignee_user_id.filter(|id| *id != 0) {
        Some(user_id) if user_id == current_user.id => Some(current_user.user_name.clone()),
        Some(user_id) => match user_names.and_then(|names| names.get(&user_id)) {
            Some(name) => Some(name.clone()),
            None if user_names.is_some() => None,
            None => state
                .user_reader
                .get_entity_by_id(i64::from(user_id))
                .await
                .map_err(|error| {
                    tracing::error!(%error, "cloud-context assignee lookup failed");
                    HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
                })?
                .map(|record| record.user_name),
        },
        None => None,
    };

    // `db.get(ProjectChatAgent, ...)`: the source identity map serves every
    // lookup of one agent id with a single SQL read, so the row is resolved
    // once here and reused by the approval and AI-state projections.
    let assignee_agent_id = nonempty(item.assignee_agent_id.as_deref());
    let assignee_agent = match assignee_agent_id.as_deref() {
        Some(agent_id) => match context.agent(agent_id) {
            Some(row) => Some(row.clone()),
            None if single.is_none() => None,
            None => repository
                .chat_agent(agent_id)
                .await
                .map_err(HttpError::internal)?,
        },
        None => None,
    };
    let assignee_agent_name = assignee_agent.as_ref().and_then(|agent| agent.name.clone());

    // `db.get(Kind, item.assignee_team_id)` when set.
    let assignee_team_name = match item.assignee_team_id.filter(|id| *id != 0) {
        Some(team_id) => match context.team(i64::from(team_id)) {
            Some(name) => Some(name.clone()),
            None if single.is_none() => None,
            None => repository
                .kind_name(i64::from(team_id))
                .await
                .map_err(HttpError::internal)?,
        },
        None => None,
    };

    // `metadata.get("collaboration_group")`; a concrete assignee wins over the
    // group projection (`if item.assignee_user_id or item.assignee_agent_id or
    // item.assignee_team_id: group = None`).
    let has_assignee = item.assignee_user_id.is_some_and(|id| id != 0)
        || item
            .assignee_agent_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
        || item.assignee_team_id.is_some_and(|id| id != 0);
    let collaboration_group = (!has_assignee)
        .then(|| json_object(metadata.collaboration_group.as_ref()))
        .flatten();
    let assignee_group_id = collaboration_group
        .as_ref()
        .and_then(|group| json_string(group.get("id")));
    let assignee_group_name = collaboration_group
        .as_ref()
        .and_then(|group| json_string(group.get("name")));

    // `_present_cached_ai_state` then `execution_ai_state` (when a run exists).
    let cached_ai_state = present_cached_ai_state(
        state,
        &repository,
        item,
        metadata.ai_state.as_ref(),
        context,
        single.is_some(),
    )
    .await?;
    let overlay = execution_overlay(
        state,
        &repository,
        item,
        current_user.id,
        assignee_agent.as_ref(),
        execution,
        cached_ai_state,
    )
    .await?;

    let content_revision = content_revision(metadata);
    let is_unread = is_unread(metadata, current_user.id);
    let activity_read_sequence = activity_read_sequence(metadata, current_user.id);
    let description = if can_view_detail {
        item.description.clone().unwrap_or_default()
    } else {
        String::new()
    };

    let mut assignment_history = json_array(metadata.assignment_history.as_ref());
    let mut status_history = json_array(metadata.status_history.as_ref());
    enrich_history_names(&mut assignment_history, &context.users);
    enrich_history_names(&mut status_history, &context.users);

    // `context.users.get(item.created_by_user_id)`: the creator's `user_name`.
    let created_by_user_name = match item.created_by_user_id.filter(|id| *id != 0) {
        Some(user_id) if user_id == current_user.id => Some(current_user.user_name.clone()),
        Some(user_id) => match user_names.and_then(|names| names.get(&user_id)) {
            Some(name) => Some(name.clone()),
            None if user_names.is_some() => None,
            None => state
                .user_reader
                .get_entity_by_id(i64::from(user_id))
                .await
                .map_err(|error| {
                    tracing::error!(%error, "loop-item creator lookup failed");
                    HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
                })?
                .map(|record| record.user_name),
        },
        None => None,
    };

    // `issue_badges(metadata) if can_view_detail else []`.
    let badges = if can_view_detail {
        issue_badges(metadata)
    } else {
        Vec::new()
    };

    // `execution_processing_actor` / `execution_human_waiting_since`: only the
    // authoritative newest run identifies the current AI actor or the handoff
    // back to people.
    let processing_actor = execution
        .and_then(|execution| execution_processing_actor(execution, overlay.ai_state.as_ref()));
    let human_waiting_since = execution.and_then(execution_human_waiting_since);

    let human_task_binding = super::human_task_binding::human_task_binding_with_comments(
        state.mysql,
        item,
        current_user.id,
        project,
        preloaded_comments,
    )
    .await?;

    Ok(LoopItemResponse {
        id: item.id.clone(),
        cloud_project_id: item.cloud_project_id.clone(),
        sequence_number: item.sequence_number.unwrap_or(0),
        parent_id: normalize_empty_id(item.parent_id.as_deref()),
        title: item.title.clone().unwrap_or_default(),
        description,
        status: item.status.clone().unwrap_or_default(),
        assignee_user_id: item.assignee_user_id.filter(|id| *id != 0),
        assignee_group_id,
        assignee_group_name,
        assignee_name,
        assignee_agent_id: normalize_empty_id(item.assignee_agent_id.as_deref()),
        assignee_agent_name,
        assignee_team_id: item.assignee_team_id.filter(|id| *id != 0),
        assignee_team_name,
        ai_state: overlay.ai_state,
        processing_actor,
        human_waiting_since,
        human_requests: json_array(metadata.human_requests.as_ref()),
        execution_id: overlay.id,
        execution_state: overlay
            .display_state
            .or_else(|| json_string(metadata.execution_state.as_ref())),
        execution_control_state: overlay.control_state,
        execution_observed_state: overlay.observed_state,
        execution_sync_state: overlay.sync_state,
        execution_attempt_no: overlay.attempt_no,
        execution_last_event_seq: overlay.last_event_seq,
        can_approve: overlay.can_approve,
        assignment_history,
        status_history,
        approval: overlay
            .approval
            .or_else(|| json_object(metadata.approval.as_ref())),
        human_task_binding,
        queued_at: overlay
            .queued_at
            .or_else(|| json_string(metadata.queued_at.as_ref())),
        execution_note: overlay
            .note
            .or_else(|| json_string(metadata.execution_note.as_ref())),
        execution_error: overlay
            .error
            .or_else(|| json_string(metadata.execution_error.as_ref())),
        automation: json_object(metadata.automation.as_ref()),
        workflow: json_object(metadata.workflow.as_ref()).map(|workflow| workflow_view(&workflow)),
        execution_config: execution_config_view(metadata.execution_config.as_ref()),
        priority: item.priority.clone().unwrap_or_default(),
        start_at: isoformat_unset(item.start_at),
        due_at: isoformat_unset(item.due_at),
        sort_order: item.sort_order,
        milestone_id: metadata.milestone_id.clone(),
        tags: normalize_tags(metadata.tags.as_ref()),
        created_by_user_id: i64::from(item.created_by_user_id.unwrap_or(0)),
        created_by_user_name,
        invited_only,
        can_view_detail,
        security_level,
        can_edit: permissions.edit_content,
        permissions,
        detail_loaded: true,
        badges,
        content_revision,
        activity_read_sequence,
        is_unread,
        current_delivery_id: normalize_empty_id(item.current_delivery_id.as_deref()),
        version: item.version,
        created_at: utc_datetime_string(item.created_at).unwrap_or_default(),
        updated_at: utc_datetime_string(item.updated_at).unwrap_or_default(),
        completed_at: isoformat_unset(item.completed_at),
    })
}

/// `issue_permissions(access, issue_creator_user_id, user_id)`
/// (`app.services.cloud_projects.access`): Issue management and execution
/// are independent capabilities.
fn issue_permissions(role: &str, invited_only: bool) -> Permissions {
    let developer = has_permission(role, "Developer");
    Permissions {
        edit_content: developer,
        comment: developer,
        assign: developer,
        execute: developer && !invited_only,
    }
}

/// `issue_badges(metadata)` (`app.services.issue_badges`): the metadata badge
/// objects that carry a string `id` and `label`, in stored order.
fn issue_badges(metadata: &ItemMetadata) -> Vec<Value> {
    issue_badges_value(metadata.badges.as_ref())
}

/// `issue_badges(metadata)` over the raw `metadata["badges"]` value.
///
/// `issue_badges` returns plain dicts, but the response field is
/// `list[IssueBadge]` (`app/schemas/delivery.py:140-146`), so pydantic fills
/// every unset member from the schema defaults before serialization. Apply
/// those defaults here: `url = ""`, `icon = ""`, `tone = "neutral"`,
/// `tooltip = ""`.
pub fn issue_badges_value(badges: Option<&Value>) -> Vec<Value> {
    const DEFAULT_TEXT: &str = "";
    let Some(Value::Array(entries)) = badges else {
        return Vec::new();
    };
    entries
        .iter()
        .filter(|entry| {
            entry.is_object()
                && entry.get("id").is_some_and(Value::is_string)
                && entry.get("label").is_some_and(Value::is_string)
        })
        .map(|entry| {
            let mut badge = entry.as_object().cloned().unwrap_or_default();
            for (key, default) in [
                ("url", DEFAULT_TEXT),
                ("icon", DEFAULT_TEXT),
                ("tone", "neutral"),
                ("tooltip", DEFAULT_TEXT),
            ] {
                badge.entry(key).or_insert_with(|| json!(default));
            }
            Value::Object(badge)
        })
        .collect()
}

#[path = "item_response_execution.rs"]
mod item_response_execution;
pub use item_response_execution::metadata_security_level;
use item_response_execution::*;

/// `content_revision`: the metadata revision when it is an integer >= 1.
fn content_revision(metadata: &ItemMetadata) -> i64 {
    metadata
        .content_revision
        .as_ref()
        .and_then(Value::as_i64)
        .filter(|value| *value >= 1)
        .unwrap_or(1)
}

/// `is_unread`: whether the caller's read revision trails the content
/// revision.
fn is_unread(metadata: &ItemMetadata, user_id: i32) -> bool {
    let revision = content_revision(metadata);
    let Some(Value::Object(read_revisions)) = metadata.read_revisions.as_ref() else {
        return true;
    };
    match read_revisions.get(&user_id.to_string()) {
        Some(Value::Number(value)) => value.as_i64().is_none_or(|read| read < revision),
        _ => true,
    }
}

/// `activity_read_sequence(metadata, user_id)`: the caller's stored activity
/// read sequence, or `0` when absent (`app.services.loop_item_unread`).
fn activity_read_sequence(metadata: &ItemMetadata, user_id: i32) -> i64 {
    let Some(Value::Object(sequences)) = metadata.activity_read_sequences.as_ref() else {
        return 0;
    };
    match sequences.get(&user_id.to_string()).and_then(Value::as_i64) {
        Some(value) if value >= 0 => value,
        _ => 0,
    }
}

#[path = "item_response_views.rs"]
mod item_response_views;
use item_response_views::*;

/// A metadata value that is a JSON string, cloned; otherwise `None`.
fn json_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `_normalize_empty_id` / `normalize_empty_text`: `""` becomes `None`.
fn normalize_empty_id(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

/// `x or None`: an empty string becomes `None`.
fn nonempty(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

/// A JSON value for an optional string: `Some` renders the string, `None`
/// renders JSON null.
fn optional_string(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

/// `database_datetime_as_utc(db, value).isoformat()` (`app.db.timezone`,
/// used for `created_at`/`updated_at` in `response_values`): the stored naive
/// database datetime is session-local UTC+8, so it is reinterpreted in that
/// offset, converted to UTC, and rendered as pydantic's aware datetime
/// (`...Z`, with six fractional digits only when nonzero).
pub fn utc_datetime_string(value: Option<NaiveDateTime>) -> Option<String> {
    /// `MYSQL_SESSION_TIMEZONE` offset (`settings.DATABASE_TIMEZONE`).
    const DB_SESSION_OFFSET_SECONDS: i32 = 8 * 3600;
    value.map(|value| {
        use chrono::TimeZone as _;
        let utc = chrono::FixedOffset::east_opt(DB_SESSION_OFFSET_SECONDS)
            .expect("valid fixed offset")
            .from_local_datetime(&value)
            .single()
            .expect("database datetime is representable")
            .with_timezone(&chrono::Utc)
            .naive_utc();
        let base = utc.format("%Y-%m-%dT%H:%M:%S").to_string();
        if utc.and_utc().timestamp_subsec_nanos() == 0 {
            format!("{base}Z")
        } else {
            format!("{base}.{:06}Z", utc.and_utc().timestamp_subsec_micros())
        }
    })
}

/// pydantic naive-datetime serialization (`isoformat()`): `YYYY-MM-DDTHH:MM:SS`
/// plus six fractional digits when the value has sub-second precision.
pub fn isoformat(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(|value| {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            base
        } else {
            format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
        }
    })
}

/// `normalize_unset_datetime`: the `1970-01-01 00:00:01` sentinel and NULL
/// become `None`.
fn isoformat_unset(value: Option<NaiveDateTime>) -> Option<String> {
    if datetime_is_unset(value) {
        None
    } else {
        isoformat(value)
    }
}

/// `loop_datetime_value_is_unset` (`app.models.delivery`): the model-level
/// unset check that also treats the `1970-01-01 00:00:00` epoch constant as
/// absent, used by `_optional_datetime` for the execution AI-state fields.
fn datetime_model_is_unset(value: Option<NaiveDateTime>) -> bool {
    match value {
        None => true,
        Some(value) => matches!(
            value.format("%Y-%m-%d %H:%M:%S").to_string().as_str(),
            "1970-01-01 00:00:00" | "1970-01-01 00:00:01"
        ),
    }
}

/// `iso(value)`: `_optional_datetime(value).isoformat()` — the model-variant
/// unset datetimes render as `None`.
pub fn isoformat_model_unset(value: Option<NaiveDateTime>) -> Option<String> {
    if datetime_model_is_unset(value) {
        None
    } else {
        isoformat(value)
    }
}

#[cfg(test)]
#[path = "item_response_tests.rs"]
mod tests;
