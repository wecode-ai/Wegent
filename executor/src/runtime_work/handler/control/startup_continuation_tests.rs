use super::tests::{context, seed, EnvGuard};
use super::*;

#[test]
fn continuation_queues_before_the_initial_native_session_is_ready() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _home = EnvGuard::home(root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "unused-codex");
            seed(&handler, "caller");
            let mut target = seed(&handler, "target");
            target.thread_id = None;
            target.workspace_path = root.path().to_string_lossy().into_owned();
            handler.store.upsert_task(target);
            handler.retain_runtime_model_config("target", &json!({"model_id":"test"}));
            let (cancel_tx, _cancel_rx) = oneshot::channel();
            let (_stopped_tx, stopped_rx) = oneshot::channel();
            handler.start_local_task_execution("target".into(), cancel_tx, stopped_rx);
            handler
                .turn_scheduler
                .lock()
                .unwrap()
                .active_task_ids
                .insert("target".into(), RuntimeTaskKind::Personal);

            let args = json!({"conversation_id":workbench_control::conversation_id("control-test-device","target"),
                "message":"Follow up while native startup is pending", "request_key":"startup-follow-up"});
            let first = handler
                .control_operation(&context("caller"), "continue_conversation", args.clone())
                .await
                .unwrap();
            assert_eq!(first["operation"]["delivery_status"], "accepted", "{first}");
            assert_eq!(first["operation"]["result"]["status"], "queued");
            let second = handler
                .control_operation(&context("caller"), "continue_conversation", args)
                .await
                .unwrap();
            assert_eq!(second["duplicate"], true);
            assert_eq!(second["operation"], first["operation"]);
            let queued = handler.turn_scheduler.lock().unwrap().queued_turns.clone();
            assert_eq!(queued.len(), 1);
            assert_eq!(queued[0].local_task_id, "target");
            assert!(queued[0].resume_thread_id.is_none());
            let mut turn = queued[0].clone();
            assert!(handler.bind_pending_continuation(&mut turn).is_err());
            assert!(turn.resume_thread_id.is_none());
            assert!(turn.direct_thread_id.is_none());
            handler.store.update_task("target", |link| {
                link.thread_id = Some("thread-original-creation".into());
            });
            handler.bind_pending_continuation(&mut turn).unwrap();
            assert_eq!(turn.resume_thread_id.as_deref(), Some("thread-original-creation"));
            assert!(turn.direct_thread_id.is_none());
            assert!(turn.fork_thread_id.is_none());

            let mut new_session = queued[0].clone();
            new_session.send_payload.as_mut().unwrap()["startNewSession"] = json!(true);
            handler.bind_pending_continuation(&mut new_session).unwrap();
            assert!(new_session.resume_thread_id.is_none());
            assert!(new_session.direct_thread_id.is_none());
            assert!(new_session.fork_thread_id.is_none());

            let no_queue = handler
                .control_operation(&context("caller"), "continue_conversation", json!({
                    "conversation_id":workbench_control::conversation_id("control-test-device","target"),
                    "message":"Do not queue", "request_key":"startup-no-queue", "queue_if_busy":false
                }))
                .await
                .unwrap();
            assert_eq!(no_queue["operation"]["delivery_status"], "rejected");
            assert_eq!(no_queue["operation"]["result"]["code"], "bad_request");
            assert_eq!(handler.turn_scheduler.lock().unwrap().queued_turns.len(), 1);
        });
}
