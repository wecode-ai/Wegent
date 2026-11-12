use super::*;

fn assert_binding_denied(error: AppIpcError, reason: &str) {
    assert_eq!(error.code, "permission_denied");
    assert_eq!(
        error.message,
        format!("The review run binding is no longer valid: {reason}")
    );
}

#[test]
fn evidence_filter_preserves_pagination_and_discloses_unknown_time_and_truncation() {
    let start = 1_780_000_000_000_i64;
    let end = start + 1000;
    let mut page = json!({"messages":[
        {"id":"old","createdAt":start-1}, {"id":"start","createdAt":start},
        {"id":"inside","createdAt":end-1}, {"id":"end","createdAt":end},
        {"id":"unknown"}], "turns":[{"private":"unfiltered"}],
        "beforeCursor":"older", "hasMoreBefore":true, "fullContent":false});
    super::super::stand_in_history::filter_history_page(&mut page, Some(start), Some(end));
    assert_eq!(
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["start", "inside", "unknown"]
    );
    assert!(page.get("turns").is_none());
    assert_eq!(page["unknownTimestamps"], true);
    assert_eq!(page["contentMayBeTruncated"], true);
    assert_eq!(page["beforeCursor"], "older");
    assert_eq!(page["hasMoreBefore"], true);
    let mut previous = json!({"messages":[{"createdAt":start-1},{"createdAt":end}]});
    super::super::stand_in_history::filter_history_page(&mut previous, None, Some(end));
    assert_eq!(previous["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn onboarding_never_resumes_unrelated_persisted_turns() {
    assert!(!should_resume_persisted_turns_before_rpc(
        "runtime.stand_in.onboarding.get"
    ));
    assert!(!should_resume_persisted_turns_before_rpc(
        "runtime.stand_in.onboarding.complete"
    ));
}

#[tokio::test]
async fn scheduled_review_uses_the_real_run_window_and_rejects_stale_versions() {
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let review = handler
        .automation_store
        .create(weekly_review(7, "mac", "09:00", "UTC", "en").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    let binding = run.coordination.as_ref().unwrap();
    identity.task_id = binding.task_id.clone();
    identity.review = true;
    identity.role = Some("@primary".into());
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:binding.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","weeklyReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let page = handler
        .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
        .await
        .unwrap();
    let end = chrono::DateTime::parse_from_rfc3339(page["windowEnd"].as_str().unwrap()).unwrap();
    assert_eq!(end.timestamp_millis(), run.scheduled_for.timestamp_millis());
    let actor = handler.local_task_link(&identity.task_id).unwrap();
    for (pointer, value, reason) in [
        (
            "/executionRequest/standInSchedule/id",
            json!("missing"),
            "automation_missing",
        ),
        ("/origin/weeklyReview", json!(false), "identity_mismatch"),
        (
            "/executionRequest/standInSchedule/runId",
            json!("missing"),
            "run_missing",
        ),
    ] {
        let mut invalid = actor.clone();
        *invalid.runtime_handle.pointer_mut(pointer).unwrap() = value;
        assert_binding_denied(handler.review_run_end(&invalid, 7).unwrap_err(), reason);
    }
    let mut invalid = actor.clone();
    invalid.local_task_id.push_str("-different");
    assert_binding_denied(
        handler.review_run_end(&invalid, 7).unwrap_err(),
        "coordination_mismatch",
    );
    handler
        .automation_store
        .mark_failed(&run.id, "test failure".into())
        .unwrap();
    assert_binding_denied(
        handler.review_run_end(&actor, 7).unwrap_err(),
        "run_not_active",
    );
    handler.automation_store.update(review).unwrap();
    assert_binding_denied(
        handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .unwrap_err(),
        "automation_version_changed",
    );
}

#[tokio::test]
async fn memory_review_reads_older_history_and_revalidates_the_scheduled_run() {
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    let binding = run.coordination.as_ref().unwrap();
    identity.task_id = binding.task_id.clone();
    identity.memory_review = true;
    identity.role = Some("@primary".into());
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:binding.task_id.clone(), runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }), ..Default::default()});
    let page = handler
        .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
        .await
        .unwrap();
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(page["windowStart"].as_str().unwrap())
            .unwrap()
            .timestamp_millis(),
        0
    );
    assert!(handler.remember_from_conversation(&identity, &json!({"taskId":"missing","messageId":"fake","excerpt":"invented","content":"False fact"})).await.is_err());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    assert!(store.stand_in_memories(7).unwrap().is_empty());
    handler.automation_store.update(review).unwrap();
    assert_binding_denied(
        handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .unwrap_err(),
        "automation_version_changed",
    );
}

