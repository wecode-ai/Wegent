//! Keep project access, Issue visibility, execution ownership and device identity separate.

use std::collections::{BTreeSet, HashMap};

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql};
use serde_json::Value;

use crate::cloud_projects::authorized_project;
use crate::device_identity::{owned_device_identity_ids, resolve_owned_device_alias};
use crate::http_compat::FastApiError;
use crate::loop_tasks::assignment_repository::{LOOP_ITEMS_UNLABELED, LoopItemGetRow};
use crate::loop_tasks::loop_repository::{LoopItemRepository, has_permission};
use crate::state::AppState;

use super::{database_error, error, request::SearchRequest};

pub(super) struct Target {
    pub owner_id: i64,
    pub task_id: String,
    pub project_bound: bool,
}

pub(super) async fn resolve(
    state: &AppState,
    caller: i32,
    request: &SearchRequest,
) -> Result<Target, FastApiError> {
    let Some((project_id, issue_id)) = &request.project_session else {
        let device =
            resolve_owned_device_alias(&state.mysql, i64::from(caller), &request.device_id)
                .await
                .map_err(database_error)?;
        if device.is_none() {
            return Err(error(
                StatusCode::NOT_FOUND,
                "Device not found or access denied",
            ));
        }
        return Ok(Target {
            owner_id: i64::from(caller),
            task_id: request.task_id.clone(),
            project_bound: false,
        });
    };
    require_issue(state, caller, project_id, issue_id).await?;
    bound_target(
        &state.mysql,
        project_id,
        issue_id,
        &request.device_id,
        &request.task_id,
    )
    .await
}

