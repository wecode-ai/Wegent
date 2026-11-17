// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Device consent resolves only assignment-owned intents already in the ledger.

mod schema;
#[cfg(test)]
mod tests;

use brz_mysql::{Json, MysqlResult, MysqlTransaction};
use chrono::Utc;
use serde_json::{Value, json};

use crate::background_jobs::project::{authority, queue, store};
use crate::background_jobs::robot::{self, model::Execution};
use crate::device_identity::{DeviceKindRow, KINDS_DEVICE_QUERY, resolve_owned_device_alias_on};
use crate::loop_tasks::{
    assignments::active_events,
    loop_repository::{CommentRow, item_comments_query},
};
use crate::plugins_marketplace::query::PluginQuery;
use crate::state::AppState;

use super::{project_chat_snapshot, runtime::SocketRuntime};

pub(super) fn normalize(value: &Value) -> Value {
    schema::normalize(value)
}

const DISPATCH_PATH: &str = "$.human_assistant_dispatch";

fn enabled() -> bool {
    flag_enabled("HUMAN_ASSIGNMENT_RECEIPTS_ENABLED")
}

fn flag_enabled(name: &str) -> bool {
    crate::config::env_or_dotenv(name).is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        )
    })
}

/// The handler has already validated the authenticated installation and session.
pub(super) async fn synchronize(
    state: &AppState,
    runtime: &SocketRuntime,
    user_id: i64,
    device_id: &str,
    features: Option<&Value>,
) -> MysqlResult<()> {
    let declaration = features.and_then(|features| features.get("personalAssistantDispatch"));
    if declaration.is_none() && !enabled() {
        return Ok(());
    }
    if let Some(declaration) = declaration {
        let declaration = schema::owned(declaration, user_id);
        state
            .mysql
            .with_transaction(async |tx| persist_on(tx, user_id, device_id, &declaration).await)
            .await?;
    }
    let issues: Vec<(String,)> = state
        .mysql
        .fetch_all(
            "SELECT issue.id FROM loop_items issue WHERE issue.resource_type='task' \
         AND issue.assignee_user_id=? AND EXISTS (SELECT 1 FROM loop_items assignment \
         WHERE assignment.loop_item_id=issue.id AND assignment.resource_type='comment' \
         AND JSON_TYPE(JSON_EXTRACT(assignment.metadata,'$.human_assistant_dispatch'))='OBJECT')",
            (user_id,),
        )
        .await?;
    for (issue_id,) in issues {
        let effects = state
            .mysql
            .with_transaction(async |tx| refresh_issue_on(tx, &issue_id, user_id, enabled()).await)
            .await?;
        if effects.changed {
            project_chat_snapshot::publish_item_change_with_reason(
                state,
                runtime,
                &issue_id,
                user_id,
                "human_assistant_dispatch",
            )
            .await;
        }
        robot::request_runtime_cancellations(state, &effects.cancellations).await;
    }
    Ok(())
}

async fn persist_on(
    tx: &mut impl MysqlTransaction,
    user_id: i64,
    device_id: &str,
    declaration: &Value,
) -> MysqlResult<bool> {
    let mut query = &mut *tx;
    let Some(device) = resolve_owned_device_alias_on(&mut query, user_id, device_id).await? else {
        return Ok(false);
    };
    let current: Option<DeviceKindRow> = tx
        .fetch_optional(
            format!("{KINDS_DEVICE_QUERY} AND kinds.id=? AND kinds.name=? FOR UPDATE"),
            (user_id, device.id, device.name.as_str()),
        )
        .await?;
    let Some(current) = current else {
        return Ok(false);
    };
    if current.json["spec"]["personalAssistantDispatch"] == *declaration {
        return Ok(false);
    }
    let result = tx
        .execute(
            "UPDATE kinds SET json=JSON_SET(json,'$.spec.personalAssistantDispatch',CAST(? AS JSON)), \
         updated_at=UTC_TIMESTAMP(6) WHERE id=? AND user_id=? AND name=? \
         AND namespace='default' AND kind='Device' AND is_active=true",
            (
                Json(declaration.clone()),
                current.id,
                user_id,
                current.name.as_str(),
            ),
        )
        .await?;
    Ok(result.rows_affected == 1)
}

