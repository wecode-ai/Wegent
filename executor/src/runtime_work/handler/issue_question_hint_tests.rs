use super::*;

async fn inventory(handler: &RuntimeWorkRpcHandler, pending_only: bool) -> Value {
    handler
        .list_tasks_with_project_index(
            &json!({"preferCached":true,"pendingOnly":pending_only}),
            &CodexGlobalProjectIndex::from_test_payload(&Map::new()),
            Instant::now(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn pending_issue_question_hint_survives_original_runtime_task_deletion() {
    let (handler, root) = isolated_runtime_work_handler("issue-question-hint");
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Hint"})).unwrap())
        .unwrap();
    let issue = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Question"})).unwrap(),
        )
        .unwrap();
    store
        .create_comment(
            &serde_json::from_value(json!({
                "project_id":project.id,"task_id":issue.id,"sender_type":"agent",
                "sender_id":"agent","sender_name":"Agent","content":"Working",
                "metadata":{"runtime_address":{"deviceId":"device-1","taskId":"original"}}
            }))
            .unwrap(),
        )
        .unwrap();
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "original".into(),
        root.display().to_string(),
        "Original".into(),
    ));
    assert_eq!(
        inventory(&handler, true).await["localIssueQuestionsPending"],
        false
    );
    let request = store
        .report_issue_human_request(
            crate::task_runtime::IssueHumanRequestScope {
                project_id: &project.id,
                issue_id: &issue.id,
            },
            "device-1",
            "original",
            "question",
            "Choose scope",
            &[],
        )
        .unwrap();
    assert_eq!(
        inventory(&handler, true).await["localIssueQuestionsPending"],
        true
    );
    assert!(handler.store.delete_task("original").is_some());
    assert_eq!(
        inventory(&handler, true).await["localIssueQuestionsPending"],
        true
    );
    store
        .assign_issue_human_request(
            crate::task_runtime::IssueHumanRequestScope {
                project_id: &project.id,
                issue_id: &issue.id,
            },
            request["id"].as_str().unwrap(),
            1,
            7,
            "Current profile",
            None,
        )
        .unwrap();
    assert_eq!(
        inventory(&handler, true).await["localIssueQuestionsPending"],
        false
    );
    let viewers = handler
        .list_tasks_with_project_index(
            &json!({"preferCached":true,"pendingOnly":true,"localIssueUserIds":[0,7]}),
            &CodexGlobalProjectIndex::from_test_payload(&Map::new()),
            Instant::now(),
        )
        .await
        .unwrap();
    assert_eq!(viewers["localIssueQuestionsPending"], true);
    assert!(inventory(&handler, false)
        .await
        .get("localIssueQuestionsPending")
        .is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn human_request_viewer_scope_defaults_are_exact_and_arrays_are_validated() {
    use crate::local::app_ipc::human_request_viewer_ids;
    assert_eq!(
        human_request_viewer_ids(&json!({}), "ids", &[0]).unwrap(),
        vec![0]
    );
    assert_eq!(
        human_request_viewer_ids(&json!({}), "ids", &[7]).unwrap(),
        vec![7]
    );
    assert_eq!(
        human_request_viewer_ids(&json!({"ids":[7,0,7]}), "ids", &[0]).unwrap(),
        vec![0, 7]
    );
    assert!(human_request_viewer_ids(&json!({"ids":[]}), "ids", &[0])
        .unwrap()
        .is_empty());
    for ids in [json!([-1]), json!(["7"]), json!([7.5]), json!(null)] {
        assert!(human_request_viewer_ids(&json!({"ids":ids}), "ids", &[0]).is_err());
    }
}

#[tokio::test]
async fn pending_issue_question_hint_does_not_report_false_when_storage_fails() {
    let (mut handler, root) = isolated_runtime_work_handler("issue-question-hint-error");
    fs::create_dir_all(&root).unwrap();
    let blocked = root.join("not-a-directory");
    fs::write(&blocked, "blocked").unwrap();
    handler.task_store_path = Arc::new(blocked.join("tasks.sqlite"));
    let response = inventory(&handler, true).await;
    assert_eq!(response["success"], true);
    assert!(response.get("localIssueQuestionsPending").is_none());
    let _ = fs::remove_dir_all(root);
}
