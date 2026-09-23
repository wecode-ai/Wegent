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

fn manager(project: &LoopItem) -> &Value {
    &project.metadata["project_manager"]
}

fn event_overlap(left: &Value, right: &Value) -> bool {
    if text(left, "eventType") != text(right, "eventType") {
        return false;
    }
    let left_tags = left["tags"].as_array().cloned().unwrap_or_default();
    let right_tags = right["eventConfig"]["tags"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    left_tags.is_empty()
        || right_tags.is_empty()
        || left_tags.iter().any(|tag| right_tags.contains(tag))
}

pub(super) fn validate_manager(
    value: &Value,
    processing_rules: &Value,
) -> Result<(), TaskRuntimeError> {
    if value.is_null() || value["enabled"] != true {
        return Ok(());
    }
    if text(value, "agentId").is_empty() || text(value, "prompt").trim().is_empty() {
        return Err(TaskRuntimeError::Invalid(
            "project manager requires an Agent and instructions".into(),
        ));
    }
    let triggers = value["triggers"].as_array().ok_or_else(|| {
        TaskRuntimeError::Invalid("project manager triggers must be an array".into())
    })?;
    let mut ids = HashSet::new();
    for trigger in triggers {
        if text(trigger, "id").is_empty() || !ids.insert(text(trigger, "id")) {
            return Err(TaskRuntimeError::Invalid(
                "project manager trigger IDs must be unique".into(),
            ));
        }
        match text(trigger, "kind") {
            "event"
                if matches!(
                    text(trigger, "eventType"),
                    "task.created" | "task.tag_added" | "task.status_changed"
                ) => {}
            "schedule" => {
                next_schedule(trigger, Utc::now())?;
            }
            _ => {
                return Err(TaskRuntimeError::Invalid(
                    "unsupported project manager trigger".into(),
                ))
            }
        }
        if trigger["enabled"] == false || text(trigger, "kind") != "event" {
            continue;
        }
        if triggers
            .iter()
            .filter(|other| {
                other["enabled"] != false
                    && text(other, "kind") == "event"
                    && text(other, "eventType") == text(trigger, "eventType")
                    && (other["tags"].as_array().is_none_or(Vec::is_empty)
                        || trigger["tags"].as_array().is_none_or(Vec::is_empty)
                        || other["tags"].as_array().is_some_and(|tags| {
                            tags.iter().any(|tag| {
                                trigger["tags"]
                                    .as_array()
                                    .is_some_and(|current| current.contains(tag))
                            })
                        }))
            })
            .count()
            > 1
        {
            return Err(TaskRuntimeError::Invalid(
                "project manager triggers overlap".into(),
            ));
        }
        if processing_rules
            .as_array()
            .into_iter()
            .flatten()
            .any(|rule| {
                rule["enabled"] != false
                    && text(rule, "triggerType") == "event"
                    && event_overlap(trigger, rule)
            })
        {
            return Err(TaskRuntimeError::Invalid(
                "project manager overlaps automatic processing".into(),
            ));
        }
    }
    Ok(())
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
    let project = get_item_from(connection, project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    let manager_config = manager(&project);
    if manager_config["enabled"] == true {
        for trigger in manager_config["triggers"].as_array().into_iter().flatten() {
            if trigger["enabled"] == false
                || text(trigger, "kind") != "event"
                || text(trigger, "eventType") != event
            {
                continue;
            }
            let tags = trigger["tags"].as_array().cloned().unwrap_or_default();
            if event == "task.tag_added"
                && !tags.is_empty()
                && !tags
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|tag| added_tags.iter().any(|added| added == tag))
            {
                continue;
            }
            run_for_manager(connection, &project, "event", Some(task_id), None)?;
            return Ok(());
        }
    }
    if event == "task.created"
        && get_item_from(connection, task_id, "task")?
            .is_some_and(|task| task.assignee_user_id.is_some())
    {
        return Ok(());
    }
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

fn run_for_manager(
    connection: &Connection,
    project: &LoopItem,
    trigger: &str,
    issue_id: Option<&str>,
    instruction: Option<&str>,
) -> Result<Value, TaskRuntimeError> {
    let config = manager(project);
    if config["enabled"] != true {
        return Err(TaskRuntimeError::Invalid(
            "project manager is disabled".into(),
        ));
    }
    let agent_id = text(config, "agentId");
    let agent = get_item_from(connection, agent_id, "chat_agent")?
        .ok_or_else(|| TaskRuntimeError::Invalid("project manager Agent was not found".into()))?;
    if agent.cloud_project_id.as_deref() != Some(&project.id)
        || agent.status.as_deref() != Some("active")
    {
        return Err(TaskRuntimeError::Invalid(
            "project manager Agent is unavailable".into(),
        ));
    }
    let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM loop_item_executions WHERE loop_item_id=?1 AND status IN ('queued','pending_approval','claimed','running','cancel_requested'))", [&project.id], |row| row.get(0))?;
    let run_id = format!("local-manager-run-{}", Uuid::new_v4());
    let stamp = now();
    let run = json!({"id":run_id,"automationId":"project-manager","projectId":project.id,"projectManager":true,"trigger":trigger,"issueId":issue_id,"taskId":project.id,"taskTitle":project.name,"status":if active {"skipped"} else {"queued"},"createdAt":stamp,"updatedAt":stamp,"completedAt":if active {Some(stamp.clone())} else {None},"actions":[]});
    if !active {
        let prompt = format!("You are the project-level AI manager. Coordinate Issues, never claim their delivery. Use wework_space tools to inspect this project. Project ID: {}. Run ID: {}. Event Issue: {}. For assigned Issues, coordinate in comments; changing the assignee or active Issue status/scope requires human approval.\n\nProject instructions: {}\n\nCurrent request: {}", project.id, run_id, issue_id.unwrap_or(""), text(config, "prompt"), instruction.unwrap_or(""));
        create_local_execution(
            connection,
            &project.id,
            &project.id,
            agent_id,
            &agent,
            "none",
            json!({"message":prompt,"automation_run_id":run_id,"automation_role":"manager"}),
        )?;
    }
    connection.execute("INSERT INTO loop_items (id, resource_type, cloud_project_id, metadata, created_at, updated_at) VALUES (?1, 'automation_run', ?2, ?3, ?4, ?4)", params![run_id, project.id, run.to_string(), stamp])?;
    Ok(run)
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

pub(super) fn run_collaboration_group(
    connection: &Connection,
    project_id: &str,
    task_id: &str,
    group_id: &str,
) -> Result<Option<Value>, TaskRuntimeError> {
    let project = get_item_from(connection, project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    let Some(group) = project.metadata["collaboration_groups"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|group| text(group, "id") == group_id)
    else {
        return Err(TaskRuntimeError::Invalid(
            "collaboration group was not found".into(),
        ));
    };
    if !group["leader"].is_object() {
        return Ok(None);
    }
    let instructions = text(group, "instructions");
    let prompt = if instructions.is_empty() {
        format!(
            "Coordinate the collaboration group {}.",
            text(group, "name")
        )
    } else {
        instructions.to_owned()
    };
    let rule = json!({
        "id": format!("collaboration-group:{group_id}"),
        "prompt": prompt,
        "targetKind": "collaboration_group",
        "targetId": group_id,
        "timezone": "UTC",
    });
    run_for_issue(connection, &project, task_id, &rule, "assignment").map(Some)
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
            let manager_planning = group["coordination_mode"].as_str().unwrap_or("manager")
                == "manager"
                && !group["stages"]
                    .as_array()
                    .is_some_and(|stages| !stages.is_empty());
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
                nodes.push(json!({"id":id,"name":stage["name"],"prompt":format!("{}\n{}\n{}\n\n{}\n{}",text(rule,"prompt"),text(group,"instructions"),text(&stage,"description"),task.title.as_deref().unwrap_or_default(),task.description),"kind":"ai","execution_mode":if kind=="agent" {"robot"} else {"human"},"required_assignee_type":if kind=="agent" {"agent"} else {"user"},"required_assignee_id":assignee["id"],"depends_on":previous.iter().collect::<Vec<_>>(),"required":true,"automation_role":if manager_planning && nodes.is_empty() {"manager"} else {""}}));
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
    pub fn local_automation_assignment_candidates(
        &self,
        project_id: &str,
        task_id: &str,
        run_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let project = get_item_from(&connection, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let task =
            get_item_from(&connection, task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        ensure_local_manager_scope(&connection, &task, run_id)?;
        let group_id = text(&task.metadata["collaboration_group"], "id");
        let group = collaboration_group(&project, group_id)?;
        let participants = group["members"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(std::iter::once(&group["leader"]))
            .collect::<Vec<_>>();
        let allowed_agents = participants
            .iter()
            .filter(|member| text(member, "kind") == "agent")
            .map(|member| text(member, "id").to_owned())
            .collect::<HashSet<_>>();
        let allowed_users = participants
            .iter()
            .filter(|member| text(member, "kind") == "human")
            .map(|member| text(member, "id").to_owned())
            .collect::<HashSet<_>>();
        let mut statement = connection.prepare(
            "SELECT id, resource_type, project_space, cloud_project_id, parent_id,
                    public_id, project_key, name, title, description, sequence_number,
                    next_item_number, status, priority, sort_order, current_delivery_id,
                    metadata, version, created_at, updated_at, completed_at,
                    assignee_agent_id, created_by_user_id, assignee_user_id
             FROM loop_items
             WHERE resource_type='chat_agent' AND cloud_project_id=?1
               AND deleted_at IS NULL AND status='active'
             ORDER BY created_at ASC",
        )?;
        let robots = collect_items(statement.query_map(params![project_id], map_loop_item)?)?
            .into_iter()
            .map(map_chat_agent)
            .filter(|agent| allowed_agents.contains(&agent.id))
            .map(|agent| {
                json!({
                    "id": agent.id,
                    "name": agent.display_name,
                    "runtime": agent.runtime,
                    "capability": agent.capability_description,
                })
            })
            .collect::<Vec<_>>();
        let members = allowed_users
            .into_iter()
            .map(|id| {
                json!({
                    "id": id,
                    "name": "本地用户",
                    "role": "Owner",
                    "capability": "",
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"members": members, "robots": robots}))
    }

    pub fn submit_local_automation_workflow_plan(
        &self,
        project_id: &str,
        task_id: &str,
        run_id: &str,
        plan: &Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let mut task =
            get_item_from(&transaction, task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        ensure_local_manager_scope(&transaction, &task, run_id)?;
        let group_id = text(&task.metadata["collaboration_group"], "id");
        let group = collaboration_group(&project, group_id)?;
        let participants = group["members"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(std::iter::once(&group["leader"]))
            .collect::<Vec<_>>();
        let allowed = participants
            .iter()
            .map(|member| (text(member, "kind"), text(member, "id")))
            .collect::<HashSet<_>>();
        let items = plan["items"].as_array().ok_or_else(|| {
            TaskRuntimeError::Invalid("workflow plan requires at least one item".into())
        })?;
        if items.is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "workflow plan requires at least one item".into(),
            ));
        }
        let workflow = task
            .metadata
            .get_mut("workflow")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| TaskRuntimeError::Invalid("Issue has no active workflow".into()))?;
        if workflow.get("plan_submitted") == Some(&Value::Bool(true)) {
            return Err(TaskRuntimeError::Invalid(
                "workflow plan was already submitted".into(),
            ));
        }
        let nodes = workflow
            .get_mut("nodes")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| TaskRuntimeError::Invalid("Issue workflow has no nodes".into()))?;
        let manager_node_id = nodes
            .iter()
            .find(|node| text(node, "automation_role") == "manager")
            .and_then(|node| node["id"].as_str())
            .map(ToOwned::to_owned)
            .ok_or_else(|| TaskRuntimeError::Invalid("AI manager stage is missing".into()))?;
        let mut previous = manager_node_id;
        let mut seen_keys = HashSet::new();
        let mut planned = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let client_key = text(item, "client_key");
            let title = text(item, "title").trim();
            let assignee_type = text(item, "assignee_type");
            let assignee_id = text(item, "assignee_id");
            let member_kind = match assignee_type {
                "agent" => "agent",
                "user" => "human",
                _ => {
                    return Err(TaskRuntimeError::Invalid(
                        "local workflow items require a user or agent assignee".into(),
                    ))
                }
            };
            if client_key.is_empty() || !seen_keys.insert(client_key.to_owned()) {
                return Err(TaskRuntimeError::Invalid(
                    "workflow item client_key must be unique".into(),
                ));
            }
            if title.is_empty() || assignee_id.is_empty() {
                return Err(TaskRuntimeError::Invalid(
                    "workflow items require a title and assignee".into(),
                ));
            }
            if !allowed.contains(&(member_kind, assignee_id)) {
                return Err(TaskRuntimeError::Invalid(
                    "workflow assignee is not a member of the collaboration group".into(),
                ));
            }
            if assignee_type == "agent" {
                let agent =
                    get_item_from(&transaction, assignee_id, "chat_agent")?.ok_or_else(|| {
                        TaskRuntimeError::Invalid("workflow Agent was not found".into())
                    })?;
                if agent.cloud_project_id.as_deref() != Some(project_id)
                    || agent.status.as_deref() != Some("active")
                {
                    return Err(TaskRuntimeError::Invalid(
                        "workflow Agent is not active in this project".into(),
                    ));
                }
            }
            let node_id = format!("{run_id}:plan:{index}:{client_key}");
            let description = text(item, "description");
            let rationale = text(item, "rationale");
            nodes.push(json!({
                "id": node_id,
                "name": title,
                "prompt": format!("{title}\n\n{description}\n\n{rationale}"),
                "kind": "ai",
                "execution_mode": if assignee_type == "agent" {"robot"} else {"human"},
                "required_assignee_type": assignee_type,
                "required_assignee_id": assignee_id,
                "depends_on": [previous],
                "required": true,
                "status": "blocked",
            }));
            previous = node_id;
            planned.push(item.clone());
        }
        workflow.insert("plan_submitted".to_owned(), json!(true));
        workflow.insert(
            "plan_summary".to_owned(),
            plan.get("summary").cloned().unwrap_or_else(|| json!("")),
        );
        workflow.insert("plan_items".to_owned(), json!(planned));
        transaction.execute(
            "UPDATE loop_items SET metadata=?1, version=version+1, updated_at=?2 WHERE id=?3",
            params![task.metadata.to_string(), now(), task_id],
        )?;
        transaction.commit()?;
        Ok(json!({
            "status": "submitted",
            "summary": plan.get("summary").cloned().unwrap_or_else(|| json!("")),
            "items": planned,
        }))
    }

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
                && !(manager(&project)["enabled"] == true
                    && manager(&project)["triggers"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|trigger| {
                            trigger["enabled"] != false && text(trigger, "kind") == "schedule"
                        }))
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
            if manager(&project)["enabled"] == true {
                let manager_triggers = manager(&project)["triggers"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for trigger in &manager_triggers {
                    if trigger["enabled"] == false || text(trigger, "kind") != "schedule" {
                        continue;
                    }
                    let key = format!(
                        "manager:{}:{}:{}",
                        text(trigger, "id"),
                        text(trigger, "cronExpression"),
                        text(trigger, "timezone")
                    );
                    let current_time = Utc::now();
                    let previous = project.metadata["automation_schedule"][&key]
                        .as_str()
                        .map(chrono::DateTime::parse_from_rfc3339)
                        .transpose()
                        .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?
                        .map(|stamp| stamp.with_timezone(&Utc));
                    if previous.is_some_and(|due| due <= current_time) {
                        run_for_manager(&transaction, &project, "scheduled", None, None)?;
                    }
                    if !project.metadata["automation_schedule"].is_object() {
                        project.metadata["automation_schedule"] = json!({});
                    }
                    project.metadata["automation_schedule"][&key] =
                        json!(next_schedule(trigger, current_time)?.to_rfc3339());
                    changed = true;
                }
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

    pub fn run_project_manager(
        &self,
        project_id: &str,
        instruction: &str,
    ) -> Result<Value, TaskRuntimeError> {
        if instruction.trim().is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "project manager instruction is required".into(),
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let run = run_for_manager(&transaction, &project, "manual", None, Some(instruction))?;
        transaction.commit()?;
        Ok(run)
    }

    pub fn list_project_manager_runs(
        &self,
        project_id: &str,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='automation_run' AND cloud_project_id=?1 AND json_extract(metadata,'$.projectManager')=1 ORDER BY created_at DESC LIMIT 100")?;
        let records = statement
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        records.into_iter().map(|record| {
            let mut run: Value = serde_json::from_str(&record)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            let state: Option<(String, Option<String>)> = connection.query_row(
                "SELECT status, completed_at FROM loop_item_executions WHERE json_extract(execution_payload,'$.automation_run_id')=?1 ORDER BY id DESC LIMIT 1",
                [text(&run, "id")],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            if let Some((status, completed_at)) = state {
                run["status"] = json!(match status.as_str() {
                    "completed" | "succeeded" => "succeeded",
                    "failed" => "failed",
                    "cancelled" => "cancelled",
                    "running" => "running",
                    _ => "queued",
                });
                if let Some(completed_at) = completed_at { run["completedAt"] = json!(completed_at); }
            }
            Ok(run)
        }).collect()
    }

    pub fn record_project_manager_action(
        &self,
        project_id: &str,
        run_id: &str,
        kind: &str,
        item_id: &str,
        payload: Value,
        pending: bool,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut run = get_item_from(&transaction, run_id, "automation_run")?
            .ok_or_else(|| TaskRuntimeError::Invalid("manager run was not found".into()))?;
        if run.cloud_project_id.as_deref() != Some(project_id)
            || run.metadata["projectManager"] != true
        {
            return Err(TaskRuntimeError::Invalid(
                "manager run does not belong to this project".into(),
            ));
        }
        let item = get_item_from(&transaction, item_id, "task")?;
        if item
            .as_ref()
            .is_some_and(|item| item.cloud_project_id.as_deref() != Some(project_id))
        {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        let action = json!({"id":Uuid::new_v4().to_string(),"kind":kind,"itemId":item_id,"itemVersion":item.as_ref().map(|item| item.version),"status":if pending {"pending_confirmation"} else {"executed"},"payload":payload,"createdAt":now()});
        if !run.metadata["actions"].is_array() {
            run.metadata["actions"] = json!([]);
        }
        run.metadata["actions"]
            .as_array_mut()
            .unwrap()
            .push(action.clone());
        transaction.execute(
            "UPDATE loop_items SET metadata=?1, updated_at=?2 WHERE id=?3",
            params![run.metadata.to_string(), now(), run_id],
        )?;
        transaction.commit()?;
        Ok(action)
    }

    pub fn decide_project_manager_action(
        &self,
        project_id: &str,
        run_id: &str,
        action_id: &str,
        approve: bool,
        version: i64,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let run = get_item_from(&connection, run_id, "automation_run")?
            .ok_or_else(|| TaskRuntimeError::Invalid("manager run was not found".into()))?;
        if run.cloud_project_id.as_deref() != Some(project_id)
            || run.metadata["projectManager"] != true
        {
            return Err(TaskRuntimeError::Invalid(
                "manager run does not belong to this project".into(),
            ));
        }
        let action = run.metadata["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|action| {
                text(action, "id") == action_id && text(action, "status") == "pending_confirmation"
            })
            .cloned()
            .ok_or_else(|| TaskRuntimeError::Invalid("manager action is not pending".into()))?;
        let item_id = text(&action, "itemId");
        let item =
            get_item_from(&connection, item_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        if item.cloud_project_id.as_deref() != Some(project_id)
            || item.version != version
            || action["itemVersion"] != version
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        drop(connection);
        if approve {
            let payload = &action["payload"];
            let update = if text(&action, "kind") == "assign" {
                let assignee_type = text(payload, "assignee_type");
                let assignee_id = text(payload, "assignee_id");
                match assignee_type {
                    "agent" => TaskUpdate {
                        version,
                        assignee_agent_id: Some(Some(assignee_id.into())),
                        assignee_user_id: Some(None),
                        ..TaskUpdate::default()
                    },
                    "user" => {
                        TaskUpdate {
                            version,
                            assignee_user_id: Some(Some(assignee_id.parse().map_err(|_| {
                                TaskRuntimeError::Invalid("invalid assignee".into())
                            })?)),
                            assignee_agent_id: Some(None),
                            ..TaskUpdate::default()
                        }
                    }
                    _ => return Err(TaskRuntimeError::Invalid("unsupported assignee".into())),
                }
            } else {
                serde_json::from_value::<TaskUpdate>(json!({"version":version,"title":payload.get("title"),"description":payload.get("description"),"status":payload.get("status"),"priority":payload.get("priority"),"tags":payload.get("tags")})).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?
            };
            self.update_task(project_id, item_id, update)?;
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut current = get_item_from(&transaction, run_id, "automation_run")?
            .ok_or_else(|| TaskRuntimeError::Invalid("manager run was not found".into()))?;
        let actions = current.metadata["actions"]
            .as_array_mut()
            .ok_or_else(|| TaskRuntimeError::Invalid("manager actions are unavailable".into()))?;
        let selected = actions
            .iter_mut()
            .find(|candidate| text(candidate, "id") == action_id)
            .ok_or_else(|| TaskRuntimeError::Invalid("manager action was not found".into()))?;
        selected["status"] = json!(if approve { "executed" } else { "rejected" });
        selected["decidedAt"] = json!(now());
        let result = selected.clone();
        transaction.execute(
            "UPDATE loop_items SET metadata=?1, updated_at=?2 WHERE id=?3",
            params![current.metadata.to_string(), now(), run_id],
        )?;
        transaction.commit()?;
        Ok(result)
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

fn collaboration_group<'a>(
    project: &'a LoopItem,
    group_id: &str,
) -> Result<&'a Value, TaskRuntimeError> {
    project.metadata["collaboration_groups"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|group| text(group, "id") == group_id)
        .ok_or_else(|| TaskRuntimeError::Invalid("collaboration group was not found".into()))
}

fn ensure_local_manager_scope(
    connection: &Connection,
    task: &LoopItem,
    run_id: &str,
) -> Result<(), TaskRuntimeError> {
    if run_id.is_empty()
        || text(&task.metadata["workflow"], "automation_run_id") != run_id
        || task.metadata["workflow"]["cancelled"] == true
        || task.metadata["workflow"]["error"].is_string()
        || !task.metadata["workflow"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|node| {
                text(node, "automation_role") == "manager"
                    && !matches!(
                        text(node, "status"),
                        "completed" | "forced_completed" | "failed" | "cancelled"
                    )
            })
    {
        return Err(TaskRuntimeError::Invalid(
            "workflow planning is only available to the active collaboration group owner".into(),
        ));
    }
    let exists: bool = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM loop_items
            WHERE id=?1 AND resource_type='automation_run'
              AND json_extract(metadata,'$.issueId')=?2
              AND COALESCE(json_extract(metadata,'$.status'),'queued')
                  NOT IN ('succeeded','failed','cancelled')
        )",
        params![run_id, task.id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(TaskRuntimeError::Invalid(
            "active collaboration workflow was not found".into(),
        ));
    }
    Ok(())
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

#[cfg(test)]
mod project_manager_tests {
    use super::*;

    #[test]
    fn rejects_event_that_would_start_two_automation_systems() {
        let manager = json!({"enabled":true,"agentId":"agent-1","prompt":"Coordinate","triggers":[{
            "id":"created","kind":"event","eventType":"task.created","enabled":true,"tags":[]
        }]});
        let rules = json!([{"id":"old","enabled":true,"triggerType":"event","eventType":"task.created","eventConfig":{"tags":[]}}]);

        let error = validate_manager(&manager, &rules).unwrap_err();

        assert!(error.to_string().contains("overlaps automatic processing"));
    }

    #[test]
    fn allows_distinct_tag_event_scopes() {
        let manager = json!({"enabled":true,"agentId":"agent-1","prompt":"Coordinate","triggers":[{
            "id":"backend","kind":"event","eventType":"task.tag_added","enabled":true,"tags":["backend"]
        }]});
        let rules = json!([{"id":"frontend","enabled":true,"triggerType":"event","eventType":"task.tag_added","eventConfig":{"tags":["frontend"]}}]);

        validate_manager(&manager, &rules).unwrap();
    }
}