fn fixture(root: &std::path::Path) -> (RuntimeWorkRpcHandler, StandInMcpIdentity) {
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
    handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
    handler.automation_store =
        crate::runtime_work::automations::AutomationStore::new(root.join("automations.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let settings = store.personal_stand_in(7, "mac").unwrap();
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id:"primary".into(),
        runtime_handle:json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac","standInId":"@primary"},"executionRequest":{"user_id":7}}),
        ..Default::default()
    });
    (
        handler,
        StandInMcpIdentity {
            task_id: "primary".into(),
            user: 7,
            device: "mac".into(),
            role: Some("@primary".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: false,
        },
    )
}

#[tokio::test]
async fn memory_review_traverses_long_history_saves_evidence_and_commits_only_complete_sources() {
    let root = tempfile::tempdir().unwrap();
    let (mut handler, mut identity) = fixture(root.path());
    handler.transcript_test_workers = Some(Arc::new(tokio::sync::Semaphore::new(2)));
    let mut review = crate::runtime_work::automations::memory_review(7, "mac").unwrap();
    review.schedule = crate::runtime_work::automations::AutomationSchedule::OneTime {
        execute_at: chrono::Utc::now(),
    };
    let review = handler.automation_store.create(review).unwrap();
    let due = handler.automation_store.due(chrono::Utc::now()).unwrap();
    assert_eq!(due.len(), 1);
    let (claimed, run) = due.into_iter().next().unwrap();
    assert!(!claimed.enabled);
    assert_eq!(claimed.version, review.version);
    identity.task_id = run.coordination.as_ref().unwrap().task_id.clone();
    identity.role = Some("@primary".into());
    identity.memory_review = true;
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:identity.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let mut messages: Vec<Value> = (0..55).map(|index| json!({"id":format!("message-{index}"),"role":"user","content":format!("Fact {index}"),"createdAt":1})).collect();
    messages[54]["content"] = json!(format!(
        "{} Keep weekly reports brief",
        "context ".repeat(4000)
    ));
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"history".into(), runtime:"chat".into(),created_at:1,updated_at:2,
        runtime_handle:json!({"origin":{"type":"ordinary","userId":7},"executionRequest":{"user_id":7},"messages":messages}),..Default::default()});
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let args = json!({"taskId":"history"});
    assert!(handler
        .memory_progress_operation(&identity, "complete_memory_source", &args)
        .await
        .is_err());
    let mut seen = HashSet::new();
    let mut saved = None;
    let mut saved_input = None;
    let mut finished = false;
    for _ in 0..30 {
        let result = handler
            .memory_progress_operation(&identity, "next_memory_page", &args)
            .await
            .unwrap();
        let page = &result["page"];
        for message in page["messages"].as_array().into_iter().flatten() {
            seen.insert(message["id"].as_str().unwrap().to_owned());
        }
        if page["content"]
            .as_str()
            .is_some_and(|text| text.contains("Keep weekly reports brief"))
        {
            let mut input = result["readArguments"].clone();
            input["messageId"] = json!("message-54");
            input["excerpt"] = json!("Keep weekly reports brief");
            input["content"] = json!("Prefers brief weekly reports");
            saved_input = Some(input.clone());
            saved = Some(
                handler
                    .remember_from_conversation(&identity, &input)
                    .await
                    .unwrap(),
            );
        }
        if result["readyToComplete"] == true {
            finished = true;
            break;
        }
        assert_eq!(
            store.memory_review_progress(7, "history").unwrap()["completedThrough"],
            0
        );
        assert!(handler
            .memory_progress_operation(&identity, "complete_memory_source", &args)
            .await
            .is_err());
    }
    assert!(
        finished,
        "The bounded fixture must finish without cursor cycles"
    );
    assert_eq!(seen.len(), 55);
    let saved = saved.expect("A fact in a later content chunk must be readable and savable");
    assert_eq!(saved["scope"], json!({"kind":"personal"}));
    assert_eq!(saved["evidence"]["messageId"], "message-54");
    let mut input = saved_input.unwrap();
    input["id"] = saved["id"].clone();
    input["version"] = json!(saved["version"].as_i64().unwrap() + 1);
    assert!(handler
        .remember_from_conversation(&identity, &input)
        .await
        .is_err());
    let pending = handler
        .memory_progress_operation(&identity, "next_memory_page", &args)
        .await
        .unwrap();
    assert_eq!(pending["readyToComplete"], false);
    assert_eq!(pending["pendingWriteCount"], 1);
    assert!(handler
        .memory_progress_operation(&identity, "complete_memory_source", &args)
        .await
        .is_err());
    assert_eq!(
        store.memory_review_progress(7, "history").unwrap()["completedThrough"],
        0
    );
    input["version"] = saved["version"].clone();
    let retried = handler
        .remember_from_conversation(&identity, &input)
        .await
        .unwrap();
    store
        .delete_stand_in_memory(
            7,
            retried["id"].as_str().unwrap(),
            retried["version"].as_i64().unwrap(),
        )
        .unwrap();
    input.as_object_mut().unwrap().remove("id");
    input.as_object_mut().unwrap().remove("version");
    for content in [
        "Prefers brief weekly reports",
        "Weekly summaries should be concise",
    ] {
        input["content"] = json!(content);
        let suppressed = handler
            .remember_from_conversation(&identity, &input)
            .await
            .unwrap();
        assert_eq!(suppressed["saved"], false);
        assert_eq!(suppressed["status"], "suppressed");
        assert!(store.stand_in_memories(7).unwrap().is_empty());
        assert!(
            store.memory_review_progress(7, "history").unwrap()["pendingWrites"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    let committed = handler
        .memory_progress_operation(&identity, "complete_memory_source", &args)
        .await
        .unwrap();
    assert_eq!(
        committed["completedThrough"],
        run.scheduled_for.timestamp_millis()
    );
    let listed = handler
        .memory_progress_operation(&identity, "list_memory_sources", &json!({}))
        .await
        .unwrap();
    assert!(!listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["taskId"] == "history"));
    handler.automation_store.update(claimed).unwrap();
    for error in [
        handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .unwrap_err(),
        handler
            .remember_from_conversation(&identity, &input)
            .await
            .unwrap_err(),
        handler
            .memory_progress_operation(&identity, "complete_memory_source", &args)
            .await
            .unwrap_err(),
    ] {
        assert_binding_denied(error, "automation_version_changed");
    }
    assert!(store.stand_in_memories(7).unwrap().is_empty());
    assert_eq!(
        store.memory_review_progress(7, "history").unwrap()["completedThrough"],
        run.scheduled_for.timestamp_millis()
    );
}

#[tokio::test]
async fn discovery_reads_all_pages_and_keeps_identity_and_recent_updates_to_old_tasks() {
    let root = tempfile::tempdir().unwrap();
    let (handler, identity) = fixture(root.path());
    for index in 0..121 {
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: format!("task-{index:03}"),
            created_at: 1,
            updated_at: chrono::Utc::now().timestamp_millis(),
            runtime_handle: json!({"executionRequest":{"user_id":7}}),
            ..Default::default()
        });
    }
    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "other-user".into(),
        updated_at: chrono::Utc::now().timestamp_millis(),
        runtime_handle: json!({"executionRequest":{"user_id":8}}),
        ..Default::default()
    });
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"role-chat".into(),updated_at:chrono::Utc::now().timestamp_millis(),runtime_handle:json!({"origin":{"type":"stand_in_identity"},"executionRequest":{"user_id":7}}),..Default::default()});
    let mut args = json!({});
    let mut ids = Vec::new();
    loop {
        let page = handler
            .read_stand_in_conversations(&identity, "list_tasks", &args)
            .await
            .unwrap();
        ids.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["taskId"].as_str().unwrap().to_owned()),
        );
        if page["nextCursor"].is_null() {
            break;
        }
        args = json!({"cursor":page["nextCursor"]});
    }
    assert_eq!(ids.len(), 123);
    assert!(ids.contains(&"role-chat".into()));
    assert!(!ids.contains(&"other-user".into()));
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 123);
}

