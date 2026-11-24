use chrono::{DateTime, TimeDelta, Utc};
use serde_json::{json, Value};
use wegent_local_task_store::personal_stand_in::{
    active_delegated_source, permits_delegated_message, permits_delegated_reply,
    requires_dingtalk_delegation, source_namespace, stand_in_identities, DINGTALK_PROVIDER,
};
use wegent_local_task_store::LocalTaskStore;

fn source(id: &str, kind: &str, account: &str) -> Value {
    json!({
        "providerId": DINGTALK_PROVIDER, "kind": kind, "id": id, "name": id,
        "profile": "current", "accountId": account, "policy": {"automatic": false, "askBeforeAct": true}
    })
}

fn draft(store: &LocalTaskStore, sources: Value) -> Value {
    let mut settings = store.personal_stand_in(7, "desktop").unwrap();
    settings["primary"] =
        json!({"enabled":true,"prompt":"","preferences":"","connections":sources});
    settings
}

fn saved(store: &LocalTaskStore, settings: Value) -> Value {
    store
        .save_personal_stand_in(7, "desktop", settings)
        .unwrap()
}

fn primary(settings: &Value) -> Value {
    stand_in_identities(settings)
        .into_iter()
        .find(|identity| identity["id"] == "@primary")
        .unwrap()
}

fn instant_after(boundary: &Value) -> Value {
    let time = DateTime::parse_from_rfc3339(boundary.as_str().unwrap()).unwrap();
    json!((time.with_timezone(&Utc) + TimeDelta::nanoseconds(1)).to_rfc3339())
}

#[test]
fn existing_confirmation_applies_only_to_exact_conversations_before_delegation() {
    let mut identity = json!({"id":"@primary"});
    let mut group = source("team", "group", "account");
    assert!(!requires_dingtalk_delegation(&identity, &group));

    group["policy"]["askBeforeAct"] = json!(false);
    assert!(requires_dingtalk_delegation(&identity, &group));
    group["policy"]["askBeforeAct"] = json!(true);
    group["collectionKey"] = json!("all-messages");
    assert!(requires_dingtalk_delegation(&identity, &group));

    group.as_object_mut().unwrap().remove("collectionKey");
    identity["delegation"] = json!({"version":1,"paused":true});
    assert!(requires_dingtalk_delegation(&identity, &group));
}

#[test]
fn activation_requires_explicit_intent_and_one_account_with_exact_sources() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut legacy = source("group", "group", "account-a");
    legacy.as_object_mut().unwrap().remove("accountId");
    legacy["policy"]["askBeforeAct"] = json!(false);
    let legacy = saved(&store, draft(&store, json!([legacy])));
    let identity = primary(&legacy);
    assert!(active_delegated_source(&identity, &identity["connections"][0]).is_none());
    assert!(legacy["primary"].get("delegation").is_none());

    let mut all_groups = source("*", "group", "account-a");
    all_groups["scope"] = json!("all");
    let mut full_group = source("group", "group", "account-a");
    full_group["collectionKey"] = json!("all-messages");
    let mut invalid_source_drafts = [
        json!([all_groups]),
        json!([full_group]),
        json!([]),
        json!([source("group", "group-all", "account-a")]),
        json!([
            source("group", "group", "account-a"),
            source("peer", "direct", "account-b")
        ]),
    ];
    for sources in &mut invalid_source_drafts {
        let mut settings = draft(&store, sources.take());
        settings["primary"]["delegation"] = json!({"action":"enable"});
        assert!(store
            .save_personal_stand_in(7, "desktop", settings)
            .is_err());
    }
    assert_eq!(store.personal_stand_in(7, "desktop").unwrap(), legacy);

    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"version":99,"authorized":true,"paused":false});
    let mut settings = saved(&store, settings);
    assert_eq!(settings["primary"]["delegation"]["authorized"], false);
    assert_eq!(settings["primary"]["delegation"]["version"], 0);
    settings["primary"]["delegation"]["action"] = json!("enable");
    assert!(store
        .propose_stand_in_settings(7, "desktop", None, "Enable a delegation", settings.clone())
        .is_err());
    let settings = saved(&store, settings);
    let identity = primary(&settings);
    let selection = &identity["connections"][0];
    assert!(active_delegated_source(&identity, selection).is_some());
    assert_eq!(identity["delegation"]["version"], 1);
    assert!(identity["delegation"].get("action").is_none());
    assert_eq!(
        selection["policy"],
        json!({"automatic":true, "askBeforeAct":false, "immediate":true})
    );
}

