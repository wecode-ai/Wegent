use super::*;

fn turn(id: &str, origin: Value) -> SpawnTurnRequest {
    SpawnTurnRequest {
        task_kind: None,
        local_task_id: id.into(),
        runtime: "codex".into(),
        request: ExecutionRequest {
            extra: Map::from_iter([("origin".into(), origin)]),
            ..Default::default()
        },
        send_payload: None,
        direct_thread_id: None,
        fork_thread_id: None,
        fork_thread_path: None,
        resume_thread_id: None,
        initial_thread_goal: None,
    }
}

#[test]
fn execution_owner_classifies_triggers_and_survives_queue_serialization() {
    for (origin, expected) in [
        (json!(null), RuntimeTaskKind::Personal),
        (
            json!({"type":"board_task","loopItemId":"human-issue"}),
            RuntimeTaskKind::Personal,
        ),
        (
            json!({"type":"stand_in_identity"}),
            RuntimeTaskKind::StandIn,
        ),
        (
            json!({"type":"stand_in_coordinator"}),
            RuntimeTaskKind::StandIn,
        ),
        (
            json!({"type":"stand_in_task","initiatedBy":"stand_in"}),
            RuntimeTaskKind::StandIn,
        ),
        (
            json!({"type":"stand_in_schedule","initiatedBy":"stand_in"}),
            RuntimeTaskKind::StandIn,
        ),
        (json!({"type":"connection_work"}), RuntimeTaskKind::StandIn),
        (json!({"type":"dingtalk_work"}), RuntimeTaskKind::StandIn),
        (
            json!({"type":"issue_dispatch","initiatedBy":"stand_in"}),
            RuntimeTaskKind::StandIn,
        ),
        (
            json!({"type":"project_coordinator"}),
            RuntimeTaskKind::Agent,
        ),
        (json!({"type":"project_automation"}), RuntimeTaskKind::Agent),
        (
            json!({"type":"issue_dispatch","dispatchRole":"executor"}),
            RuntimeTaskKind::Agent,
        ),
        (
            json!({"type":"issue_dispatch","dispatchRole":"manager"}),
            RuntimeTaskKind::Agent,
        ),
        (
            json!({"type":"board_task","executionId":"cloud-execution"}),
            RuntimeTaskKind::Agent,
        ),
        (
            json!({"type":"board_comment","executionId":"cloud-execution"}),
            RuntimeTaskKind::Agent,
        ),
    ] {
        let request = turn("task", origin);
        let restored: SpawnTurnRequest =
            serde_json::from_value(serde_json::to_value(&request).unwrap()).unwrap();
        assert_eq!(request.task_kind(), expected);
        assert_eq!(restored.task_kind(), expected);
    }
}

#[test]
fn saturated_category_does_not_block_other_categories_or_their_queues() {
    let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(1), VecDeque::new());
    for (kind, origin) in [
        (RuntimeTaskKind::Personal, json!(null)),
        (
            RuntimeTaskKind::StandIn,
            json!({"type":"stand_in_identity"}),
        ),
        (RuntimeTaskKind::Agent, json!({"type":"project_automation"})),
    ] {
        let first = format!("{kind:?}-1");
        let second = format!("{kind:?}-2");
        assert!(scheduler.enqueue(turn(&first, origin.clone())).is_some());
        assert!(scheduler.enqueue(turn(&second, origin)).is_none());
        assert_eq!(scheduler.active(kind), 1);
        assert_eq!(scheduler.available(kind), 0);
    }
    let ready = scheduler.finish("StandIn-1");
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].local_task_id, "StandIn-2");
    assert_eq!(scheduler.queued(RuntimeTaskKind::Personal), 1);
    assert_eq!(scheduler.queued(RuntimeTaskKind::Agent), 1);
    assert_eq!(scheduler.active_task_ids.len(), 3);
}

