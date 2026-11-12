mod common;
use common::*;
use serde_json::json;
use wegent_local_task_store::{LocalTaskStore, LoopItem, ProjectUpdate};

fn task(store: &LocalTaskStore, group: &str, project: Option<&str>) -> LoopItem {
    store
        .create_task_with_context(
            group,
            serde_json::from_value(json!({"title":"Resolve exact resources","status":"pending"}))
                .unwrap(),
            None,
            None,
            project.map(str::to_owned),
        )
        .unwrap()
}

#[test]
fn group_resolution_returns_only_the_selected_current_source_without_mutation() {
    let (_directory, store, group) = fixture();
    let own = agent(&store, &group);
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Resource scope"})).unwrap())
        .unwrap();
    let shared = agent(&store, &project.id);
    let item = task(&store, &group, Some(&project.id));
    for (selected, source) in [(&own, &group), (&shared, &project.id)] {
        let resolved = store
            .resolve_chat_agents_for_task(&group, &item.id, "agent", &selected.id, None)
            .unwrap();
        assert_eq!(resolved["work_owner_id"], group);
        assert_eq!(resolved["resource_owner_id"], *source);
        assert_eq!(resolved["agents"].as_array().unwrap().len(), 1);
        assert_eq!(resolved["agents"][0]["id"], selected.id);
        assert_eq!(resolved["references"][&selected.id], selected.id);
        assert_eq!(
            store.get_task(&group, &item.id).unwrap().version,
            item.version
        );
    }
    assert!(store
        .resolve_chat_agents_for_task(&project.id, &item.id, "agent", &shared.id, None)
        .is_err());
    assert!(store
        .resolve_chat_agents_for_task(&group, &item.id, "unknown", &shared.id, None)
        .is_err());
    store.archive_project(&project.id, project.version).unwrap();
    assert!(store
        .resolve_chat_agents_for_task(&group, &item.id, "agent", &shared.id, None)
        .is_err());
    assert!(store
        .resolve_chat_agents_for_task(&group, &item.id, "agent", &own.id, None)
        .is_ok());
    let completed = store
        .update_task(
            &group,
            &item.id,
            serde_json::from_value(json!({"version":item.version,"status":"completed"})).unwrap(),
        )
        .unwrap();
    assert!(store
        .resolve_chat_agents_for_task(&group, &completed.id, "agent", &own.id, None)
        .is_err());
}

#[test]
fn exact_project_crew_team_aliases_resolve_to_complete_canonical_references() {
    let (directory, store, group) = fixture();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Installed crew source"})).unwrap())
        .unwrap();
    let installed = agent(&store, "default-work-items");
    let unrelated = agent(&store, "default-work-items");
    let member = agent(&store, "default-work-items");
    let connection = rusqlite::Connection::open(directory.path().join("tasks.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.wegent_team_id',42) WHERE id=?1",
            [&installed.id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.wegent_team_id',84) WHERE id=?1",
            [&member.id],
        )
        .unwrap();
    drop(connection);
    let mut definition = crew(&project.id, "42");
    definition["members"] = json!([{ "kind":"agent","id":"84" },{ "kind":"agent","id":installed.id },{ "kind":"human","id":"0" }]);
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                collaboration_groups: Some(json!([definition])),
                ..Default::default()
            },
        )
        .unwrap();
    let own = agent(&store, &group);
    update(
        &store,
        &group,
        json!({"collaboration_groups":[crew(&group,&own.id)]}),
    )
    .unwrap();
    let item = task(&store, &group, Some(&project.id));
    assert!(store
        .resolve_chat_agents_for_task(&group, &item.id, "group", "same-crew-id", None)
        .is_err());
    let resolved = store
        .resolve_chat_agents_for_task(&group, &item.id, "group", "same-crew-id", Some(&project.id))
        .unwrap();
    assert_eq!(resolved["resource_owner_id"], project.id);
    assert_eq!(
        resolved["collaboration_group"]["binding_owner_id"],
        project.id
    );
    assert_eq!(
        resolved["collaboration_group"]["owner_id"],
        "original-definition-owner"
    );
    assert_eq!(resolved["collaboration_group"]["leader"]["id"], "42");
    assert_eq!(resolved["agents"].as_array().unwrap().len(), 2);
    assert_eq!(resolved["agents"][0]["id"], installed.id);
    assert_eq!(resolved["references"]["84"], member.id);
    assert_eq!(resolved["references"][&member.id], member.id);
    assert_eq!(resolved["references"]["42"], installed.id);
    assert_eq!(resolved["references"][&installed.id], installed.id);
    assert!(store
        .resolve_chat_agents_for_task(&group, &item.id, "agent", &unrelated.id, None)
        .is_err());
    assert!(store
        .list_chat_agents(&group)
        .unwrap()
        .iter()
        .all(|entry| entry.id != installed.id));
}

