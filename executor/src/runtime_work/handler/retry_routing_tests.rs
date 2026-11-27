// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn proxy_retry_uses_request_turn_identity_instead_of_the_previous_route_request() {
    let (mut handler, root, mut request) = setup("proxy-retry-turn-identity");
    let (sender, mut receiver) = broadcast::channel(32);
    handler.event_tx = Some(sender);
    request.subtask_id = "previous-turn".into();
    handler.register_thread_event_route("thread-1", "task-1".into(), request, false);
    handler.route_codex_notification(notification("turn/started", "previous-turn"));
    handler.route_codex_notification(notification("turn/completed", "previous-turn"));
    handler.route_codex_notification(notification("turn/started", "current-turn"));
    for waiting in [true, false] {
        handler.route_codex_notification(json!({
            "method": "runtime/modelRetry",
            "params": {
                "threadId": "thread-1", "turnId": "current-turn",
                "waitId": "current-request", "waiting": waiting,
            },
        }));
    }
    let blocks = std::iter::from_fn(|| receiver.try_recv().ok())
        .filter(|event| {
            matches!(
                event["event"].as_str(),
                Some("response.block.created" | "response.block.updated")
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(blocks.len(), 2);
    for block in &blocks {
        assert_eq!(block["payload"]["subtaskId"], "current-turn");
    }
    let created_id = &blocks[0]["payload"]["data"]["block"]["id"];
    assert_eq!(created_id, "reconnecting-task-1-current-turn");
    assert_eq!(&blocks[1]["payload"]["data"]["block_id"], created_id);
    assert_eq!(blocks[1]["payload"]["data"]["updates"]["status"], "done");
    fs::remove_dir_all(root).unwrap();
}