#[derive(Default)]
struct Effects {
    changed: bool,
    cancellations: Vec<Execution>,
}

async fn refresh_issue_on(
    tx: &mut impl MysqlTransaction,
    issue_id: &str,
    owner: i64,
    may_create: bool,
) -> MysqlResult<Effects> {
    let issue: Option<store::Node> = tx
        .fetch_optional(
            format!(
                "SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND {} FOR UPDATE",
                store::COLUMNS,
                store::LIVE
            ),
            (issue_id,),
        )
        .await?;
    let Some(issue) = issue.filter(|issue| issue.assignee_user_id == owner) else {
        return Ok(Effects::default());
    };
    let comments: Vec<CommentRow> = tx
        .fetch_all(format!("{} FOR UPDATE", item_comments_query()), (issue_id,))
        .await?;
    let owner_id = owner.to_string();
    let assignment = active_events(&comments).into_iter().find(|event| {
        matches!(
            event.metadata.target_type.as_deref(),
            Some("human" | "user")
        ) && event.metadata.target_id.as_deref() == Some(owner_id.as_str())
            && event
                .metadata
                .human_assistant_dispatch
                .as_ref()
                .is_some_and(|dispatch| {
                    super::human_automation::stage_matches(
                        event.metadata.workflow_step.as_deref(),
                        dispatch,
                    ) && valid_assignment(
                        dispatch,
                        &issue,
                        owner,
                        &event.comment.id,
                        event.metadata.assignment_version,
                    )
                })
    });
    let Some(assignment) = assignment else {
        return Ok(Effects::default());
    };
    let mut dispatch = assignment
        .metadata
        .human_assistant_dispatch
        .clone()
        .expect("existing intent");
    if terminal_dispatch(&dispatch) {
        return Ok(Effects::default());
    }
    let before = dispatch.clone();
    let mut effects = Effects::default();
    let resolution = endpoint_on(tx, &issue, owner).await?;
    let reason = if matches!(issue.status.as_str(), "completed" | "cancelled" | "deleted") {
        Some("issue_closed")
    } else if !authorized_on(tx, &issue, owner).await? {
        Some("permission_denied")
    } else if resolution.endpoint.is_none() {
        Some(resolution.reason)
    } else {
        None
    };
    if let Some(reason) = reason {
        revoke_on(tx, &issue, owner, &mut dispatch, reason, &mut effects).await?;
    } else if may_create
        && (super::human_automation::context(&dispatch).is_none()
            || flag_enabled("HUMAN_AUTOMATION_RECEIPTS_ENABLED"))
    {
        let (device, role) = resolution.endpoint.expect("authorized endpoint");
        admit_on(
            tx,
            &issue,
            assignment.comment,
            &mut dispatch,
            &device,
            &role,
        )
        .await?;
    }
    if before != dispatch {
        dispatch["updatedAt"] = json!(Utc::now().to_rfc3339());
        tx.execute(
            "UPDATE loop_items SET metadata=JSON_SET(metadata,?,CAST(? AS JSON)),updated_at=CURRENT_TIMESTAMP(6) \
             WHERE id=? AND loop_item_id=? AND resource_type='comment'",
            (
                DISPATCH_PATH,
                Json(dispatch),
                assignment.comment.id.as_str(),
                issue.id.as_str(),
            ),
        )
        .await?;
        effects.changed = true;
    }
    Ok(effects)
}

fn terminal_dispatch(dispatch: &Value) -> bool {
    matches!(
        dispatch["dispatchState"].as_str(),
        Some("completed" | "failed" | "cancelled" | "superseded" | "cancelling")
    )
}

