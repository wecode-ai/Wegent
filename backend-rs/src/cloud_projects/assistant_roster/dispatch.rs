use std::collections::{BTreeMap, BTreeSet};

use brz_http_server::StatusCode;
use brz_mysql::MysqlTransaction;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::SessionUser;
use crate::background_jobs::project::{issues, store};
use crate::cloud_projects::members::has_permission;
use crate::cloud_projects::role_for_priority;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::roster::roster_entries;
use super::{
    ProjectAssistantRosterEntry, authorize_project, automatic, capability_match, digest,
    dispatch_status, dispatch_write_error, text, wegent_agent_id,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DispatchAssignment {
    #[serde(default)]
    roster_entry_id: Option<String>,
    user_id: i64,
    brief: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssistantDispatchRequest {
    intent_id: String,
    goal: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    due_at: Option<String>,
    #[serde(default)]
    manager_user_id: Option<i64>,
    #[serde(default)]
    confirmation_state: String,
    assignments: Vec<DispatchAssignment>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DispatchChild {
    pub(super) issue_id: String,
    pub(super) user_id: i64,
    pub(super) roster_entry_id: String,
    pub(super) status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AssistantDispatchResult {
    pub(super) dispatch_id: String,
    pub(super) intent_id: String,
    pub(super) root_issue_id: String,
    pub(super) manager_user_id: i64,
    pub(super) children: Vec<DispatchChild>,
    pub(super) replayed: bool,
}

fn validate_dispatch(input: &AssistantDispatchRequest) -> Result<(), FastApiError> {
    if input.intent_id.trim().is_empty()
        || input.goal.trim().is_empty()
        || input.assignments.is_empty()
        || input
            .assignments
            .iter()
            .any(|row| row.user_id < 1 || row.brief.trim().is_empty())
    {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Dispatch intent, goal, and scoped briefs are required",
        ));
    }
    Ok(())
}

fn validate_date(value: &str) -> Result<String, FastApiError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| value.to_string())
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map(|_| format!("{value}T23:59:59+08:00"))
        })
        .map_err(|_| {
            FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Invalid dispatch due date",
            )
        })
}