async fn require_issue(
    state: &AppState,
    caller: i32,
    project_id: &str,
    issue_id: &str,
) -> Result<(), FastApiError> {
    let number = project_id
        .parse()
        .map_err(|_| error(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    let (project, role) = authorized_project(&state.mysql, number, caller)
        .await
        .map_err(database_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Cloud project not found"))?;
    let item: Option<LoopItemGetRow> = state.mysql.fetch_optional(
        format!("SELECT {LOOP_ITEMS_UNLABELED} FROM loop_items WHERE id = ? AND cloud_project_id = ? \
            AND resource_type = 'task' AND (deleted_at IS NULL OR deleted_at IN \
            ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) LIMIT 1"),
        (issue_id, project_id)).await.map_err(database_error)?;
    let repository = LoopItemRepository::new(&state.mysql);
    let metadata = project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref());
    let Some(item) = item else {
        if matches!(
            metadata.and_then(|metadata| metadata.task_provider.as_deref()),
            Some("github" | "gitlab")
        ) {
            return require_external_issue(state, caller, project_id, issue_id, role).await;
        }
        return Err(error(StatusCode::NOT_FOUND, "Project task not found"));
    };
    let explicit = item
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.security_level.as_ref())
        .and_then(Value::as_str);
    let related = match explicit {
        Some("related") => true,
        Some("open") => false,
        _ => {
            metadata.and_then(|metadata| metadata.default_issue_security.as_deref())
                == Some("related")
        }
    };
    if !has_permission(role, "Maintainer")
        && related
        && !repository
            .is_related_item(&item.id, caller)
            .await
            .map_err(database_error)?
    {
        return Err(error(StatusCode::NOT_FOUND, "Project task not found"));
    }
    Ok(())
}

async fn require_external_issue(
    state: &AppState,
    caller: i32,
    project_id: &str,
    issue_id: &str,
    role: &str,
) -> Result<(), FastApiError> {
    let project = LoopItemRepository::new(&state.mysql)
        .find_external_project(issue_id)
        .await
        .map_err(database_error)?
        .filter(|project| project.id == project_id)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Project task not found"))?;
    let number = issue_id
        .rsplit_once('-')
        .and_then(|(_, number)| number.parse::<i64>().ok())
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Project task not found"))?;
    let issue = crate::loop_tasks::assignments::get_issue(state, &project, number).await?;
    let response =
        crate::loop_item_pages::projection::issue_response(state, &project, role, caller, &issue)
            .await
            .map_err(database_error)?;
    if !response.can_view_detail() {
        return Err(error(StatusCode::NOT_FOUND, "Project task not found"));
    }
    Ok(())
}

#[derive(Debug, FromMysqlRow)]
pub(super) struct Execution {
    pub id: i64,
    pub executor_owner_user_id: i64,
    pub runtime_device_id: String,
    pub runtime_task_id: String,
    pub execution_payload: String,
}

impl Execution {
    fn intent(&self) -> Value {
        serde_json::from_str(&self.execution_payload).unwrap_or(Value::Null)
    }

    fn is_dispatch(&self) -> bool {
        let intent = self.intent();
        intent
            .get("runtime_selection")
            .filter(|selection| selection.is_object())
            .unwrap_or(&intent)
            .get("executor_kind")
            .and_then(Value::as_str)
            == Some("collaboration_group_dispatch")
    }

    fn origin(&self) -> Value {
        self.intent()
            .get("origin_context")
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub fn conversation_id(&self) -> String {
        let task = if self.runtime_task_id.is_empty() {
            self.origin()
                .get("comment_continue_task_id")
                .and_then(Value::as_str)
                .filter(|task| !task.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("codex-queue-{}", self.id))
        } else {
            self.runtime_task_id.clone()
        };
        if self.is_dispatch() {
            format!("{task}-manager-initial")
        } else {
            task
        }
    }
}

#[derive(Debug, FromMysqlRow)]
struct Binding {
    task_user_id: Option<i64>,
    device_id: String,
}

#[derive(Debug, FromMysqlRow)]
pub(super) struct Activity {
    pub agent_id: String,
    pub runtime_device_id: String,
    pub runtime_task_id: String,
    pub metadata: Value,
    pub active: i64,
}

pub(super) async fn bound_target<M: Mysql>(
    mysql: &M,
    project_id: &str,
    issue_id: &str,
    device: &str,
    task: &str,
) -> Result<Target, FastApiError> {
    let executions: Vec<Execution> = mysql.fetch_all(
        "SELECT id, executor_owner_user_id, runtime_device_id, runtime_task_id, execution_payload \
         FROM loop_item_executions WHERE cloud_project_id = ? AND loop_item_id = ? \
         AND runtime_task_id IN (?, ?)",
        (project_id, issue_id, task, task.strip_suffix("-manager-initial").unwrap_or(task))).await.map_err(database_error)?;
    let bindings: Vec<Binding> = mysql.fetch_all(
        "SELECT task_user_id, device_id FROM loop_items WHERE resource_type = 'execution' \
         AND cloud_project_id = ? AND loop_item_id = ? AND task_id = ? \
         AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND (unlinked_at IS NULL OR unlinked_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))",
        (project_id, issue_id, task)).await.map_err(database_error)?;
    let mut aliases = HashMap::new();
    for owner in executions
        .iter()
        .map(|row| row.executor_owner_user_id)
        .chain(bindings.iter().filter_map(|row| row.task_user_id))
        .collect::<BTreeSet<_>>()
    {
        aliases.insert(
            owner,
            owned_device_identity_ids(mysql, owner, device)
                .await
                .map_err(database_error)?,
        );
    }
    let executions: Vec<&Execution> = executions
        .iter()
        .filter(|row| execution_matches(row, task, &aliases))
        .collect();
    let mut owners: BTreeSet<i64> = executions
        .iter()
        .map(|row| row.executor_owner_user_id)
        .collect();
    for binding in bindings {
        if let Some(owner) = binding.task_user_id
            && aliases
                .get(&owner)
                .is_some_and(|ids| ids.contains(&binding.device_id))
        {
            owners.insert(owner);
        }
    }
    if owners.is_empty() {
        owners = member_owners(mysql, project_id, issue_id, device, task).await?;
    }
    finish_target(
        owners,
        executions.iter().map(|row| row.conversation_id()).collect(),
        task,
    )
}

pub(super) fn execution_matches(
    row: &Execution,
    task: &str,
    aliases: &HashMap<i64, Vec<String>>,
) -> bool {
    let candidate = task.strip_suffix("-manager-initial").unwrap_or(task);
    (row.runtime_task_id == task
        || row.runtime_task_id == candidate && task == row.conversation_id())
        && aliases
            .get(&row.executor_owner_user_id)
            .is_some_and(|ids| ids.contains(&row.runtime_device_id))
}

pub(super) fn finish_target(
    owners: BTreeSet<i64>,
    tasks: BTreeSet<String>,
    submitted: &str,
) -> Result<Target, FastApiError> {
    if owners.is_empty() || owners.contains(&0) {
        return Err(error(
            StatusCode::NOT_FOUND,
            "Project session binding not found",
        ));
    }
    if owners.len() != 1 {
        return Err(error(
            StatusCode::CONFLICT,
            "Project session has conflicting execution owners",
        ));
    }
    if tasks.len() > 1 {
        return Err(error(
            StatusCode::CONFLICT,
            "Project session has conflicting Runtime task identities",
        ));
    }
    Ok(Target {
        owner_id: *owners.first().unwrap(),
        task_id: tasks
            .first()
            .cloned()
            .unwrap_or_else(|| submitted.to_owned()),
        project_bound: true,
    })
}

async fn member_owners<M: Mysql>(
    mysql: &M,
    project_id: &str,
    issue_id: &str,
    device: &str,
    task: &str,
) -> Result<BTreeSet<i64>, FastApiError> {
    let activities: Vec<Activity> = mysql.fetch_all(
        "SELECT agent_id, runtime_device_id, runtime_task_id, metadata, \
         (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AS active \
         FROM project_chat_messages WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC",
        (project_id, issue_id)).await.map_err(database_error)?;
    let dispatches: Vec<Execution> = mysql.fetch_all(
        "SELECT id, executor_owner_user_id, runtime_device_id, runtime_task_id, execution_payload \
         FROM loop_item_executions WHERE cloud_project_id = ? AND loop_item_id = ?",
        (project_id, issue_id)).await.map_err(database_error)?;
    let mut owners = BTreeSet::new();
    for target in activities.iter().filter(|row| {
        row.active != 0
            && row.runtime_task_id == task
            && row.metadata.get("activity_type").and_then(Value::as_str) == Some("member_execution")
    }) {
        let dispatch = dispatches
            .iter()
            .find(|row| {
                row.is_dispatch()
                    && (target.metadata.get("execution_id").and_then(Value::as_i64) == Some(row.id)
                        || target
                            .metadata
                            .get("dispatch_id")
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                            .is_some_and(|id| {
                                row.origin().get("dispatch_id").and_then(Value::as_str) == Some(id)
                            }))
            })
            .filter(|row| !row.runtime_device_id.is_empty())
            .ok_or_else(|| {
                error(
                    StatusCode::CONFLICT,
                    "The collaboration activity has no execution binding",
                )
            })?;
        let aliases = owned_device_identity_ids(mysql, dispatch.executor_owner_user_id, device)
            .await
            .map_err(database_error)?;
        if !aliases.contains(&target.runtime_device_id) {
            continue;
        }
        member_assignment(dispatch, target, &activities)?;
        let manager = resolve_owned_device_alias(
            mysql,
            dispatch.executor_owner_user_id,
            &dispatch.runtime_device_id,
        )
        .await
        .map_err(database_error)?;
        let member = resolve_owned_device_alias(
            mysql,
            dispatch.executor_owner_user_id,
            &target.runtime_device_id,
        )
        .await
        .map_err(database_error)?;
        if manager.is_none()
            || manager.as_ref().map(|row| row.id) != member.as_ref().map(|row| row.id)
        {
            return Err(error(
                StatusCode::CONFLICT,
                "The collaboration member session does not match its assignment",
            ));
        }
        owners.insert(dispatch.executor_owner_user_id);
    }
    Ok(owners)
}

pub(super) fn member_assignment(
    dispatch: &Execution,
    target: &Activity,
    activities: &[Activity],
) -> Result<(), FastApiError> {
    let metadata = &target.metadata;
    let fields: Option<Vec<&str>> = ["dispatch_id", "coordination_round_id", "assignment_id"]
        .iter()
        .map(|key| {
            metadata
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .collect();
    let fields = fields
        .filter(|_| !target.runtime_device_id.is_empty() && !target.runtime_task_id.is_empty())
        .ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "The collaboration member session identity is incomplete",
            )
        })?;
    let assignment = activities
        .iter()
        .find(|row| {
            row.metadata.get("activity_type").and_then(Value::as_str) == Some("manager_assignment")
                && row.metadata.get("dispatch_id") == metadata.get("dispatch_id")
                && row.metadata.get("coordination_round_id")
                    == metadata.get("coordination_round_id")
        })
        .and_then(|row| row.metadata.get("dispatch_assignments"))
        .and_then(Value::as_array)
        .and_then(|assignments| {
            assignments.iter().find(|entry| {
                entry.get("assignment_id").and_then(Value::as_str) == Some(fields[2])
                    && entry.get("assignee_type").and_then(Value::as_str) == Some("agent")
            })
        })
        .ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "The collaboration member assignment is unavailable",
            )
        })?;
    let expected = format!(
        "{}-member-{}-{}",
        dispatch.runtime_task_id, fields[1], fields[2]
    );
    if target.runtime_task_id != expected
        || assignment.get("agent_id").and_then(Value::as_str) != Some(&target.agent_id)
        || assignment.get("runtime_task_id").and_then(Value::as_str) != Some(&expected)
    {
        return Err(error(
            StatusCode::CONFLICT,
            "The collaboration member session does not match its assignment",
        ));
    }
    Ok(())
}