fn valid_assignment(
    dispatch: &Value,
    issue: &store::Node,
    owner: i64,
    assignment: &str,
    version: Option<i64>,
) -> bool {
    dispatch["assignmentId"] == assignment
        && super::human_automation::context(dispatch)
            .is_none_or(|context| context["assignment_id"] == assignment)
        && dispatch["issueId"] == issue.id
        && dispatch["projectId"] == issue.cloud_project_id
        && dispatch["ownerUserId"].as_i64() == Some(owner)
        && version.is_some()
        && dispatch["assignmentVersion"].as_i64() == version
        && dispatch["dispatchId"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
}

/// Personal consent replaces Agent and project-device grants, while assignment
/// authority and the owner's current project/Issue permission remain required.
pub(crate) async fn require_current_on(
    query: &mut impl PluginQuery,
    issue: &store::Node,
    row: &Execution,
) -> anyhow::Result<()> {
    let owner = row.executor_owner_user_id;
    anyhow::ensure!(
        owner > 0
            && row.assigner_user_id == owner
            && issue.assignee_user_id == owner
            && issue.id == row.loop_item_id
            && issue.cloud_project_id == row.cloud_project_id
            && !matches!(issue.status.as_str(), "completed" | "cancelled" | "deleted"),
        "Personal assignment is no longer active"
    );
    let active: Option<(i64,)> = query
        .fetch_optional(
            "SELECT id FROM users WHERE id=? AND is_active=true",
            (owner,),
        )
        .await?;
    anyhow::ensure!(active.is_some(), "Personal assignment owner is unavailable");
    let comments: Vec<CommentRow> = query
        .fetch_all(
            format!("{} FOR UPDATE", item_comments_query()),
            (issue.id.as_str(),),
        )
        .await?;
    let context = row.context();
    let owner_id = owner.to_string();
    let execution_id = row.id.to_string();
    let matches = active_events(&comments).into_iter().any(|event| {
        matches!(
            event.metadata.target_type.as_deref(),
            Some("human" | "user")
        ) && event.metadata.target_id.as_deref() == Some(owner_id.as_str())
            && event
                .metadata
                .human_assistant_dispatch
                .as_ref()
                .is_some_and(|dispatch| {
                    super::human_automation::stage_matches(
                        event.metadata.workflow_step.as_deref(),
                        dispatch,
                    ) && super::human_automation::identity_matches(dispatch, &context)
                        && valid_assignment(
                            dispatch,
                            issue,
                            owner,
                            &event.comment.id,
                            event.metadata.assignment_version,
                        )
                        && dispatch["assignmentId"] == context["assignment_id"]
                        && dispatch["assignmentVersion"] == context["assignment_version"]
                        && dispatch["executionId"].as_str() == Some(execution_id.as_str())
                        && !terminal_dispatch(dispatch)
                })
    });
    anyhow::ensure!(matches, "Personal assignment is no longer current");
    let route = if row.runtime_device_id.is_empty() {
        &row.execution_device_id
    } else {
        &row.runtime_device_id
    };
    anyhow::ensure!(
        endpoint_permitted_on(
            query,
            owner,
            route,
            &issue.cloud_project_id,
            &issue.metadata.0["tags"]
        )
        .await?,
        "Default assistant authorization revoked"
    );
    Ok(())
}

pub(crate) async fn endpoint_permitted_on(
    query: &mut impl PluginQuery,
    owner: i64,
    route: &str,
    project_id: &str,
    tags: &Value,
) -> anyhow::Result<bool> {
    let Some(resolved) = resolve_owned_device_alias_on(query, owner, route).await? else {
        return Ok(false);
    };
    // Alias discovery may read an earlier repeatable-read snapshot. Consent
    // must come from the current row and stay locked through publication.
    let device: Option<DeviceKindRow> = query
        .fetch_optional(
            format!("{KINDS_DEVICE_QUERY} AND kinds.id=? AND kinds.name=? FOR UPDATE"),
            (owner, resolved.id, resolved.name.as_str()),
        )
        .await?;
    Ok(device.is_some_and(|device| {
        if authority::truthy(&device.json["spec"]["workspaceOwnerId"]) {
            return false;
        }
        schema::declaration(&device.json["spec"]["personalAssistantDispatch"]).is_some_and(
            |declaration| {
                declaration
                    .roles
                    .iter()
                    .any(|role| role.permits(owner, project_id, tags))
            },
        )
    }))
}

async fn authorized_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
) -> MysqlResult<bool> {
    let active: Option<(i64,)> = tx
        .fetch_optional(
            "SELECT id FROM users WHERE id=? AND is_active=true",
            (owner,),
        )
        .await?;
    if active.is_none() {
        return Ok(false);
    }
    let mut query = &mut *tx;
    let access =
        match authority::execution_access_on(&mut query, &issue.cloud_project_id, owner).await {
            Ok(access) => access,
            Err(error) if robot::authority::infrastructure(&error) => {
                return Err(dependency_error(error));
            }
            Err(_) => return Ok(false),
        };
    match authority::require_issue_with_priority_on(
        &mut query,
        &access.project,
        issue,
        owner,
        access.priority,
    )
    .await
    {
        Ok(()) => Ok(true),
        Err(error) if robot::authority::infrastructure(&error) => Err(dependency_error(error)),
        Err(_) => Ok(false),
    }
}

