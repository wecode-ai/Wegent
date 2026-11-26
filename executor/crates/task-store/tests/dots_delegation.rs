use chrono::{DateTime, TimeDelta, Utc};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
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

fn reply_claims(path: &Path) -> Vec<Value> {
    let connection = Connection::open(path).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT metadata FROM loop_items
             WHERE resource_type='stand_in_delegation_reply_claim'",
        )
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| serde_json::from_str(&row.unwrap()).unwrap())
        .collect()
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
fn verified_scope_reopens_paused_and_changes_accounts_in_one_delegation() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    let account = json!({
        "profile":"current", "accountId":"account-a",
        "organizationId":"org-a", "organizationName":"First Organization",
        "accountName":"Fixture Owner"
    });
    settings["primary"]["delegation"] =
        json!({"action":"prepare", "profile":"current", "accountId":"account-a"});
    let mut mismatched = settings.clone();
    mismatched["primary"]["delegation"]["accountId"] = json!("account-b");
    assert!(store
        .save_personal_stand_in(7, "desktop", mismatched)
        .is_err());
    assert!(store
        .propose_stand_in_settings(7, "desktop", None, "Prepare scope", settings.clone())
        .is_err());
    assert!(store
        .save_personal_stand_in(7, "desktop", settings.clone())
        .is_err());
    let original = store
        .save_personal_stand_in_with_verified_dingtalk_account_for_backend(
            7,
            "desktop",
            None,
            settings,
            Some(&account),
        )
        .unwrap();
    let mut reopened = store.personal_stand_in(7, "desktop").unwrap();
    assert_eq!(reopened, original);
    let identity = primary(&reopened);
    let selected = &identity["connections"][0];
    assert_eq!(identity["delegation"]["version"], 0);
    assert_eq!(
        identity["delegation"]["organizationName"],
        "First Organization"
    );
    assert_eq!(identity["delegation"]["authorized"], false);
    assert_eq!(identity["delegation"]["paused"], true);
    assert!(identity["delegation"]["effectiveAfter"].is_null());
    assert_eq!(selected["organizationId"], "org-a");
    assert!(selected["enabledAfter"].is_null());
    assert!(active_delegated_source(&identity, selected).is_none());

    reopened["primary"]["delegation"]["action"] = json!("enable");
    reopened["primary"]["delegation"]["organizationId"] = json!("forged");
    reopened["primary"]["connections"][0]["organizationId"] = json!("forged");
    let mut enabled = saved(&store, reopened);
    let identity = primary(&enabled);
    let selected = &identity["connections"][0];
    assert_eq!(identity["delegation"]["version"], 1);
    assert_eq!(identity["delegation"]["organizationId"], "org-a");
    assert_eq!(selected["organizationId"], "org-a");
    assert!(active_delegated_source(&identity, selected).is_some());
    assert!(!permits_delegated_message(
        &identity,
        selected,
        &selected["enabledAfter"]
    ));

    enabled["primary"]["connections"] = json!([]);
    enabled["primary"]["delegation"] =
        json!({"action":"prepare", "profile":"other", "accountId":"account-b"});
    let other = json!({"profile":"other", "accountId":"account-b", "organizationId":"org-b"});
    let switched = store
        .save_personal_stand_in_with_verified_dingtalk_account_for_backend(
            7,
            "desktop",
            None,
            enabled,
            Some(&other),
        )
        .unwrap();
    let replacement = primary(&switched);
    assert_eq!(replacement["delegation"]["version"], 2);
    assert_eq!(replacement["delegation"]["profile"], "other");
    assert_eq!(replacement["delegation"]["organizationId"], "org-b");
    assert_eq!(replacement["delegation"]["authorized"], false);
    assert_eq!(replacement["delegation"]["paused"], true);
    assert!(replacement["connections"].as_array().unwrap().is_empty());
    assert!(active_delegated_source(&replacement, selected).is_none());
}

