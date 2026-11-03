//! Project coordination leases share the existing project record and transaction.
use super::*;

fn transition_binding(
    previous: &Value,
    actor: i64,
    device: &str,
    input: &Value,
) -> Result<Value, TaskRuntimeError> {
    let enabled = input["enabled"]
        .as_bool()
        .ok_or_else(|| TaskRuntimeError::Invalid("An explicit enabled state is required".into()))?;
    if input.get("expectedGeneration") != Some(&previous["generation"]) {
        return Err(TaskRuntimeError::VersionConflict);
    }
    if !enabled && previous["enabled"] == true && previous["userId"] != actor {
        return Err(TaskRuntimeError::Invalid(
            "Only the enabling member can stop this coordination binding".into(),
        ));
    }
    if enabled && previous["enabled"] == true {
        if previous["userId"] == actor && previous["deviceId"] == device {
            return Ok(previous.clone());
        }
        if input["takeover"] != true {
            return Err(TaskRuntimeError::Invalid(
                "Explicit takeover is required for another member or device".into(),
            ));
        }
    }
    if !enabled && (previous.is_null() || previous["enabled"] == false) {
        return Ok(previous.clone());
    }
    let at = Utc::now().to_rfc3339();
    Ok(
        json!({"enabled":enabled,"userId":if enabled {json!(actor)} else {previous["userId"].clone()},"deviceId":if enabled {json!(device)} else {previous["deviceId"].clone()},"generation":Uuid::new_v4().to_string(),"sourceCutoff":if enabled && previous["enabled"]==true {previous["sourceCutoff"].clone()} else {json!(at)},"updatedBy":actor,"updatedAt":at}),
    )
}