fn dependency_error(error: anyhow::Error) -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: error.to_string(),
    }
}

struct EndpointResolution {
    endpoint: Option<(DeviceKindRow, schema::Role)>,
    reason: &'static str,
}

async fn endpoint_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
) -> MysqlResult<EndpointResolution> {
    let devices: Vec<DeviceKindRow> = tx
        .fetch_all(
            format!("{KINDS_DEVICE_QUERY} ORDER BY kinds.updated_at DESC,kinds.id DESC"),
            (owner,),
        )
        .await?;
    Ok(select_endpoint(devices, issue, owner))
}

fn select_endpoint(
    devices: Vec<DeviceKindRow>,
    issue: &store::Node,
    owner: i64,
) -> EndpointResolution {
    let mut reason = "no_authorized_assistant";
    for device in devices {
        if authority::truthy(&device.json["spec"]["workspaceOwnerId"]) {
            continue;
        }
        let Some(declaration) =
            schema::declaration(&device.json["spec"]["personalAssistantDispatch"])
        else {
            continue;
        };
        for role in declaration.roles {
            if let Some(denial) =
                role.denial_reason(owner, &issue.cloud_project_id, &issue.metadata.0["tags"])
            {
                if reason_priority(denial) > reason_priority(reason) {
                    reason = denial;
                }
            } else {
                return EndpointResolution {
                    endpoint: Some((device, role)),
                    reason: "waiting_device",
                };
            }
        }
    }
    EndpointResolution {
        endpoint: None,
        reason,
    }
}

fn reason_priority(reason: &str) -> u8 {
    match reason {
        "assistant_disabled" => 1,
        "project_not_authorized" => 2,
        "automatic_disabled" => 3,
        "tag_mismatch" => 4,
        _ => 0,
    }
}

