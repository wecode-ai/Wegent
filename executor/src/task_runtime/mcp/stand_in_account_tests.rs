use super::*;

fn settings_with_current_account(store: &LocalTaskStore) -> Value {
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] = json!({
        "enabled": true,
        "prompt": "",
        "preferences": "",
        "connections": [{
            "providerId": crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,
            "profile": "current",
            "accountId": "account-new",
            "kind": "direct",
            "id": "current-peer",
            "name": "Current peer",
            "policy": {"automatic": true, "askBeforeAct": true, "immediate": false}
        }, {
            "providerId": "connection/email",
            "profile": "mailbox",
            "kind": "mailbox",
            "id": "mailbox",
            "name": "Mailbox",
            "policy": {"automatic": true, "askBeforeAct": true, "immediate": false}
        }]
    });
    store.save_personal_stand_in(7, "mac", settings).unwrap()
}

fn identity(work: Option<&str>) -> StandInMcpIdentity {
    StandInMcpIdentity {
        task_id: work.unwrap_or("stand-in-identity").into(),
        user: 7,
        device: "mac".into(),
        role: Some("@primary".into()),
        work: work.map(str::to_owned),
        ask_before_act: false,
        coordinator_batch: None,
        project: None,
        review: false,
        memory_review: false,
        readonly_worker: false,
    }
}

fn append_hidden_old_message(database: &std::path::Path, work_id: &str) -> Value {
    let message = json!({
        "id":"hidden-old-message",
        "recordId":"hidden-old-record",
        "userId":7,
        "roleId":"@primary",
        "text":"hidden old-account content",
        "at":"2026-01-03T00:00:00Z",
        "dispatchStatus":"failed",
        "delegationResult":{"action":"reply","reason":"hidden old-account decision"},
        "workId":work_id,
        "source":{
            "providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,
            "profile":"current",
            "accountId":"account-old",
            "kind":"direct",
            "id":"old-peer",
            "delegated":true
        }
    });
    let connection = rusqlite::Connection::open(database).unwrap();
    connection
        .execute(
            "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
             VALUES (?1,'stand_in_message',?2,?3,?3)",
            rusqlite::params![
                "hidden-old-message",
                message.to_string(),
                "9999-12-31T23:59:59Z"
            ],
        )
        .unwrap();
    let mut work: Value = serde_json::from_str(
        &connection
            .query_row(
                "SELECT metadata FROM loop_items WHERE id=?1 AND resource_type='stand_in_work'",
                rusqlite::params![work_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    work["messageCount"] = json!(work["messageCount"].as_u64().unwrap() + 1);
    work["latestMessage"] = message.clone();
    work["status"] = json!("failed");
    work["error"] = json!("hidden old-account failure");
    connection
        .execute(
            "UPDATE loop_items SET metadata=?1 WHERE id=?2 AND resource_type='stand_in_work'",
            rusqlite::params![work.to_string(), work_id],
        )
        .unwrap();
    message
}

#[test]
fn runtime_catalog_keeps_unrelated_tasks_and_drops_tasks_without_visible_work() {
    let visible = vec![json!({"id":"visible-work","taskId":"visible-task"})];
    let hidden = std::collections::BTreeSet::from(["hidden-task".to_owned()]);
    let run = |origin: Value| json!({"taskId":"runtime","runtimeHandle":{"origin":origin}});

    assert!(work_runtime_visible(
        &run(json!({"type":"connection_work","workId":"visible-work"})),
        &visible,
        &hidden,
    ));
    assert!(!work_runtime_visible(
        &run(json!({"type":"connection_work","workId":"hidden-work"})),
        &visible,
        &hidden,
    ));
    assert!(!work_runtime_visible(
        &run(json!({"type":"stand_in_task","sourceTaskId":"hidden-task"})),
        &visible,
        &hidden,
    ));
    assert!(work_runtime_visible(
        &run(json!({"type":"stand_in_task","sourceTaskId":"visible-task"})),
        &visible,
        &hidden,
    ));
    assert!(work_runtime_visible(
        &run(json!({"type":"stand_in_identity"})),
        &visible,
        &hidden,
    ));
    assert!(work_runtime_visible(
        &run(json!({"type":"ordinary_task"})),
        &visible,
        &hidden,
    ));
}

#[tokio::test]
async fn list_read_and_reply_ignore_events_from_the_previous_delegation_account() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&database).unwrap();
    settings_with_current_account(&store);
    let legacy_work_id = "retired-delegation-work";
    let legacy_work = json!({
        "id": legacy_work_id,
        "userId": 7,
        "roleId": "@primary",
        "taskId": legacy_work_id,
        "title": "old-account work",
        "messageCount": 0
    });
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
             VALUES (?1,'stand_in_work',?2,?3,?3)",
            rusqlite::params![
                legacy_work_id,
                legacy_work.to_string(),
                "2026-01-01T00:00:00Z"
            ],
        )
        .unwrap();
    let hidden = append_hidden_old_message(&database, legacy_work_id);
    let retired_ingest = store.ingest_stand_in_message(
        7,
        "@primary",
        &hidden["source"],
        &json!({"id":"new-message","text":"New chat","at":"2026-01-04T00:00:00Z"}),
        None,
    );
    assert!(retired_ingest
        .unwrap_err()
        .to_string()
        .contains("DingTalk delegation has been removed"));
    let email_source = json!({
        "providerId":"connection/email",
        "profile":"mailbox",
        "kind":"mailbox",
        "id":"mailbox",
        "name":"Mailbox"
    });
    let current_work = store
        .ingest_stand_in_message(
            7,
            "@primary",
            &email_source,
            &json!({"id":"mail-message","text":"current mailbox content","at":"2026-01-02T00:00:00Z"}),
            None,
        )
        .unwrap();

    let listed = list_visible_work(&store, &identity(None)).unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["items"][0]["id"], current_work["id"]);
    assert!(!listed.to_string().contains("old-account"));

    let runtime = TaskRuntime::new(store).unwrap();
    let current = read_connected_work_store(
        &runtime,
        &identity(current_work["id"].as_str()),
        &Value::Null,
    )
    .unwrap();
    assert_eq!(current["messages"][0]["text"], "current mailbox content");
    let denied = read_connected_work_store(&runtime, &identity(Some(legacy_work_id)), &Value::Null)
        .unwrap_err();
    assert!(denied.contains("no source events visible"));
    let denied = reply_to_work(
        &runtime,
        &identity(Some(legacy_work_id)),
        &json!({"messageId":hidden["recordId"],"text":"Reply"}),
        false,
        None,
    )
    .await
    .unwrap_err();
    assert!(denied.contains("different DingTalk account"));
}