#[test]
fn first_enable_can_bind_authoritative_identity_without_a_saved_draft() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable", "organizationId":"forged"});
    let mut verified = json!({"profile":"other", "accountId":"account-a", "organizationId":"org"});
    assert!(store
        .save_personal_stand_in_with_verified_dingtalk_account_for_backend(
            7,
            "desktop",
            None,
            settings.clone(),
            Some(&verified),
        )
        .is_err());
    verified["profile"] = json!("current");
    let enabled = store
        .save_personal_stand_in_with_verified_dingtalk_account_for_backend(
            7,
            "desktop",
            None,
            settings,
            Some(&verified),
        )
        .unwrap();
    let identity = primary(&enabled);
    let selection = &identity["connections"][0];
    assert!(active_delegated_source(&identity, selection).is_some());
    assert_eq!(selection["organizationId"], "org");
    assert_eq!(identity["delegation"]["organizationId"], "org");
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
fn omitting_primary_cannot_erase_the_saved_delegation() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let mut settings = saved(&store, settings);
    settings["primary"]["delegation"]["action"] = json!("pause");
    let settings = saved(&store, settings);
    let mut role_only = settings.clone();
    role_only.as_object_mut().unwrap().remove("primary");

    let proposal = store
        .propose_stand_in_settings(
            7,
            "desktop",
            None,
            "Update other settings",
            role_only.clone(),
        )
        .unwrap();
    let reviewed = store
        .resolve_stand_in_proposal(7, "desktop", proposal["id"].as_str().unwrap(), true, None)
        .unwrap();
    assert_eq!(reviewed["primary"], settings["primary"]);

    role_only["version"] = reviewed["version"].clone();
    let mut saved_settings = saved(&store, role_only);
    assert_eq!(saved_settings["primary"], settings["primary"]);
    saved_settings["primary"]["delegation"]["action"] = json!("resume");
    assert_eq!(
        saved(&store, saved_settings)["primary"]["delegation"]["version"],
        3
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

#[test]
fn source_pause_global_pause_and_scope_removal_block_already_queued_replies() {
    for change in ["source pause", "global pause", "scope removal"] {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let mut settings = draft(
            &store,
            json!([
                source("team", "group", "account-a"),
                source("peer", "direct", "account-a")
            ]),
        );
        settings["primary"]["delegation"] = json!({"action":"enable"});
        let mut settings = saved(&store, settings);
        let group = settings["primary"]["connections"][0].clone();
        let direct = settings["primary"]["connections"][1].clone();
        let event =
            json!({"id":"question", "text":"Where is the guide?", "at":"2099-01-01T00:00:00Z"});
        let group_item = store
            .ingest_stand_in_message(7, "@primary", &group, &event, None)
            .unwrap();
        let direct_item = store
            .ingest_stand_in_message(7, "@primary", &direct, &event, None)
            .unwrap();

        match change {
            "source pause" => settings["primary"]["connections"][0]["paused"] = json!(true),
            "global pause" => settings["primary"]["delegation"]["action"] = json!("pause"),
            "scope removal" => settings["primary"]["connections"] = json!([direct]),
            _ => unreachable!(),
        }
        saved(&store, settings);
        for (item, permitted) in [(group_item, false), (direct_item, change != "global pause")] {
            let id = item["id"].as_str().unwrap();
            let record = item["latestMessage"]["recordId"].as_str().unwrap();
            let decision = json!({"action":"reply","template":"document","reason":"Quoted guide."});
            let claim = store
                .record_delegation_decision(7, "desktop", id, record, decision)
                .unwrap();
            assert_eq!(claim.is_some(), permitted, "Claim after {change}");
            let persisted = store.stand_in_work(7, id).unwrap();
            if permitted {
                assert_eq!(persisted["delegationResult"]["status"], "submitting");
            } else {
                assert_eq!(persisted["status"], "pending");
                assert!(persisted["delegationResult"].is_null());
            }
        }
    }
}

#[test]
fn unknown_submission_survives_restart_and_blocks_linked_followup_but_not_independent_work() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let settings = saved(&store, settings);
    let source = &settings["primary"]["connections"][0];
    let original =
        json!({"id":"original", "text":"Where is the guide?", "at":"2099-01-01T00:00:00Z"});
    let item = store
        .ingest_stand_in_message(7, "@primary", source, &original, None)
        .unwrap();
    let work = item["id"].as_str().unwrap();
    let record = item["latestMessage"]["recordId"].as_str().unwrap();
    let decision = json!({"action":"reply","template":"document","reason":"Quoted guide."});
    assert!(store
        .record_delegation_decision(7, "desktop", work, record, decision.clone())
        .unwrap()
        .is_some());
    store
        .finish_delegated_submission(7, work, record, None)
        .unwrap();
    drop(store);

    let store = LocalTaskStore::open(&path).unwrap();
    let replayed = store
        .ingest_stand_in_message(7, "@primary", source, &original, None)
        .unwrap();
    assert_eq!(replayed["id"], work);
    assert_eq!(replayed["messageCount"], 1);
    assert_eq!(replayed["delegationResult"]["status"], "unknown");
    let followup = json!({"id":"followup","quotedMessageId":"original","text":"Any update?","at":"2099-01-01T00:01:00Z"});
    let linked = store
        .ingest_stand_in_message(7, "@primary", source, &followup, None)
        .unwrap();
    assert_eq!(linked["id"], work);
    let linked_message = store
        .known_stand_in_message(7, "@primary", source, "followup")
        .unwrap()
        .unwrap();
    let linked_record = linked_message["recordId"].as_str().unwrap();
    assert_ne!(linked_record, record);
    let split = store
        .adjust_stand_in_message(7, work, linked_record, None)
        .unwrap();
    let split_work = split["id"].as_str().unwrap();
    assert_ne!(split_work, work);
    assert!(store
        .record_delegation_decision(7, "desktop", split_work, linked_record, decision.clone())
        .unwrap()
        .is_none());
    let messages = store.stand_in_messages(7, work).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["id"], "original");
    assert_eq!(messages[0]["delegationResult"]["status"], "unknown");
    let split_messages = store.stand_in_messages(7, split_work).unwrap();
    assert_eq!(split_messages.len(), 1);
    assert_eq!(split_messages[0]["id"], "followup");
    assert_eq!(split_messages[0]["delegationResult"]["action"], "skip");

    let further = json!({"id":"further","quotedMessageId":"followup","text":"Still waiting","at":"2099-01-01T00:02:00Z"});
    let item = store
        .ingest_stand_in_message(7, "@primary", source, &further, None)
        .unwrap();
    assert_eq!(item["id"], split_work);
    let further = store
        .known_stand_in_message(7, "@primary", source, "further")
        .unwrap()
        .unwrap();
    assert!(store
        .record_delegation_decision(
            7,
            "desktop",
            split_work,
            further["recordId"].as_str().unwrap(),
            decision.clone(),
        )
        .unwrap()
        .is_none());

    let independent = json!({"id":"independent", "text":"Where is the release checklist?", "at":"2099-01-01T00:03:00Z"});
    let item = store
        .ingest_stand_in_message(7, "@primary", source, &independent, None)
        .unwrap();
    let independent_work = item["id"].as_str().unwrap();
    let independent_record = item["latestMessage"]["recordId"].as_str().unwrap();
    assert_ne!(independent_work, work);
    let merged = store
        .adjust_stand_in_message(7, independent_work, independent_record, Some(work))
        .unwrap();
    assert_eq!(merged["id"], work);
    assert!(store
        .record_delegation_decision(7, "desktop", work, independent_record, decision)
        .unwrap()
        .is_some());
    store
        .finish_delegated_submission(7, work, independent_record, Some("channel-receipt"))
        .unwrap();
    let independent = store
        .known_stand_in_message(7, "@primary", source, "independent")
        .unwrap()
        .unwrap();
    assert_eq!(independent["delegationResult"]["status"], "sent");
    assert_eq!(
        independent["delegationResult"]["receiptId"],
        "channel-receipt"
    );
}

