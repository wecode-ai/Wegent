// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn run_goal_test(test: impl std::future::Future<Output = ()>) {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _homes: Vec<_> = [
        "WEGENT_EXECUTOR_HOME",
        "CODEX_HOME",
        "WEGENT_CODEX_HOME",
        "WEGENT_WORKBENCH_HOME",
    ]
    .into_iter()
    .map(|key| ScalarEnv::set(key, home.path().to_str().unwrap()))
    .collect();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test);
}

fn block_goal_admission(handler: &RuntimeWorkRpcHandler) {
    let mut scheduler = handler.turn_scheduler.lock().unwrap();
    scheduler.settings.max_concurrent_tasks = 1;
    scheduler
        .active_task_ids
        .insert("another-task".into(), RuntimeTaskKind::Personal);
}

#[test]
fn activating_an_owned_goal_does_not_admit_another_continuation() {
    run_goal_test(async {
        for local_owner in [false, true] {
            let (handler, root, request) = setup("native-goal-live-owner");
            handler.store.update_task("task-1", |link| {
                store_runtime_execution_request(&mut link.runtime_handle, &request);
            });
            handler.journal_active_goal_turn("task-1", None);
            let execution = if local_owner {
                Some(start_test_execution(&handler, "task-1"))
            } else {
                handler.route_codex_notification(notification("turn/started", "turn-1"));
                assert!(handler.native_task_holds_capacity("task-1"));
                None
            };
            assert!(!handler.resume_active_goal("task-1").await.unwrap());
            assert!(handler
                .turn_scheduler
                .lock()
                .unwrap()
                .queued_turns
                .is_empty());
            if let Some(execution) = execution {
                handler.finish_local_task_execution("task-1", execution);
            }
            handler.sync_runtime_task_goal_status("task-1", None, None);
            handler.persist_current_turn_state().await.unwrap();
            let _ = fs::remove_dir_all(root);
        }
    });
}

