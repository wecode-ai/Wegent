use super::*;

pub(super) fn emit_local_assignment_notifications(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    receipt: &Value,
) {
    let Some(sender) = &context.event_sender else {
        return;
    };
    if receipt.get("state").and_then(Value::as_str) != Some("dispatched") {
        return;
    }
    match assignment_payloads(runtime, context, receipt) {
        Ok(payloads) => {
            for payload in payloads {
                let _ = sender.send(json!({
                    "type": "event",
                    "event": "project.task.assigned",
                    "payload": payload,
                }));
            }
        }
        Err(error) => crate::logging::log_executor_event(
            "local collaboration assignment notification failed",
            &[("error", error.to_string())],
        ),
    }
}

fn assignment_payloads(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    receipt: &Value,
) -> Result<Vec<Value>, super::super::TaskRuntimeError> {
    let Some(grant) = context.grant() else {
        return Ok(Vec::new());
    };
    let Some((project_id, item_id)) = grant.space_id.as_deref().zip(grant.item_id.as_deref())
    else {
        return Ok(Vec::new());
    };
    let project = runtime
        .list_projects()?
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or(super::super::TaskRuntimeError::ProjectNotFound)?;
    let actor = runtime
        .list_chat_agents(project_id)?
        .into_iter()
        .find(|agent| Some(agent.id.as_str()) == grant.manager_agent_id.as_deref())
        .map(|agent| agent.display_name)
        .unwrap_or_else(|| project.name.clone().unwrap_or_default());
    let assignments = receipt.get("assignments").and_then(Value::as_array);
    Ok(assignments
        .into_iter()
        .flatten()
        .filter(|assignment| assignment["assignee_type"] == "human")
        .map(|assignment| {
            json!({
                "projectStore": "local",
                "projectId": project_id,
                "projectName": project.name,
                "itemId": item_id,
                "itemTitle": assignment["task_title"],
                "actorName": actor,
                "assignmentId": assignment["human_assignment_id"],
                "recipientUserId": assignment["human_user_id"],
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_runtime::{LocalTaskStore, TaskProviderKind};

    #[test]
    fn emits_committed_human_assignments_with_local_issue_identity() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Offline project".to_owned(),
                project_key: Some("OFF".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();
        let (sender, mut receiver) = tokio::sync::broadcast::channel(8);
        let mut context = SpaceMcpRequestContext::new(
            Some(SpaceContextGrant {
                space_id: Some(project.id.clone()),
                item_id: Some("OFF-1".to_owned()),
                ..SpaceContextGrant::default()
            }),
            None,
            None,
        );
        context.set_event_sender(Some(sender));
        let receipt = json!({
            "state": "dispatched",
            "assignments": [
                {"assignee_type": "agent", "task_title": "AI work"},
                {
                    "assignee_type": "human", "human_assignment_id": "human-1",
                    "task_title": "Inspect memory", "human_user_id": "1"
                }
            ]
        });
        emit_local_assignment_notifications(&runtime, &context, &receipt);
        assert_eq!(
            receiver.try_recv().unwrap(),
            json!({
                "type": "event", "event": "project.task.assigned",
                "payload": {
                    "projectStore": "local", "projectId": project.id,
                    "projectName": "Offline project", "itemId": "OFF-1",
                    "itemTitle": "Inspect memory", "actorName": "Offline project",
                    "assignmentId": "human-1", "recipientUserId": "1"
                }
            })
        );
        emit_local_assignment_notifications(
            &runtime,
            &context,
            &json!({"state": "already_dispatched", "assignments": receipt["assignments"]}),
        );
        assert!(receiver.try_recv().is_err());
    }
}
