//! Local project rules compile into the existing durable execution/workflow queue.
use super::*;
use crate::runtime_work::automations::{next_run_after, AutomationSchedule};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn rules(project: &LoopItem) -> Vec<Value> {
    project.metadata["automatic_processing_rules"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

pub(super) fn validate_rules(value: &Value) -> Result<(), TaskRuntimeError> {
    let rules = value
        .as_array()
        .ok_or_else(|| TaskRuntimeError::Invalid("automation rules must be an array".into()))?;
    for rule in rules {
        if text(rule, "id").is_empty() || text(rule, "targetId").is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "automation rule requires an id and target".into(),
            ));
        }
        if !matches!(
            text(rule, "targetKind"),
            "agent" | "human" | "collaboration_group"
        ) {
            return Err(TaskRuntimeError::Invalid(
                "unsupported local automation target".into(),
            ));
        }
        match text(rule, "triggerType") {
            "schedule" => {
                next_schedule(rule, Utc::now())?;
            }
            "event"
                if matches!(
                    text(rule, "eventType"),
                    "task.created" | "task.tag_added" | "task.status_changed"
                ) => {}
            _ => {
                return Err(TaskRuntimeError::Invalid(
                    "unsupported local automation trigger".into(),
                ))
            }
        }
    }
    Ok(())
}

fn next_schedule(
    rule: &Value,
    after: chrono::DateTime<Utc>,
) -> Result<chrono::DateTime<Utc>, TaskRuntimeError> {
    next_run_after(
        &AutomationSchedule::Cron {
            expression: text(rule, "cronExpression").into(),
        },
        text(rule, "timezone"),
        after,
    )
    .ok_or_else(|| TaskRuntimeError::Invalid("invalid automation schedule or timezone".into()))
}

