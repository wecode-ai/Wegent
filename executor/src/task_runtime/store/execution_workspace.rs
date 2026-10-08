use super::{json, TaskRuntimeError, Value};

pub(super) fn apply_project_workspace(
    payload: &mut Value,
    metadata: &Value,
    device_id: &str,
) -> Result<(), TaskRuntimeError> {
    if payload
        .get("workspaceSourceTask")
        .is_some_and(|value| !value.is_null())
    {
        payload.as_object_mut().unwrap().remove("workspacePath");
        payload.as_object_mut().unwrap().remove("execution");
        return Ok(());
    }
    let Some(config) = metadata
        .get("execution_environment")
        .filter(|value| value.is_object())
    else {
        return Ok(());
    };
    let state = &config["devices"][device_id];
    let path = state["workspace_path"]
        .as_str()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    if state["status"].as_str() != Some("ready") || path.is_none() {
        return Err(TaskRuntimeError::Invalid(
            "Initialize the project's execution environment on this device before starting a task"
                .into(),
        ));
    }
    payload["workspacePath"] = json!(path.unwrap());
    payload["standaloneChatWorkspace"] = json!(false);
    payload.as_object_mut().unwrap().remove("projectId");
    let isolated = config["workspace_policy"].as_str() != Some("project")
        && config["repositories"]
            .as_array()
            .is_some_and(|repositories| {
                repositories
                    .iter()
                    .any(|repository| repository["primary"].as_bool() == Some(true))
            });
    if isolated {
        payload["execution"] = json!({"workspace": {"source": "git_worktree"}});
    } else {
        payload.as_object_mut().unwrap().remove("execution");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(policy: &str) -> Value {
        json!({"execution_environment": {
            "workspace_policy": policy,
            "repositories": [{"primary": true}],
            "devices": {"device": {"status": "ready", "workspace_path": "/prepared/repo"}}
        }})
    }

    #[test]
    fn applies_project_policy_instead_of_agent_workspace() {
        for policy in ["project", "git_worktree"] {
            let mut payload = json!({"projectId": 7, "standaloneChatWorkspace": true});
            apply_project_workspace(&mut payload, &metadata(policy), "device").unwrap();
            assert_eq!(payload["workspacePath"], "/prepared/repo");
            assert_eq!(payload["standaloneChatWorkspace"], false);
            assert!(payload.get("projectId").is_none());
            assert_eq!(payload.get("execution").is_some(), policy == "git_worktree");
        }
    }

    #[test]
    fn refuses_unprepared_device_without_falling_back() {
        let mut payload = json!({"projectId": 7});
        assert!(apply_project_workspace(&mut payload, &metadata("git_worktree"), "other").is_err());
    }

    #[test]
    fn blank_environments_do_not_request_git_worktrees() {
        let mut config = metadata("git_worktree");
        config["execution_environment"]["repositories"] = json!([]);
        let mut payload = json!({});
        apply_project_workspace(&mut payload, &config, "device").unwrap();
        assert!(payload.get("execution").is_none());
    }

    #[test]
    fn inherited_tasks_keep_their_workspace_without_preflight_or_recreation() {
        let mut payload = json!({
            "workspaceSourceTask": {"taskId": "existing"},
            "workspacePath": "/base",
            "execution": {"workspace": {"source": "git_worktree"}}
        });
        apply_project_workspace(&mut payload, &metadata("git_worktree"), "other").unwrap();
        assert!(payload.get("workspacePath").is_none());
        assert!(payload.get("execution").is_none());
    }
}
