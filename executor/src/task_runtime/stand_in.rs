//! Personal device settings stored alongside existing local project data.
use super::*;

fn key(project_id: &str, user_id: i64, stand_in_id: &str) -> Result<String, TaskRuntimeError> {
    if stand_in_id.is_empty()
        || stand_in_id.len() > 64
        || !stand_in_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(TaskRuntimeError::Invalid("invalid Stand-in id".into()));
    }
    Ok(format!("stand_in:{project_id}:{user_id}:{stand_in_id}"))
}

fn defaults(id: &str) -> Value {
    json!({"id":id,"name":"","tags":[],"enabled":false,"prompt":"","executionDeviceId":"","version":0})
}

impl LocalTaskStore {
    pub fn stand_in_settings(
        &self,
        project_id: &str,
        user_id: i64,
        stand_in_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        Ok(get_item_from(
            &connection,
            &key(project_id, user_id, stand_in_id)?,
            "stand_in_settings",
        )?
        .map(|row| row.metadata)
        .unwrap_or_else(|| defaults(stand_in_id)))
    }

    pub fn save_stand_in_settings(
        &self,
        project_id: &str,
        user_id: i64,
        mut value: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let stand_in_id = value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_owned();
        let id = key(project_id, user_id, &stand_in_id)?;
        if value.get("id").is_some_and(|id| !id.is_string())
            || value.get("name").is_some_and(|name| {
                !name.is_string() || name.as_str().unwrap().chars().count() > 100
            })
        {
            return Err(TaskRuntimeError::Invalid(
                "invalid Stand-in identity".into(),
            ));
        }
        let tags = value.get("tags").cloned().unwrap_or_else(|| json!([]));
        if !tags.as_array().is_some_and(|tags| {
            tags.len() <= 50
                && tags.iter().all(|tag| {
                    tag.as_str()
                        .is_some_and(|tag| !tag.trim().is_empty() && tag.chars().count() <= 100)
                })
        }) {
            return Err(TaskRuntimeError::Invalid(
                "tags must be nonempty tag names".into(),
            ));
        }
        value["id"] = json!(stand_in_id);
        value["tags"] = tags;
        if value
            .get("agentId")
            .is_some_and(|id| !id.is_null() && !id.is_string())
        {
            return Err(TaskRuntimeError::Invalid(
                "agentId must be a string or null".into(),
            ));
        }
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
        let enabled = value["enabled"]
            .as_bool()
            .ok_or_else(|| TaskRuntimeError::Invalid("enabled is required".into()))?;
        let prompt = value["prompt"]
            .as_str()
            .ok_or_else(|| TaskRuntimeError::Invalid("prompt is required".into()))?;
        let device = value["executionDeviceId"]
            .as_str()
            .ok_or_else(|| TaskRuntimeError::Invalid("device is required".into()))?;
        if prompt.chars().count() > 8000 || (enabled && device.trim().is_empty()) {
            return Err(TaskRuntimeError::Invalid("invalid StandIn settings".into()));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if value["projectStore"] != "cloud" {
            get_item_from(&connection, project_id, "project")?
                .ok_or(TaskRuntimeError::ProjectNotFound)?;
        }
        let previous = get_item_from(&connection, &id, "stand_in_settings")?;
        let version = previous
            .as_ref()
            .map(|row| row.metadata["version"].as_i64().unwrap_or(0))
            .unwrap_or(0);
        if value["version"].as_i64() != Some(version) {
            return Err(TaskRuntimeError::VersionConflict);
        }
        value["version"] = json!(version + 1);
        value["userId"] = json!(user_id);
        value["projectId"] = json!(project_id);
        value["enabledAfter"] = if enabled
            && previous
                .as_ref()
                .is_some_and(|row| row.metadata["enabled"] == true)
        {
            previous.as_ref().unwrap().metadata["enabledAfter"].clone()
        } else {
            json!(now())
        };
        connection.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,metadata,created_at,updated_at) VALUES (?1,'stand_in_settings',?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at", params![id, if value["projectStore"] == "cloud" { None } else { Some(project_id) }, value.to_string(), now()])?;
        connection.commit()?;
        Ok(value)
    }

    pub fn enabled_stand_in_settings(&self) -> Result<Vec<Value>, TaskRuntimeError> {
        Ok(self
            .all_stand_in_settings()?
            .into_iter()
            .filter(|value| value["enabled"] == true)
            .collect())
    }

    pub fn user_stand_in_settings(&self, user_id: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        Ok(self
            .all_stand_in_settings()?
            .into_iter()
            .filter(|value| value["userId"] == user_id)
            .collect())
    }

    fn all_stand_in_settings(&self) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_settings'")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut settings = Vec::new();
        for row in rows {
            let value: Value = serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            settings.push(value);
        }
        Ok(settings)
    }
}
