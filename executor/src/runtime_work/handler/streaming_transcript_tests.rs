use super::*;

#[test]
fn native_text_extraction_preserves_streaming_whitespace() {
    use crate::runtime_work::util::extract_text;

    for text in ["  Indented paragraph.\n\n", "\n\n", "中文🙂 "] {
        for key in ["text", "content", "message"] {
            assert_eq!(extract_text(&json!({(key): text})).as_deref(), Some(text));
        }
        assert_eq!(
            extract_text(&json!({"content": [{"text": text}]})).as_deref(),
            Some(text)
        );
    }
    assert_eq!(extract_text(&json!({"text": ""})), None);
}

#[tokio::test]
async fn native_transcript_preserves_text_identity_and_order() {
    let (mut handler, root) = isolated_runtime_work_handler("streaming-transcript-identity");
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
    install_native_history(
        &mut handler,
        &root,
        vec![json!({"id":"turn-1","status":"inProgress","items":[
          {"id":"progress-1","type":"agentMessage","phase":"commentary","text":"Inspecting the code."},
          {"id":"progress-2","type":"agentMessage","phase":"commentary","text":"The implementation is ready."}
        ]})],
        None,
    );
    let mut expected_content = String::new();
    for delta in ["First paragraph.\n\n", "Second paragraph."] {
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
            ["progress-1", "progress-2"]
        );
        assert_eq!(items[0]["type"], "block");
        let live = response["runtimeTurns"][0]["items"].as_array().unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0]["id"], "final-1");
        assert_eq!(live[0]["type"], "assistant_text");
        assert_eq!(live[0]["content"], expected_content);
        assert_eq!(
            items,
            response["messages"][0]["runtimeItems"].as_array().unwrap()
        );
    }
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
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