pub(super) fn on_event(
    connection: &Connection,
    project_id: &str,
    task_id: &str,
    event: &str,
    added_tags: &[String],
) -> Result<(), TaskRuntimeError> {
    if event == "task.created"
        && get_item_from(connection, task_id, "task")?
            .is_some_and(|task| task.assignee_user_id.is_some())
    {
        return Ok(());
    }
    let project = get_item_from(connection, project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    for rule in rules(&project) {
        if rule["enabled"] == false
            || text(&rule, "triggerType") != "event"
            || text(&rule, "eventType") != event
        {
            continue;
        }
        if event == "task.tag_added"
            && !rule["eventConfig"]["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|tag| added_tags.iter().any(|added| added == tag))
        {
            continue;
        }
        run_for_issue(connection, &project, task_id, &rule, "event")?;
    }
    Ok(())
}

fn run_for_issue(
    connection: &Connection,
    project: &LoopItem,
    task_id: &str,
    rule: &Value,
    trigger: &str,
) -> Result<Value, TaskRuntimeError> {
    let run_id = format!("local-run-{}", Uuid::new_v4());
    let stamp = now();
    let mut run = json!({"id": run_id, "automationId": rule["id"], "projectId": project.id, "issueId": task_id,
        "trigger": trigger, "status": "queued", "timezone": rule["timezone"].as_str().unwrap_or("UTC"), "scheduledFor": stamp,
        "taskId": null, "backendTaskId": null, "deviceId": null, "error": null, "startedAt":null, "expiresAt":null,
        "createdAt": stamp, "updatedAt": stamp, "completedAt": null});
    // A bad rule must be visible as a failed run without losing the user's Issue.
    connection.execute_batch("SAVEPOINT local_automation_dispatch")?;
    match dispatch(connection, project, task_id, rule, &run_id) {
        Ok(()) => {
            if text(rule, "targetKind") == "human" {
                run["status"] = json!("succeeded");
                run["completedAt"] = json!(stamp);
            }
            connection.execute_batch("RELEASE local_automation_dispatch")?;
        }
        Err(TaskRuntimeError::Invalid(error)) => {
            connection.execute_batch(
                "ROLLBACK TO local_automation_dispatch; RELEASE local_automation_dispatch",
            )?;
            run["status"] = json!("failed");
            run["error"] = json!(error);
            run["completedAt"] = json!(stamp);
        }
        Err(error) => {
            connection.execute_batch(
                "ROLLBACK TO local_automation_dispatch; RELEASE local_automation_dispatch",
            )?;
            return Err(error);
        }
    }
    connection.execute("INSERT INTO loop_items (id, resource_type, cloud_project_id, metadata, created_at, updated_at) VALUES (?1, 'automation_run', ?2, ?3, ?4, ?4)", params![run_id, project.id, run.to_string(), stamp])?;
    Ok(run)
}

fn dispatch(
    connection: &Connection,
    project: &LoopItem,
    task_id: &str,
    rule: &Value,
    run_id: &str,
) -> Result<(), TaskRuntimeError> {
    let task = get_item_from(connection, task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    if task.cloud_project_id.as_deref() != Some(&project.id) {
        return Err(TaskRuntimeError::TaskNotFound);
    }
    if task.metadata["workflow"]["automation_run_id"].is_string()
        && task.metadata["workflow"]["cancelled"] != true
        && !task.metadata["workflow"]["error"].is_string()
        && task.metadata["workflow"]["nodes"]
            .as_array()
            .is_some_and(|nodes| {
                nodes
                    .iter()
                    .any(|node| !matches!(text(node, "status"), "completed" | "forced_completed"))
            })
    {
        let has_failed: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM loop_item_executions WHERE json_extract(execution_payload,'$.automation_run_id')=?1 AND status IN ('failed','cancelled'))", [text(&task.metadata["workflow"], "automation_run_id")], |row| row.get(0))?;
        if !has_failed {
            return Err(TaskRuntimeError::Invalid(
                "Issue already has an unfinished workflow".into(),
            ));
        }
    }
    let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM loop_item_executions WHERE loop_item_id = ?1 AND status IN ('queued','pending_approval','claimed','running','cancel_requested'))", [task_id], |row| row.get(0))?;
    if active {
        return Err(TaskRuntimeError::Invalid(
            "Issue already has an active execution".into(),
        ));
    }
    let target_id = text(rule, "targetId");
    match text(rule, "targetKind") {
        "human" => {
            let user_id: i64 = target_id
                .parse()
                .map_err(|_| TaskRuntimeError::Invalid("invalid local assignee".into()))?;
            connection.execute("UPDATE loop_items SET assignee_user_id=?1, assignee_agent_id=NULL, version=version+1, updated_at=?2 WHERE id=?3", params![user_id, now(), task_id])?;
        }
        "agent" => {
            let agent = get_item_from(connection, target_id, "chat_agent")?.ok_or_else(|| {
                TaskRuntimeError::Invalid("automation Agent was not found".into())
            })?;
            if agent.cloud_project_id.as_deref() != Some(&project.id)
                || agent.status.as_deref() != Some("active")
            {
                return Err(TaskRuntimeError::Invalid(
                    "automation Agent is not active in this project".into(),
                ));
            }
            let message = format!(
                "{}\n\n{}\n{}",
                text(rule, "prompt"),
                task.title.as_deref().unwrap_or_default(),
                task.description
            );
            create_local_execution(
                connection,
                task_id,
                &project.id,
                target_id,
                &agent,
                task.priority.as_deref().unwrap_or("none"),
                json!({"message":message, "automation_run_id":run_id}),
            )?;
            connection.execute("UPDATE loop_items SET assignee_agent_id=?1, assignee_user_id=NULL, status='in_progress', version=version+1, updated_at=?2 WHERE id=?3", params![target_id, now(), task_id])?;
        }
        "collaboration_group" => {
            let group = project.metadata["collaboration_groups"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|group| text(group, "id") == target_id)
                .ok_or_else(|| {
                    TaskRuntimeError::Invalid("collaboration group was not found".into())
                })?;
            let stages = group["stages"].as_array().filter(|stages| !stages.is_empty()).cloned().unwrap_or_else(|| vec![json!({"id":"leader", "name":group["name"], "description":group["instructions"], "assignee":group["leader"]})]);
            let mut nodes = Vec::new();
            let mut previous: Option<String> = None;
            for stage in stages {
                let assignee = if stage["assignee"].is_object() {
                    &stage["assignee"]
                } else {
                    &group["leader"]
                };
                let kind = text(assignee, "kind");
                if !matches!(kind, "agent" | "human") {
                    return Err(TaskRuntimeError::Invalid(
                        "unsupported collaboration group member".into(),
                    ));
                }
                let id = format!("{}:{}", run_id, text(&stage, "id"));
                nodes.push(json!({"id":id,"name":stage["name"],"prompt":format!("{}\n{}\n{}\n\n{}\n{}",text(rule,"prompt"),text(group,"instructions"),text(&stage,"description"),task.title.as_deref().unwrap_or_default(),task.description),"kind":"ai","execution_mode":if kind=="agent" {"robot"} else {"human"},"required_assignee_type":if kind=="agent" {"agent"} else {"user"},"required_assignee_id":assignee["id"],"depends_on":previous.iter().collect::<Vec<_>>(),"required":true}));
                previous = Some(id);
            }
            let mut workflow = instantiate_local_workflow(&json!({"version":1,"nodes":nodes}))?;
            workflow["automation_run_id"] = json!(run_id);
            enqueue_ready_local_workflow_stages(
                connection,
                task_id,
                &project.id,
                task.priority.as_deref().unwrap_or("none"),
                &mut workflow,
            )?;
            let mut metadata = task.metadata;
            metadata["workflow"] = workflow;
            connection.execute("UPDATE loop_items SET metadata=?1, status='in_progress', version=version+1, updated_at=?2 WHERE id=?3",params![metadata.to_string(),now(),task_id])?;
        }
        _ => {
            return Err(TaskRuntimeError::Invalid(
                "unsupported local automation target".into(),
            ))
        }
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn cancel_project_automation_run(
        &self,
        project_id: &str,
        run_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let mut run = self.project_automation_run(project_id, run_id)?;
        let current = self
            .list_project_automation_runs(project_id, text(&run, "automationId"))?
            .into_iter()
            .find(|item| text(item, "id") == run_id)
            .ok_or_else(|| TaskRuntimeError::Invalid("automation run not found".into()))?;
        if matches!(
            text(&current, "status"),
            "succeeded" | "failed" | "cancelled"
        ) {
            return Ok(json!({"run":current,"executions":[]}));
        }
        // Fence workflow advancement before cancelling executions, including a racing completion.
        {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let stamp = now();
            transaction.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.workflow.cancelled',json('true')), version=version+1, updated_at=?1 WHERE id=?2 AND json_extract(metadata,'$.workflow.automation_run_id')=?3",params![stamp,text(&run,"issueId"),run_id])?;
            run["status"] = json!("cancelled");
            run["updatedAt"] = json!(stamp);
            run["completedAt"] = json!(stamp);
            transaction.execute(
                "UPDATE loop_items SET metadata=?1, updated_at=?2 WHERE id=?3",
                params![run.to_string(), stamp, run_id],
            )?;
            transaction.commit()?;
        }
        let ids = {
            let connection = self.connection()?;
            let mut statement=connection.prepare("SELECT id FROM loop_item_executions WHERE cloud_project_id=?1 AND json_extract(execution_payload,'$.automation_run_id')=?2")?;
            let ids = statement
                .query_map(params![project_id, run_id], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        let mut executions = Vec::new();
        for id in ids {
            executions.push(self.cancel_execution(id, None)?);
        }
        Ok(json!({"run":run,"executions":executions}))
    }

    pub fn retry_project_automation_run(
        &self,
        project_id: &str,
        run_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let run = self.project_automation_run(project_id, run_id)?;
        let current = self
            .list_project_automation_runs(project_id, text(&run, "automationId"))?
            .into_iter()
            .find(|run| text(run, "id") == run_id)
            .ok_or_else(|| TaskRuntimeError::Invalid("automation run not found".into()))?;
        if !matches!(text(&current, "status"), "failed" | "cancelled") {
            return Err(TaskRuntimeError::Invalid(
                "only failed or cancelled automation runs can be retried".into(),
            ));
        }
        self.run_project_automation(
            project_id,
            text(&run, "automationId"),
            Some(text(&run, "issueId")),
        )
    }

    fn project_automation_run(
        &self,
        project_id: &str,
        run_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let item = get_item_from(&connection, run_id, "automation_run")?
            .ok_or_else(|| TaskRuntimeError::Invalid("automation run not found".into()))?;
        if item.cloud_project_id.as_deref() != Some(project_id) {
            return Err(TaskRuntimeError::Invalid(
                "automation run does not belong to this project".into(),
            ));
        }
        Ok(item.metadata)
    }

    pub fn tick_project_automations(&self) -> Result<(), TaskRuntimeError> {
        let projects = self.list_projects()?;
        for project in projects {
            if project.metadata["project_store"] == "backend" {
                continue;
            }
            if !rules(&project)
                .iter()
                .any(|rule| rule["enabled"] != false && text(rule, "triggerType") == "schedule")
            {
                continue;
            }
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut project = get_item_from(&transaction, &project.id, "project")?
                .ok_or(TaskRuntimeError::ProjectNotFound)?;
            let mut changed = false;
            for rule in rules(&project) {
                if rule["enabled"] == false || text(&rule, "triggerType") != "schedule" {
                    continue;
                }
                let key = format!("{}:{}", text(&rule, "id"), rule["version"]);
                let current_time = Utc::now();
                let previous = project.metadata["automation_schedule"][&key]
                    .as_str()
                    .map(chrono::DateTime::parse_from_rfc3339)
                    .transpose()
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?
                    .map(|stamp| stamp.with_timezone(&Utc));
                if let Some(due) = previous {
                    if due > current_time {
                        continue;
                    }
                    let ids = local_open_issue_ids(&transaction, &project.id)?;
                    for id in ids {
                        run_for_issue(&transaction, &project, &id, &rule, "scheduled")?;
                    }
                }
                if !project.metadata["automation_schedule"].is_object() {
                    project.metadata["automation_schedule"] = json!({});
                }
                project.metadata["automation_schedule"][&key] =
                    json!(next_schedule(&rule, current_time)?.to_rfc3339());
                changed = true;
            }
            if changed {
                transaction.execute(
                    "UPDATE loop_items SET metadata=?1 WHERE id=?2",
                    params![project.metadata.to_string(), project.id],
                )?;
            }
            transaction.commit()?;
        }
        Ok(())
    }

    pub fn run_project_automation(
        &self,
        project_id: &str,
        rule_id: &str,
        issue_id: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let rule = rules(&project)
            .into_iter()
            .find(|rule| text(rule, "id") == rule_id)
            .ok_or_else(|| TaskRuntimeError::Invalid("automation rule was not found".into()))?;
        let ids = if let Some(id) = issue_id {
            vec![id.to_owned()]
        } else {
            local_open_issue_ids(&transaction, project_id)?
        };
        let mut runs = Vec::new();
        for id in ids {
            runs.push(run_for_issue(&transaction, &project, &id, &rule, "manual")?);
        }
        transaction.commit()?;
        Ok(json!(runs))
    }

    pub fn list_project_automation_runs(
        &self,
        project_id: &str,
        rule_id: &str,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement=connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='automation_run' AND cloud_project_id=?1 AND json_extract(metadata,'$.automationId')=?2 ORDER BY created_at DESC")?;
        let records = statement
            .query_map(params![project_id, rule_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut runs = Vec::new();
        for record in records {
            let mut run: Value = serde_json::from_str(&record)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            let mut executions=connection.prepare("SELECT status, runtime_task_id, runtime_device_id, error_message, started_at, completed_at, updated_at FROM loop_item_executions e WHERE json_extract(execution_payload,'$.automation_run_id')=?1 AND NOT EXISTS(SELECT 1 FROM loop_item_executions retry WHERE retry.previous_execution_id=e.id) ORDER BY id")?;
            let states = executions
                .query_map([text(&run, "id")], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let task = get_item_from(&connection, text(&run, "issueId"), "task")?;
            let workflow_error = task
                .as_ref()
                .filter(|task| {
                    text(&task.metadata["workflow"], "automation_run_id") == text(&run, "id")
                })
                .and_then(|task| task.metadata["workflow"]["error"].as_str());
            let workflow_pending = task.as_ref().is_some_and(|task| {
                text(&task.metadata["workflow"], "automation_run_id") == text(&run, "id")
                    && task.metadata["workflow"]["cancelled"] != true
                    && task.metadata["workflow"]["nodes"]
                        .as_array()
                        .is_some_and(|nodes| {
                            nodes.iter().any(|node| {
                                !matches!(text(node, "status"), "completed" | "forced_completed")
                            })
                        })
            });
            if let Some(latest) = states.last() {
                let status = if states.iter().any(|state| {
                    matches!(state.0.as_str(), "running" | "claimed" | "cancel_requested")
                }) {
                    "running"
                } else if text(&run, "status") == "cancelled" {
                    "cancelled"
                } else if workflow_error.is_some() || states.iter().any(|state| state.0 == "failed")
                {
                    "failed"
                } else if states.iter().any(|state| state.0 == "cancelled") {
                    "cancelled"
                } else if states
                    .iter()
                    .any(|state| matches!(state.0.as_str(), "queued" | "pending_approval"))
                {
                    "queued"
                } else if workflow_pending {
                    "running"
                } else {
                    "succeeded"
                };
                run["status"] = json!(status);
                run["taskId"] = json!(latest.1);
                run["deviceId"] = json!(latest.2);
                run["startedAt"] = json!(states.iter().filter_map(|state| state.4.as_ref()).min());
                run["updatedAt"] = json!(states.iter().map(|state| &state.6).max());
                if matches!(status, "succeeded" | "failed" | "cancelled") {
                    if run["completedAt"].is_null() {
                        run["completedAt"] =
                            json!(states.iter().filter_map(|state| state.5.as_ref()).max());
                    }
                } else {
                    run["completedAt"] = Value::Null;
                }
                if let Some(error) = workflow_error {
                    run["error"] = json!(error);
                }
                if !latest.3.is_empty() {
                    run["error"] = json!(latest.3);
                }
            }
            if workflow_pending && states.is_empty() && text(&run, "status") == "queued" {
                run["status"] = json!("running");
            }
            runs.push(run);
        }
        Ok(runs)
    }
}

fn local_open_issue_ids(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<String>, TaskRuntimeError> {
    let mut statement=connection.prepare("SELECT id FROM loop_items WHERE resource_type='task' AND cloud_project_id=?1 AND deleted_at IS NULL AND status NOT IN ('completed','cancelled') ORDER BY created_at")?;
    let items = statement
        .query_map([project_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}
