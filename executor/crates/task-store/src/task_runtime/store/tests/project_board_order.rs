use super::*;

fn fixture() -> (TempDir, LocalTaskStore, LoopItem, Vec<LoopItem>) {
    let (directory, store, project) = chat_agent_store();
    let mut items = Vec::new();
    for index in 0..3 {
        let group = store
            .chat_group_request("create", json!({"name":format!("Group{index}")}))
            .unwrap();
        let owner = group["group"]["id"].as_str().unwrap();
        let item = store.create_task_with_context(owner,
            serde_json::from_value(json!({"title":format!("Card{index}"),"status":if index==1 {"completed"}else{"pending"}})).unwrap(),
            None, None, Some(project.id.clone())).unwrap();
        items.push(item);
    }
    (directory, store, project, items)
}

fn move_item(
    store: &LocalTaskStore,
    item: &LoopItem,
    project: &str,
    anchor: &str,
) -> Result<LoopItem, TaskRuntimeError> {
    store.update_task(
        item.cloud_project_id.as_deref().unwrap(),
        &item.id,
        serde_json::from_value(json!({"version":item.version,"status":"pending",
            "position":{"before_item_id":anchor,"classification_project_id":project}}))
        .unwrap(),
    )
}

#[test]
fn project_board_order_persists_across_groups_and_reload_without_owner_or_foreign_version_changes()
{
    let (directory, store, project, items) = fixture();
    let updated = move_item(&store, &items[1], &project.id, &items[0].id).unwrap();
    assert_eq!(updated.status.as_deref(), Some("pending"));
    assert_eq!(updated.cloud_project_id, items[1].cloud_project_id);
    let current = store.list_tasks(&project.id).unwrap();
    let rank = |id: &str| {
        current
            .iter()
            .find(|item| item.id == id)
            .unwrap()
            .sort_order
    };
    assert_eq!(rank(&items[1].id) + 1, rank(&items[0].id));
    for index in [0, 2] {
        let same = store
            .get_task(
                items[index].cloud_project_id.as_deref().unwrap(),
                &items[index].id,
            )
            .unwrap();
        assert_eq!(same.version, items[index].version);
        assert_eq!(same.sort_order, items[index].sort_order);
    }
    move_item(&store, &items[2], &project.id, &items[1].id).unwrap();
    drop(store);
    let reopened = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut current = reopened.list_tasks(&project.id).unwrap();
    current.sort_by_key(|item| item.sort_order);
    assert_eq!(
        current
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            items[2].id.as_str(),
            items[1].id.as_str(),
            items[0].id.as_str()
        ]
    );
    for item in current {
        let original = items
            .iter()
            .find(|original| original.id == item.id)
            .unwrap();
        assert_eq!(item.cloud_project_id, original.cloud_project_id);
    }
}

#[test]
fn project_board_order_rejects_foreign_scope_parent_and_archived_group_atomically() {
    for invalid in [
        "project",
        "parent",
        "group",
        "anchor",
        "project-archived",
        "state",
    ] {
        let (_directory, store, project, items) = fixture();
        let mut scope = project.id.clone();
        if invalid == "project" {
            scope = store
                .create_project(ProjectCreate {
                    name: "Other".into(),
                    project_key: None,
                    description: String::new(),
                    task_provider: TaskProviderKind::Local,
                    provider_config: json!({}),
                })
                .unwrap()
                .id;
        } else if invalid == "parent" {
            let parent = store
                .create_task(
                    items[0].cloud_project_id.as_deref().unwrap(),
                    serde_json::from_value(json!({"title":"Other parent"})).unwrap(),
                )
                .unwrap();
            store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE loop_items SET parent_id=?2 WHERE id=?1",
                    params![items[0].id, parent.id],
                )
                .unwrap();
        } else if invalid == "project-archived" {
            store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE loop_items SET status='archived' WHERE id=?1",
                    [&project.id],
                )
                .unwrap();
        } else if invalid != "state" {
            let owner = if invalid == "group" {
                items[1].cloud_project_id.as_ref().unwrap()
            } else {
                items[0].cloud_project_id.as_ref().unwrap()
            };
            store
                .connection()
                .unwrap()
                .execute(
                    if invalid == "group" {
                        "UPDATE loop_items SET status='archived' WHERE id=?1"
                    } else {
                        "UPDATE loop_items SET deleted_at='2026-11-12' WHERE id=?1"
                    },
                    [owner],
                )
                .unwrap();
        }
        let before = store.get_item(&project.id, "project").unwrap().metadata;
        let result = if invalid == "state" {
            store.update_task(
                items[1].cloud_project_id.as_deref().unwrap(),
                &items[1].id,
                serde_json::from_value(json!({"version":items[1].version,"status":"invalid",
                    "position":{"before_item_id":items[0].id,"classification_project_id":scope}}))
                .unwrap(),
            )
        } else {
            move_item(&store, &items[1], &scope, &items[0].id)
        };
        assert!(result.is_err(), "invalid case {invalid}");
        let same = store.get_item(&items[1].id, "task").unwrap();
        assert_eq!(same.version, items[1].version);
        assert_eq!(same.status, items[1].status);
        assert_eq!(
            store.get_item(&project.id, "project").unwrap().metadata,
            before
        );
    }
}
