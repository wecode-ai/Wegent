// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn turn(method: &str, thread: &str, id: &str, status: &str) -> Value {
    json!({"method":method,"params":{"threadId":thread,"turn":{"id":id,"status":status}}})
}

fn goal(status: &str) -> Value {
    json!({"method":"thread/goal/updated","params":{"threadId":"thread","goal":{"status":status}}})
}

fn request(activity: &CodexNativeActivity, method: &str) -> CodexNativeRequest {
    static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let request_id = NEXT_REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    activity
        .request_context(request_id, method, &json!({"threadId":"thread"}))
        .unwrap()
}

fn loaded_activity() -> CodexNativeActivity {
    let mut activity = CodexNativeActivity::default();
    for thread in ["thread", "other"] {
        activity.observe(&json!({"method":"thread/started","params":{"thread":{"id":thread}}}));
    }
    activity
}

fn clear_goal() -> Value {
    json!({"method":"thread/goal/cleared","params":{"threadId":"thread"}})
}

#[test]
fn activating_an_unloaded_goal_does_not_block_its_own_resume() {
    let mut activity = CodexNativeActivity::default();
    let set = request(&activity, "thread/goal/set");
    activity.observe_response(&set, &json!({"goal":{"status":"active"}}));
    activity.observe(&goal("active"));
    assert!(
        activity.active_threads().is_empty(),
        "Persisting an unloaded Goal must leave admission available to load it"
    );
}

#[test]
fn loaded_goal_mutations_remain_protected_until_native_unload() {
    for method in ["thread/start", "thread/resume", "thread/fork"] {
        for unload in [
            json!({"method":"thread/closed","params":{"threadId":"thread"}}),
            json!({"method":"thread/status/changed","params":{"threadId":"thread","status":{"type":"notLoaded"}}}),
        ] {
            let mut activity = CodexNativeActivity::default();
            let load = activity.request_context(1, method, &json!({})).unwrap();
            activity.observe_response(&load, &json!({"thread":{"id":"thread"}}));
            let set = request(&activity, "thread/goal/set");
            activity.observe_response(&set, &json!({"goal":{"status":"active"}}));
            assert_eq!(activity.active_threads().get("thread"), Some(&1));
            assert!(activity.observe(&unload));
            let cold_set = request(&activity, "thread/goal/set");
            activity.observe_response(&cold_set, &json!({"goal":{"status":"active"}}));
            activity.observe(&goal("active"));
            assert!(activity.active_threads().is_empty(), "{method}: {unload}");
        }
    }
}

#[test]
fn native_turn_settlement_is_idempotent_and_cannot_clear_another_turn() {
    let mut activity = loaded_activity();
    for (thread, id) in [("thread", "one"), ("thread", "two"), ("other", "one")] {
        assert!(activity.observe(&turn("turn/started", thread, id, "inProgress")));
        assert!(!activity.observe(&turn("turn/started", thread, id, "inProgress")));
    }
    assert!(activity.observe(&turn("turn/completed", "thread", "one", "completed")));
    assert!(!activity.observe(&turn("turn/completed", "thread", "one", "failed")));
    assert!(!activity.observe(&turn("turn/started", "thread", "one", "inProgress")));
    assert_eq!(
        activity.active_threads(),
        HashMap::from([("thread".into(), 1), ("other".into(), 1)])
    );
    activity.observe(&turn("turn/completed", "thread", "two", "completed"));
    assert_eq!(
        activity.active_threads(),
        HashMap::from([("other".into(), 1)])
    );
}

#[test]
fn an_active_goal_keeps_successful_continuations_busy_but_not_failed_turns() {
    for status in ["failed", "interrupted", "cancelled"] {
        for started in [false, true] {
            let mut activity = loaded_activity();
            activity.observe(&goal("active"));
            if started {
                activity.observe(&turn("turn/started", "thread", "one", "inProgress"));
            }
            assert!(activity.observe(&turn("turn/completed", "thread", "one", status)));
            assert!(
                activity.active_threads().is_empty(),
                "{status}, started={started}"
            );
        }
    }
    let mut activity = loaded_activity();
    activity.observe(&goal("active"));
    activity.observe(&turn("turn/started", "thread", "one", "inProgress"));
    activity.observe(&turn("turn/completed", "thread", "one", "completed"));
    assert_eq!(activity.active_threads().get("thread"), Some(&1));
    activity.observe(&turn("turn/started", "thread", "two", "inProgress"));
    activity.observe(&goal("blocked"));
    assert_eq!(activity.active_threads().get("thread"), Some(&1));
    activity.observe(&turn("turn/completed", "thread", "two", "completed"));
    assert!(activity.active_threads().is_empty());
}

