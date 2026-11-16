use super::*;

impl LocalTaskStore {
    pub fn project_coordinator_context(
        &self,
        project_id: &str,
        group_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let project = get_item_from(&connection, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let mut group = collaboration_group(&project, group_id)?;
        let revision = Self::coordination_event_version(&group);
        group["version"] = json!(revision);
        let agent = if group["leader"]["kind"] == "agent" {
            let id = group["leader"]["id"]
                .as_str()
                .ok_or_else(|| TaskRuntimeError::Invalid("Missing project leader".into()))?;
            serde_json::to_value(map_chat_agent(collaboration_agent(
                &connection,
                project_id,
                id,
            )?))
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?
        } else {
            Value::Null
        };
        Ok(
            json!({"project":{"id":project.id,"name":project.name,"description":project.description,"version":project.version},"group":group,"agent":agent}),
        )
    }
}