#[test]
fn concurrent_goal_activations_admit_only_one_owned_resume() {
    run_goal_test(async {
        let (handler, root, request) = setup("native-goal-readmission-race");
        handler.store.update_task("task-1", |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        handler.journal_active_goal_turn("task-1", None);
        block_goal_admission(&handler);
        let (first, second) = tokio::join!(
            handler.resume_active_goal("task-1"),
            handler.resume_active_goal("task-1")
        );
        assert_eq!(
            [first.unwrap(), second.unwrap()]
                .into_iter()
                .filter(|value| *value)
                .count(),
            1
        );
        {
            let scheduler = handler.turn_scheduler.lock().unwrap();
            assert_eq!(scheduler.queued_turns.len(), 1);
            assert_eq!(scheduler.queued_turns[0].request.prompt, json!(""));
            assert_eq!(
                scheduler.queued_turns[0].request.extra[RESUME_GOAL_ONLY_MARKER],
                true
            );
        }
        handler.persist_current_turn_state().await.unwrap();
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn failed_goal_readmission_preserves_its_previous_recovery_intent() {
    run_goal_test(async {
        let (mut handler, root, request) = setup("native-goal-readmission-write-failure");
        handler.store.update_task("task-1", |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        handler.journal_active_goal_turn("task-1", None);
        handler.persist_current_turn_state().await.unwrap();
        block_goal_admission(&handler);
        let blocked = root.join("blocked-queue-parent");
        fs::write(&blocked, "not a directory").unwrap();
        let previous_queue_path = handler.turn_queue_path.clone();
        handler.turn_queue_path = Arc::new(blocked.join("queue.json"));
        assert_eq!(
            handler.resume_active_goal("task-1").await.unwrap_err().code,
            "runtime_queue_failed"
        );
        assert!(handler
            .active_goal_turns
            .lock()
            .unwrap()
            .contains_key("task-1"));
        assert_eq!(
            handler
                .local_task_link("task-1")
                .unwrap()
                .goal_execution_status
                .as_deref(),
            Some("running")
        );
        assert!(handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .is_empty());
        assert!(turns::read_runtime_turn_state(&previous_queue_path)
            .unwrap()
            .active_goal_turns
            .contains_key("task-1"));
        let operation = handler.turn_queue_operation.lock().await;
        drop(operation);
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn goal_activation_acknowledges_only_durable_recovery_ownership() {
    run_goal_test(async {
        for (loaded, fail_persistence) in [(false, false), (true, false), (false, true)] {
            let (mut handler, root, request) = setup("native-goal-activation-ack");
            block_goal_admission(&handler);
            handler.store.update_task("task-1", |link| {
                link.thread_id = Some("11111111-1111-4111-8111-111111111111".into());
                link.goal_status = Some("paused".into());
                store_runtime_execution_request(&mut link.runtime_handle, &request);
            });
            install_native_history(&mut handler, &root, vec![], None);
            fs::write(
                root.join("thread_goal_set.json"),
                json!({
                    "goal":{"status":"active", "tokensUsed":10}
                })
                .to_string(),
            )
            .unwrap();
            if loaded {
                fs::write(
                    root.join("thread_resume.json"),
                    json!({"thread":{"id":"11111111-1111-4111-8111-111111111111"}}).to_string(),
                )
                .unwrap();
                handler
                    .codex_app_server
                    .request(
                        "thread/resume",
                        json!({"threadId":"11111111-1111-4111-8111-111111111111"}),
                    )
                    .await
                    .unwrap();
            }
            if fail_persistence {
                let blocked = root.join("blocked-queue-parent");
                fs::write(&blocked, "not a directory").unwrap();
                handler.turn_queue_path = Arc::new(blocked.join("queue.json"));
            }
            let result = handler
                .set_task_goal(json!({
                    "taskId":"task-1", "status":"active"
                }))
                .await;
            if fail_persistence {
                assert_eq!(result.unwrap_err().code, "runtime_queue_failed");
                assert!(handler
                    .active_goal_turns
                    .lock()
                    .unwrap()
                    .contains_key("task-1"));
            } else {
                let response = result.unwrap();
                assert_eq!(response["success"], true, "{response}");
                assert_eq!(
                    response["resumed"], false,
                    "Preparing a cold session must leave continuation owned by native Goal"
                );
                let repeated = handler
                    .set_task_goal(json!({
                        "taskId":"task-1", "status":"active"
                    }))
                    .await
                    .unwrap();
                assert_eq!(repeated["resumed"], false);
                assert_eq!(handler.turn_scheduler.lock().unwrap().queued_turns.len(), 0);
                assert_eq!(
                    handler
                        .local_task_link("task-1")
                        .unwrap()
                        .goal_execution_status
                        .as_deref(),
                    Some("running")
                );
                assert!(turns::read_runtime_turn_state(&handler.turn_queue_path)
                    .unwrap()
                    .active_goal_turns
                    .contains_key("task-1"));
            }
            handler.codex_app_server.restart().await;
            let operation = handler.turn_queue_operation.lock().await;
            drop(operation);
            let _ = fs::remove_dir_all(root);
        }
    });
}

#[test]
fn passive_goal_metadata_cannot_invent_an_execution_profile() {
    run_goal_test(async {
        let (handler, root, _) = setup("native-unowned-goal-profile");
        handler.route_codex_notification(notification("turn/started", "turn-1"));
        handler.route_codex_notification(json!({"method":"thread/goal/updated", "params": {
            "threadId":"thread-1", "goal":{"status":"active", "tokensUsed":10}
        }}));
        handler.persist_current_turn_state().await.unwrap();
        assert!(turns::read_runtime_turn_state(&handler.turn_queue_path)
            .unwrap()
            .active_goal_turns
            .is_empty());
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn reactivated_native_goal_recovers_without_a_live_local_execution() {
    run_goal_test(async {
        let (handler, root, mut request) = setup("native-reactivated-goal-recovery");
        request.model_config = json!({"model":"retained-model"});
        request
            .extra
            .insert("runtime_command_id".into(), json!("finished-user-command"));
        handler.store.update_task("task-1", |link| {
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        handler.route_codex_notification(notification("turn/started", "old-turn"));
        handler.route_codex_notification(notification("turn/completed", "old-turn"));
        handler.route_codex_notification(json!({"method":"thread/goal/updated", "params": {
            "threadId":"thread-1", "goal":{"status":"paused", "tokensUsed":10}
        }}));
        assert!(!handler.is_active_local_task("task-1"));
        assert!(handler.active_goal_turns.lock().unwrap().is_empty());

        handler.route_codex_notification(json!({"method":"thread/goal/updated", "params": {
            "threadId":"thread-1", "goal":{"status":"active", "tokensUsed":10}
        }}));
        handler.persist_current_turn_state().await.unwrap();
        let restored = turns::read_runtime_turn_state(&handler.turn_queue_path).unwrap();
        let turn = restored.active_goal_turns.get("task-1").expect(
        "Reactivating a native Goal must restore durable recovery ownership without a user send",
    );
        assert_eq!(turn.resume_thread_id.as_deref(), Some("thread-1"));
        assert_eq!(turn.request.model_config["model"], "retained-model");
        assert_eq!(turn.request.prompt, json!(""));
        assert_eq!(turn.request.extra[RESUME_GOAL_ONLY_MARKER], true);
        assert!(!turn.request.extra.contains_key("runtime_command_id"));
        assert!(restored.queued_turns.is_empty());
        assert!(!handler.is_active_local_task("task-1"));
        handler.sync_runtime_task_goal_status("task-1", Some("paused".into()), None);
        handler.persist_current_turn_state().await.unwrap();
        assert!(turns::read_runtime_turn_state(&handler.turn_queue_path)
            .unwrap()
            .active_goal_turns
            .is_empty());
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn goal_activation_binds_and_retains_the_route_until_the_goal_stops() {
    run_goal_test(async {
        for status in [Some("paused"), Some("blocked"), Some("complete"), None] {
            let (mut handler, root, mut request) = setup("goal-model-route-lifetime");
            request.model_config = json!({
                "model_id": "goal-route-model",
                "base_url": "http://synthetic.invalid/v1",
                "api_key": "synthetic-key"
            });
            handler.store.update_task("task-1", |link| {
                store_runtime_execution_request(&mut link.runtime_handle, &request);
                link.goal_status = Some("blocked".into());
            });
            handler.retain_runtime_model_config("task-1", &request.model_config);
            install_native_history(&mut handler, &root, vec![], None);
            let link = handler.local_task_link("task-1").unwrap();
            handler
                .prepare_goal_model_route(&link, "thread-1", &json!({"status":"active"}))
                .await
                .unwrap();
            assert!(local_model_proxy::thread_has_bound_route("thread-1"));
            assert!(
                handler.thread_event_routing.lock().unwrap().routes["thread-1"]
                    .goal_model_route
                    .is_some()
            );
            // Passive history refreshes must not drop the Goal's inference lease.
            handler.register_thread_event_route_from_store("thread-1");
            handler.sync_runtime_task_goal_status("task-1", Some("active".into()), None);
            assert!(
                handler.thread_event_routing.lock().unwrap().routes["thread-1"]
                    .goal_model_route
                    .is_some()
            );
            handler.sync_runtime_task_goal_status("task-1", status.map(str::to_owned), None);
            assert!(
                handler.thread_event_routing.lock().unwrap().routes["thread-1"]
                    .goal_model_route
                    .is_none()
            );
            handler.codex_app_server.restart().await;
            let _ = fs::remove_dir_all(root);
        }
    });
}

#[test]
fn timed_out_goal_resume_or_activation_retains_its_route_until_native_state_confirms_stop() {
    run_goal_test(async {
        let _timeout = ScalarEnv::set("WEGENT_CODEX_RPC_TIMEOUT_SECONDS", "1");
        for (method, compact) in [
            ("thread_resume", false),
            ("thread_goal_set", false),
            ("thread_resume", true),
        ] {
            let (mut handler, root, mut request) = setup("goal-model-route-ambiguous-activation");
            let thread = "11111111-1111-4111-8111-111111111111";
            request.model_config = json!({"model_id":"goal-route-model",
            "base_url":"http://synthetic.invalid/v1","api_key":"synthetic-key"});
            handler.store.update_task("task-1", |link| {
                link.thread_id = Some(thread.into());
                link.goal_status = Some("blocked".into());
                store_runtime_execution_request(&mut link.runtime_handle, &request);
            });
            handler.retain_runtime_model_config("task-1", &request.model_config);
            block_goal_admission(&handler);
            install_native_history(&mut handler, &root, vec![], None);
            let pending = if compact { "defer" } else { "hold" };
            fs::write(root.join(format!("{method}.{pending}")), "").unwrap();
            fs::write(
                root.join("thread_goal_set.json"),
                json!({"goal":{"status":"active"}}).to_string(),
            )
            .unwrap();
            fs::write(
                root.join("thread_goal_get.json"),
                json!({"goal":{"status":"blocked"}}).to_string(),
            )
            .unwrap();
            let notification_method = if compact { "test_fence" } else { method };
            fs::write(root.join(format!("{notification_method}.notifications.jsonl")), json!({
            "method":"thread/goal/updated", "params":{"threadId":thread,"goal":{"status":"active"}}
        }).to_string() + "\n").unwrap();
            let result = if compact {
                handler
                    .compact_task(json!({"taskId":"task-1","modelConfig":request.model_config}))
                    .await
            } else {
                handler
                    .set_task_goal(json!({"taskId":"task-1","status":"active"}))
                    .await
            }
            .unwrap();
            assert_eq!(result["accepted"], false);
            assert!(
                result["error"].as_str().unwrap().contains("timed out"),
                "{result}"
            );
            assert!(handler.thread_event_routing.lock().unwrap().routes[thread]
                .goal_model_route
                .is_some());
            fs::remove_file(root.join(format!("{method}.{pending}"))).unwrap();
            if compact {
                fs::write(root.join("test_fence.json"), "{}").unwrap();
                handler
                    .call_codex_thread_method("test/fence", json!({"threadId":thread}))
                    .await
                    .unwrap();
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                while handler
                    .local_task_link("task-1")
                    .unwrap()
                    .goal_status
                    .as_deref()
                    != Some("active")
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert!(handler.thread_event_routing.lock().unwrap().routes[thread]
                .goal_model_route
                .is_some());
            fs::write(
                root.join("thread_goal_get.json"),
                json!({"goal":{"status":"complete"}}).to_string(),
            )
            .unwrap();
            let confirmed = handler
                .get_task_goal(json!({"taskId":"task-1"}))
                .await
                .unwrap();
            assert_eq!(confirmed["goal"]["status"], "complete");
            assert!(handler.thread_event_routing.lock().unwrap().routes[thread]
                .goal_model_route
                .is_none());
            handler.persist_current_turn_state().await.unwrap();
            handler.codex_app_server.restart().await;
            let _ = fs::remove_dir_all(root);
        }
    });
}

#[test]
fn goal_reads_cannot_release_a_newer_activation_or_deadlock_conditional_mutations() {
    run_goal_test(async {
        let (mut handler, root, mut request) = setup("goal-read-activation-order");
        let thread = "22222222-2222-4222-8222-222222222222";
        request.model_config = json!({"model_id":"goal-route-model",
            "base_url":"http://synthetic.invalid/v1","api_key":"synthetic-key"});
        handler.store.update_task("task-1", |link| {
            link.thread_id = Some(thread.into());
            link.goal_status = Some("blocked".into());
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        handler.retain_runtime_model_config("task-1", &request.model_config);
        block_goal_admission(&handler);
        install_native_history(&mut handler, &root, vec![], None);
        fs::write(root.join("thread_goal_get.defer"), "").unwrap();
        fs::write(
            root.join("thread_goal_set.json"),
            json!({"goal":{"status":"active"}}).to_string(),
        )
        .unwrap();
        let reader = handler.clone();
        let reading =
            tokio::spawn(async move { reader.get_task_goal(json!({"taskId":"task-1"})).await });
        let deferred = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(request) = fs::read_to_string(root.join("requests.jsonl"))
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .find(|request| request["method"] == "thread/goal/get")
                {
                    break request;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let writer = handler.clone();
        let activating = tokio::spawn(async move {
            writer
                .set_task_goal(json!({"taskId":"task-1","status":"active"}))
                .await
        });
        let activated = tokio::time::timeout(Duration::from_secs(5), activating)
            .await
            .expect("A pending read must not block Goal activation")
            .unwrap()
            .unwrap();
        assert_eq!(activated["goal"]["status"], "active");
        fs::write(root.join("test_fence.json"), "{}").unwrap();
        fs::write(
            root.join("test_fence.notifications.jsonl"),
            json!({
                "id":deferred["id"],"result":{"goal":{"status":"blocked"}}
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        handler
            .call_codex_thread_method("test/fence", json!({"threadId":thread}))
            .await
            .unwrap();
        assert_eq!(reading.await.unwrap().unwrap()["goal"]["status"], "blocked");
        assert_eq!(
            handler
                .local_task_link("task-1")
                .unwrap()
                .goal_status
                .as_deref(),
            Some("active")
        );
        assert!(handler.thread_event_routing.lock().unwrap().routes[thread]
            .goal_model_route
            .is_some());
        fs::remove_file(root.join("thread_goal_get.defer")).unwrap();
        fs::write(
            root.join("thread_goal_get.json"),
            json!({"goal":{"status":"active"}}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("thread_goal_set.json"),
            json!({"goal":{"status":"paused"}}).to_string(),
        )
        .unwrap();
        let paused = tokio::time::timeout(
            Duration::from_secs(5),
            handler.set_task_goal(json!({
                "taskId":"task-1","status":"paused","eventGoalExpected":{"status":"active"}
            })),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(paused["accepted"], true);
        assert_eq!(paused["goal"]["status"], "paused");
        handler.codex_app_server.restart().await;
        let _ = fs::remove_dir_all(root);
    });
}

#[test]
fn inactive_notification_during_activation_cannot_release_the_prepared_route() {
    run_goal_test(async {
        let (mut handler, root, mut request) = setup("goal-notification-activation-order");
        let thread = "22222222-2222-4222-8222-222222222222";
        request.model_config = json!({"model_id":"goal-route-model",
            "base_url":"http://synthetic.invalid/v1","api_key":"synthetic-key"});
        handler.store.update_task("task-1", |link| {
            link.thread_id = Some(thread.into());
            link.goal_status = Some("blocked".into());
            store_runtime_execution_request(&mut link.runtime_handle, &request);
        });
        handler.retain_runtime_model_config("task-1", &request.model_config);
        block_goal_admission(&handler);
        install_native_history(&mut handler, &root, vec![], None);
        fs::write(root.join("thread_goal_set.defer"), "").unwrap();
        let writer = handler.clone();
        let activating = tokio::spawn(async move {
            writer
                .set_task_goal(json!({"taskId":"task-1","status":"active"}))
                .await
        });
        let deferred = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(request) = fs::read_to_string(root.join("requests.jsonl"))
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .find(|request| request["method"] == "thread/goal/set")
                {
                    break request;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(handler.thread_event_routing.lock().unwrap().routes[thread]
            .goal_model_route
            .is_some());
        fs::write(root.join("test_fence.json"), "{}").unwrap();
        fs::write(root.join("test_fence.notifications.jsonl"), json!({
            "method":"thread/goal/updated", "params":{"threadId":thread,"goal":{"status":"paused"}}
        }).to_string() + "\n").unwrap();
        handler
            .call_codex_thread_method("test/fence", json!({"threadId":thread}))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while handler
                .local_task_link("task-1")
                .unwrap()
                .goal_status
                .as_deref()
                != Some("paused")
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            handler.thread_event_routing.lock().unwrap().routes[thread]
                .goal_model_route
                .is_some(),
            "An inactive notification cannot release a pending activation's registration"
        );
        fs::write(
            root.join("test_fence.notifications.jsonl"),
            json!({
                "id":deferred["id"],"result":{"goal":{"status":"active"}}
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        handler
            .call_codex_thread_method("test/fence", json!({"threadId":thread}))
            .await
            .unwrap();
        assert_eq!(
            activating.await.unwrap().unwrap()["goal"]["status"],
            "active"
        );
        assert!(handler.thread_event_routing.lock().unwrap().routes[thread]
            .goal_model_route
            .is_some());
        fs::write(
            root.join("thread_goal_get.json"),
            json!({"goal":{"status":"paused"}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            handler
                .get_task_goal(json!({"taskId":"task-1"}))
                .await
                .unwrap()["goal"]["status"],
            "paused"
        );
        assert!(handler.thread_event_routing.lock().unwrap().routes[thread]
            .goal_model_route
            .is_none());
        handler.codex_app_server.restart().await;
        let _ = fs::remove_dir_all(root);
    });
}