#[test]
fn native_responses_bridge_startup_and_goal_clear_keeps_a_running_turn() {
    let mut activity = loaded_activity();
    let goal = request(&activity, "thread/goal/set");
    assert!(activity.observe_response(&goal, &json!({"goal":{"status":"active"}})));
    assert_eq!(activity.active_threads().get("thread"), Some(&1));
    let start = request(&activity, "turn/start");
    assert!(activity.observe_response(&start, &json!({"turn":{"id":"one"}})));
    let clear = request(&activity, "thread/goal/clear");
    assert!(activity.observe_response(&clear, &json!({})));
    assert_eq!(activity.active_threads().get("thread"), Some(&1));
    activity.observe(&turn("turn/completed", "thread", "one", "completed"));
    assert!(activity.active_threads().is_empty());
    assert!(!activity.observe_response(&start, &json!({"turn":{"id":"one"}})));
    let goal = request(&activity, "thread/goal/set");
    assert!(activity.observe_response(&goal, &json!({"goal":{"status":"active"}})));
    let get = request(&activity, "thread/goal/get");
    assert!(activity.observe_response(&get, &json!({"goal":null})));
    assert!(activity.active_threads().is_empty());
}

#[test]
fn reading_a_persisted_active_goal_does_not_start_native_work() {
    let mut activity = loaded_activity();
    let get = request(&activity, "thread/goal/get");
    assert!(!activity.observe_response(&get, &json!({"goal":{"status":"active"}})));
    assert!(activity.active_threads().is_empty());

    for response_order in 0..3 {
        let mut activity = loaded_activity();
        let get = request(&activity, "thread/goal/get");
        let active = json!({"goal":{"status":"active"}});
        if response_order == 0 {
            activity.observe_response(&get, &active);
        }
        activity.observe(&turn("turn/started", "thread", "one", "inProgress"));
        if response_order == 1 {
            activity.observe_response(&get, &active);
        }
        activity.observe(&turn("turn/completed", "thread", "one", "completed"));
        if response_order == 2 {
            assert!(activity.active_threads().is_empty());
            activity.observe_response(&get, &active);
        }
        assert_eq!(
            activity.active_threads().get("thread"),
            Some(&1),
            "response_order={response_order}"
        );
    }
}

#[test]
fn a_goal_terminal_discards_prior_native_work_and_goal_metadata() {
    for terminal in [
        clear_goal(),
        goal("blocked"),
        goal("complete"),
        turn("turn/completed", "thread", "failed", "failed"),
    ] {
        let mut activity = loaded_activity();
        let get = request(&activity, "thread/goal/get");
        let active = json!({"goal":{"status":"active"}});
        activity.observe_response(&get, &active);
        activity.observe(&turn("turn/started", "thread", "one", "inProgress"));
        activity.observe(&turn("turn/completed", "thread", "one", "completed"));
        assert_eq!(activity.active_threads().get("thread"), Some(&1));
        let old_get = request(&activity, "thread/goal/get");
        let old_set = request(&activity, "thread/goal/set");
        assert!(activity.observe(&terminal));
        assert!(!activity.observe_response(&old_get, &active));
        assert!(!activity.observe_response(&old_set, &active));
        assert!(!activity.observe(&turn("turn/started", "thread", "one", "inProgress")));
        activity.observe(&turn("turn/started", "thread", "two", "inProgress"));
        activity.observe(&turn("turn/completed", "thread", "two", "completed"));
        assert!(activity.active_threads().is_empty(), "{terminal}");
    }

    let mut activity = loaded_activity();
    activity.observe(&turn("turn/started", "thread", "one", "inProgress"));
    activity.observe(&turn("turn/completed", "thread", "one", "completed"));
    activity.observe(&clear_goal());
    let get = request(&activity, "thread/goal/get");
    activity.observe_response(&get, &json!({"goal":{"status":"active"}}));
    assert!(activity.active_threads().is_empty());
}

