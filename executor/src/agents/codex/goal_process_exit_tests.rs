// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn goal_process_exit_never_replays_a_previous_completed_turn() {
    for shutdown in [false, true] {
        for exit_notification in [false, true] {
            for continuation_started in [false, true] {
                let client = CodexAppServerClient::new(format!(
                    "goal-process-exit-{shutdown}-{exit_notification}-{continuation_started}"
                ));
                client.state.lock().await.executor_shutdown_requested = shutdown;
                let (sender, mut receiver) = broadcast::channel(16);
                sender
                    .send(json!({
                        "method": "thread/goal/updated",
                        "params": {"threadId": "goal-thread", "goal": {"status": "active"}}
                    }))
                    .unwrap();
                sender
                    .send(json!({
                        "method": "turn/completed",
                        "params": {"threadId": "goal-thread", "turn": {"id": "first", "status": "completed"}}
                    }))
                    .unwrap();
                if continuation_started {
                    sender
                        .send(json!({
                            "method": "turn/started",
                            "params": {"threadId": "goal-thread", "turn": {"id": "next", "status": "inProgress"}}
                        }))
                        .unwrap();
                }
                if exit_notification {
                    sender
                        .send(json!({
                            "method": "codex/app-server/exited",
                            "params": {"message": "synthetic process exit"}
                        }))
                        .unwrap();
                }
                drop(sender);
                let mut state = CodexRunState::default();
                let result = read_shared_turn_notifications(
                    &client,
                    &mut receiver,
                    "goal-thread",
                    &mut state,
                    30,
                    Instant::now() + Duration::from_secs(30),
                    SharedTurnNotificationOptions {
                        overload_turn_recovering: None,
                        overload_continuation_params: json!({}),
                        active_turn_id: Some("first".to_owned()),
                        expected_client_user_message_id: None,
                        notifications: None,
                        cancellation: None,
                        request_user_input_answers: None,
                        active_turn_started: None,
                        active_turn_finished: None,
                        wait_for_goal_continuation: true,
                        auto_approve_mcp_tool_calls: false,
                    },
                )
                .await;
                assert!(state.goal_is_active());
                let error = result.expect_err("process exit must not complete an active Goal");
                assert_eq!(
                    error,
                    if shutdown {
                        CODEX_APP_SERVER_EXECUTOR_SHUTDOWN
                    } else if exit_notification {
                        "synthetic process exit"
                    } else {
                        "codex app-server notification stream closed before completing the turn"
                    }
                );
            }
        }
    }
}
