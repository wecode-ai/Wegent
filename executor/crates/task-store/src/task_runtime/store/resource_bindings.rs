//! Resource bindings retain their own container independently of the work owner.
use super::*;

/// The Agent binding retains its resource owner; the Thread retains its Group owner.
pub(super) fn group_resource_agent(
    connection: &Connection,
    group_id: &str,
    classification_project_id: Option<&str>,
    agent_id: &str,
) -> Result<LoopItem, TaskRuntimeError> {
    chat_groups::local_group(connection, group_id, true)?;
    let agent = get_item_from(connection, agent_id, "chat_agent")?
        .filter(|agent| agent.status.as_deref() == Some("active"))
        .ok_or_else(|| TaskRuntimeError::Invalid("Agent binding is unavailable".into()))?;
    if agent.cloud_project_id.as_deref() == Some(group_id) {
        return Ok(agent);
    }
    if let Some(project_id) = classification_project_id {
        let project = thread_project_links::require_target(connection, project_id)?;
        if project.status.as_deref() == Some("active")
            && agent.cloud_project_id.as_deref() == Some(project_id)
        {
            return Ok(agent);
        }
    }
    Err(TaskRuntimeError::Invalid(
        "Agent binding is not authorized for this Group or its linked project".into(),
    ))
}

pub(super) fn task_resource_agent(
    connection: &Connection,
    owner_id: &str,
    task_id: &str,
    agent_id: &str,
) -> Result<LoopItem, TaskRuntimeError> {
    if get_item_from(connection, owner_id, "chat_group")?.is_none() {
        return collaboration_agent(connection, owner_id, agent_id);
    }
    chat_groups::local_group(connection, owner_id, true)?;
    let task = get_item_from(connection, task_id, "task")?
        .filter(|item| item.cloud_project_id.as_deref() == Some(owner_id))
        .ok_or(TaskRuntimeError::TaskNotFound)?;
    let project_id = thread_project_links::linked_project(connection, &task.id)?;
    if let Some(agent) = get_item_from(connection, agent_id, "chat_agent")? {
        if agent.cloud_project_id.as_deref() != Some(owner_id)
            && agent.cloud_project_id != project_id
            && task.metadata["collaboration_group"].is_object()
        {
            return crew_agent(
                connection,
                owner_id,
                task_id,
                &task.metadata["collaboration_group"],
                agent_id,
            );
        }
    }
    if let Some(agent) = retained_original_project_agent(
        connection,
        owner_id,
        &task,
        project_id.as_deref(),
        agent_id,
    )? {
        return Ok(agent);
    }
    group_resource_agent(connection, owner_id, project_id.as_deref(), agent_id)
}

/// A completed migration proves origin, while current source and resource policy still authorize use.
fn retained_original_project_agent(
    connection: &Connection,
    owner: &str,
    task: &LoopItem,
    project: Option<&str>,
    agent: &str,
) -> Result<Option<LoopItem>, TaskRuntimeError> {
    let Some(project) = project.filter(|_| task.assignee_agent_id.as_deref() == Some(agent)) else {
        return Ok(None);
    };
    let retained: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM loop_items migration, json_each(migration.metadata,'$.retained_agent_bindings') member
         WHERE migration.resource_type='thread_migration' AND migration.parent_id=?1
           AND migration.cloud_project_id=?2 AND migration.status='completed' AND migration.deleted_at IS NULL
           AND json_extract(migration.metadata,'$.retain_source_project')=1 AND member.key=?3 AND member.value=?4)",
        params![owner,project,task.id,agent],|row|row.get(0))?;
    if !retained {
        return Ok(None);
    }
    let source = thread_project_links::require_target(connection, project)?;
    if source.status.as_deref() != Some("active") {
        return Err(TaskRuntimeError::Invalid(
            "Original project resource authority is unavailable".into(),
        ));
    }
    let binding = collaboration_agent(connection, project, agent)?;
    if binding.id != agent || binding.status.as_deref() != Some("active") {
        return Err(TaskRuntimeError::Invalid(
            "Original assigned Agent is unavailable".into(),
        ));
    }
    Ok(Some(binding))
}

pub(super) fn scope_resource_group(
    connection: &Connection,
    owner_id: &str,
    project_id: Option<&str>,
    group_id: &str,
    source_id: Option<&str>,
) -> Result<Value, TaskRuntimeError> {
    let owner =
        work_container_from(connection, owner_id)?.ok_or(TaskRuntimeError::ProjectNotFound)?;
    let is_group = owner.resource_type == "chat_group";
    if is_group {
        chat_groups::local_group(connection, owner_id, true)?;
    }
    let mut containers = vec![owner];
    if is_group {
        if let Some(project_id) =
            project_id.filter(|id| source_id.is_none() || source_id == Some(*id))
        {
            let project = thread_project_links::require_target(connection, project_id)?;
            if project.status.as_deref() == Some("active") {
                containers.push(project);
            }
        }
    }
    let mut candidates = Vec::new();
    for container in containers
        .iter()
        .filter(|container| source_id.is_none() || source_id == Some(container.id.as_str()))
    {
        if let Some(group) = container.metadata["collaboration_groups"]
            .as_array()
            .and_then(|groups| {
                groups
                    .iter()
                    .find(|group| group["id"].as_str() == Some(group_id))
            })
        {
            let mut group = group.clone();
            group["binding_owner_id"] = json!(container.id);
            candidates.push(group);
        }
    }
    if candidates.len() != 1 {
        return Err(TaskRuntimeError::Invalid(
            if candidates.is_empty() {
                "Collaboration group binding is not authorized for this work item"
            } else {
                "Select the binding source for this collaboration group"
            }
            .into(),
        ));
    }
    Ok(candidates.remove(0))
}

