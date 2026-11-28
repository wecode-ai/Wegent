use super::*;

#[test]
fn delete_chat_agent_blocks_group_references_and_preserves_other_records() {
    let (directory, store, mut project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    let retained = make_local_agent(&store, &project.id, "auto");
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.wegent_team_id',42) WHERE id=?1",
            [&agent.id],
        )
        .unwrap();
    for reference in [agent.id.as_str(), "42"] {
        for group in [
            json!({"leader":{"kind":"agent","id":reference}}),
            json!({"members":[{"kind":"agent","id":reference}]}),
            json!({"stages":[{"assignee":{"kind":"agent","id":reference}}]}),
        ] {
            project = store
                .update_project(
                    &project.id,
                    ProjectUpdate {
                        version: project.version,
                        collaboration_groups: Some(json!([group])),
                        ..Default::default()
                    },
                )
                .unwrap();
            let error = store
                .delete_chat_agent(&project.id, &agent.id, agent.version)
                .unwrap_err();
            assert!(error.to_string().contains("PROJECT_AGENT_IN_USE"));
            assert_eq!(store.list_chat_agents(&project.id).unwrap().len(), 2);
        }
    }
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(json!([])),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .delete_chat_agent(&project.id, &agent.id, agent.version)
        .unwrap();
    drop(store);
    let reopened = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let remaining = reopened.list_chat_agents(&project.id).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, retained.id);
    let connection = reopened.connection().unwrap();
    let (status, deleted): (String, Option<String>) = connection
        .query_row(
            "SELECT status,deleted_at FROM loop_items WHERE id=?1",
            params![agent.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "archived");
    assert!(deleted.is_some());
}

#[test]
fn delete_chat_agent_checks_version_project_and_managed_agents() {
    let (_directory, store, project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    assert!(matches!(
        store.delete_chat_agent(&project.id, &agent.id, agent.version + 1),
        Err(TaskRuntimeError::VersionConflict)
    ));
    assert!(store
        .delete_chat_agent("other-project", &agent.id, agent.version)
        .is_err());
    let managed = store
        .create_chat_agent(&project.id, default_chat_agent_input())
        .unwrap();
    assert!(store
        .delete_chat_agent(&project.id, &managed.id, managed.version)
        .unwrap_err()
        .to_string()
        .contains("PROJECT_AGENT_MANAGED"));
    assert_eq!(store.list_chat_agents(&project.id).unwrap().len(), 2);
}

#[test]
fn stale_group_draft_cannot_reference_an_agent_deleted_after_the_project_was_read() {
    let (_directory, store, project) = chat_agent_store();
    let agent = make_local_agent(&store, &project.id, "auto");
    LocalTaskStore::open(store.path())
        .unwrap()
        .delete_chat_agent(&project.id, &agent.id, agent.version)
        .unwrap();
    let error = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(
                    json!([{"leader":{"kind":"agent","id":agent.id},"members":[],"stages":[]}]),
                ),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("not active"));
    let persisted = store.get_project(&project.id).unwrap();
    assert_eq!(persisted.version, project.version);
    assert_eq!(
        persisted.metadata["collaboration_groups"],
        project.metadata["collaboration_groups"]
    );
}

#[test]
fn project_binding_reuses_source_and_removal_preserves_definition() {
    let (_directory, store, project) = chat_agent_store();
    let mut input = default_chat_agent_input();
    input.name = "source".into();
    input.created_by_user_id = Some(project.created_by_user_id);
    let source = store
        .create_chat_agent(DEFAULT_WORK_ITEM_PROJECT_ID, input)
        .unwrap();
    let binding = store
        .bind_chat_agent(&project.id, &source.team_ref)
        .unwrap();
    assert_eq!(binding.team_ref, source.id);
    assert_eq!(binding.source_project_id, DEFAULT_WORK_ITEM_PROJECT_ID);
    store
        .bind_chat_agent(&project.id, &source.team_ref)
        .unwrap();
    assert_eq!(store.list_chat_agents(&project.id).unwrap().len(), 1);
    assert!(store
        .delete_chat_agent(DEFAULT_WORK_ITEM_PROJECT_ID, &source.id, source.version)
        .is_err());
    store
        .delete_chat_agent(&project.id, &source.id, source.version)
        .unwrap();
    assert!(store.list_chat_agents(&project.id).unwrap().is_empty());
    assert!(store
        .list_chat_agents(DEFAULT_WORK_ITEM_PROJECT_ID)
        .unwrap()
        .iter()
        .any(|agent| agent.id == source.id));
    let foreign = make_local_agent(&store, DEFAULT_WORK_ITEM_PROJECT_ID, "auto");
    assert!(store.bind_chat_agent(&project.id, &foreign.id).is_err());
}
