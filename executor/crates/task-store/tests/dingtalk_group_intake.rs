use serde_json::json;
use wegent_local_task_store::{
    personal_stand_in::{
        requires_dingtalk_delegation, source_collection_namespace, stand_in_collection_connection,
        stand_in_identities, DINGTALK_PROVIDER,
    },
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

#[test]
fn confirmed_all_messages_persists_both_scopes_and_keeps_mentions_separate() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    let mentions = json!({
        "providerId": DINGTALK_PROVIDER, "profile":"account", "kind":"group", "id":"*",
        "scope":"all", "name":"Groups", "policy":{"automatic":true, "askBeforeAct":true}
    });
    let mut groups = mentions.clone();
    groups["collectionKey"] = json!("all-messages");
    let mut direct = mentions.clone();
    direct["kind"] = json!("direct");
    direct["name"] = json!("Contacts");
    settings["primary"] = json!({
        "enabled":true, "prompt":"", "preferences":"", "dingTalkConnectionMode":"confirmed",
        "connections":[&groups, &direct]
    });
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    drop(store);
    let store = LocalTaskStore::open(path).unwrap();
    let saved = store.personal_stand_in(7, "mac").unwrap();
    let primary = stand_in_identities(&saved)
        .into_iter()
        .find(|role| role["id"] == "@primary")
        .unwrap();
    for mut concrete in [groups, direct] {
        concrete["id"] = json!("actual");
        concrete.as_object_mut().unwrap().remove("scope");
        let grant = stand_in_collection_connection(&primary, &concrete).unwrap();
        assert_eq!(grant["id"], "*");
        assert!(!requires_dingtalk_delegation(&primary, grant));
        concrete["profile"] = json!("other-account");
        assert!(stand_in_collection_connection(&primary, &concrete).is_none());
    }
    assert!(stand_in_collection_connection(&primary, &mentions).is_none());

    let mut private_only = saved;
    private_only["primary"]["connections"]
        .as_array_mut()
        .unwrap()
        .retain(|connection| connection["kind"] == "direct");
    let private_only = store
        .save_personal_stand_in(7, "mac", private_only)
        .unwrap();
    let mut direct = private_only["primary"]["connections"][0].clone();
    direct["id"] = json!("contact");
    direct.as_object_mut().unwrap().remove("scope");
    let mut group = direct.clone();
    group["kind"] = json!("group");
    group["collectionKey"] = json!("all-messages");
    assert!(stand_in_collection_connection(&private_only["primary"], &direct).is_some());
    assert!(stand_in_collection_connection(&private_only["primary"], &group).is_none());
}