#[test]
fn source_and_template_changes_apply_only_to_their_effective_ranges() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let first = saved(&store, settings);
    let first_identity = primary(&first);
    let topic = &first_identity["connections"][0];
    let old = instant_after(&topic["enabledAfter"]);
    assert!(permits_delegated_reply(
        &first_identity,
        topic,
        "document",
        &old
    ));
    assert!(!permits_delegated_reply(
        &first_identity,
        topic,
        "unknown",
        &old
    ));

    let mut edited = first.clone();
    edited["primary"]["delegation"]["templates"]["document"] = json!(false);
    let mut edited = saved(&store, edited);
    let identity = primary(&edited);
    assert_eq!(identity["delegation"]["version"], 2);
    assert!(!permits_delegated_reply(&identity, topic, "document", &old));
    assert!(permits_delegated_reply(&identity, topic, "schedule", &old));
    assert!(permits_delegated_reply(&identity, topic, "process", &old));

    edited["primary"]["connections"]
        .as_array_mut()
        .unwrap()
        .push(source("group", "group", "account-a"));
    edited["primary"]["delegation"]["templates"]["document"] = json!(true);
    let mut edited = saved(&store, edited);
    let identity = primary(&edited);
    let group = &identity["connections"][1];
    assert_eq!(identity["delegation"]["version"], 3);
    assert_eq!(
        identity["connections"][0]["enabledAfter"],
        topic["enabledAfter"]
    );
    assert!(permits_delegated_reply(&identity, topic, "schedule", &old));
    assert!(!permits_delegated_reply(&identity, topic, "document", &old));
    assert!(!permits_delegated_message(&identity, group, &old));
    assert!(!permits_delegated_message(
        &identity,
        group,
        &group["enabledAfter"]
    ));
    assert!(permits_delegated_reply(
        &identity,
        group,
        "document",
        &instant_after(&group["enabledAfter"])
    ));

    edited["primary"]["preferences"] = json!("Concise");
    let preferences = saved(&store, edited);
    assert_eq!(preferences["primary"]["delegation"], identity["delegation"]);
}

#[test]
fn ordinary_saves_keep_pauses_and_account_switches_revoke_old_authority() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut settings = draft(
        &store,
        json!([
            source("peer", "direct", "account-a"),
            source("group", "group", "account-a")
        ]),
    );
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let mut settings = saved(&store, settings);
    let old_source = settings["primary"]["connections"][0].clone();
    let old = instant_after(&old_source["enabledAfter"]);

    settings["primary"]["connections"][0]["paused"] = json!(true);
    let mut settings = saved(&store, settings);
    assert!(active_delegated_source(&primary(&settings), &old_source).is_none());
    settings["primary"]["delegation"]["action"] = json!("pause");
    let mut settings = saved(&store, settings);
    settings["primary"]["connections"][0]
        .as_object_mut()
        .unwrap()
        .remove("paused");
    settings["primary"]["delegation"]["paused"] = json!(false);
    settings["primary"]["delegation"]["templates"]["process"] = json!(false);
    let mut settings = saved(&store, settings);
    assert_eq!(settings["primary"]["delegation"]["paused"], true);
    assert_eq!(settings["primary"]["connections"][0]["paused"], true);
    assert_eq!(store.personal_stand_in(7, "desktop").unwrap(), settings);

    settings["primary"]["delegation"]["action"] = json!("resume");
    let mut settings = saved(&store, settings);
    let current = primary(&settings);
    assert!(!permits_delegated_message(&current, &old_source, &old));
    assert!(active_delegated_source(&current, &current["connections"][1]).is_some());
    settings["primary"]["connections"] = json!([]);
    let mut settings = saved(&store, settings);
    let version_before_switch = settings["primary"]["delegation"]["version"]
        .as_u64()
        .unwrap();
    assert_eq!(settings["primary"]["delegation"]["paused"], true);

    settings["primary"]["connections"] = json!([source("peer", "direct", "account-b")]);
    let mut settings = saved(&store, settings);
    assert_eq!(settings["primary"]["delegation"]["authorized"], false);
    assert_eq!(
        settings["primary"]["delegation"]["version"],
        version_before_switch + 1
    );
    settings["primary"]["delegation"]["action"] = json!("enable");
    let settings = saved(&store, settings);
    let current = primary(&settings);
    assert_eq!(current["delegation"]["version"], version_before_switch + 2);
    assert!(active_delegated_source(&current, &old_source).is_none());
    assert_ne!(
        source_namespace(&old_source),
        source_namespace(&current["connections"][0])
    );
}