#[tokio::test]
async fn history_rejects_forged_runs_foreign_owners_roles_and_devices() {
    let root = tempfile::tempdir().unwrap();
    let (handler, identity) = fixture(root.path());
    for forbidden in [
        StandInMcpIdentity {
            user: 8,
            ..identity.clone()
        },
        StandInMcpIdentity {
            device: "other".into(),
            ..identity.clone()
        },
        StandInMcpIdentity {
            role: Some("other".into()),
            ..identity.clone()
        },
        StandInMcpIdentity {
            work: Some("external".into()),
            ..identity.clone()
        },
        StandInMcpIdentity {
            review: true,
            memory_review: false,
            readonly_worker: false,
            ..identity.clone()
        },
    ] {
        assert_eq!(
            handler
                .read_stand_in_conversations(&forbidden, "list_tasks", &json!({}))
                .await
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }
    assert_eq!(
        handler
            .read_stand_in_conversations(&identity, "read_task", &json!({"taskId":"missing"}))
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
}

#[tokio::test]
async fn onboarding_rpc_is_offline_and_repeated_completion_does_not_recreate_deleted_review() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _) = fixture(root.path());
    let args = json!({"userId":7,"weeklyReview":true,"time":"09:00"});
    let before = handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.get", args.clone())
        .await
        .unwrap();
    assert_eq!(before["state"]["completed"], false);
    assert_eq!(before["reviewTemplate"]["timezone"], "UTC");
    let completed = handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.complete", args.clone())
        .await
        .unwrap();
    assert_eq!(completed["state"]["completed"], true);
    assert_eq!(completed["settings"]["primary"]["enabled"], true);
    assert_eq!(
        handler
            .automation_store
            .get("stand-in-weekly-review-7")
            .unwrap()
            .timezone,
        "UTC"
    );
    handler
        .automation_store
        .delete("stand-in-weekly-review-7")
        .unwrap();
    handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.complete", args)
        .await
        .unwrap();
    assert!(handler.automation_store.list().is_empty());
}