async fn admit_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    assignment: &CommentRow,
    dispatch: &mut Value,
    device: &DeviceKindRow,
    role: &schema::Role,
) -> MysqlResult<()> {
    if dispatch["executionId"]
        .as_str()
        .is_some_and(|value| !value.is_empty())
        || terminal_dispatch(dispatch)
    {
        return Ok(());
    }
    let scope = format!(
        "human-assistant:{}",
        dispatch["dispatchId"].as_str().unwrap_or("")
    );
    let existing: Option<(i64,)> = tx.fetch_optional(
        "SELECT id FROM loop_item_executions WHERE execution_scope=? AND loop_item_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE",
        (scope.as_str(), issue.id.as_str()),
    ).await?;
    let id = if let Some((id,)) = existing {
        id
    } else {
        let mut context = json!({"human_assistant_dispatch":dispatch["dispatchId"],
            "assignment_id":assignment.id,"assignment_version":dispatch["assignmentVersion"],
            "owner_user_id":role.user_id,"assigned_by_user_id":assignment.created_by_user_id,
            "stand_in_id":role.id,"publish_policy":"summary_and_evidence_only"});
        if let Some(automation) = super::human_automation::context(dispatch) {
            context["human_automation"] = automation.clone();
        }
        let input = queue::Admission {
            owner: role.user_id,
            assigner: role.user_id,
            agent_id: String::new(),
            team_id: 0,
            environment: "local".into(),
            device_id: device.name.clone(),
            context,
            runtime_selection: json!({"executor_kind":"human_assistant"}),
            config: json!({}),
            requires_approval: false,
            waiting_runtime: true,
        };
        let automation_run_id = super::human_automation::context(dispatch)
            .and_then(|context| context["automation_run_id"].as_str());
        let execution =
            queue::enqueue_intent_on(tx, issue, automation_run_id, &scope, &input).await?;
        tx.execute(
            "UPDATE loop_item_executions SET max_retries=0,runtime_task_id='',execution_note=? WHERE id=? AND status='waiting_runtime'",
            ("Waiting for the owner's authorized default assistant", execution.id),
        ).await?;
        execution.id
    };
    dispatch["executionId"] = json!(id.to_string());
    dispatch["endpointRef"] = json!(format!("wework-local:{}:@primary", device.name));
    dispatch["dispatchState"] = json!("waiting_device");
    dispatch["reasonCode"] = json!("waiting_device");
    Ok(())
}

async fn revoke_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
    dispatch: &mut Value,
    reason: &str,
    effects: &mut Effects,
) -> MysqlResult<()> {
    let id = dispatch["executionId"]
        .as_str()
        .and_then(|value| value.parse::<i64>().ok());
    let Some(id) = id else {
        dispatch["dispatchState"] = json!(if reason == "issue_closed" {
            "cancelled"
        } else {
            "no_authorized_assistant"
        });
        dispatch["reasonCode"] = json!(reason);
        return Ok(());
    };
    let execution: Option<Execution> = tx.fetch_optional(
        format!("SELECT {} FROM loop_item_executions WHERE id=? AND loop_item_id=? AND executor_owner_user_id=? FOR UPDATE", robot::model::COLUMNS),
        (id, issue.id.as_str(), owner),
    ).await?;
    let Some(mut execution) =
        execution.filter(|row| row.selection()["executor_kind"] == "human_assistant")
    else {
        return Ok(());
    };
    if execution.terminal() {
        return Ok(());
    }
    let next = cancel_on(tx, &execution, reason).await?;
    dispatch["dispatchState"] = json!(next);
    dispatch["reasonCode"] = json!(reason);
    if next == "cancelling" {
        execution.status = "cancel_requested".into();
        effects.cancellations.push(execution);
    }
    Ok(())
}

async fn cancel_on(
    tx: &mut impl MysqlTransaction,
    row: &Execution,
    reason: &str,
) -> MysqlResult<&'static str> {
    let now = Utc::now().naive_utc();
    if row.can_cancel_without_runtime() {
        tx.execute(
            "UPDATE loop_item_executions SET status='cancelled',completed_at=?,lease_expires_at='1970-01-01 00:00:01', \
             observed_state='cancelled',observed_at=?,sync_state='in_sync',termination_reason=?,execution_note=?, \
             version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status=? AND version=?",
            (now, now, reason, reason, row.id, row.status.as_str(), row.version),
        ).await?;
        Ok("cancelled")
    } else {
        tx.execute(
            "UPDATE loop_item_executions SET status='cancel_requested',cancel_requested_at=?,sync_state='pending', \
             termination_reason=?,execution_note=?,version=version+1,updated_at=UTC_TIMESTAMP(6) \
             WHERE id=? AND status IN ('claimed','running') AND version=?",
            (now, reason, reason, row.id, row.version),
        ).await?;
        Ok("cancelling")
    }
}
