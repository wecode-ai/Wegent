//! Instance binding and whole-profile lifecycle transitions are durable and versioned.
use super::personal_stand_in::{
    read_personal, stamp_project_enabled, stamp_stand_in_connections, write_personal,
};
use super::*;

const BINDING_KEY: &str = "stand-in-instance-binding";

impl LocalTaskStore {
    pub fn remember_stand_in_stop_tasks(
        &self,
        user: i64,
        device: &str,
        tasks: &[String],
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut settings = read_personal(&transaction, user, device)?;
        if settings["lifecycle"]["status"] != "stopping" {
            return Ok(settings);
        }
        let mut pending = settings["lifecycle"]["tasks"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for task in tasks {
            let task = json!(task);
            if !pending.contains(&task) {
                pending.push(task);
            }
        }
        settings["lifecycle"]["tasks"] = json!(pending);
        write_personal(&transaction, &settings)?;
        transaction.commit()?;
        Ok(settings)
    }

    pub fn stand_in_binding(
        &self,
        operation: &str,
        expected_version: i64,
        target: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut binding = get_item_from(&transaction, BINDING_KEY, "stand_in_binding")?
            .map(|item| item.metadata)
            .unwrap_or_else(|| json!({"version":0,"status":"unbound","target":null}));
        if operation == "get" {
            return Ok(binding);
        }
        if binding["version"] != expected_version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        match operation {
            "bind" => {
                if !matches!(binding["status"].as_str(), Some("unbound" | "stopped")) {
                    return Err(TaskRuntimeError::Invalid(
                        "Stop the current stand-in before changing its binding".into(),
                    ));
                }
                if !target["userId"].as_i64().is_some_and(|id| id >= 0)
                    || !target["deviceId"].as_str().is_some_and(|id| !id.is_empty())
                {
                    return Err(TaskRuntimeError::Invalid("Invalid stand-in binding".into()));
                }
                binding["target"] = target;
                binding["status"] = json!("active");
            }
            "beginStop" if matches!(binding["status"].as_str(), Some("active" | "stopping")) => {
                binding["status"] = json!("stopping");
            }
            "completeStop" if binding["status"] == "stopping" => {
                binding["status"] = json!("stopped");
            }
            _ => {
                return Err(TaskRuntimeError::Invalid(
                    "Invalid binding transition".into(),
                ))
            }
        }
        binding["version"] = json!(expected_version + 1);
        transaction.execute(
            "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_binding',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
            params![BINDING_KEY, binding.to_string(), now()],
        )?;
        transaction.commit()?;
        Ok(binding)
    }

    pub fn transition_personal_stand_in(
        &self,
        user: i64,
        device: &str,
        operation: &str,
    ) -> Result<Value, TaskRuntimeError> {
        self.personal_stand_in(user, device)?;
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_personal(&transaction, user, device)?;
        let mut settings = previous.clone();
        match operation {
            "stop" => {
                if settings["lifecycle"]["status"].is_null() {
                    settings["lifecycle"] = json!({
                        "status":"stopping",
                        "primaryEnabled":settings["primary"]["enabled"] != false,
                        "enabledRoles":settings["roles"].as_array().into_iter().flatten()
                            .filter(|role| role["enabled"] == true).map(|role| role["id"].clone()).collect::<Vec<_>>()
                    });
                }
                if !settings["primary"].is_object() {
                    settings["primary"] = json!({"prompt":"","preferences":""});
                }
                settings["primary"]["enabled"] = json!(false);
                for role in settings["roles"].as_array_mut().into_iter().flatten() {
                    role["enabled"] = json!(false);
                }
            }
            "stopped" if settings["lifecycle"]["status"] == "stopping" => {
                settings["lifecycle"]["status"] = json!("stopped");
                settings["lifecycle"]
                    .as_object_mut()
                    .unwrap()
                    .remove("tasks");
            }
            "start" => {
                if settings["lifecycle"]["status"] == "stopping" {
                    return Err(TaskRuntimeError::Invalid(
                        "Stand-in cancellation is incomplete".into(),
                    ));
                }
                if settings["lifecycle"]["status"] == "stopped" {
                    settings["primary"]["enabled"] =
                        settings["lifecycle"]["primaryEnabled"].clone();
                    let enabled = settings["lifecycle"]["enabledRoles"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    for role in settings["roles"].as_array_mut().into_iter().flatten() {
                        role["enabled"] = json!(enabled.contains(&role["id"]));
                    }
                    settings.as_object_mut().unwrap().remove("lifecycle");
                }
            }
            _ => {
                return Err(TaskRuntimeError::Invalid(
                    "Invalid stand-in lifecycle transition".into(),
                ))
            }
        }
        if settings != previous {
            if operation == "start" {
                stamp_stand_in_connections(&mut settings["primary"], &previous["primary"]);
                stamp_project_enabled(&mut settings["primary"], &previous["primary"]);
                for role in settings["roles"].as_array_mut().into_iter().flatten() {
                    let before = previous["roles"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|before| before["id"] == role["id"])
                        .unwrap_or(&Value::Null);
                    stamp_stand_in_connections(role, before);
                    stamp_project_enabled(role, before);
                }
            }
            settings["version"] = json!(previous["version"].as_i64().unwrap_or(0) + 1);
            write_personal(&transaction, &settings)?;
            super::stand_in_processing::update_processing_configuration(
                &transaction,
                user,
                &previous,
                &settings,
            )?;
        }
        transaction.commit()?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_requires_completed_stop_and_rejects_stale_transitions() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let first = json!({"userId":7,"deviceId":"mac"});
        let second = json!({"userId":7,"deviceId":"cloud"});
        store.stand_in_binding("bind", 0, first.clone()).unwrap();
        assert!(store.stand_in_binding("bind", 1, second.clone()).is_err());
        store.stand_in_binding("beginStop", 1, Value::Null).unwrap();
        assert!(store.stand_in_binding("bind", 2, second.clone()).is_err());
        assert!(store
            .stand_in_binding("completeStop", 1, Value::Null)
            .is_err());
        store
            .stand_in_binding("completeStop", 2, Value::Null)
            .unwrap();
        let reopened = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let binding = reopened
            .stand_in_binding("bind", 3, second.clone())
            .unwrap();
        assert_eq!(binding["target"], second);
        assert_eq!(binding["status"], "active");
    }

    #[test]
    fn whole_profile_stop_preserves_configuration_and_blocks_early_restart() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["enabled"] = json!(true);
        let saved = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let stopped = store
            .transition_personal_stand_in(7, "mac", "stop")
            .unwrap();
        assert_eq!(stopped["primary"]["enabled"], false);
        assert_eq!(stopped["roles"][0]["enabled"], false);
        assert!(store
            .transition_personal_stand_in(7, "mac", "start")
            .is_err());
        store
            .transition_personal_stand_in(7, "mac", "stopped")
            .unwrap();
        let resumed = store
            .transition_personal_stand_in(7, "mac", "start")
            .unwrap();
        let mut expected_roles = saved["roles"].clone();
        expected_roles[0]["enabledAfter"] = resumed["roles"][0]["enabledAfter"].clone();
        assert_eq!(resumed["roles"], expected_roles);
        assert_eq!(resumed["primary"]["enabled"], true);
        assert!(resumed["lifecycle"].is_null());
    }
}