#[test]
fn limit_changes_drain_only_the_affected_category_without_interrupting_active_turns() {
    let mut scheduler = RuntimeTurnScheduler::new(RuntimeSettings::uniform(1), VecDeque::new());
    for id in ["stand-in-1", "stand-in-2", "stand-in-3"] {
        scheduler.enqueue(turn(id, json!({"type":"stand_in_identity"})));
    }
    scheduler.enqueue(turn("personal", json!(null)));
    scheduler.enqueue(turn("personal-waiting", json!(null)));
    let mut settings = scheduler.settings.clone();
    settings.max_concurrent_stand_in_tasks = 2;
    let ready = scheduler.update_limits(settings.clone());
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].local_task_id, "stand-in-2");
    settings.max_concurrent_stand_in_tasks = 1;
    assert!(scheduler.update_limits(settings).is_empty());
    assert_eq!(scheduler.active(RuntimeTaskKind::StandIn), 2);
    assert!(scheduler.finish("stand-in-1").is_empty());
    assert_eq!(
        scheduler.finish("stand-in-2")[0].local_task_id,
        "stand-in-3"
    );
    assert_eq!(scheduler.queued(RuntimeTaskKind::Personal), 1);
}

#[test]
fn legacy_settings_seed_all_categories_once() {
    let settings: RuntimeSettings =
        serde_json::from_value(json!({"maxConcurrentTasks":4})).unwrap();
    assert_eq!(settings.max_concurrent_tasks, 4);
    assert_eq!(settings.max_concurrent_stand_in_tasks, 4);
    assert_eq!(settings.max_concurrent_agent_tasks, 4);
    let settings: RuntimeSettings = serde_json::from_value(
        json!({"maxConcurrentTasks":2,"maxConcurrentStandInTasks":6,"maxConcurrentAgentTasks":8}),
    )
    .unwrap();
    assert_eq!(settings.total_limit(), 16);
}

#[tokio::test]
async fn settings_rpc_persists_independent_partial_updates_and_rejects_invalid_limits() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home =
        super::super::tests::ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let handler = RuntimeWorkRpcHandler::new("concurrency-test", "/bin/false");
    let initial = handler.update_runtime_settings(json!({"maxConcurrentTasks":2,"maxConcurrentStandInTasks":4,"maxConcurrentAgentTasks":6})).await.unwrap();
    assert_eq!(initial["maxConcurrentStandInTasks"], 4);
    let updated = handler
        .update_runtime_settings(json!({"maxConcurrentTasks":3}))
        .await
        .unwrap();
    assert_eq!(
        updated,
        json!({"maxConcurrentTasks":3,"maxConcurrentStandInTasks":4,"maxConcurrentAgentTasks":6})
    );
    let stored = super::super::system::read_runtime_settings();
    assert_eq!(serde_json::to_value(stored).unwrap(), updated);
    for invalid in [
        json!({}),
        json!({"maxConcurrentAgentTasks":0}),
        json!({"maxConcurrentStandInTasks":21}),
        json!({"maxConcurrentTasks":null}),
        json!({"maxConcurrentTasks":1.5}),
        json!({"maxConcurrentTasks":true}),
    ] {
        assert!(handler.update_runtime_settings(invalid).await.is_err());
        assert_eq!(handler.get_runtime_settings().await.unwrap(), updated);
    }
    let capacity = handler.get_runtime_capacity().await.unwrap();
    assert_eq!(capacity["limit"], 13);
    assert_eq!(capacity["categories"]["personal"]["limit"], 3);
    assert_eq!(capacity["categories"]["standIn"]["limit"], 4);
    assert_eq!(capacity["categories"]["agent"]["limit"], 6);
}

#[test]
fn follow_up_owner_is_bound_to_original_task_and_persisted_with_the_queued_turn() {
    let root = tempfile::tempdir().unwrap();
    let store = RuntimeWorkStore::new(root.path().join("tasks.json"));
    store.upsert_task(RuntimeTaskLink {
        local_task_id: "original-agent".into(),
        runtime_handle: json!({"origin":{"type":"board_task","executionId":"first-execution"}}),
        ..Default::default()
    });
    let mut follow_up = turn("original-agent", json!({"type":"board_task"}));
    follow_up.bind_task_kind(&store);
    assert_eq!(follow_up.task_kind(), RuntimeTaskKind::Agent);
    follow_up
        .request
        .extra
        .insert("origin".into(), json!({"type":"board_comment"}));
    let restored: SpawnTurnRequest =
        serde_json::from_value(serde_json::to_value(follow_up).unwrap()).unwrap();
    assert_eq!(restored.task_kind(), RuntimeTaskKind::Agent);
}