#[brz_http_server::post("/api/v1/cloud-projects/:project_id/assistant-dispatches")]
async fn create_assistant_dispatch(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<AssistantDispatchResult, FastApiError> {
    let mut request: AssistantDispatchRequest = serde_json::from_value(body).map_err(|_| {
        FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, "Invalid dispatch body")
    })?;
    request.intent_id = request.intent_id.trim().to_string();
    request.goal = request.goal.trim().to_string();
    for assignment in &mut request.assignments {
        assignment.brief = assignment.brief.trim().to_string();
    }
    validate_dispatch(&request)?;
    let access = authorize_project(&state.mysql, project_id, user.id, "Developer").await?;
    let roster = roster_entries(state, &access.project.id).await?;
    let roster_by_id = roster
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let mut selected = Vec::new();
    let mut users = BTreeSet::new();
    for assignment in &request.assignments {
        let entry = match assignment.roster_entry_id.as_deref() {
            Some(id) => roster_by_id.get(id).copied(),
            None => roster
                .iter()
                .find(|entry| entry.user_id == assignment.user_id),
        }
        .filter(|entry| entry.user_id == assignment.user_id && entry.enabled)
        .ok_or_else(|| {
            FastApiError::detail(
                StatusCode::CONFLICT,
                "Assistant assignment is not in the authorized roster",
            )
        })?;
        if !users.insert(assignment.user_id) {
            return Err(FastApiError::detail(
                StatusCode::CONFLICT,
                "One member can have only one assistant assignment per dispatch",
            ));
        }
        selected.push((assignment, entry));
    }
    if request.confirmation_state != "confirmed" {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Assistant dispatch requires confirmed assignments",
        ));
    }
    let manager = match request.manager_user_id {
        Some(id) => id,
        None => selected
            .iter()
            .max_by_key(|(_, entry)| capability_match(entry, &request.goal, &request.description))
            .map(|(assignment, _)| assignment.user_id)
            .unwrap_or_else(|| i64::from(user.id)),
    };
    let manager_roster_entry = roster.iter().find(|entry| entry.user_id == manager);
    if !users.contains(&manager)
        && manager != i64::from(user.id)
        && !has_permission(
            role_for_priority(access.priority).unwrap_or("Viewer"),
            "Maintainer",
        )
    {
        return Err(FastApiError::forbidden(
            "Dispatch coordinator must be a selected member or project maintainer",
        ));
    }
    if !users.contains(&manager) && manager != i64::from(user.id) {
        authorize_project(
            &state.mysql,
            project_id,
            i32::try_from(manager).map_err(|_| FastApiError::validation(json!([])))?,
            "Developer",
        )
        .await?;
    }
    let manager_name = if let Some(entry) = manager_roster_entry {
        entry.user_name.clone()
    } else if manager == i64::from(user.id) {
        user.user_name.clone()
    } else {
        state
            .user_reader
            .get_entity_by_id(manager)
            .await
            .map_err(|_| FastApiError::internal())?
            .map(|user| user.user_name)
            .ok_or_else(|| FastApiError::validation(json!([])))?
    };
    let dispatch_id = digest(&[
        "assistant-dispatch",
        &access.project.id,
        &user.id.to_string(),
        &request.intent_id,
    ]);
    let request_fingerprint = serde_json::to_string(&request)
        .map(|value| digest(&[&value]))
        .map_err(|_| FastApiError::validation(json!([])))?;
    let due_at = request.due_at.as_deref().map(validate_date).transpose()?;
    let (result, pending) = state
        .mysql
        .with_transaction(async |tx| {
            // Project locking serializes sequence allocation and intent requests.
            let locked_project = store::locked(tx, "project", &access.project.id)
                .await?
                .ok_or(brz_mysql::MysqlError::RowNotFound)?;
            if let Some(existing) = store::locked(tx, "assistant_dispatch", &dispatch_id).await? {
                if existing.metadata.0["request_fingerprint"]
                    .as_str()
                    .is_some_and(|value| value != request_fingerprint)
                {
                    return Err(brz_mysql::MysqlError::InvalidQuery {
                        reason: "intent id already has different dispatch content".into(),
                    });
                }
                return Ok((
                    dispatch_from_metadata(
                        &dispatch_id,
                        &request.intent_id,
                        existing.metadata.0,
                        true,
                    ),
                    Vec::new(),
                ));
            }
            let mut checked_entries = BTreeSet::new();
            for entry in selected
                .iter()
                .map(|(_, entry)| *entry)
                .chain(manager_roster_entry)
            {
                if !checked_entries.insert(entry.id.as_str()) {
                    continue;
                }
                let current = store::locked(tx, "project_assistant_roster", &entry.id)
                    .await?
                    .ok_or_else(|| brz_mysql::MysqlError::InvalidQuery {
                        reason: "assistant roster changed before dispatch".into(),
                    })?;
                if current.status != "active"
                    || current.user_id != entry.user_id
                    || current.version != entry.version
                {
                    return Err(brz_mysql::MysqlError::InvalidQuery {
                        reason: "assistant roster changed before dispatch".into(),
                    });
                }
            }
            let mut sequence = locked_project.next_item_number;
            let root_context = json!({
                "dispatch_id": dispatch_id,
                "intent_id": request.intent_id,
                "assistant_dispatch": true,
                "risk_ceiling": "low",
            });
            let mut root_metadata = issues::issue_metadata(
                &locked_project,
                i64::from(user.id),
                &request.goal,
                &request.description,
                &["assistant-dispatch"],
                &root_context,
            );
            root_metadata["assignment_history"] = json!([{
                "by_user_id": user.id,
                "to_type": "user",
                "to_id": manager.to_string(),
                "to_name": manager_name,
                "action": "assign",
                "at": Utc::now().to_rfc3339(),
            }]);
            root_metadata["assistant_dispatch_role"] = json!("manager");
            let root = issues::insert_issue_on(
                tx,
                &locked_project,
                i64::from(user.id),
                &request.goal,
                &request.description,
                &root_context,
                sequence,
                root_metadata,
            )
            .await?;
            let root_due = due_at.clone().unwrap_or_default();
            tx.execute(
                "UPDATE loop_items SET assignee_user_id=?,due_at=CASE WHEN ?='' THEN due_at ELSE ? END,updated_at=UTC_TIMESTAMP(6) WHERE id=?",
                (manager, root_due.as_str(), root_due.as_str(), root.id.as_str()),
            )
            .await?;
            let assigned_root = store::locked(tx, "task", &root.id)
                .await?
                .ok_or(brz_mysql::MysqlError::RowNotFound)?;
            let mut pending = Vec::new();
            let manager_entry = selected
                .iter()
                .find(|(assignment, _)| assignment.user_id == manager)
                .map(|(_, entry)| *entry)
                .or_else(|| roster.iter().find(|entry| entry.user_id == manager));
            if let Some(manager_entry) = manager_entry.filter(|entry| {
                entry.endpoint_kind == "wegent_agent" && automatic(entry)
            })
            {
                if let Some(notification) = enqueue_wegent_agent(
                    tx,
                    state,
                    WegentEnqueue {
                        project: &locked_project,
                        issue: &assigned_root,
                        entry: manager_entry,
                        dispatch_id: &dispatch_id,
                        brief: if request.description.trim().is_empty() {
                            &request.goal
                        } else {
                            &request.description
                        },
                        context: root_context.clone(),
                        assigner: i64::from(user.id),
                        dispatch_role: "manager",
                    },
                )
                .await?
                {
                    pending.push(notification);
                }
            } else {
                let (root_assignment_id, _) =
                    crate::background_jobs::project::assignments::record(
                        tx,
                        &assigned_root,
                        "human",
                        &manager.to_string(),
                        &manager_name,
                        i64::from(user.id),
                        true,
                        "manual",
                        &Value::Null,
                    )
                    .await?;
                if let Some(notification) =
                    crate::background_jobs::project::notifications::direct_human_on(
                        tx,
                        state,
                        &locked_project,
                        &assigned_root,
                        manager,
                        i64::from(user.id),
                        &manager_name,
                        &root_assignment_id,
                    )
                    .await?
                {
                    pending.push(notification);
                }
            }
            sequence += 1;
            let mut children = Vec::new();
            for (assignment, entry) in &selected {
                let child_context = json!({
                    "dispatch_id": dispatch_id,
                    "intent_id": request.intent_id,
                    "parent_issue_id": root.id,
                    "assistant_roster_entry_id": entry.id,
                    "owner_user_id": assignment.user_id,
                    "publish_policy": "summary_only",
                });
                let mut metadata = issues::issue_metadata(
                    &locked_project,
                    i64::from(user.id),
                    &request.goal,
                    &assignment.brief,
                    &["assistant-dispatch", "scoped-assignment"],
                    &child_context,
                );
                metadata["assistant_brief"] = json!(assignment.brief);
                metadata["assistant_owner_user_id"] = json!(assignment.user_id);
                metadata["assistant_endpoint_ref"] = json!(entry.endpoint_ref);
                metadata["assistant_autonomy_policy"] = entry.autonomy_policy.clone();
                metadata["publish_policy"] = json!("summary_only");
                metadata["assistant_dispatch_role"] = json!("member");
                metadata["awaiting_public_summary"] = json!(true);
                metadata["assignment_history"] = json!([{
                    "by_user_id": user.id,
                    "to_type": "user",
                    "to_id": assignment.user_id.to_string(),
                    "to_name": entry.user_name,
                    "action": "assign",
                    "at": Utc::now().to_rfc3339(),
                }]);
                if entry.availability == "offline" {
                    metadata["queued_reason"] = json!("waiting_device");
                } else if !automatic(entry) {
                    metadata["queued_reason"] = json!("waiting_confirmation");
                }
                let child = issues::insert_issue_on(
                    tx,
                    &locked_project,
                    i64::from(user.id),
                    &format!("{} · {}", request.goal, entry.user_name),
                    &assignment.brief,
                    &child_context,
                    sequence,
                    metadata,
                )
                .await?;
                sequence += 1;
                tx.execute(
                    "UPDATE loop_items SET parent_id=?,assignee_user_id=?,status=?,due_at=CASE WHEN ?='' THEN due_at ELSE ? END,updated_at=UTC_TIMESTAMP(6) WHERE id=?",
                    (
                        root.id.as_str(),
                        assignment.user_id,
                        if dispatch_status(entry) == "queued" {
                            "queued"
                        } else {
                            "pending"
                        },
                        due_at.clone().unwrap_or_default(),
                        due_at.clone().unwrap_or_default(),
                        child.id.as_str(),
                    ),
                )
                .await?;
                let assigned = store::locked(tx, "task", &child.id)
                    .await?
                    .ok_or(brz_mysql::MysqlError::RowNotFound)?;
                if entry.endpoint_kind == "wegent_agent" && automatic(entry) {
                    if let Some(notification) = enqueue_wegent_agent(
                        tx,
                        state,
                        WegentEnqueue {
                            project: &locked_project,
                            issue: &assigned,
                            entry,
                            dispatch_id: &dispatch_id,
                            brief: &assignment.brief,
                            context: child_context.clone(),
                            assigner: i64::from(user.id),
                            dispatch_role: "member",
                        },
                    )
                    .await?
                    {
                        pending.push(notification);
                    }
                } else {
                    let (assignment_id, _) =
                        crate::background_jobs::project::assignments::record(
                            tx,
                            &assigned,
                            "human",
                            &assignment.user_id.to_string(),
                            &entry.user_name,
                            i64::from(user.id),
                            true,
                            "manual",
                            &Value::Null,
                        )
                        .await?;
                    if let Some(notification) =
                        crate::background_jobs::project::notifications::direct_human_on(
                            tx,
                            state,
                            &locked_project,
                            &assigned,
                            assignment.user_id,
                            i64::from(user.id),
                            &entry.user_name,
                            &assignment_id,
                        )
                        .await?
                    {
                        pending.push(notification);
                    }
                }
                children.push(DispatchChild {
                    issue_id: child.id,
                    user_id: assignment.user_id,
                    roster_entry_id: entry.id.clone(),
                    status: dispatch_status(entry).into(),
                });
            }
            tx.execute(
                "UPDATE loop_items SET next_item_number=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?",
                (sequence, locked_project.id.as_str()),
            )
            .await?;
            let metadata = json!({
                "intent_id": request.intent_id,
                "root_issue_id": root.id,
                "manager_user_id": manager,
                "children": children,
                "creator_user_id": user.id,
                "request_fingerprint": request_fingerprint,
            });
            crate::background_jobs::project::store::insert(
                tx,
                "assistant_dispatch",
                json!({
                    "id": dispatch_id,
                    "cloud_project_id": access.project.id,
                    "user_id": user.id,
                    "title": request.goal,
                    "status": "dispatched",
                    "metadata": metadata,
                }),
            )
            .await?;
            Ok((
                AssistantDispatchResult {
                    dispatch_id: dispatch_id.clone(),
                    intent_id: request.intent_id.clone(),
                    root_issue_id: root.id,
                    manager_user_id: manager,
                    children,
                    replayed: false,
                },
                pending,
            ))
        })
        .await
        .map_err(dispatch_write_error)?;
    for notification in pending {
        crate::background_jobs::project::notifications::deliver(state, notification).await;
    }
    Ok(result)
}

