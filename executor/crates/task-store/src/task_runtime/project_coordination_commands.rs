//! Coordinator commands reuse the real local group queue and its execution receipts.
use super::*;

#[cfg(test)]
#[path = "project_coordination_commands_tests.rs"]
mod tests;

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.into())
}

fn identifier(value: &str, limit: usize) -> Result<(), TaskRuntimeError> {
    if value.is_empty()
        || value.len() > limit
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(invalid("Invalid project coordination command identity"));
    }
    Ok(())
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, TaskRuntimeError> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| invalid("Incomplete project coordination command"))
}

fn input(
    actor: i64,
    device: &str,
    project: &str,
    group: &str,
    command: &str,
    body: &Value,
) -> Result<Value, TaskRuntimeError> {
    identifier(project, 256)?;
    identifier(group, 256)?;
    identifier(command, 64)?;
    if actor < 0 || device.trim().is_empty() || device.len() > 256 {
        return Err(invalid("A verified member and hosting device are required"));
    }
    for key in ["generation", "issueId", "groupVersion"] {
        text(body, key)?;
    }
    for key in ["projectVersion", "issueVersion"] {
        if !body[key].as_i64().is_some_and(|value| value > 0) {
            return Err(TaskRuntimeError::VersionConflict);
        }
    }
    Ok(
        json!({"projectStore":"local","projectId":project,"groupId":group,"commandId":command,
        "userId":actor,"deviceId":device,"generation":body["generation"],"issueId":body["issueId"],
        "projectVersion":body["projectVersion"],"issueVersion":body["issueVersion"],"groupVersion":body["groupVersion"]}),
    )
}

fn receipt_on(
    connection: &Connection,
    project: &str,
    group: &str,
    command: &str,
) -> Result<Option<LocalExecution>, TaskRuntimeError> {
    let id: Option<i64> = connection.query_row(
        "SELECT id FROM loop_item_executions WHERE cloud_project_id=?1 AND json_extract(execution_payload,'$.project_coordination.groupId')=?2 AND json_extract(execution_payload,'$.project_coordination.commandId')=?3 ORDER BY id LIMIT 1",
        params![project, group, command], |row| row.get(0)).optional()?;
    id.map(|id| execution_row(connection, id)).transpose()
}

fn result(
    row: &LocalExecution,
    actor: i64,
    digest: Option<&str>,
) -> Result<Value, TaskRuntimeError> {
    if row.assigner_user_id != actor {
        return Err(invalid(
            "This coordination command belongs to another member",
        ));
    }
    let scope = &row
        .execution_payload
        .as_ref()
        .ok_or_else(|| invalid("Missing command receipt"))?["project_coordination"];
    if digest.is_some_and(|digest| scope["inputDigest"] != digest) {
        return Err(TaskRuntimeError::VersionConflict);
    }
    Ok(
        json!({"commandId":scope["commandId"],"accepted":true,"execution":{"id":row.id,"issueId":row.loop_item_id,"status":row.status}}),
    )
}

