//! Instance binding and whole-profile lifecycle transitions are durable and versioned.
use super::personal_stand_in::{
    read_personal, stamp_project_enabled, stamp_stand_in_connections, write_personal,
};
use super::*;

const BINDING_KEY: &str = "stand-in-instance-binding";

/// A stopped target accepts only portable, disabled imports without changing its saved grants.
pub(super) fn preserve_stopped_import(
    previous: &Value,
    value: &mut Value,
) -> Result<(), TaskRuntimeError> {
    if previous["lifecycle"]["status"].is_null() {
        value.as_object_mut().unwrap().remove("lifecycle");
        return Ok(());
    }
    let old = previous["roles"].as_array().unwrap();
    let roles = value["roles"].as_array().unwrap();
    let unchanged = old.iter().all(|role| roles.iter().any(|next| next == role));
    let portable = roles
        .iter()
        .filter(|role| !old.iter().any(|before| before["id"] == role["id"]))
        .all(|role| {
            role["enabled"] == false
                && role["migrationSource"]
                    .as_str()
                    .is_some_and(|source| !source.is_empty())
                && role["connections"].is_null()
                && role["workspace"].is_null()
                && role["collaboration"]["enabled"] == false
                && role["collaboration"]["allProjects"] == false
        });
    if previous["lifecycle"]["status"] != "stopped"
        || value["primary"] != previous["primary"]
        || !unchanged
        || !portable
    {
        return Err(TaskRuntimeError::Invalid("A stopped stand-in accepts only disabled portable imports without changing existing configuration".into()));
    }
    value["lifecycle"] = previous["lifecycle"].clone();
    Ok(())
}

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
        instance_device: Option<&str>,
        operation: &str,
        expected_version: i64,
        target: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let key = instance_device.map(|device| format!("{BINDING_KEY}:{device}"));
        let key = key.as_deref().unwrap_or(BINDING_KEY);
        let mut saved = get_item_from(&transaction, key, "stand_in_binding")?;
        if let (None, Some(device)) = (&saved, instance_device) {
            // Development worktrees share this database but have separate desktop IDs.
            // A legacy local binding can only belong to the device it was bound to.
            if let Some(legacy) = get_item_from(&transaction, BINDING_KEY, "stand_in_binding")?
                .filter(|item| item.metadata["target"]["deviceId"].as_str() == Some(device))
            {
                transaction.execute(
                    "UPDATE loop_items SET id=?1 WHERE id=?2 AND resource_type='stand_in_binding'",
                    params![key, BINDING_KEY],
                )?;
                saved = Some(legacy);
            }
        }
        let mut binding = saved
            .map(|item| item.metadata)
            .unwrap_or_else(|| json!({"version":0,"status":"unbound","target":null}));
        if operation == "get" {
            transaction.commit()?;
            return Ok(binding);
        }
        if matches!(
            operation,
            "markStopping"
                | "clearStopping"
                | "markStoppingWithGeneration"
                | "clearStoppingIfGeneration"
        ) {
            let (Some(user_id), Some(device_id)) = (
                target["userId"].as_i64().filter(|id| *id >= 0),
                target["deviceId"].as_str().filter(|id| !id.is_empty()),
            ) else {
                return Err(TaskRuntimeError::Invalid("Invalid stand-in binding".into()));
            };
            let stop_key = format!("{user_id}:{device_id}");
            let mut stopping = binding["stoppingTargets"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let generation = binding["stoppingTargetGenerations"][&stop_key]
                .as_i64()
                .unwrap_or(0);
            let legacy_stopping = binding["status"] == "stopping"
                && binding["target"]["userId"].as_i64() == Some(user_id)
                && binding["target"]["deviceId"].as_str() == Some(device_id);
            let pending =
                stopping.iter().any(|item| item.as_str() == Some(&stop_key)) || legacy_stopping;
            if matches!(operation, "markStopping" | "markStoppingWithGeneration") {
                if operation == "markStoppingWithGeneration" {
                    let next = binding["stoppingGeneration"]
                        .as_i64()
                        .unwrap_or(0)
                        .checked_add(1)
                        .ok_or_else(|| {
                            TaskRuntimeError::Invalid("Stop marker generation exhausted".into())
                        })?;
                    binding["stoppingGeneration"] = json!(next);
                    binding["stoppingTargetGenerations"][&stop_key] = json!(next);
                }
                if !stopping.iter().any(|item| item.as_str() == Some(&stop_key)) {
                    stopping.push(json!(stop_key));
                }
            } else {
                let expected = if operation == "clearStoppingIfGeneration" {
                    expected_version
                } else {
                    0
                };
                if !pending {
                    transaction.commit()?;
                    return Ok(binding);
                }
                if generation != expected {
                    return Err(TaskRuntimeError::VersionConflict);
                }
                stopping.retain(|item| item.as_str() != Some(&stop_key));
                if let Some(generations) = binding
                    .get_mut("stoppingTargetGenerations")
                    .and_then(Value::as_object_mut)
                {
                    generations.remove(&stop_key);
                }
                // Clearing a verified stop must retire the pre-upgrade stop state too.
                // Keep its target and advance the legacy CAS version only if changed.
                if legacy_stopping {
                    binding["status"] = json!("stopped");
                    binding["version"] = json!(binding["version"].as_i64().unwrap_or(0) + 1);
                }
            }
            if stopping.is_empty() {
                if let Some(object) = binding.as_object_mut() {
                    object.remove("stoppingTargets");
                }
            } else {
                binding["stoppingTargets"] = json!(stopping);
            }
            transaction.execute(
                "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_binding',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
                params![key, binding.to_string(), now()],
            )?;
            transaction.commit()?;
            return Ok(binding);
        }
        if binding["version"] != expected_version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        match operation {
            "bind" | "prepareBind" | "prepareReplacement" => {
                let status = binding["status"].as_str();
                let allowed = match operation {
                    "prepareReplacement" => {
                        matches!(status, Some("active" | "stopping"))
                            && target["deviceId"] != binding["target"]["deviceId"]
                            && (binding["target"]["userId"] == 0
                                || target["userId"] == binding["target"]["userId"])
                    }
                    _ => matches!(status, Some("unbound" | "stopped")),
                };
                if !allowed {
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
                binding["status"] = if operation == "bind" {
                    json!("active")
                } else {
                    json!("activating")
                };
            }
            "completeActivation" if binding["status"] == "activating" => {
                binding["status"] = json!("active");
            }
            "cancelActivation"
                if binding["status"] == "activating"
                    && target["userId"] == binding["target"]["userId"]
                    && target["deviceId"] == binding["target"]["deviceId"] =>
            {
                binding["status"] = json!("unbound");
                binding["target"] = Value::Null;
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
                ));
            }
        }
        binding["version"] = json!(expected_version + 1);
        transaction.execute(
            "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_binding',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
            params![key, binding.to_string(), now()],
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
        self.transition_personal_stand_in_with_version(user, device, operation, None)
    }

    pub fn transition_personal_stand_in_with_version(
        &self,
        user: i64,
        device: &str,
        operation: &str,
        expected_version: Option<i64>,
    ) -> Result<Value, TaskRuntimeError> {
        self.personal_stand_in(user, device)?;
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_personal(&transaction, user, device)?;
        if expected_version.is_some_and(|version| previous["version"] != version) {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let mut settings = previous.clone();
        match operation {
            "stop" => {
                transaction.execute(
                    "DELETE FROM loop_items WHERE resource_type='stand_in_dispatch' AND json_extract(metadata,'$.userId')=?1",
                    [user],
                )?;
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
                ));
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
        store
            .stand_in_binding(None, "bind", 0, first.clone())
            .unwrap();
        assert!(store
            .stand_in_binding(None, "bind", 1, second.clone())
            .is_err());
        store
            .stand_in_binding(None, "beginStop", 1, Value::Null)
            .unwrap();
        assert!(store
            .stand_in_binding(None, "bind", 2, second.clone())
            .is_err());
        assert!(store
            .stand_in_binding(None, "completeStop", 1, Value::Null)
            .is_err());
        store
            .stand_in_binding(None, "completeStop", 2, Value::Null)
            .unwrap();
        let reopened = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let binding = reopened
            .stand_in_binding(None, "bind", 3, second.clone())
            .unwrap();
        assert_eq!(binding["target"], second);
        assert_eq!(binding["status"], "active");
    }

    #[test]
    fn explicit_unavailable_replacement_is_limited_to_the_same_account_and_another_device() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let old = json!({"userId":7,"deviceId":"offline"});
        let new = json!({"userId":7,"deviceId":"online"});
        store
            .stand_in_binding(None, "bind", 0, old.clone())
            .unwrap();
        assert!(store
            .stand_in_binding(None, "prepareReplacement", 1, old)
            .is_err());
        assert!(store
            .stand_in_binding(None, "prepareReplacement", 0, new.clone())
            .is_err());
        assert!(store
            .stand_in_binding(
                None,
                "prepareReplacement",
                1,
                json!({"userId":8,"deviceId":"online"})
            )
            .is_err());
        let binding = store
            .stand_in_binding(None, "prepareReplacement", 1, new.clone())
            .unwrap();
        assert_eq!(binding["target"], new);
        assert_eq!(binding["status"], "activating");
        let reopened = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        assert_eq!(
            reopened
                .stand_in_binding(None, "get", 0, Value::Null)
                .unwrap()["status"],
            "activating"
        );
        let ready = reopened
            .stand_in_binding(None, "completeActivation", 2, Value::Null)
            .unwrap();
        assert_eq!(ready["status"], "active");
    }

    #[test]
    fn binding_reads_preserve_legacy_metadata_without_migrating() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let target = json!({
            "userId":7,"deviceId":"mac",
            "backendUrl":"https://original.example/api","username":"previous-name"
        });
        let binding = store.stand_in_binding(None, "bind", 0, target).unwrap();
        assert_eq!(
            store.stand_in_binding(None, "get", 0, Value::Null).unwrap(),
            binding
        );
        assert!(store
            .stand_in_binding(None, "unsupported", 1, Value::Null)
            .is_err());
        let reopened = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        assert_eq!(
            reopened
                .stand_in_binding(None, "get", 0, Value::Null)
                .unwrap(),
            binding
        );
    }

    #[test]
    fn stopping_targets_persist_across_reopen_without_mutating_legacy_binding_version() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let cloud = json!({"userId":7,"deviceId":"cloud-1"});
        let other = json!({"userId":8,"deviceId":"cloud-2"});
        let marked = store
            .stand_in_binding(None, "markStopping", -1, cloud.clone())
            .unwrap();
        assert_eq!(marked["version"], 0);
        assert_eq!(marked["stoppingTargets"], json!(["7:cloud-1"]));
        store
            .stand_in_binding(None, "markStopping", -1, other.clone())
            .unwrap();
        let reopened = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        assert_eq!(
            reopened
                .stand_in_binding(None, "get", 0, Value::Null)
                .unwrap()["stoppingTargets"],
            json!(["7:cloud-1", "8:cloud-2"])
        );
        let cleared = reopened
            .stand_in_binding(None, "clearStopping", -1, cloud)
            .unwrap();
        assert_eq!(cleared["stoppingTargets"], json!(["8:cloud-2"]));
        let all_cleared = reopened
            .stand_in_binding(None, "clearStopping", -1, other)
            .unwrap();
        assert!(all_cleared.get("stoppingTargets").is_none());
    }

    #[test]
    fn stale_stop_clear_and_abandoned_activation_cannot_change_newer_state() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let target = json!({"userId":7,"deviceId":"cloud"});
        let key = "7:cloud";
        store
            .stand_in_binding(None, "markStopping", -1, target.clone())
            .unwrap();
        let first = store
            .stand_in_binding(None, "markStoppingWithGeneration", -1, target.clone())
            .unwrap();
        let first_generation = first["stoppingTargetGenerations"][key].as_i64().unwrap();
        let second = store
            .stand_in_binding(None, "markStoppingWithGeneration", -1, target.clone())
            .unwrap();
        let second_generation = second["stoppingTargetGenerations"][key].as_i64().unwrap();
        assert!(second_generation > first_generation);
        let reopened = LocalTaskStore::open(&path).unwrap();
        assert!(reopened
            .stand_in_binding(None, "clearStopping", -1, target.clone())
            .is_err());
        assert!(reopened
            .stand_in_binding(
                None,
                "clearStoppingIfGeneration",
                first_generation,
                target.clone()
            )
            .is_err());
        assert_eq!(
            reopened
                .stand_in_binding(None, "get", 0, Value::Null)
                .unwrap(),
            second
        );
        assert!(reopened
            .stand_in_binding(
                None,
                "clearStoppingIfGeneration",
                second_generation,
                target.clone()
            )
            .unwrap()
            .get("stoppingTargets")
            .is_none());
        let prepared = reopened
            .stand_in_binding(None, "prepareBind", 0, target.clone())
            .unwrap();
        assert_eq!(prepared["status"], "activating");
        let retired = reopened
            .stand_in_binding(None, "cancelActivation", 1, target.clone())
            .unwrap();
        assert_eq!(retired["status"], "unbound");
        assert!(retired["target"].is_null());
        let replacement = reopened
            .stand_in_binding(None, "prepareBind", 2, target.clone())
            .unwrap();
        assert!(reopened
            .stand_in_binding(None, "cancelActivation", 1, target)
            .is_err());
        assert_eq!(
            reopened
                .stand_in_binding(None, "get", 0, Value::Null)
                .unwrap(),
            replacement
        );
    }

    #[test]
    fn clearing_a_verified_stop_retires_only_matching_legacy_state() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let cloud = json!({"userId":7,"deviceId":"cloud-1"});
        let other = json!({"userId":7,"deviceId":"cloud-2"});
        let store = LocalTaskStore::open(&path).unwrap();
        store
            .stand_in_binding(None, "bind", 0, cloud.clone())
            .unwrap();
        store
            .stand_in_binding(None, "beginStop", 1, Value::Null)
            .unwrap();
        let unrelated = store
            .stand_in_binding(None, "clearStopping", -1, other)
            .unwrap();
        assert_eq!(unrelated["status"], "stopping");
        assert_eq!(unrelated["version"], 2);
        store
            .stand_in_binding(None, "clearStopping", -1, cloud.clone())
            .unwrap();
        let reopened = LocalTaskStore::open(&path).unwrap();
        let binding = reopened
            .stand_in_binding(None, "get", 0, Value::Null)
            .unwrap();
        assert_eq!(binding["status"], "stopped");
        assert_eq!(binding["target"], cloud);
        assert_eq!(binding["version"], 3);
        assert_eq!(
            reopened
                .stand_in_binding(None, "clearStopping", -1, cloud)
                .unwrap(),
            binding
        );
    }

    #[test]
    fn development_bindings_are_device_scoped_in_the_shared_store() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let old_target = json!({"userId":7,"deviceId":"old-dev"});
        let new_target = json!({"userId":7,"deviceId":"cloud"});
        store.stand_in_binding(None, "bind", 0, old_target).unwrap();
        let legacy = store
            .stand_in_binding(None, "beginStop", 1, Value::Null)
            .unwrap();

        let new = store
            .stand_in_binding(Some("new-dev"), "get", 0, Value::Null)
            .unwrap();
        assert_eq!(new["status"], "unbound");
        let new = store
            .stand_in_binding(Some("new-dev"), "bind", 0, new_target.clone())
            .unwrap();
        assert_eq!(new["target"]["deviceId"], "cloud");

        assert_eq!(
            store
                .stand_in_binding(Some("old-dev"), "get", 0, Value::Null)
                .unwrap(),
            legacy
        );
        let marked = store
            .stand_in_binding(Some("new-dev"), "markStopping", -1, new_target.clone())
            .unwrap();
        assert_eq!(marked["stoppingTargets"], json!(["7:cloud"]));
        let reopened = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        assert_eq!(
            reopened
                .stand_in_binding(Some("new-dev"), "get", 0, Value::Null)
                .unwrap(),
            marked
        );
        assert_eq!(
            reopened
                .stand_in_binding(Some("old-dev"), "get", 0, Value::Null)
                .unwrap(),
            legacy
        );
        assert_eq!(
            reopened
                .stand_in_binding(Some("new-dev"), "clearStopping", -1, new_target)
                .unwrap(),
            new
        );
        store
            .stand_in_binding(Some("old-dev"), "completeStop", 2, Value::Null)
            .unwrap();
        assert_eq!(
            store
                .stand_in_binding(Some("new-dev"), "get", 0, Value::Null)
                .unwrap(),
            new
        );
    }

    #[test]
    fn whole_profile_stop_preserves_configuration_and_blocks_early_restart() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"] = json!([crate::task_runtime::personal_stand_in::empty_role(
            "default", "mac"
        )]);
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

    #[test]
    fn stopped_targets_only_append_disabled_portable_imports_and_never_restore_their_enablement() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"] = json!([crate::task_runtime::personal_stand_in::empty_role(
            "default", "mac"
        )]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        store
            .transition_personal_stand_in(7, "mac", "stop")
            .unwrap();
        let stopped = store
            .transition_personal_stand_in(7, "mac", "stopped")
            .unwrap();
        let mut imported = stopped["roles"][0].clone();
        imported["id"] = json!("migrated-test");
        imported["name"] = json!("Imported responsibilities");
        imported["migrationSource"] = json!("source-device:primary");
        imported["collaboration"]["allProjects"] = json!(false);
        let mut draft = stopped.clone();
        draft["roles"].as_array_mut().unwrap().push(imported);
        draft["lifecycle"]["enabledRoles"] = json!(["migrated-test"]);
        let saved = store
            .save_personal_stand_in(7, "mac", draft.clone())
            .unwrap();
        assert_eq!(saved["lifecycle"], stopped["lifecycle"]);
        let mut edit = saved.clone();
        edit["primary"]["prompt"] = json!("Overwrite existing responsibilities");
        assert!(store.save_personal_stand_in(7, "mac", edit).is_err());
        let mut enable = saved.clone();
        enable["roles"][1]["enabled"] = json!(true);
        assert!(store.save_personal_stand_in(7, "mac", enable).is_err());
        let mut granted = saved.clone();
        let mut next = draft["roles"][1].clone();
        next["id"] = json!("migrated-with-workspace");
        next["workspace"] = json!({"projectKey":"source-private-directory"});
        granted["roles"].as_array_mut().unwrap().push(next);
        assert!(store.save_personal_stand_in(7, "mac", granted).is_err());
        let resumed = store
            .transition_personal_stand_in(7, "mac", "start")
            .unwrap();
        assert_eq!(resumed["roles"][1]["enabled"], false);
        assert_eq!(resumed["roles"][1]["name"], "Imported responsibilities");
    }
}
