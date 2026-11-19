//! Busy conversations accept source input into the ordinary durable queue.
use super::super::tests::{context, seed, EnvGuard};
use super::*;

#[test]
fn received_event_enters_the_message_queue_while_the_conversation_is_busy() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        let mut link = seed(&handler,"caller");
        link.runtime_handle["executionRequest"]["user_id"] = json!(7);
        handler.store.upsert_task(link.clone());
        handler.preparing_turns.lock().unwrap().insert("caller".into(), PreparingTurn { owner_request:None,cancellation_requested:false });
        let key = "a".repeat(64);
        let id = "busy-event";
        let operation = super::super::execution::continuation_operation_id("control-test-device","caller",&format!("connection-event:{id}"));
        let event = json!({"id":"ci-terminal","topicId":"pr","text":"Checks failed","at":chrono::Utc::now().to_rfc3339()});
        let record = json!({"subscription_key":id,"task_id":"caller","device_id":"control-test-device",
            "session":session::binding(&link).unwrap(),"source":{"name":"Repository","enabledAfter":"2026-01-01T00:00:00Z"},
            "status":"pending","operation_id":operation,"continuation":"Inspect the CI failure","events":[event],
            "resource_event_keys":[key],"observation_id":"observation"});
        handler.save_event_subscription(id,&record).unwrap();
        event_store::transact(&handler.event_subscription_path(),|state| {
            state["observations"]["observation"] = json!({"events":[{"key":key,"sequence":1,"event":event}]}); Ok(())
        }).unwrap();
        assert!(handler.is_busy_local_task("caller"));
        handler.collect_conversation_subscription(id,record,"cycle").await.unwrap();
        let saved = event_store::transact(&handler.event_subscription_path(),|state|Ok(state["operations"][id].clone())).unwrap();
        let receipt = handler.control_get_operation(&context("caller"),&json!({"operation_id":operation})).await.unwrap();
        assert_eq!(receipt["operation"]["delivery_status"],"accepted", "{receipt}");
        assert_eq!(saved["status"],"delivered");
        let queued = handler.turn_scheduler.lock().unwrap().queued_turns.clone();
        assert_eq!(queued.len(),1);
        assert_eq!(queued[0].request.extra["resource_event_keys"],json!([key]));
        handler.collect_conversation_subscription(id,saved,"cycle-2").await.unwrap();
        assert_eq!(handler.turn_scheduler.lock().unwrap().queued_turns.clone().len(),1,"The accepted event must not be enqueued twice");
    });
}