pub(super) fn task_resource_group(
    connection: &Connection,
    owner: &str,
    task: &str,
    group: &str,
    source: Option<&str>,
) -> Result<Value, TaskRuntimeError> {
    let item = get_item_from(connection, task, "task")?
        .filter(|item| item.cloud_project_id.as_deref() == Some(owner))
        .ok_or(TaskRuntimeError::TaskNotFound)?;
    let project = thread_project_links::linked_project(connection, &item.id)?;
    scope_resource_group(connection, owner, project.as_deref(), group, source)
}

fn current_crew(
    connection: &Connection,
    owner: &str,
    task: &str,
    snapshot: &Value,
) -> Result<Value, TaskRuntimeError> {
    let id = snapshot["id"]
        .as_str()
        .ok_or_else(|| TaskRuntimeError::Invalid("Missing collaboration group binding".into()))?;
    task_resource_group(
        connection,
        owner,
        task,
        id,
        snapshot["binding_owner_id"].as_str(),
    )
}

fn crew_agent(
    connection: &Connection,
    owner: &str,
    task: &str,
    snapshot: &Value,
    agent_id: &str,
) -> Result<LoopItem, TaskRuntimeError> {
    let crew = current_crew(connection, owner, task, snapshot)?;
    let source = crew["binding_owner_id"].as_str().unwrap();
    let agent = collaboration_agent(connection, source, agent_id)?;
    let alias = agent.metadata["wegent_team_id"]
        .as_i64()
        .map(|id| id.to_string());
    let member = std::iter::once(&crew["leader"])
        .chain(crew["members"].as_array().into_iter().flatten())
        .any(|member| {
            member["kind"] == "agent"
                && member["id"].as_str().is_some_and(|id| {
                    id == agent.id || (source != owner && alias.as_deref() == Some(id))
                })
        });
    if !member || agent.status.as_deref() != Some("active") {
        return Err(TaskRuntimeError::Invalid(
            "Agent is no longer authorized in this collaboration group".into(),
        ));
    }
    Ok(agent)
}

pub(super) fn task_execution_agent(
    connection: &Connection,
    owner: &str,
    task: &str,
    agent: &str,
    payload: &Value,
) -> Result<LoopItem, TaskRuntimeError> {
    if get_item_from(connection, owner, "chat_group")?.is_none() {
        return collaboration_agent(connection, owner, agent);
    }
    if let Some(crew) = payload
        .get("collaboration_group")
        .filter(|crew| crew.is_object())
    {
        require_current_execution_crew(connection, owner, task, agent, payload)?;
        return crew_agent(connection, owner, task, crew, agent);
    }
    task_resource_agent(connection, owner, task, agent)
}

/// A reply may resume only the currently assigned crew generation and leader.
pub(super) fn require_current_comment_crew(
    connection: &Connection,
    owner: &str,
    task: &str,
    agent: &str,
    payload: &Value,
) -> Result<(), TaskRuntimeError> {
    if get_item_from(connection, owner, "chat_group")?.is_none()
        || !payload["collaboration_group"].is_object()
    {
        return Ok(());
    }
    let item = get_item_from(connection, task, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    let assigned = &item.metadata["collaboration_group"];
    let snapshot = &payload["collaboration_group"];
    if ["id", "binding_owner_id"]
        .iter()
        .any(|key| assigned[key] != snapshot[key])
    {
        return Err(TaskRuntimeError::Invalid(
            "Current collaboration group assignment changed".into(),
        ));
    }
    require_current_execution_crew(connection, owner, task, agent, payload)
}

pub(super) fn require_current_execution_crew(
    connection: &Connection,
    owner: &str,
    task: &str,
    agent: &str,
    payload: &Value,
) -> Result<(), TaskRuntimeError> {
    if get_item_from(connection, owner, "chat_group")?.is_none()
        || !payload["collaboration_group"].is_object()
    {
        return Ok(());
    }
    let snapshot = &payload["collaboration_group"];
    let current = current_crew(connection, owner, task, snapshot)?;
    if ["id", "binding_owner_id", "leader", "members", "stages"]
        .iter()
        .any(|key| snapshot[key] != current[key])
    {
        return Err(TaskRuntimeError::Invalid(
            "Current collaboration group assignment changed".into(),
        ));
    }
    let resolved = crew_agent(connection, owner, task, snapshot, agent)?;
    if payload["dispatch_role"] == "manager" {
        let leader = current["leader"]["id"].as_str().ok_or_else(|| {
            TaskRuntimeError::Invalid("Collaboration manager is unavailable".into())
        })?;
        if current["leader"]["kind"] != "agent"
            || crew_agent(connection, owner, task, snapshot, leader)?.id != resolved.id
        {
            return Err(TaskRuntimeError::Invalid(
                "Current collaboration manager changed".into(),
            ));
        }
    }
    Ok(())
}