#[tokio::test]
async fn mixed_work_only_exposes_current_mail_in_list_read_and_reply_actions() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&database).unwrap();
    settings_with_current_account(&store);
    let email_source = json!({
        "providerId":"connection/email",
        "profile":"mailbox",
        "kind":"mailbox",
        "id":"mailbox",
        "name":"Mailbox"
    });
    let work = store
        .ingest_stand_in_message(
            7,
            "@primary",
            &email_source,
            &json!({"id":"mail-message","text":"current mailbox content","at":"2026-01-02T00:00:00Z"}),
            None,
        )
        .unwrap();
    let work_id = work["id"].as_str().unwrap();
    let hidden = append_hidden_old_message(&database, work_id);

    let listed = list_visible_work(&store, &identity(None)).unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    let item = &listed["items"][0];
    assert_eq!(item["messageCount"], 1);
    assert_eq!(item["latestMessage"]["text"], "current mailbox content");
    assert!(item.get("error").is_none());
    assert!(!listed.to_string().contains("hidden old-account"));

    let runtime = TaskRuntime::new(store).unwrap();
    let read = read_connected_work_store(&runtime, &identity(Some(work_id)), &Value::Null).unwrap();
    assert_eq!(read["messages"].as_array().unwrap().len(), 1);
    assert_eq!(read["messages"][0]["text"], "current mailbox content");
    assert!(!read.to_string().contains("hidden old-account"));

    let denied = read_connected_work_store(
        &runtime,
        &identity(Some(work_id)),
        &json!({"messageId":hidden["recordId"]}),
    )
    .unwrap_err();
    assert!(denied.contains("Unknown source event"));
    let denied = reply_to_work(
        &runtime,
        &identity(Some(work_id)),
        &json!({"messageId":hidden["recordId"],"text":"Reply"}),
        false,
        None,
    )
    .await
    .unwrap_err();
    assert!(denied.contains("Unknown source event"));
}