#[test]
fn retained_default_direct_agent_resolution_requires_exact_origin_and_current_authority() {
    let (_directory, store, group) = fixture();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Original installation"})).unwrap())
        .unwrap();
    let installed = agent(&store, "default-work-items");
    let unrelated = agent(&store, "default-work-items");
    let original = store
        .create_task(
            &project.id,
            serde_json::from_value(
                json!({"title":"Original assignment","assignee_agent_id":installed.id}),
            )
            .unwrap(),
        )
        .unwrap();
    store.create_comment(&serde_json::from_value(json!({"project_id":project.id,"task_id":original.id,
        "sender_type":"user","sender_id":"0","sender_name":"Local owner","content":"Historical participation","metadata":{}})).unwrap()).unwrap();
    for run in store
        .list_executions(&project.id, None, None, true)
        .unwrap()
    {
        store
            .fail_runtime_preflight(run.id, "Historical execution settled")
            .unwrap();
    }
    let report = store
        .chat_group_request(
            "migration.inspect",
            json!({"source_project_id":project.id,"target_group_id":group}),
        )
        .unwrap()["inventory"]
        .clone();
    store
        .chat_group_request(
            "migration.apply",
            json!({"inventory":report,"retain_source_project":true}),
        )
        .unwrap();
    let resolved = store
        .resolve_chat_agents_for_task(&group, &original.id, "agent", &installed.id, None)
        .unwrap();
    assert_eq!(resolved["resource_owner_id"], project.id);
    assert_eq!(resolved["agents"][0]["project_id"], "default-work-items");
    assert_eq!(resolved["agents"][0]["id"], installed.id);
    assert!(store.list_chat_agents(&group).unwrap().is_empty());
    let another = task(&store, &group, Some(&project.id));
    assert!(store
        .resolve_chat_agents_for_task(&group, &another.id, "agent", &installed.id, None)
        .is_err());
    assert!(store
        .resolve_chat_agents_for_task(&group, &original.id, "agent", &unrelated.id, None)
        .is_err());
    let current = store.get_task(&group, &original.id).unwrap();
    store
        .chat_group_request(
            "project_link.update",
            json!({"thread_id":original.id,"version":current.version,"project_id":null}),
        )
        .unwrap();
    assert!(store
        .resolve_chat_agents_for_task(&group, &original.id, "agent", &installed.id, None)
        .is_err());
}

#[test]
fn leaving_or_revoking_resources_is_rechecked_on_every_resolution() {
    let (_directory, store, group) = fixture();
    let own = agent(&store, &group);
    let item = task(&store, &group, None);
    store
        .chat_group_request(
            "participation.update",
            json!({"group_id":group,"thread_id":item.id,"joined":false}),
        )
        .unwrap();
    assert!(store
        .resolve_chat_agents_for_task(&group, &item.id, "agent", &own.id, None)
        .is_err());
    store
        .chat_group_request(
            "participation.update",
            json!({"group_id":group,"thread_id":item.id,"joined":true}),
        )
        .unwrap();
    assert!(store
        .resolve_chat_agents_for_task(&group, &item.id, "agent", &own.id, None)
        .is_ok());
    store
        .archive_chat_agent(&group, &own.id, own.version)
        .unwrap();
    assert!(store
        .resolve_chat_agents_for_task(&group, &item.id, "agent", &own.id, None)
        .is_err());
    assert_eq!(
        store.get_task(&group, &item.id).unwrap().version,
        item.version
    );
}