struct WegentEnqueue<'a> {
    project: &'a store::Node,
    issue: &'a store::Node,
    entry: &'a ProjectAssistantRosterEntry,
    dispatch_id: &'a str,
    brief: &'a str,
    context: Value,
    assigner: i64,
    dispatch_role: &'a str,
}

async fn enqueue_wegent_agent(
    tx: &mut impl MysqlTransaction,
    state: &AppState,
    request: WegentEnqueue<'_>,
) -> brz_mysql::MysqlResult<Option<crate::background_jobs::project::notifications::Pending>> {
    let WegentEnqueue {
        project,
        issue,
        entry,
        dispatch_id,
        brief,
        mut context,
        assigner,
        dispatch_role,
    } = request;
    let agent_id = wegent_agent_id(&entry.endpoint_ref).ok_or_else(|| {
        brz_mysql::MysqlError::InvalidQuery {
            reason: "Wegent endpoint has no project Agent id".into(),
        }
    })?;
    let owner = issue.assignee_user_id;
    let agent = crate::background_jobs::project::authority::agent(
        state,
        &project.id,
        agent_id,
        owner,
        true,
    )
    .await
    .map_err(|error| brz_mysql::MysqlError::InvalidQuery {
        reason: error.to_string(),
    })?;
    context["dispatch_id"] = json!(dispatch_id);
    context["assistant_roster_entry_id"] = json!(entry.id);
    context["assistant_endpoint_ref"] = json!(entry.endpoint_ref);
    context["dispatch_role"] = json!(dispatch_role);
    context["runtime_subject_user_id"] = json!(owner);
    context["runtime_source"] = json!("agent_default");
    context["publish_policy"] = json!("summary_only");
    let mut plan = crate::background_jobs::project::assignments::agent_admission(
        state, issue, &agent, assigner, context, brief, None,
    )
    .await
    .map_err(|error| brz_mysql::MysqlError::InvalidQuery {
        reason: error.to_string(),
    })?;
    if entry.availability == "offline" {
        plan.waiting_runtime = true;
    }
    let mut run = project.clone();
    run.id.clear();
    let execution =
        crate::background_jobs::project::queue::enqueue_on(tx, state, issue, &run, &plan).await?;
    let (_assignment_id, _) = crate::background_jobs::project::assignments::record(
        tx,
        issue,
        "agent",
        &agent.id,
        &entry.display_name,
        assigner,
        true,
        "manual",
        &Value::Null,
    )
    .await?;
    tx.execute(
        "UPDATE loop_items SET assignee_agent_id=?,status=?,metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),'$.execution_id',?),version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",
        (
            agent.id.as_str(),
            if entry.availability == "offline" {
                "pending"
            } else {
                "queued"
            },
            execution.id,
            issue.id.as_str(),
        ),
    )
    .await?;
    crate::background_jobs::project::notifications::execution_on(
        tx,
        state,
        project,
        issue,
        execution.id,
        plan.owner,
        &execution.status,
        "",
    )
    .await
}

pub(super) fn dispatch_from_metadata(
    dispatch_id: &str,
    intent_id: &str,
    metadata: Value,
    replayed: bool,
) -> AssistantDispatchResult {
    AssistantDispatchResult {
        dispatch_id: dispatch_id.into(),
        intent_id: intent_id.into(),
        root_issue_id: text(&metadata, "root_issue_id"),
        manager_user_id: metadata["manager_user_id"].as_i64().unwrap_or_default(),
        children: serde_json::from_value(metadata["children"].clone()).unwrap_or_default(),
        replayed,
    }
}
