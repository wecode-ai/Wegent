use super::*;

#[test]
fn absent_or_null_source_fields_do_not_add_searchable_null_text() {
    for item in [
        json!({"id":"ISSUE-1","title":"Ordinary","tags":[]}),
        json!({"id":"ISSUE-1","title":"Ordinary","description":null,"tags":[]}),
    ] {
        assert!(!matches(&item, &json!({"query":"null"}), &HashSet::new()).unwrap());
    }
}

#[tokio::test]
async fn paging_does_not_wait_for_an_unrelated_owners_locked_query() {
    let directory = tempfile::tempdir().unwrap();
    let store =
        crate::task_runtime::LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(ProjectCreate {
            name: "Cursor isolation".into(),
            project_key: Some("CURSOR".into()),
            description: String::new(),
            task_provider: crate::task_runtime::TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    for title in ["First", "Second"] {
        store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":title})).unwrap(),
            )
            .unwrap();
    }
    let runtime = TaskRuntime::new(store).unwrap();
    let mut first_owner = SpaceMcpRequestContext::new(None, None, None);
    first_owner.current_device_id = Some("cursor-device".into());
    first_owner.principal_id = Some("first-owner".into());
    let mut second_owner = first_owner.clone();
    second_owner.principal_id = Some("second-owner".into());
    let request = json!({"scope":{"kind":"projects","spaces":[{
        "project_store":"local","space_id":project.id,"device_id":"cursor-device"
    }]},"limit":1});
    let first = search(&runtime, &first_owner, &request).await.unwrap();
    let second = search(&runtime, &second_owner, &request).await.unwrap();
    let first_id = first["query_id"].as_str().unwrap();
    let second_id = second["query_id"].as_str().unwrap();
    // Hold the earlier registry entry so the old cross-query cursor scan must wait.
    let (blocked, target, target_owner) = {
        let cache = registry().lock().unwrap();
        let earlier = cache
            .keys()
            .find(|id| id.as_str() == first_id || id.as_str() == second_id)
            .unwrap();
        if earlier == first_id {
            (cache.get(first_id).unwrap().clone(), &second, &second_owner)
        } else {
            (cache.get(second_id).unwrap().clone(), &first, &first_owner)
        }
    };
    let held = blocked.lock().await;
    let page = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        search(
            &runtime,
            target_owner,
            &json!({"cursor":target["next_cursor"],"limit":1}),
        ),
    )
    .await;
    drop(held);
    let page = page
        .expect("Paging waited for an unrelated owner's query")
        .unwrap();
    assert_eq!(page["query_id"], target["query_id"]);
    assert_eq!(page["matched_total"], 2);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_ne!(page["items"][0]["id"], target["items"][0]["id"]);
    assert!(page["next_cursor"].is_null());
}
