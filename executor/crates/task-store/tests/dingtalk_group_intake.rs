use serde_json::json;
use wegent_local_task_store::{
    personal_stand_in::{source_collection_namespace, stand_in_collection_connection},
    LocalTaskStore,
};

#[test]
fn group_message_mode_persists_and_invalidates_only_its_old_collection_partition() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] = json!({
        "enabled":true,"prompt":"","preferences":"",
        "connections":[{
            "providerId":"@wegent/dsh-connection-dingtalk/dingtalk",
            "profile":"account","kind":"group","id":"feedback","name":"Feedback",
            "policy":{"automatic":true,"askBeforeAct":true,"immediate":false}
        }]
    });
    let original = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let mentions = original["primary"]["connections"][0].clone();
    let mut changed = original.clone();
    changed["primary"]["connections"][0]["collectionKey"] = json!("all-messages");
    let saved = store.save_personal_stand_in(7, "mac", changed).unwrap();
    let all = &saved["primary"]["connections"][0];
    assert_ne!(
        source_collection_namespace(&mentions),
        source_collection_namespace(all)
    );
    assert!(stand_in_collection_connection(&saved["primary"], &mentions).is_none());
    assert!(stand_in_collection_connection(&saved["primary"], all).is_some());
    assert_ne!(mentions["enabledAfter"], all["enabledAfter"]);
    assert_eq!(mentions["policy"], all["policy"]);
    drop(store);
    let store = LocalTaskStore::open(&path).unwrap();
    let loaded = store.personal_stand_in(7, "mac").unwrap();
    assert_eq!(loaded, saved);
    let unchanged = store.save_personal_stand_in(7, "mac", loaded).unwrap();
    assert_eq!(
        unchanged["primary"]["connections"][0]["enabledAfter"],
        all["enabledAfter"]
    );
    let mut reverted = unchanged;
    reverted["primary"]["connections"][0]
        .as_object_mut()
        .unwrap()
        .remove("collectionKey");
    let reverted = store.save_personal_stand_in(7, "mac", reverted).unwrap();
    assert!(stand_in_collection_connection(&reverted["primary"], all).is_none());
    assert!(stand_in_collection_connection(
        &reverted["primary"],
        &reverted["primary"]["connections"][0]
    )
    .is_some());
}