#[test]
fn a_newer_passive_goal_read_preserves_the_pending_set_response_bridge() {
    for get_response_first in [false, true] {
        for status in [Some("active"), Some("complete"), None] {
            let mut activity = loaded_activity();
            let set = request(&activity, "thread/goal/set");
            let get = request(&activity, "thread/goal/get");
            let set_response = json!({"goal":{"status":"active"}});
            let get_response = match status {
                Some(status) => json!({"goal":{"status":status}}),
                None => json!({"goal":null}),
            };
            if get_response_first {
                activity.observe_response(&get, &get_response);
                assert!(activity.active_threads().is_empty());
                activity.observe_response(&set, &set_response);
            } else {
                activity.observe_response(&set, &set_response);
                activity.observe_response(&get, &get_response);
            }
            assert_eq!(
                activity.active_threads().contains_key("thread"),
                status == Some("active"),
                "status={status:?}, get_response_first={get_response_first}"
            );
        }
    }
}

#[test]
fn native_goal_changes_reject_older_goal_responses() {
    for notification in [
        goal("blocked"),
        goal("failed"),
        goal("complete"),
        clear_goal(),
    ] {
        for method in ["thread/goal/get", "thread/goal/set"] {
            let mut activity = loaded_activity();
            activity.observe(&goal("active"));
            let pending = request(&activity, method);
            assert!(activity.observe(&notification));
            assert!(!activity.observe_response(&pending, &json!({"goal":{"status":"active"}})));
            assert!(
                activity.active_threads().is_empty(),
                "{method}: {notification}"
            );
        }
    }
    for method in ["thread/goal/get", "thread/goal/set", "thread/goal/clear"] {
        let mut activity = loaded_activity();
        let pending = request(&activity, method);
        activity.observe(&goal("active"));
        assert!(!activity.observe_response(&pending, &json!({"goal":null})));
        assert_eq!(
            activity.active_threads().get("thread"),
            Some(&1),
            "{method}"
        );
    }
}

#[test]
fn a_failed_terminal_invalidates_old_goal_responses_but_duplicates_preserve_new_goals() {
    let mut activity = loaded_activity();
    activity.observe(&goal("active"));
    let old_get = request(&activity, "thread/goal/get");
    let failed = turn("turn/completed", "thread", "one", "failed");
    assert!(activity.observe(&failed));
    assert!(!activity.observe_response(&old_get, &json!({"goal":{"status":"active"}})));
    assert!(activity.active_threads().is_empty());

    activity.observe(&goal("active"));
    let current_get = request(&activity, "thread/goal/get");
    assert!(!activity.observe(&failed));
    assert!(!activity.observe(&turn("turn/started", "thread", "one", "inProgress")));
    assert_eq!(activity.active_threads().get("thread"), Some(&1));
    assert!(activity.observe_response(&current_get, &json!({"goal":{"status":"complete"}})));
    assert!(activity.active_threads().is_empty());
}

#[test]
fn a_terminal_for_another_turn_cannot_remove_a_live_turn_or_its_goal() {
    let mut activity = loaded_activity();
    activity.observe(&goal("active"));
    activity.observe(&turn("turn/started", "thread", "current", "inProgress"));
    activity.observe(&turn("turn/completed", "thread", "old", "failed"));
    assert_eq!(activity.active_threads().get("thread"), Some(&1));
    activity.observe(&turn("turn/completed", "thread", "current", "completed"));
    assert_eq!(activity.active_threads().get("thread"), Some(&1));
    activity.observe(&clear_goal());
    assert!(activity.active_threads().is_empty());
}

#[test]
fn goal_response_versions_are_scoped_to_their_own_thread() {
    let mut activity = loaded_activity();
    let pending = request(&activity, "thread/goal/set");
    let other = json!({"method":"thread/goal/updated","params":{"threadId":"other","goal":{"status":"active"}}});
    activity.observe(&other);
    assert!(activity.observe_response(&pending, &json!({"goal":{"status":"active"}})));
    assert_eq!(
        activity.active_threads(),
        HashMap::from([("thread".into(), 1), ("other".into(), 1)])
    );
}

