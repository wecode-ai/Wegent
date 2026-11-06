// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn active_history_fixture(label: &str) -> (RuntimeWorkRpcHandler, PathBuf, Value) {
    let (handler, root) = isolated_runtime_work_handler(label);
    let mut link = RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
    link.thread_id = Some("thread-1".into());
    link.runtime_handle["transcriptSnapshotMessages"] = json!([{
        "id":"cached", "role":"assistant", "content":"cached history".repeat(100_000)
    }]);
    handler.upsert_local_task(link);
    handler.begin_active_codex_transcript("task-1", "thread-1", "long-turn");
    let mut items = (0..7_001)
        .map(|index| {
            json!({
                "id":format!("completed-{index}"),"type":"agentMessage",
                "text":"historical body","lifecycleCompleted":true
            })
        })
        .collect::<Vec<_>>();
    items.push(json!({
        "id":"pending","type":"agentMessage","text":"Live output",
        "lifecycleCompleted":false
    }));
    handler
        .active_codex_transcript_items
        .lock()
        .unwrap()
        .get_mut("task-1")
        .unwrap()
        .items = items;
    let thread = json!({"id":"thread-1","timeline":true,"turns":[{
        "id":"long-turn","status":"inProgress","items":[{
            "id":"completed-7000","type":"agentMessage","text":"historical body","position":7000
        }]
    }]});
    (handler, root, thread)
}

#[test]
fn a_bounded_native_page_merges_only_unfinished_active_items_without_reading_cached_bodies() {
    let (handler, root, mut thread) = active_history_fixture("bounded-active-history");
    let full_reads = handler.store.full_task_read_count();

    handler.merge_active_codex_transcript("task-1", &mut thread);

    assert_eq!(handler.store.full_task_read_count(), full_reads);
    let items = thread["turns"][0]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], "completed-7000");
    assert_eq!(items[1]["id"], "pending");
    assert_eq!(items[1]["text"], "Live output");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn scanning_active_item_metadata_observes_cancellation_before_mutating_the_page() {
    let (handler, root, mut thread) = active_history_fixture("cancel-active-history");
    let original = thread.clone();
    let checkpoints = std::cell::Cell::new(0);

    let error = handler
        .merge_active_codex_transcript_checked("task-1", &mut thread, &|| {
            let count = checkpoints.get() + 1;
            checkpoints.set(count);
            if count == 32 {
                Err(AppIpcError::new("request_cancelled", "cancelled"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();

    assert_eq!(error.code, "request_cancelled");
    assert_eq!(checkpoints.get(), 32);
    assert_eq!(thread, original);
    assert!(handler.active_codex_transcript_items.try_lock().is_ok());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn isolated_runtime_fixtures_keep_two_worker_slots_shared_only_with_their_clones() {
    let (first, first_root) = isolated_runtime_work_handler("first-transcript-pool");
    let (second, second_root) = isolated_runtime_work_handler("second-transcript-pool");
    let clone = first.clone();
    let workers = first.transcript_test_workers.as_ref().unwrap().clone();
    let request = json!({"method":"runtime.tasks.transcript","payload":{
        "taskId":"pending-task","transcriptProtocolVersion":2
    }});
    let first_slot = workers.clone().try_acquire_owned().unwrap();
    assert!(clone.handle_runtime_rpc(request.clone()).await.is_ok());
    let second_slot = workers.try_acquire_owned().unwrap();

    let error = clone.handle_runtime_rpc(request.clone()).await.unwrap_err();
    assert_eq!(error.code, "runtime_read_busy");
    assert!(second.handle_runtime_rpc(request).await.is_ok());

    drop((first_slot, second_slot));
    let _ = fs::remove_dir_all(first_root);
    let _ = fs::remove_dir_all(second_root);
}
