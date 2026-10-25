use serde_json::{json, Value};
use wegent_executor::task_runtime::personal_stand_in::stand_in_identities;
use wegent_executor::task_runtime::LocalTaskStore;

fn source() -> Value {
    json!({"id":"group","profile":"corp:user","kind":"group","name":"Project group","policy":{"automatic":true,"askBeforeAct":true}})
}

#[test]
fn proposals_require_explicit_owner_confirmation_and_reject_stale_versions() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let original = store.personal_stand_in(7, "mac").unwrap();
    let mut draft = original.clone();
    draft["primary"] = json!({"enabled":true,"prompt":"Coordinate my work","preferences":"Keep replies concise","dingtalk":[source()]});
    let proposal = store
        .propose_stand_in_settings(7, "mac", None, "Connect the selected group", draft.clone())
        .unwrap();
    assert_eq!(store.personal_stand_in(7, "mac").unwrap(), original);
    assert!(store
        .resolve_stand_in_proposal(8, "mac", proposal["id"].as_str().unwrap(), true)
        .is_err());
    let saved = store
        .resolve_stand_in_proposal(7, "mac", proposal["id"].as_str().unwrap(), true)
        .unwrap();
    assert_eq!(
        saved["primary"]["dingtalk"][0]["policy"]["askBeforeAct"],
        true
    );
    assert!(saved["primary"]["dingtalk"][0]["enabledAfter"].is_string());
    assert!(store
        .resolve_stand_in_proposal(7, "mac", proposal["id"].as_str().unwrap(), true)
        .is_err());
    let stale = store
        .propose_stand_in_settings(7, "mac", None, "Update preferences", saved.clone())
        .unwrap();
    store.save_personal_stand_in(7, "mac", saved).unwrap();
    assert!(store
        .resolve_stand_in_proposal(7, "mac", stale["id"].as_str().unwrap(), true)
        .is_err());
    assert_eq!(
        store.stand_in_proposal(7, None).unwrap()["status"],
        "pending"
    );
}

#[test]
fn role_cannot_propose_primary_or_other_role_changes() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let mut draft = store.personal_stand_in(7, "mac").unwrap();
    draft["primary"] = json!({"enabled":true,"prompt":"Changed","preferences":""});
    assert!(store
        .propose_stand_in_settings(7, "mac", Some("default"), "Change another identity", draft)
        .is_err());
    assert!(store
        .stand_in_proposal(7, Some("default"))
        .unwrap()
        .is_null());
}

#[test]
fn invalid_primary_sources_and_duplicate_account_scopes_are_rejected_atomically() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let original = store.personal_stand_in(0, "mac").unwrap();
    let mut draft = original.clone();
    draft["primary"] = json!({"enabled":true,"prompt":"","preferences":"","collaboration":{"enabled":true,"allProjects":true}});
    assert!(store.save_personal_stand_in(0, "mac", draft).is_err());
    let mut duplicate = original.clone();
    duplicate["primary"] =
        json!({"enabled":true,"prompt":"","preferences":"","dingtalk":[source(),source()]});
    assert!(store
        .save_personal_stand_in(0, "mac", duplicate.clone())
        .is_err());
    assert_eq!(store.personal_stand_in(0, "mac").unwrap(), original);
    duplicate["primary"]["dingtalk"][1]["profile"] = json!("other-corp:user");
    let saved = store.save_personal_stand_in(0, "mac", duplicate).unwrap();
    assert_eq!(saved["primary"]["dingtalk"].as_array().unwrap().len(), 2);
}

