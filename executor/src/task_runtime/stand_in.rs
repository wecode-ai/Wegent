//! Project-addressed views over the personal stand-in; no project-owned settings.
use super::personal_stand_in::{
    empty_role, project_role, read_personal, validate_role, write_personal,
};
use super::*;

impl LocalTaskStore {
    pub fn stand_in_settings(
        &self,
        project_id: &str,
        user_id: i64,
        stand_in_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let personal = self.personal_stand_in(user_id, "")?;
        let role = personal["roles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|role| {
                (role["id"] == stand_in_id || role["legacyStandInId"] == stand_in_id)
                    && role["collaboration"]["projects"]
                        .as_array()
                        .is_some_and(|projects| {
                            projects.iter().any(|project| project["id"] == project_id)
                        })
            })
            .or_else(|| {
                personal["roles"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|role| role["id"] == stand_in_id)
            })
            .cloned()
            .unwrap_or_else(|| {
                empty_role(
                    stand_in_id,
                    personal["executionDeviceId"].as_str().unwrap_or_default(),
                )
            });
        let kind = role["collaboration"]["projects"]
            .as_array()
            .and_then(|projects| projects.iter().find(|project| project["id"] == project_id))
            .and_then(|project| project["store"].as_str())
            .unwrap_or("local");
        Ok(project_role(
            &role,
            user_id,
            project_id,
            kind,
            personal["autoSelect"] == true,
        ))
    }

    pub fn save_stand_in_settings(
        &self,
        project_id: &str,
        user_id: i64,
        mut value: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let device = value["executionDeviceId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let kind = value["projectStore"].as_str().unwrap_or("local").to_owned();
        let id = value["id"].as_str().unwrap_or("default").to_owned();
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if kind == "local" {
            get_item_from(&connection, project_id, "project")?
                .ok_or(TaskRuntimeError::ProjectNotFound)?;
        }
        let mut personal = read_personal(&connection, user_id, &device)?;
        let before = personal["roles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|role| role["id"] == id);
        let version = before
            .and_then(|role| role["version"].as_i64())
            .unwrap_or(0);
        if value["version"].as_i64() != Some(version) {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let mut source = before
            .map(|role| role["collaboration"].clone())
            .unwrap_or_else(|| empty_role(&id, &device)["collaboration"].clone());
        if before.is_none() || version == 0 {
            source["allProjects"] = json!(false);
        }
        source["enabled"] = json!(true);
        source["tags"] = value.get("tags").cloned().unwrap_or_else(|| json!([]));
        let project = json!({"id":project_id,"store":kind});
        if !source["projects"].as_array().unwrap().contains(&project) {
            source["projects"]
                .as_array_mut()
                .unwrap()
                .push(project.clone());
        }
        source["excludedProjects"]
            .as_array_mut()
            .unwrap()
            .retain(|row| row != &project);
        value["id"] = json!(id);
        value["name"] = value.get("name").cloned().unwrap_or_else(|| json!(""));
        value["collaboration"] = source;
        if value["agentId"].is_string() {
            value["agentProject"] = project;
        }
        validate_role(&value, &device)?;
        value["version"] = json!(version + 1);
        value["userId"] = json!(user_id);
        value.as_object_mut().unwrap().remove("projectId");
        value.as_object_mut().unwrap().remove("projectStore");
        value["enabledAfter"] = before
            .filter(|role| role["enabled"] == true && value["enabled"] == true)
            .map(|role| role["enabledAfter"].clone())
            .unwrap_or_else(|| json!(now()));
        let roles = personal["roles"].as_array_mut().unwrap();
        if let Some(index) = roles.iter().position(|role| role["id"] == id) {
            roles[index] = value.clone();
        } else {
            roles.push(value.clone());
        }
        personal["executionDeviceId"] = json!(device);
        personal["userId"] = json!(user_id);
        personal["version"] = json!(personal["version"].as_i64().unwrap_or(0) + 1);
        write_personal(&connection, &personal)?;
        connection.commit()?;
        Ok(project_role(
            &value,
            user_id,
            project_id,
            &kind,
            personal["autoSelect"] == true,
        ))
    }
}

pub(super) fn validate_execution_settings(value: &Value) -> Result<(), TaskRuntimeError> {
    if let Some(workspace) = value.get("workspace").filter(|value| !value.is_null()) {
        if !["projectKey", "workspacePath"].iter().all(|key| {
            workspace[*key]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
        }) || !matches!(
            workspace["executionMode"].as_str(),
            Some("current_workspace" | "git_worktree")
        ) || workspace
            .get("branch")
            .is_some_and(|branch| !branch.is_null() && !branch.is_string())
        {
            return Err(TaskRuntimeError::Invalid(
                "invalid Stand-in workspace".into(),
            ));
        }
    }
    if value.get("goalMode").is_some_and(|goal| !goal.is_boolean())
        || value.get("modelOptions").is_some_and(|options| {
            !options
                .as_object()
                .is_some_and(|options| options.values().all(Value::is_string))
        })
        || value.get("model").is_some_and(|model| {
            !model.is_null()
                && (!model.is_object()
                    || !matches!(model["runtime"].as_str(), Some("codex" | "claude_code"))
                    || !["provider", "model_id"].iter().all(|key| {
                        model[*key]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                    }))
        })
    {
        return Err(TaskRuntimeError::Invalid(
            "invalid Stand-in execution settings".into(),
        ));
    }
    Ok(())
}
