use super::*;

#[tokio::test]
async fn reply_actions_select_exact_versions_without_bypassing_source_authority() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let source = json!({"providerId":"@third-party/messages/source","profile":"account",
        "kind":"group","id":"group","name":"Group",
        "policy":{"automatic":false,"askBeforeAct":true}});
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["roles"][0]["enabled"] = json!(true);
    settings["roles"][0]["connections"] = json!([source.clone()]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    store
        .ensure_coordinated_work(7, "default", "work", &source, "Work")
        .unwrap();
    for version in ["v1", "v2"] {
        store
            .ingest_stand_in_message(
                7,
                "default",
                &source,
                &json!({"id":"stable","objectId":"object","version":version,"text":version,
                    "at":"2026-01-01T00:00:00Z"}),
                Some("work"),
            )
            .unwrap();
    }
    let messages = store.stand_in_messages(7, "work").unwrap();
    assert_eq!(messages.len(), 2);
    let record = &messages.iter().find(|row| row["version"] == "v2").unwrap()["recordId"];
    let runtime = TaskRuntime::new(store).unwrap();
    let identity = StandInMcpIdentity {
        task_id: "work".into(),
        user: 7,
        device: "mac".into(),
        role: Some("default".into()),
        work: Some("work".into()),
        ask_before_act: false,
        coordinator_batch: None,
        project: None,
        review: false,
        memory_review: false,
        readonly_worker: false,
    };
    let exact = json!({"messageId":record,"text":"Reply"});
    for email in [false, true] {
        let denied = reply_to_work(&runtime, &identity, &exact, email)
            .await
            .unwrap_err();
        assert!(denied.contains("Automatic reply authorization was revoked"));
        let ambiguous = reply_to_work(
            &runtime,
            &identity,
            &json!({"messageId":"stable","text":"Reply"}),
            email,
        )
        .await
        .unwrap_err();
        assert!(ambiguous.contains("Ambiguous source event ID"));
        for foreign in [
            StandInMcpIdentity {
                user: 8,
                ..identity.clone()
            },
            StandInMcpIdentity {
                role: Some("other".into()),
                ..identity.clone()
            },
            StandInMcpIdentity {
                work: Some("foreign-work".into()),
                ..identity.clone()
            },
        ] {
            assert!(reply_to_work(&runtime, &foreign, &exact, email)
                .await
                .is_err());
        }
    }
    let mut revoked = runtime
        .stand_in_store()
        .personal_stand_in(7, "mac")
        .unwrap();
    revoked["roles"][0]["connections"] = json!([]);
    runtime
        .stand_in_store()
        .save_personal_stand_in(7, "mac", revoked)
        .unwrap();
    for email in [false, true] {
        let denied = reply_to_work(&runtime, &identity, &exact, email)
            .await
            .unwrap_err();
        assert!(denied.contains("Source connection was removed"));
    }
}
