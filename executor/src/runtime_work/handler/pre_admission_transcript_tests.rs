// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn setup_recovery_history(label: &str) -> (RuntimeWorkRpcHandler, PathBuf) {
    let (handler, root) = isolated_runtime_work_handler(label);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    link.runtime_handle["lastTurnId"] = json!("old");
    handler.upsert_local_task(link);
    (handler, root)
}

fn recovery_history() -> Value {
    json!({"id":"thread-1","timeline":true,"turns":[
        {"id":"old","position":10,"status":"interrupted","ownsUserPresentation":true,
         "itemsPositioned":true,"items":[{"id":"old-answer","type":"agentMessage","text":"Before crash","position":11}]},
        {"id":"recovered","position":20,"status":"interrupted","ownsUserPresentation":true,
         "itemsPositioned":true,"items":[]}
    ]})
}

#[test]
fn recovery_history_observes_the_new_native_turn_before_its_callback() {
    for has_output in [false, true] {
        let (handler, root) = setup_recovery_history("pre-admission-recovery-history");
        start_test_execution(&handler, "task-1");
        let before = handler.local_task_link("task-1").unwrap().execution_state;
        let mut thread = recovery_history();
        if has_output {
            thread["turns"][1]["items"] = json!([
                {"id":"new-answer","type":"agentMessage","text":"Recovered output","position":21}
            ]);
        }

        handler.merge_active_codex_transcript("task-1", &mut thread);

        assert_eq!(thread["turns"][0]["status"], "interrupted");
        assert_eq!(thread["turns"][1]["status"], "inProgress");
        let projection =
            crate::runtime_work::transcript::project_transcript(&thread, "test-device", false);
        assert_eq!(projection.turns[0]["status"], "cancelled");
        assert_eq!(projection.turns[1]["status"], "streaming");
        assert_eq!(
            handler.local_task_link("task-1").unwrap().execution_state,
            before
        );
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn inactive_or_unproven_history_never_reopens_an_interrupted_turn() {
    for case in [
        "stopped",
        "stop-requested",
        "completed",
        "other-thread",
        "missing-previous",
        "same-turn",
        "missing-opening",
        "older-position",
    ] {
        let (handler, root) = setup_recovery_history(&format!("pre-admission-history-{case}"));
        if case != "stopped" {
            start_test_execution(&handler, "task-1");
        }
        let mut thread = recovery_history();
        match case {
            "stop-requested" => assert!(handler.request_active_turn_stop("task-1")),
            "completed" => thread["turns"][1]["timelineCompleted"] = json!(true),
            "other-thread" => thread["id"] = json!("other-thread"),
            "missing-previous" => thread["turns"][0]["id"] = json!("unknown"),
            "same-turn" => {
                thread["turns"].as_array_mut().unwrap().pop();
            }
            "missing-opening" => thread["turns"][1]["ownsUserPresentation"] = json!(false),
            "older-position" => thread["turns"][1]["position"] = json!(5),
            _ => {}
        }

        handler.merge_active_codex_transcript("task-1", &mut thread);

        assert!(
            thread["turns"]
                .as_array()
                .unwrap()
                .iter()
                .all(|turn| turn["status"] == "interrupted"),
            "{case}"
        );
        let _ = fs::remove_dir_all(root);
    }
}