#[test]
fn reply_chain_claim_uses_the_existing_primary_key_without_a_schema_index() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let indexed: bool = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index'
             AND name='ix_stand_in_delegated_reply_chain')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!indexed, "Reply claims must not require a schema index");

    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let settings = saved(&store, settings);
    let source = &settings["primary"]["connections"][0];
    let original =
        json!({"id":"claim-original", "text":"Where is the guide?", "at":"2099-01-01T00:00:00Z"});
    let item = store
        .ingest_stand_in_message(7, "@primary", source, &original, None)
        .unwrap();
    let work = item["id"].as_str().unwrap();
    let record = item["latestMessage"]["recordId"].as_str().unwrap();
    let decision = json!({"action":"reply","template":"document","reason":"Quoted guide."});
    assert!(store
        .record_delegation_decision(7, "desktop", work, record, decision.clone())
        .unwrap()
        .is_some());
    assert_eq!(reply_claims(&path).len(), 1);

    store
        .finish_delegated_submission(7, work, record, Some("channel-receipt"))
        .unwrap();
    let claims = reply_claims(&path);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0]["status"], "sent");
    assert_eq!(claims[0]["receiptId"], "channel-receipt");

    let followup = json!({"id":"claim-followup","quotedMessageId":"claim-original","text":"Any update?","at":"2099-01-01T00:01:00Z"});
    let linked = store
        .ingest_stand_in_message(7, "@primary", source, &followup, None)
        .unwrap();
    let linked_record = linked["latestMessage"]["recordId"].as_str().unwrap();
    let split = store
        .adjust_stand_in_message(7, work, linked_record, None)
        .unwrap();
    assert!(store
        .record_delegation_decision(
            7,
            "desktop",
            split["id"].as_str().unwrap(),
            linked_record,
            decision.clone(),
        )
        .unwrap()
        .is_none());
    assert_eq!(reply_claims(&path).len(), 1);

    drop(store);
    let store = LocalTaskStore::open(&path).unwrap();
    assert!(store
        .record_delegation_decision(
            7,
            "desktop",
            split["id"].as_str().unwrap(),
            linked_record,
            decision,
        )
        .unwrap()
        .is_none());
    assert_eq!(reply_claims(&path).len(), 1);
}