#[test]
fn an_older_goal_read_cannot_clear_a_new_goal_set_response() {
    for set_response_first in [false, true] {
        let mut activity = loaded_activity();
        let old_get = request(&activity, "thread/goal/get");
        let new_set = request(&activity, "thread/goal/set");
        if set_response_first {
            assert!(activity.observe_response(&new_set, &json!({"goal":{"status":"active"}})));
            assert!(!activity.observe_response(&old_get, &json!({"goal":null})));
        } else {
            assert!(!activity.observe_response(&old_get, &json!({"goal":null})));
            assert!(activity.observe_response(&new_set, &json!({"goal":{"status":"active"}})));
        }
        assert_eq!(activity.active_threads().get("thread"), Some(&1));
        let current_get = request(&activity, "thread/goal/get");
        assert!(activity.observe_response(&current_get, &json!({"goal":null})));
        assert!(activity.active_threads().is_empty());
    }
}

#[test]
fn goal_mutation_responses_follow_request_order_in_either_response_order() {
    for (first_method, second_method, remains_active) in [
        ("thread/goal/set", "thread/goal/clear", false),
        ("thread/goal/clear", "thread/goal/set", true),
    ] {
        for second_response_first in [false, true] {
            let mut activity = loaded_activity();
            let first = request(&activity, first_method);
            let second = request(&activity, second_method);
            let response = |method| {
                if method == "thread/goal/set" {
                    json!({"goal":{"status":"active"}})
                } else {
                    json!({})
                }
            };
            if second_response_first {
                activity.observe_response(&second, &response(second_method));
                activity.observe_response(&first, &response(first_method));
            } else {
                activity.observe_response(&first, &response(first_method));
                activity.observe_response(&second, &response(second_method));
            }
            assert_eq!(
                activity.active_threads().contains_key("thread"),
                remains_active,
                "{first_method}, second_response_first={second_response_first}"
            );
            let current_get = request(&activity, "thread/goal/get");
            activity.observe_response(&current_get, &json!({"goal":null}));
            assert!(activity.active_threads().is_empty());
        }
    }
}

#[tokio::test]
async fn process_generations_keep_independent_native_activity() {
    let old = CodexNotificationHub::new();
    let current = CodexNotificationHub::new();
    old.send(turn("turn/started", "thread", "old", "inProgress"))
        .await;
    current
        .send(turn("turn/started", "thread", "current", "inProgress"))
        .await;
    assert_ne!(old.process_generation, current.process_generation);
    notify_shared_process_closed(&old, "old process exited").await;
    assert!(old
        .native_activity
        .lock()
        .unwrap()
        .active_threads()
        .is_empty());
    assert_eq!(
        current
            .native_activity
            .lock()
            .unwrap()
            .active_threads()
            .get("thread"),
        Some(&1)
    );
}

#[tokio::test]
async fn native_activity_updates_before_runtime_delivery_and_notifies_admission() {
    let hub = CodexNotificationHub::new();
    let mut receiver = hub.subscribe_runtime();
    for _ in 0..CODEX_GLOBAL_NOTIFICATION_CAPACITY {
        hub.send_runtime(json!({"method":"test/fill"}).into()).await;
    }
    let mut send = Box::pin(hub.send(turn("turn/started", "thread", "one", "inProgress")));
    assert!(futures_util::poll!(&mut send).is_pending());
    assert_eq!(
        hub.native_activity
            .lock()
            .unwrap()
            .active_threads()
            .get("thread"),
        Some(&1)
    );
    receiver.recv().await.unwrap();
    send.await;
    drop(receiver);
    let notified = hub.thread_activity_changed.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    hub.send(turn("turn/completed", "thread", "one", "completed"))
        .await;
    assert!(futures_util::poll!(&mut notified).is_ready());
    assert!(hub
        .native_activity
        .lock()
        .unwrap()
        .active_threads()
        .is_empty());
}