impl LocalTaskStore {
    pub fn project_coordination_binding(
        &self,
        project_id: &str,
        group_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let project = get_item_from(&connection, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        Ok(project.metadata["projectCoordination"][group_id].clone())
    }

    pub fn set_project_coordination_binding(
        &self,
        project_id: &str,
        group_id: &str,
        actor: i64,
        device: &str,
        input: &Value,
    ) -> Result<Value, TaskRuntimeError> {
        if actor < 0 || device.trim().is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "A verified member and running device are required".into(),
            ));
        }
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        if input["enabled"] == true {
            let group = collaboration_group(&project, group_id)?;
            if group["leader"]["kind"] != "agent" {
                return Err(TaskRuntimeError::Invalid(
                    "Configure an AI group leader before enabling automatic coordination".into(),
                ));
            }
            let leader = group["leader"]["id"]
                .as_str()
                .ok_or_else(|| TaskRuntimeError::Invalid("Missing project leader".into()))?;
            collaboration_agent(&transaction, project_id, leader)?;
        }
        let previous = project.metadata["projectCoordination"][group_id].clone();
        let binding = transition_binding(&previous, actor, device, input)?;
        if binding == previous {
            return Ok(binding);
        }
        if !project.metadata["projectCoordination"].is_object() {
            project.metadata["projectCoordination"] = json!({});
        }
        project.metadata["projectCoordination"][group_id] = binding.clone();
        transaction.execute("UPDATE loop_items SET metadata=?1,version=version+1,updated_at=?2 WHERE id=?3 AND resource_type='project'", params![project.metadata.to_string(), now(), project_id])?;
        transaction.commit()?;
        Ok(binding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(store: &LocalTaskStore) -> LoopItem {
        let project = store
            .create_project(ProjectCreate {
                name: "Coordinator binding fixture".into(),
                project_key: None,
                description: "Keep project content".into(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let agent = store
            .create_chat_agent(
                &project.id,
                serde_json::from_value(json!({"name":"leader"})).unwrap(),
            )
            .unwrap();
        store.update_project(&project.id, ProjectUpdate {
            version: project.version,
            collaboration_groups: Some(json!([{"id":"group","name":"Team","leader":{"kind":"agent","id":agent.id},"members":[]}])),
            ..Default::default()
        }).unwrap()
    }

    #[test]
    fn unavailable_leader_blocks_enable_but_does_not_block_stop() {
        let home = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(home.path().join("tasks.sqlite")).unwrap();
        let project = project(&store);
        let first = store
            .set_project_coordination_binding(
                &project.id,
                "group",
                7,
                "device",
                &json!({"enabled":true,"expectedGeneration":null}),
            )
            .unwrap();
        let agent = store.list_chat_agents(&project.id).unwrap().remove(0);
        store
            .archive_chat_agent(&project.id, &agent.id, agent.version)
            .unwrap();
        assert!(store
            .set_project_coordination_binding(
                &project.id,
                "group",
                7,
                "device",
                &json!({"enabled":true,"expectedGeneration":first["generation"]})
            )
            .is_err());
        let stopped = store
            .set_project_coordination_binding(
                &project.id,
                "group",
                7,
                "device",
                &json!({"enabled":false,"expectedGeneration":first["generation"]}),
            )
            .unwrap();
        assert_eq!(stopped["enabled"], false);
        assert_ne!(stopped["generation"], first["generation"]);
    }

    #[test]
    fn concurrent_devices_cannot_both_acquire_the_same_project_binding() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let project = project(&store);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = ["device-a", "device-b"]
            .into_iter()
            .map(|device| {
                let store = LocalTaskStore::open(&path).unwrap();
                let id = project.id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.set_project_coordination_binding(
                        &id,
                        "group",
                        7,
                        device,
                        &json!({"enabled":true,"expectedGeneration":null}),
                    )
                })
            })
            .collect();
        let outcomes: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert!(outcomes
            .iter()
            .any(|outcome| matches!(outcome, Err(TaskRuntimeError::VersionConflict))));
        let binding = store
            .project_coordination_binding(&project.id, "group")
            .unwrap();
        assert!(matches!(
            binding["deviceId"].as_str(),
            Some("device-a" | "device-b")
        ));
        let current = store.get_project(&project.id).unwrap();
        assert_eq!(current.description, "Keep project content");
        assert_eq!(
            current.metadata["collaboration_groups"],
            project.metadata["collaboration_groups"]
        );
        assert_eq!(current.version, project.version + 1);
    }

    #[test]
    fn identical_group_ids_in_distinct_projects_have_independent_bindings() {
        let home = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(home.path().join("tasks.sqlite")).unwrap();
        let first_project = project(&store);
        let second_project = project(&store);
        let first = store
            .set_project_coordination_binding(
                &first_project.id,
                "group",
                7,
                "device-a",
                &json!({"enabled":true,"expectedGeneration":null}),
            )
            .unwrap();
        let second = store
            .set_project_coordination_binding(
                &second_project.id,
                "group",
                8,
                "device-b",
                &json!({"enabled":true,"expectedGeneration":null}),
            )
            .unwrap();
        assert_ne!(first["generation"], second["generation"]);
        assert_eq!(
            store
                .project_coordination_binding(&first_project.id, "group")
                .unwrap(),
            first
        );
        assert_eq!(
            store
                .project_coordination_binding(&second_project.id, "group")
                .unwrap(),
            second
        );
        assert!(store
            .set_project_coordination_binding(
                &first_project.id,
                "group",
                8,
                "device-b",
                &json!({"enabled":false,"expectedGeneration":first["generation"]})
            )
            .is_err());
    }

    #[test]
    fn bindings_require_a_current_generation_and_explicit_takeover() {
        let first = transition_binding(
            &Value::Null,
            7,
            "device-a",
            &json!({"enabled":true,"expectedGeneration":null}),
        )
        .unwrap();
        assert!(transition_binding(
            &first,
            8,
            "device-b",
            &json!({"enabled":true,"expectedGeneration":null,"takeover":true})
        )
        .is_err());
        assert!(transition_binding(
            &first,
            8,
            "device-b",
            &json!({"enabled":true,"expectedGeneration":first["generation"]})
        )
        .is_err());
        let next = transition_binding(
            &first,
            8,
            "device-b",
            &json!({"enabled":true,"expectedGeneration":first["generation"],"takeover":true}),
        )
        .unwrap();
        assert_ne!(next["generation"], first["generation"]);
        assert_eq!(next["sourceCutoff"], first["sourceCutoff"]);
        assert_eq!(next["userId"], 8);
        assert_eq!(next["updatedBy"], 8);
        assert!(transition_binding(
            &next,
            7,
            "device-a",
            &json!({"enabled":false,"expectedGeneration":next["generation"]})
        )
        .is_err());
    }

    #[test]
    fn replay_is_stable_and_reenable_never_resurrects_an_old_generation() {
        let first = transition_binding(
            &Value::Null,
            7,
            "device",
            &json!({"enabled":true,"expectedGeneration":null}),
        )
        .unwrap();
        assert_eq!(
            transition_binding(
                &first,
                7,
                "device",
                &json!({"enabled":true,"expectedGeneration":first["generation"]})
            )
            .unwrap(),
            first
        );
        let stopped = transition_binding(
            &first,
            7,
            "device",
            &json!({"enabled":false,"expectedGeneration":first["generation"]}),
        )
        .unwrap();
        let resumed = transition_binding(
            &stopped,
            7,
            "device",
            &json!({"enabled":true,"expectedGeneration":stopped["generation"]}),
        )
        .unwrap();
        assert_ne!(resumed["generation"], first["generation"]);
        assert!(transition_binding(&Value::Null, 7, "device", &json!({"enabled":true})).is_err());
    }
}
