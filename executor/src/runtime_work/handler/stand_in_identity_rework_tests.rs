use super::*;

#[tokio::test]
async fn direct_reply_requires_the_owned_native_turn_and_complete_followup_review() {
    let root = tempfile::tempdir().unwrap();
    let (handler, mut reviewer) = fixture(root.path());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"] = json!({"enabled":true,"selfLearningEnabled":true,"prompt":"","preferences":"","connections":[]});
    store.save_personal_stand_in(7, "mac", settings).unwrap();

    let sent = chrono::Utc::now().timestamp_millis() - 25 * 60 * 60 * 1000;
    let origin = json!({"type":"stand_in_identity","standInId":"@primary","userId":7,"deviceId":"mac","conversationScope":"collaboration"});
    handler.store.update_task("primary", |link| {
        link.runtime_handle["origin"] = origin.clone()
    });
    let mut request = ExecutionRequest::default();
    request.extra.insert("origin".into(), origin.clone());
    handler.refresh_stand_in_context(&mut request).unwrap();
    let witness = crate::task_runtime::mcp::begin_stand_in_turn_witness(&mut request).unwrap();
    let turn = ActiveCodexTurn {
        execution_id: 1,
        thread_id: "thread".into(),
        turn_id: "native-turn".into(),
    };
    handler.record_identity_completion(
        "primary",
        &request,
        Some(&turn),
        Some("native-answer"),
        Some(sent),
    );
    drop(witness);
    assert!(crate::task_runtime::mcp::stand_in_turn_versions(&request).is_none());
    let messages = json!([
        {"id":"old-question","role":"user","turnId":"old-turn","content":"Which document?","createdAt":sent-400},
        {"id":"old-answer","role":"assistant","turnId":"old-turn","status":"done","content":"Last version","createdAt":sent-350,
            "completedAt":sent-300,"runtimeItems":[{"type":"assistant_text","phase":"final_answer","id":"old-final","content":"Last version"}]},
        {"id":"old-correction","role":"user","turnId":"old-followup","content":"Use the new version","createdAt":sent-200},
        {"id":"question","role":"user","turnId":"native-turn","content":"Send the link","createdAt":sent-100},
        {"id":"progress","role":"assistant","turnId":"native-turn","status":"done","content":"Checking","createdAt":sent-50,
            "completedAt":sent-45,"runtimeItems":[{"type":"assistant_text","phase":"commentary","id":"native-progress","content":"Checking"}]},
        {"id":"visible-answer","role":"assistant","turnId":"native-turn","content":"Public site","createdAt":sent-5,
            "completedAt":sent,"runtimeItems":[{"type":"assistant_text","id":"native-answer","content":"Public site"}]},
        {"id":"robot","role":"user","turnId":"robot-turn","content":"Automated status","source":{"type":"stand_in_activity"},"createdAt":sent+1},
        {"id":"correction","role":"user","turnId":"followup-turn","content":"Use the internal site","createdAt":sent+100}
    ]);
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"primary".into(),runtime:"chat".into(),
        created_at:sent-400,updated_at:sent+100,
        runtime_handle:json!({"origin":origin,"executionRequest":{"user_id":7},"messages":messages}),..Default::default()});
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    reviewer.task_id = run.coordination.as_ref().unwrap().task_id.clone();
    reviewer.memory_review = true;
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:reviewer.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let args = json!({"taskId":"primary"});
    let page = handler
        .memory_progress_operation(&reviewer, "next_memory_page", &args)
        .await
        .unwrap();
    let reference = |id: &str, excerpt: &str| json!({"id":id,"excerpt":excerpt,"readArguments":page["readArguments"]});
    let mut case = json!({"taskId":"primary","kind":"correction","content":"Check which entry is needed.",
        "scene":reference("question","Send the link"),"actual":reference("visible-answer","Public site"),
        "expected":reference("robot","Automated status")});
    assert!(handler.save_training_case(&reviewer, &case).await.is_err());
    case["expected"] = reference("correction", "Use the internal site");
    case["actual"] = reference("progress", "Checking");
    assert!(handler.save_training_case(&reviewer, &case).await.is_err());
    case["actual"] = reference("visible-answer", "Public site");
    handler.save_training_case(&reviewer, &case).await.unwrap();
    case["content"] = json!("Use the requested revision.");
    case["scene"] = reference("old-question", "Which document?");
    case["actual"] = reference("old-answer", "Last version");
    case["expected"] = reference("old-correction", "Use the new version");
    handler.save_training_case(&reviewer, &case).await.unwrap();
    let report = || {
        handler.dispatch(
            "runtime.stand_in.memory.rework_report",
            json!({"userId":7,"roleId":"@primary"}),
        )
    };
    assert_eq!(report().await.unwrap()["completeRequests"], 0);
    handler
        .memory_progress_operation(
            &reviewer,
            "complete_memory_source",
            &json!({"taskId":"primary","reworkReviewComplete":true}),
        )
        .await
        .unwrap();
    let measured = report().await.unwrap();
    assert_eq!(measured["completeRequests"], 1);
    assert_eq!(measured["ownerReworkRequests"], 1);
    assert_eq!(measured["confirmedReworkRequests"], 2);
    assert_eq!(measured["outsideRateReworkRequests"], 1);
    assert_eq!(measured["cohorts"].as_array().unwrap().len(), 1);
}