fn require_binding_on(
    connection: &Connection,
    project_id: &str,
    scope: &Value,
) -> Result<(LoopItem, Value), TaskRuntimeError> {
    if scope["projectStore"] != "local"
        || scope["projectId"] != project_id
        || !scope["userId"].as_i64().is_some_and(|user| user >= 0)
    {
        return Err(invalid("Invalid local project coordination identity"));
    }
    let group_id = text(scope, "groupId")?;
    let project = get_item_from(connection, project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    if project.status.as_deref() != Some("active") {
        return Err(invalid("Project is unavailable"));
    }
    let binding = &project.metadata["projectCoordination"][group_id];
    if binding["enabled"] != true
        || binding["userId"] != scope["userId"]
        || ["generation", "deviceId"]
            .iter()
            .any(|key| text(scope, key).is_err() || binding[*key] != scope[*key])
    {
        return Err(invalid("Project coordination was stopped or taken over"));
    }
    let group = collaboration_group(&project, group_id)?;
    if group["leader"]["kind"] != "agent" {
        return Err(invalid("Project coordination requires an AI leader"));
    }
    runner_dispatch::group_agents(connection, project_id, &group)?;
    Ok((project, group))
}

pub(super) fn execution_actor_on(
    connection: &Connection,
    project: &str,
    payload: &Value,
) -> Result<i64, TaskRuntimeError> {
    let Some(scope) = payload.get("project_coordination") else {
        return Ok(0);
    };
    let (_, group) = require_binding_on(connection, project, scope)?;
    let issue = get_item_from(connection, text(scope, "issueId")?, "task")?
        .filter(|issue| issue.cloud_project_id.as_deref() == Some(project))
        .ok_or(TaskRuntimeError::TaskNotFound)?;
    if issue.metadata["collaboration_group_assignment_key"] != scope["inputDigest"]
        || !scope["inputDigest"]
            .as_str()
            .is_some_and(|digest| !digest.is_empty())
        || issue.status.as_deref() == Some("completed")
    {
        return Err(invalid(
            "The Issue's coordination assignment is no longer current",
        ));
    }
    let assigned_group = &issue.metadata["collaboration_group"];
    let snapshot = payload.get("collaboration_group").unwrap_or(&group);
    let assigned_agent = runner_dispatch::group_agents(connection, project, snapshot)?
        .iter()
        .any(|agent| issue.assignee_agent_id.as_deref() == Some(&agent.id));
    let assigned_human = std::iter::once(&snapshot["leader"])
        .chain(snapshot["members"].as_array().into_iter().flatten())
        .any(|member| {
            member["kind"] == "human"
                && issue.assignee_user_id.is_some_and(|user| {
                    member["id"].as_str().and_then(|id| id.parse::<i64>().ok()) == Some(user)
                })
        });
    if (assigned_group.is_object() && assigned_group["id"] != scope["groupId"])
        || (!assigned_group.is_object() && !assigned_agent && !assigned_human)
    {
        return Err(invalid(
            "The Issue is no longer assigned to this coordination work",
        ));
    }
    if let Some(snapshot) = payload.get("collaboration_group") {
        let participants = |group: &Value| {
            std::iter::once(group["leader"].clone())
                .chain(group["members"].as_array().into_iter().flatten().cloned())
                .map(|member| json!([member["kind"], member["id"]]).to_string())
                .collect::<HashSet<_>>()
        };
        if !participants(snapshot).is_subset(&participants(&group)) {
            return Err(invalid("Collaboration group membership was revoked"));
        }
    }
    Ok(scope["userId"].as_i64().unwrap())
}

pub(super) fn authorize_execution_on(
    connection: &Connection,
    execution: &LocalExecution,
) -> Result<(), TaskRuntimeError> {
    if let Some(payload) = execution.execution_payload.as_ref() {
        if let Some(scope) = payload.get("project_coordination") {
            if scope["issueId"] != execution.loop_item_id
                || matches!(
                    execution.status.as_str(),
                    "cancel_requested" | "cancelled" | "failed"
                )
            {
                return Err(invalid("The project coordination execution was stopped"));
            }
        }
        execution_actor_on(connection, &execution.cloud_project_id, payload)?;
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn project_coordination_command_receipt(
        &self,
        actor: i64,
        project: &str,
        group: &str,
        command: &str,
    ) -> Result<Value, TaskRuntimeError> {
        identifier(project, 256)?;
        identifier(group, 256)?;
        identifier(command, 64)?;
        let connection = self.connection()?;
        receipt_on(&connection, project, group, command)?
            .as_ref()
            .map(|row| result(row, actor, None))
            .unwrap_or_else(|| Ok(json!({"commandId":command,"accepted":false})))
    }

    pub fn dispatch_project_coordination_command(
        &self,
        actor: i64,
        device: &str,
        project: &str,
        group: &str,
        command: &str,
        body: &Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut scope = input(actor, device, project, group, command, body)?;
        let digest = Self::coordination_event_version(&scope);
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(row) = receipt_on(&transaction, project, group, command)? {
            return result(&row, actor, Some(&digest));
        }
        scope["inputDigest"] = json!(digest);
        let (project, group) = require_binding_on(&transaction, project, &scope)?;
        if body["projectVersion"] != project.version
            || body["groupVersion"] != Self::coordination_event_version(&group)
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let issue = get_item_from(&transaction, text(body, "issueId")?, "task")?
            .filter(|issue| issue.cloud_project_id.as_deref() == Some(&project.id))
            .ok_or(TaskRuntimeError::VersionConflict)?;
        if body["issueVersion"] != issue.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if issue
            .assignee_agent_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
            || issue.assignee_user_id.is_some_and(|id| id != 0)
            || issue.metadata["collaboration_group"].is_object()
            || issue.status.as_deref() == Some("completed")
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let busy: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM loop_item_executions WHERE loop_item_id=?1 AND status IN ('pending_approval','waiting_runtime','queued','claimed','running','cancel_requested'))",[&issue.id],|row|row.get(0))?;
        if busy {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let assigned_status = assign_on(&transaction, &project, &group, &issue, actor, &digest)?;
        let id = dispatch_collaboration_group_assignment(
            &transaction,
            CollaborationGroupExecutionInput {
                item_id: &issue.id,
                project_id: &project.id,
                group: &group,
                issue_title: issue.title.as_deref().unwrap_or(&issue.id),
                issue_description: &issue.description,
                issue_status: assigned_status.as_deref(),
                prompt: None,
                priority: issue.priority.as_deref().unwrap_or("none"),
                payload: json!({"project_coordination":scope}),
            },
        )?
        .ok_or_else(|| invalid("Project coordination requires an AI leader"))?;
        local_automation::on_status_changed(
            &transaction,
            &issue.id,
            issue.status.as_deref(),
            None,
        )?;
        let response = result(&execution_row(&transaction, id)?, actor, Some(&digest))?;
        transaction.commit()?;
        Ok(response)
    }

    pub fn authorize_project_coordination_request(
        &self,
        scope: &Value,
        device: &str,
        task: &str,
    ) -> Result<(), TaskRuntimeError> {
        if scope["deviceId"] != device {
            return Err(invalid(
                "Project coordination belongs to another hosting device",
            ));
        }
        let connection = self.connection()?;
        let project = text(scope, "projectId")?;
        let receipt = receipt_on(
            &connection,
            project,
            text(scope, "groupId")?,
            text(scope, "commandId")?,
        )?
        .ok_or_else(|| invalid("Project coordination command was not accepted"))?;
        if receipt
            .execution_payload
            .as_ref()
            .and_then(|payload| payload.get("project_coordination"))
            != Some(scope)
            || Some(receipt.assigner_user_id) != scope["userId"].as_i64()
        {
            return Err(invalid(
                "Project coordination command is no longer executable",
            ));
        }
        let execution_id: Option<i64> = connection.query_row("SELECT id FROM loop_item_executions WHERE runtime_task_id=?1 AND cloud_project_id=?2 ORDER BY id DESC LIMIT 1",params![task,project],|row|row.get(0)).optional()?;
        let current = execution_row(
            &connection,
            execution_id
                .ok_or_else(|| invalid("The current coordination Runtime task is unavailable"))?,
        )?;
        if current
            .execution_payload
            .as_ref()
            .and_then(|payload| payload.get("project_coordination"))
            != Some(scope)
            || !matches!(current.status.as_str(), "claimed" | "running")
        {
            return Err(invalid(
                "The current coordination Runtime task is no longer executable",
            ));
        }
        authorize_execution_on(&connection, &current)
    }

    pub fn reconcile_project_coordination_authority(
        &self,
    ) -> Result<Vec<LocalExecution>, TaskRuntimeError> {
        let revoked = {
            let connection = self.connection()?;
            let mut statement = connection.prepare("SELECT id FROM loop_item_executions WHERE status IN ('pending_approval','waiting_runtime','queued','claimed','running','cancel_requested') AND json_type(execution_payload,'$.project_coordination') IS NOT NULL")?;
            let ids = statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut revoked = Vec::new();
            for id in ids {
                let row = execution_row(&connection, id)?;
                match authorize_execution_on(&connection, &row) {
                    Ok(()) if row.status != "cancel_requested" => {}
                    Err(error @ TaskRuntimeError::Database(_)) => return Err(error),
                    _ => revoked.push(id),
                }
            }
            revoked
        };
        revoked
            .into_iter()
            .map(|id| {
                self.cancel_execution(id, Some("Project coordination authorization was revoked"))
            })
            .collect()
    }
}

fn assign_on(
    connection: &Connection,
    project: &LoopItem,
    group: &Value,
    issue: &LoopItem,
    actor: i64,
    assignment: &str,
) -> Result<Option<String>, TaskRuntimeError> {
    let mut metadata = issue.metadata.clone();
    metadata["collaboration_group"] = group.clone();
    metadata["collaboration_group_assignment_key"] = json!(assignment);
    record_assignment_change(
        &mut metadata,
        actor,
        Some("group"),
        group["id"].as_str(),
        group["name"].as_str(),
    );
    let status = issue.status.as_deref().map(|status| {
        project_status::robot_assignment_status(&project.metadata, status).to_owned()
    });
    let changed = connection.execute("UPDATE loop_items SET metadata=?1,status=?6,version=version+1,updated_at=?2 WHERE id=?3 AND cloud_project_id=?4 AND version=?5",params![metadata.to_string(),now(),issue.id,project.id,issue.version,status])?;
    if changed != 1 {
        return Err(TaskRuntimeError::VersionConflict);
    }
    assignment_receipts::sync_assignment_receipt(connection, &project.id, &issue.id, &metadata)?;
    refresh_runtime_projection_additional_context(connection, &issue.id)?;
    Ok(status)
}
