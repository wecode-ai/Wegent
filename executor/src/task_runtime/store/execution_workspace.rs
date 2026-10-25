use super::{json, TaskRuntimeError, Value};

pub(crate) fn apply_project_workspace(
    payload: &mut Value,
    metadata: &Value,
    device_id: &str,
    project_id: &str,
) -> Result<(), TaskRuntimeError> {
    if payload["runtimeAction"] == "send"
        || payload
            .get("workspaceSourceTask")
            .is_some_and(|value| !value.is_null())
    {
        payload.as_object_mut().unwrap().remove("workspacePath");
        payload.as_object_mut().unwrap().remove("execution");
        set_materialized_workspace_source(payload, false);
        return Ok(());
    }
    let config = metadata
        .get("execution_environment")
        .filter(|value| value.is_object())
        .unwrap_or(&Value::Null);
    let state = &config["devices"][device_id];
    let path = state["workspace_path"]
        .as_str()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    payload.as_object_mut().unwrap().remove("workspacePath");
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
    let steps = config["setup_steps"].as_array().into_iter().flatten().map(|step| {
        json!({"command": step["command"], "workingDirectory": step["working_directory"]})
    }).collect::<Vec<_>>();
    payload["execution"] = json!({"environment": {
        "environmentId": project_id,
        "repositories": config["repositories"].as_array().cloned().unwrap_or_default(),
        "setupSteps": steps,
        "fingerprint": config["fingerprint"],
        "workspacePath": if state["status"] == "ready" { path } else { None },
    }});
    if isolated {
        payload["execution"]["workspace"] = json!({"source": "git_worktree"});
    }
    set_materialized_workspace_source(payload, isolated);
    Ok(())
}

fn set_materialized_workspace_source(payload: &mut Value, isolated: bool) {
    let key = if payload.get("executionRequest").is_some() {
        "executionRequest"
    } else {
        "execution_request"
    };
    if let Some(request) = payload.get_mut(key).and_then(Value::as_object_mut) {
        request.remove("workspace_source");
        if isolated {
            request.insert("workspace_source".into(), json!("git_worktree"));
        }
    }
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
            let mut payload = json!({
                "projectId": 7, "standaloneChatWorkspace": true,
                "executionRequest": {"workspace_source": "git_worktree"}
            });
            apply_project_workspace(&mut payload, &metadata(policy), "device", "project").unwrap();
            assert_eq!(
                payload["execution"]["environment"]["workspacePath"],
                "/prepared/repo"
            );
            assert_eq!(payload["standaloneChatWorkspace"], false);
            assert!(payload.get("projectId").is_none());
            assert_eq!(
                payload["execution"].get("workspace").is_some(),
                policy == "git_worktree"
            );
            assert_eq!(
                payload["executionRequest"]["workspace_source"].as_str(),
                (policy == "git_worktree").then_some("git_worktree")
            );
        }
    }

    #[test]
    fn prepares_unprepared_device_without_reusing_another_devices_path() {
        let mut payload = json!({"projectId": 7});
        apply_project_workspace(&mut payload, &metadata("git_worktree"), "other", "project")
            .unwrap();
        assert!(payload["execution"]["environment"]["workspacePath"].is_null());
    }

    #[test]
    fn blank_environments_do_not_request_git_worktrees() {
        let mut config = metadata("git_worktree");
        config["execution_environment"]["repositories"] = json!([]);
        let mut payload = json!({});
        apply_project_workspace(&mut payload, &config, "device", "project").unwrap();
        assert!(payload["execution"].get("workspace").is_none());
    }

    #[test]
    fn new_projects_prepare_a_blank_workspace_without_configuration() {
        let mut payload = json!({"projectId": "new-project"});
        apply_project_workspace(&mut payload, &json!({}), "device", "new-project").unwrap();
        assert_eq!(
            payload["execution"]["environment"]["environmentId"],
            "new-project"
        );
        assert_eq!(
            payload["execution"]["environment"]["repositories"],
            json!([])
        );
        assert!(payload["execution"].get("workspace").is_none());
    }

    #[test]
    fn inherited_tasks_keep_their_workspace_without_preflight_or_recreation() {
        let mut payload = json!({
            "workspaceSourceTask": {"taskId": "existing"},
            "workspacePath": "/base",
            "execution": {"workspace": {"source": "git_worktree"}}
        });
        apply_project_workspace(&mut payload, &metadata("git_worktree"), "other", "project")
            .unwrap();
        assert!(payload.get("workspacePath").is_none());
        assert!(payload.get("execution").is_none());
    }
}
