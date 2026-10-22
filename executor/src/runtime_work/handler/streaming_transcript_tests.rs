use super::*;

#[tokio::test]
async fn running_cached_transcript_preserves_native_text_identity_and_order() {
    let (handler, root) = isolated_runtime_work_handler("streaming-transcript-identity");
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    set_transcript_snapshot_messages(&mut link.runtime_handle, "thread-1", Vec::new(), None, None);
    handler.upsert_local_task(link);
    start_test_execution(&handler, "task-1");
    handler.begin_active_codex_transcript("task-1", "thread-1", "turn-1");
    for (id, phase, text) in [
        ("progress-1", "commentary", "Inspecting the code."),
        ("progress-2", "commentary", "The implementation is ready."),
    ] {
        handler.record_active_codex_transcript_item(
            "task-1",
            "turn-1",
            &json!({
                "method": "item/completed",
                "params": {"item": {"id": id, "type": "agentMessage", "phase": phase, "text": text}}
            }),
        );
    }
    handler.record_active_codex_transcript_item("task-1", "turn-1", &json!({
        "method": "item/started",
        "params": {"item": {"id": "final-1", "type": "agentMessage", "phase": "final_answer", "text": ""}}
    }));
    let mut expected_content = String::new();
    for delta in ["First paragraph.", "\n\nSecond paragraph."] {
        expected_content.push_str(delta);
        handler.record_active_codex_transcript_item(
            "task-1",
            "turn-1",
            &json!({
                "method": "item/agentMessage/delta",
                "params": {"itemId": "final-1", "delta": delta}
            }),
        );
        let response = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.transcript", "payload": {"taskId": "task-1"}
            }))
            .await
            .expect("the running cache must serve the transcript");
        let items = response["turns"][0]["items"].as_array().unwrap();
        assert_eq!(response["running"], true);
        assert_eq!(
            items
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["progress-1", "progress-2", "final-1"]
        );
        assert_eq!(items[0]["type"], "block");
        assert_eq!(items[2]["type"], "assistant_text");
        assert_eq!(items[2]["content"], expected_content);
        assert_eq!(
            items,
            response["messages"][0]["runtimeItems"].as_array().unwrap()
        );
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cached_transcript_does_not_rebuild_empty_native_items_from_aggregate_content() {
    let turns = transcript_canonical_turns(
        &[json!({
            "id": "aggregate", "turnId": "turn-1", "role": "assistant",
            "content": "Presentation only", "runtimeItems": [],
            "blocks": [{"id": "presentation-block", "type": "text"}]
        })],
        TranscriptTurnItemSource::CachedMessages,
    );
    assert_eq!(turns[0]["items"], json!([]));
}
