// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::lifecycle::{native_execution_state, NativeExecutionPhase};

#[tokio::test]
async fn control_metadata_preserves_native_authority_while_history_workers_are_saturated() {
    for (label, runtime, turn_status, owned, idle, interrupt_id, terminal) in [
        (
            "open",
            "active",
            "interrupted",
            None,
            false,
            Some("current"),
            None,
        ),
        (
            "goal-continuation",
            "active",
            "completed",
            None,
            false,
            None,
            None,
        ),
        (
            "lingering-local",
            "idle",
            "completed",
            Some("current"),
            true,
            None,
            Some("done"),
        ),
        (
            "dedicated-process",
            "notLoaded",
            "interrupted",
            Some("current"),
            false,
            Some("current"),
            None,
        ),
        (
            "newer-local-turn",
            "idle",
            "completed",
            Some("newer"),
            false,
            None,
            None,
        ),
        (
            "stale-running-metadata",
            "idle",
            "inProgress",
            None,
            true,
            None,
            None,
        ),
        (
            "unloaded-unknown",
            "notLoaded",
            "interrupted",
            None,
            false,
            None,
            None,
        ),
        (
            "idle-synthesized-interruption",
            "idle",
            "interrupted",
            Some("current"),
            true,
            None,
            None,
        ),
    ] {
        let (mut handler, root) = isolated_runtime_work_handler(&format!("control-{label}"));
        let mut link =
            RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
        link.thread_id = Some("thread-1".into());
        handler.upsert_local_task(link);
        install_native_history(&mut handler, &root, Vec::new(), None);
        fs::write(
            root.join("thread_turns_list.json"),
            json!({"data":[{
                "id":"current","status":turn_status,"items":[],"itemsView":"notLoaded",
                "completedAt":(turn_status == "completed").then_some(123)
            }],"nextCursor":null})
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("thread_read.json"),
            json!({"thread":{"id":"thread-1","status":{"type":runtime,"activeFlags":[]}}})
                .to_string(),
        )
        .unwrap();
        if let Some(turn) = owned {
            let execution = start_test_execution(&handler, "task-1");
            handler.record_active_codex_turn("task-1", execution, "thread-1".into(), turn.into());
            handler.store.update_task("task-1", |link| {
                let mut state = native_execution_state(link).unwrap();
                state.phase = NativeExecutionPhase::Running;
                state.turn_id = Some(turn.into());
                state.latest_turn_id = Some(turn.into());
                crate::runtime_work::lifecycle::project_native_execution(link, &state);
            });
        }
        let workers = handler.transcript_test_workers.as_ref().unwrap().clone();
        let slots = (
            workers.clone().try_acquire_owned().unwrap(),
            workers.clone().try_acquire_owned().unwrap(),
        );
        let snapshot = crate::runtime_work::transcript_work::with_test_workers(
            workers,
            handler.read_codex_recent_turns("thread-1"),
        )
        .await
        .unwrap();
        assert_eq!(
            snapshot.latest_turn_id.as_deref(),
            Some("current"),
            "{label}"
        );
        assert_eq!(snapshot.is_idle(), idle, "{label}");
        assert_eq!(snapshot.active_turn_id.as_deref(), interrupt_id, "{label}");
        assert_eq!(snapshot.terminal_task_status(), terminal, "{label}");
        handler
            .codex_app_server
            .request("test/stop", json!({}))
            .await
            .unwrap();
        let calls = fs::read_to_string(root.join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let metadata_calls = calls
            .iter()
            .filter(|call| call["method"] == "thread/turns/list")
            .collect::<Vec<_>>();
        assert_eq!(metadata_calls.len(), 1, "{label}");
        assert_eq!(metadata_calls[0]["params"]["itemsView"], "notLoaded");
        assert_eq!(metadata_calls[0]["params"]["limit"], 1);
        assert!(calls.iter().all(|call| !matches!(
            call["method"].as_str(),
            Some("thread/timeline/list" | "thread/items/list")
        )));
        assert!(calls
            .iter()
            .filter(|call| call["method"] == "thread/read")
            .all(|call| call["params"]["includeTurns"] == false));
        drop(slots);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn control_metadata_keeps_native_transitions_and_active_goal_continuation_owned() {
    for (index, phase, goal_active, retain_local) in [
        (0, NativeExecutionPhase::Queued, false, true),
        (1, NativeExecutionPhase::Starting, false, true),
        (2, NativeExecutionPhase::Continuing, true, true),
        (3, NativeExecutionPhase::Recovering, false, true),
        (4, NativeExecutionPhase::Running, true, true),
        (5, NativeExecutionPhase::Continuing, true, false),
    ] {
        let (mut handler, root) =
            isolated_runtime_work_handler(&format!("control-transition-{index}"));
        let mut link =
            RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
        link.thread_id = Some("thread-1".into());
        handler.upsert_local_task(link);
        install_native_history(&mut handler, &root, Vec::new(), None);
        fs::write(
            root.join("thread_turns_list.json"),
            json!({"data":[{
                "id":"finished","status":"completed","items":[],"completedAt":123
            }]})
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("thread_read.json"),
            json!({"thread":{
                "id":"thread-1","status":{"type":"idle"}
            }})
            .to_string(),
        )
        .unwrap();
        let execution = start_test_execution(&handler, "task-1");
        handler.record_active_codex_turn("task-1", execution, "thread-1".into(), "finished".into());
        handler.store.update_task("task-1", |link| {
            link.goal_status = goal_active.then(|| "active".into());
            let mut state = native_execution_state(link).unwrap();
            state.phase = phase;
            state.turn_id = (phase == NativeExecutionPhase::Running).then(|| "finished".into());
            state.latest_turn_id = Some("finished".into());
            crate::runtime_work::lifecycle::project_native_execution(link, &state);
        });
        if !retain_local {
            assert!(handler.finish_local_task_execution("task-1", execution));
        }

        let snapshot = handler.read_codex_recent_turns("thread-1").await.unwrap();

        assert!(!snapshot.is_idle(), "{phase:?}");
        assert_eq!(snapshot.terminal_task_status(), None, "{phase:?}");
        assert_eq!(snapshot.active_turn_id, None, "{phase:?}");
        handler
            .codex_app_server
            .request("test/stop", json!({}))
            .await
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
