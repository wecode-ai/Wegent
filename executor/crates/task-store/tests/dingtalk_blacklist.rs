use serde_json::json;
use wegent_local_task_store::{
    personal_stand_in::{
        source_collection_namespace, stand_in_collection_connection, stand_in_connection,
    },
    LocalTaskStore,
};

#[test]
fn blacklist_persists_per_identity_without_changing_permissions_or_collection_checkpoint() {
    for kind in ["group", "direct"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] = json!({"enabled":true,"prompt":"","preferences":"","connections":[{
            "providerId":"@wegent/dsh-connection-dingtalk/dingtalk","profile":"corp",
            "kind":kind,"id":"*","scope":"all","name":"All",
            "policy":{"automatic":true,"askBeforeAct":true}
        }]});
        let original = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let source = original["primary"]["connections"][0].clone();
        let mut blocked = source.clone();
        blocked["id"] = json!("blocked");
        blocked.as_object_mut().unwrap().remove("scope");
        let mut changed = original.clone();
        changed["primary"]["connections"][0]["excludedResources"] =
            json!([{"id":"blocked","name":"Blocked"}]);
        let saved = store.save_personal_stand_in(7, "mac", changed).unwrap();
        let connection = &saved["primary"]["connections"][0];
        assert_eq!(source["enabledAfter"], connection["enabledAfter"]);
        assert_eq!(
            source_collection_namespace(&source),
            source_collection_namespace(connection)
        );
        assert!(stand_in_collection_connection(&saved["primary"], &blocked).is_none());
        assert!(stand_in_connection(&saved["primary"], &blocked).is_some());
        assert!(stand_in_collection_connection(&original["primary"], &blocked).is_some());
        let mut allowed = blocked.clone();
        allowed["id"] = json!("allowed");
        assert!(stand_in_collection_connection(&saved["primary"], &allowed).is_some());
        allowed["profile"] = json!("other");
        assert!(stand_in_collection_connection(&saved["primary"], &allowed).is_none());
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), saved);
        let mut removed = saved;
        removed["primary"]["connections"][0]["excludedResources"] = json!([]);
        let restored = store.save_personal_stand_in(7, "mac", removed).unwrap();
        assert!(stand_in_collection_connection(&restored["primary"], &blocked).is_some());
        for invalid in [
            json!(null),
            json!([{"id":"*","name":"All"}]),
            json!([{"id":"","name":"Empty"}]),
            json!([{"id":"one","name":"One"},{"id":"one","name":"Duplicate"}]),
        ] {
            let mut draft = restored.clone();
            draft["primary"]["connections"][0]["excludedResources"] = invalid;
            assert!(store.save_personal_stand_in(7, "mac", draft).is_err());
        }
    }
}