#[test]
fn send_claim_respects_each_template_switch_independently() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let mut settings = saved(&store, settings);
    let templates = ["document", "schedule", "process"];
    for disabled in templates {
        for template in templates {
            settings["primary"]["delegation"]["templates"][template] = json!(template != disabled);
        }
        settings = saved(&store, settings);
        let source = &settings["primary"]["connections"][0];
        for template in templates {
            let event = json!({
                "id": format!("{disabled}-off-{template}"),
                "text":"Question",
                "at":"2099-01-01T00:00:00Z"
            });
            let item = store
                .ingest_stand_in_message(7, "@primary", source, &event, None)
                .unwrap();
            let work = item["id"].as_str().unwrap();
            let record = item["latestMessage"]["recordId"].as_str().unwrap();
            let decision =
                json!({"action":"reply","template":template,"reason":"Quoted evidence."});
            let claim = store
                .record_delegation_decision(7, "desktop", work, record, decision)
                .unwrap();
            assert_eq!(
                claim.is_some(),
                template != disabled,
                "{disabled} disabled, {template} evaluated"
            );
        }
    }
}

#[test]
fn unsupported_actions_never_claim_a_send_and_handoff_keeps_its_reason() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let mut settings = draft(&store, json!([source("peer", "direct", "account-a")]));
    settings["primary"]["delegation"] = json!({"action":"enable"});
    let settings = saved(&store, settings);
    let source = &settings["primary"]["connections"][0];
    let event = json!({"id":"question", "text":"Where is the guide?", "at":"2099-01-01T00:00:00Z"});
    let item = store
        .ingest_stand_in_message(7, "@primary", source, &event, None)
        .unwrap();
    let work = item["id"].as_str().unwrap();
    let record = item["latestMessage"]["recordId"].as_str().unwrap();
    for action in ["ask", "wait"] {
        let decision = json!({"action":action,"reason":"No guide has been shared."});
        assert!(store
            .record_delegation_decision(7, "desktop", work, record, decision)
            .is_err());
        let persisted = store.stand_in_work(7, work).unwrap();
        assert_eq!(persisted["status"], "pending");
        assert!(persisted["delegationResult"].is_null());
    }

    let reason = "No guide has been shared in this conversation.";
    let decision = json!({"action":"needs_user","reason":reason});
    assert!(store
        .record_delegation_decision(7, "desktop", work, record, decision)
        .unwrap()
        .is_none());
    let result = store.stand_in_work(7, work).unwrap();
    assert_eq!(result["delegationResult"]["action"], "needs_user");
    assert_eq!(result["delegationResult"]["status"], "complete");
    assert_eq!(result["delegationResult"]["reason"], reason);
    assert!(result["delegationResult"]["receiptId"].is_null());
}

#[test]
fn recovery_gap_stays_visible_across_progress_and_restart_until_acknowledged() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut source = source("peer", "direct", "account-a");
    source["delegated"] = json!(true);
    source["enabledAfter"] = json!("2026-11-24T00:00:00Z");
    let gap =
        json!({"reason":"duration","from":"2026-11-24T00:00:00Z","until":"2026-11-24T00:31:00Z"});
    let progressed = json!({"checkpoint":{"after":"2026-11-24T00:32:00Z","cursor":"0"}});
    store
        .save_stand_in_source(
            7,
            &source,
            &json!({"checkpoint":{"after":gap["until"],"cursor":"0"},"delegationGap":gap}),
        )
        .unwrap();
    store.save_stand_in_source(7, &source, &progressed).unwrap();
    drop(store);

    let store = LocalTaskStore::open(&path).unwrap();
    let notices = store.stand_in_source_errors(7).unwrap();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["error"]["code"], "dingtalk_delegation_gap");
    assert_eq!(notices[0]["delegationGap"], gap);
    assert_eq!(notices[0]["checkpoint"], progressed["checkpoint"]);

    let mut failed = progressed.clone();
    failed["error"] = json!({"code":"source_network_failure","retryable":true});
    store.save_stand_in_source(7, &source, &failed).unwrap();
    assert_eq!(
        store.stand_in_source_errors(7).unwrap()[0]["error"],
        failed["error"]
    );
    store.acknowledge_stand_in_source_error(7, &source).unwrap();
    assert_eq!(
        store.stand_in_source_errors(7).unwrap()[0]["delegationGap"],
        gap
    );

    store.acknowledge_stand_in_source_error(7, &source).unwrap();
    store.save_stand_in_source(7, &source, &progressed).unwrap();
    assert!(store.stand_in_source_errors(7).unwrap().is_empty());
    assert_eq!(
        store.stand_in_source(7, &source).unwrap()["checkpoint"],
        progressed["checkpoint"]
    );
}