#[tokio::test]
async fn onboarding_rpc_uses_requested_timezone_without_rewriting_existing_review() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _) = fixture(root.path());
    let mut args =
        json!({"userId":7,"weeklyReview":true,"time":"09:00","timezone":"America/New_York"});
    let before = handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.get", args.clone())
        .await
        .unwrap();
    assert_eq!(before["reviewTemplate"]["timezone"], "America/New_York");
    handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.complete", args.clone())
        .await
        .unwrap();
    let saved = handler
        .automation_store
        .get("stand-in-weekly-review-7")
        .unwrap();
    assert_eq!(saved.timezone, "America/New_York");
    args["timezone"] = json!("Europe/London");
    args["time"] = json!("11:30");
    handler
        .stand_in_onboarding_rpc("runtime.stand_in.onboarding.complete", args)
        .await
        .unwrap();
    let unchanged = handler.automation_store.get(&saved.id).unwrap();
    assert_eq!(unchanged.timezone, saved.timezone);
    assert_eq!(json!(unchanged.schedule), json!(saved.schedule));
    assert_eq!(unchanged.next_run_at, saved.next_run_at);
    assert_eq!(unchanged.version, saved.version);
}

#[tokio::test]
async fn onboarding_rpc_rejects_invalid_timezone_before_persisting() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _) = fixture(root.path());
    for method in [
        "runtime.stand_in.onboarding.get",
        "runtime.stand_in.onboarding.complete",
    ] {
        for timezone in [json!(""), json!("Not/A_Zone"), json!(42), Value::Null] {
            let error = handler
                .stand_in_onboarding_rpc(
                    method,
                    json!({"userId":7,"weeklyReview":true,"timezone":timezone}),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "bad_request");
            assert!(error.message.contains("IANA timezone"));
        }
    }
    assert!(handler.automation_store.list().is_empty());
    assert_eq!(
        handler.automation_store.stand_in_onboarding(7).unwrap()["completed"],
        false
    );
}

#[tokio::test]
async fn onboarding_preserves_a_paused_primary_and_does_not_initialize_on_opt_out() {
    let root = tempfile::tempdir().unwrap();
    let (handler, _) = fixture(root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] =
        json!({"enabled":false,"prompt":"Keep this","preferences":"Private preference"});
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let completed = handler
        .stand_in_onboarding_rpc(
            "runtime.stand_in.onboarding.complete",
            json!({"userId":7,"weeklyReview":true}),
        )
        .await
        .unwrap();
    assert_eq!(completed["settings"]["primary"]["enabled"], false);
    assert_eq!(completed["settings"]["primary"]["prompt"], "Keep this");
    let opted_out = handler
        .stand_in_onboarding_rpc(
            "runtime.stand_in.onboarding.complete",
            json!({"userId":8,"weeklyReview":false}),
        )
        .await
        .unwrap();
    assert!(opted_out["settings"]["primary"].is_null());
}