#[test]
fn primary_project_intake_has_a_cutoff_and_never_collides_with_a_role_named_primary() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] = json!({"enabled":true,"prompt":"Coordinate","preferences":"","collaboration":{"enabled":true,"allProjects":false,"projects":[{"id":"project","store":"local"}],"excludedProjects":[],"tags":[],"policy":{"automatic":true,"askBeforeAct":true}}});
    settings["roles"][0]["id"] = json!("primary");
    let saved = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let identities = stand_in_identities(&saved);
    assert_eq!(identities[0]["id"], "primary");
    assert_eq!(identities[1]["id"], "@primary");
    assert_eq!(identities[1]["version"], saved["version"]);
    assert!(identities[1]["enabledAfter"].is_string());
    assert_eq!(
        store.stand_in_settings("project", 7, "@primary").unwrap()["prompt"],
        "Coordinate"
    );
    let edited = store
        .save_personal_stand_in(7, "mac", saved.clone())
        .unwrap();
    assert_eq!(
        edited["primary"]["enabledAfter"],
        saved["primary"]["enabledAfter"]
    );
}

#[test]
fn ingestion_deduplicates_and_corrections_never_replay_sent_messages() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let first = json!({"id":"message-1","text":"Review the proposal","senderId":"alice","at":"2026-10-23T00:00:00Z"});
    let work = store
        .ingest_stand_in_message(7, "review", &source(), &first, None)
        .unwrap();
    let id = work["id"].as_str().unwrap();
    assert_eq!(
        store
            .ingest_stand_in_message(7, "review", &source(), &first, None)
            .unwrap()["id"],
        id
    );
    let other = store
        .ingest_stand_in_message(7, "other", &source(), &first, None)
        .unwrap();
    assert_ne!(other["id"], work["id"]);
    assert_eq!(other["roleId"], "other");
    assert_eq!(
        store
            .stand_in_messages(7, other["id"].as_str().unwrap())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(store.stand_in_messages(7, id).unwrap().len(), 1);
    assert!(store.stand_in_messages(8, id).is_err());
    let second = json!({"id":"message-2","text":"Also check the budget","senderId":"alice","at":"2026-10-23T00:01:00Z"});
    store
        .ingest_stand_in_message(7, "review", &source(), &second, Some(id))
        .unwrap();
    let messages = store.stand_in_messages(7, id).unwrap();
    let record = messages
        .iter()
        .find(|message| message["id"] == "message-2")
        .unwrap()["recordId"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .update_stand_in_dispatch(7, id, std::slice::from_ref(&record), "sent", None)
        .unwrap();
    let moved = store.adjust_stand_in_message(7, id, &record, None).unwrap();
    assert_eq!(
        store
            .stand_in_messages(7, moved["id"].as_str().unwrap())
            .unwrap()[0]["dispatchStatus"],
        "sent"
    );
    assert_eq!(
        store.stand_in_work(7, id).unwrap()["latestMessage"]["id"],
        "message-1"
    );
    assert_eq!(store.stand_in_work(7, id).unwrap()["messageCount"], 1);
    let other = store
        .ingest_stand_in_message(
            7,
            "other",
            &source(),
            &json!({"id":"message-3","text":"Unrelated"}),
            None,
        )
        .unwrap();
    assert!(store
        .adjust_stand_in_message(
            7,
            moved["id"].as_str().unwrap(),
            &record,
            other["id"].as_str()
        )
        .is_err());
    drop(store);
    assert_eq!(
        LocalTaskStore::open(path)
            .unwrap()
            .stand_in_messages(7, id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn messages_arriving_during_dispatch_remain_pending_after_the_earlier_batch_finishes() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let work = store
        .ingest_stand_in_message(
            7,
            "review",
            &source(),
            &json!({"id":"first","text":"First"}),
            None,
        )
        .unwrap();
    let id = work["id"].as_str().unwrap();
    let first = store.stand_in_messages(7, id).unwrap()[0]["recordId"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .update_stand_in_dispatch(7, id, std::slice::from_ref(&first), "sending", None)
        .unwrap();
    store
        .ingest_stand_in_message(
            7,
            "review",
            &source(),
            &json!({"id":"second","text":"Second"}),
            Some(id),
        )
        .unwrap();
    store
        .update_stand_in_dispatch(7, id, &[first], "sent", None)
        .unwrap();
    assert_eq!(store.stand_in_work(7, id).unwrap()["status"], "pending");
    assert_eq!(store.stand_in_work(7, id).unwrap()["messageCount"], 2);
}