#[test]
fn an_existing_explicit_delegation_without_version_migrates_to_one() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let mut settings = saved(&store, settings);
    settings["primary"]["delegation"]
        .as_object_mut()
        .unwrap()
        .remove("version");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE loop_items SET metadata=?1 WHERE id='personal-stand-in:7'",
            [settings.to_string()],
        )
        .unwrap();
    let mut migrated = store.personal_stand_in(7, "desktop").unwrap();
    assert_eq!(migrated["primary"]["delegation"]["version"], 1);
    assert_eq!(
        migrated["primary"]["connections"],
        settings["primary"]["connections"]
    );
    migrated["primary"]["delegation"]["templates"]["document"] = json!(false);
    assert_eq!(
        saved(&store, migrated)["primary"]["delegation"]["version"],
        2
    );
}

#[test]
fn connector_account_change_revokes_the_current_selection_without_reusing_its_version() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let additional_provider = json!({
        "providerId":"provider/example", "profile":"example", "kind":"inbox", "id":"inbox",
        "name":"Other connection", "policy":{"automatic":false,"askBeforeAct":true}
    });
    let mut settings = draft(
        &store,
        json!([source("peer", "direct", "account-a"), additional_provider]),
    );
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let mut settings = saved(&store, settings);
    let old_version = settings["version"].clone();
    let selection = settings["primary"]["connections"][0].clone();
    settings["primary"]["preferences"] = json!("Concise");
    let settings = saved(&store, settings);
    assert!(!store
        .invalidate_delegation_account(7, "desktop", &selection, &old_version)
        .unwrap());
    assert!(store
        .invalidate_delegation_account(7, "desktop", &selection, &settings["version"])
        .unwrap());

    let mut settings = store.personal_stand_in(7, "desktop").unwrap();
    let policy = &settings["primary"]["delegation"];
    assert_eq!(policy["version"], 2);
    assert_eq!(policy["accountInvalidated"], true);
    assert_eq!(policy["authorized"], false);
    assert_eq!(
        settings["primary"]["connections"][0]["providerId"],
        "provider/example"
    );
    assert!(active_delegated_source(&primary(&settings), &selection).is_none());
    settings["primary"]["connections"]
        .as_array_mut()
        .unwrap()
        .push(source("peer", "direct", "account-b"));
    settings["primary"]["delegation"]["action"] = json!("enable");
    let settings = saved(&store, settings);
    assert_eq!(settings["primary"]["delegation"]["version"], 3);
    assert_eq!(
        settings["primary"]["delegation"]["accountInvalidated"],
        false
    );
}

#[test]
fn durable_send_claim_rechecks_current_policy_and_keeps_unknown_on_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let mut settings = saved(&store, settings);
    let source = settings["primary"]["connections"][0].clone();
    let event = json!({"id":"question", "text":"Where is the guide?", "at":"2099-01-01T00:00:00Z"});
    let item = store
        .ingest_stand_in_message(7, "@primary", &source, &event, None)
        .unwrap();
    let id = item["id"].as_str().unwrap();
    let record = item["latestMessage"]["recordId"].as_str().unwrap();
    let mut decision = json!({"action":"reply","template":"document","reason":"Quoted guide."});

    settings["primary"]["delegation"]["templates"]["document"] = json!(false);
    saved(&store, settings);
    assert!(store
        .record_delegation_decision(7, "desktop", id, record, decision.clone())
        .unwrap()
        .is_none());

    decision["template"] = json!("process");
    assert!(store
        .record_delegation_decision(7, "desktop", id, record, decision.clone())
        .unwrap()
        .is_some());
    assert!(store
        .record_delegation_decision(7, "desktop", id, record, decision.clone())
        .unwrap()
        .is_none());
    drop(store);

    let store = LocalTaskStore::open(&path).unwrap();
    store
        .finish_delegated_submission(7, id, record, None)
        .unwrap();
    assert_eq!(
        store.stand_in_work(7, id).unwrap()["delegationResult"]["status"],
        "unknown"
    );
    assert!(store
        .record_delegation_decision(7, "desktop", id, record, decision)
        .unwrap()
        .is_none());
}
