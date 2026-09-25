use super::*;

#[test]
fn atomic_write_replaces_existing_index() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    fs::write(&index_path, b"old index").expect("old index should be written");

    atomic_write_file(&index_path, b"new index").expect("index replacement should succeed");

    assert_eq!(
        fs::read(&index_path).expect("replaced index should be readable"),
        b"new index"
    );
    assert!(temporary_files(directory.path()).is_empty());
}

#[test]
fn atomic_write_cleans_up_temp_file_after_replace_failure() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    fs::create_dir(&index_path).expect("conflicting index directory should be created");
    let sentinel_path = index_path.join("sentinel");
    fs::write(&sentinel_path, b"existing index").expect("sentinel should be written");

    let error = atomic_write_file(&index_path, b"new index")
        .expect_err("replacing a non-empty directory should fail");

    assert!(
        error.to_string().contains("replace runtime work index"),
        "unexpected error: {error}"
    );
    assert_eq!(
        fs::read(&sentinel_path).expect("existing index should remain intact"),
        b"existing index"
    );
    assert!(temporary_files(directory.path()).is_empty());
}

#[test]
fn failed_store_write_does_not_update_index_signature() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    fs::create_dir(&index_path).expect("conflicting index directory should be created");
    fs::write(index_path.join("sentinel"), b"existing index").expect("sentinel should be written");
    let store = RuntimeWorkStore::new(index_path);
    let signature_before = *store
        .index_signature
        .lock()
        .expect("index signature lock should be available");

    store.upsert_task(RuntimeTaskLink::new_pending(
        "failed-task".to_owned(),
        "/tmp/failed".to_owned(),
        "Failed task".to_owned(),
    ));

    assert_eq!(
        *store
            .index_signature
            .lock()
            .expect("index signature lock should be available"),
        signature_before
    );
    assert!(temporary_files(directory.path()).is_empty());
}

fn temporary_files(directory: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .expect("temporary directory should be readable")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".index.json.") && name.ends_with(".tmp"))
        })
        .collect()
}

#[test]
fn shared_index_reload_preserves_process_local_execution_state() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    let owner_store = RuntimeWorkStore::new(index_path.clone());
    let peer_store = RuntimeWorkStore::new(index_path.clone());

    owner_store.upsert_task(RuntimeTaskLink::new_pending(
        "owner-task".to_owned(),
        "/tmp/owner".to_owned(),
        "Owner task".to_owned(),
    ));
    owner_store.update_task("owner-task", |task| {
        task.status = "running".to_owned();
        task.running = true;
        task.thread_status = "active".to_owned();
        task.turn_status = Some("inProgress".to_owned());
        task.runtime_handle["queuePosition"] = Value::from(2);
        task.runtime_handle["lastError"] = Value::from("temporary error");
        task.runtime_handle["lastErrorCode"] = Value::from("temporary_error");
    });
    peer_store.update_task("owner-task", |task| {
        task.title = "Updated owner task".to_owned();
        task.runtime_handle["modelSelection"] = serde_json::json!({"modelName": "gpt-5.6-sol"});
    });
    peer_store.upsert_task(RuntimeTaskLink::new_imported(
        "peer-task".to_owned(),
        "/tmp/peer".to_owned(),
        "Peer task".to_owned(),
        "codex".to_owned(),
        serde_json::json!({}),
        serde_json::json!({}),
    ));

    let owner_task = owner_store
        .get_task("owner-task")
        .expect("owner task should survive peer writes");
    assert_eq!(owner_task.title, "Updated owner task");
    assert!(owner_task.running);
    assert_eq!(owner_task.status, "running");
    assert_eq!(owner_task.thread_status, "active");
    assert_eq!(owner_task.turn_status.as_deref(), Some("inProgress"));
    assert_eq!(
        owner_task.runtime_handle["modelSelection"]["modelName"],
        Value::from("gpt-5.6-sol")
    );
    assert_eq!(owner_task.runtime_handle["queuePosition"], Value::from(2));
    assert_eq!(
        owner_task.runtime_handle["lastError"],
        Value::from("temporary error")
    );
    assert_eq!(
        owner_task.runtime_handle["lastErrorCode"],
        Value::from("temporary_error")
    );

    let persisted: Value =
        serde_json::from_slice(&fs::read(&index_path).expect("shared index should be readable"))
            .expect("shared index should contain JSON");
    let persisted_owner = persisted["tasks"]["owner-task"]
        .as_object()
        .expect("owner task should be persisted");
    assert!(!persisted_owner.contains_key("running"));
    assert!(!persisted_owner.contains_key("status"));
    assert!(!persisted_owner.contains_key("thread_status"));
    assert!(!persisted_owner.contains_key("turn_status"));
    assert!(!persisted_owner.contains_key("completed_at"));
    assert_eq!(persisted_owner.get("archived"), Some(&Value::Bool(false)));
    assert_eq!(
        persisted_owner.get("recency_at"),
        Some(&Value::from(owner_task.recency_at))
    );
}

#[test]
fn persisted_archive_metadata_restores_without_task_status_fields() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    let store = RuntimeWorkStore::new(index_path.clone());
    let mut archived = RuntimeTaskLink::new_imported(
        "archived-task".to_owned(),
        "/tmp/archived".to_owned(),
        "Archived task".to_owned(),
        "codex".to_owned(),
        serde_json::json!({}),
        serde_json::json!({}),
    );
    archived.status = "archived".to_owned();

    store.upsert_task(archived);

    let restored = RuntimeWorkStore::new(index_path)
        .get_task("archived-task")
        .expect("archived task should be restored");
    assert_eq!(restored.status, "archived");
    assert!(!restored.running);
    assert_eq!(restored.thread_status, "notLoaded");
    assert_eq!(restored.turn_status, None);
}

#[test]
fn persisted_project_context_restores_with_task_metadata() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    let store = RuntimeWorkStore::new(index_path.clone());
    let mut task = RuntimeTaskLink::new_pending(
        "project-context-task".to_owned(),
        "/tmp/project-context".to_owned(),
        "Project context".to_owned(),
    );
    task.project_instructions = "Follow the project instructions".to_owned();
    task.project_plugin_ids = vec!["plugin-a".to_owned(), "plugin-b".to_owned()];

    store.upsert_task(task);

    let restored = RuntimeWorkStore::new(index_path)
        .get_task("project-context-task")
        .expect("project context task should be restored");
    assert_eq!(
        restored.project_instructions,
        "Follow the project instructions"
    );
    assert_eq!(
        restored.project_plugin_ids,
        vec!["plugin-a".to_owned(), "plugin-b".to_owned()]
    );
}

#[test]
fn terminal_turn_status_is_not_persisted() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    let store = RuntimeWorkStore::new(index_path.clone());
    let mut completed = RuntimeTaskLink::new_imported(
        "completed-task".to_owned(),
        "/tmp/completed".to_owned(),
        "Completed task".to_owned(),
        "codex".to_owned(),
        serde_json::json!({}),
        serde_json::json!({}),
    );
    completed.status = "done".to_owned();
    completed.turn_status = Some("completed".to_owned());
    completed.completed_at = Some(1_780_000_000_000);
    completed.runtime_handle = serde_json::json!({
        "queuePosition": 1,
        "lastError": "transient",
        "lastErrorCode": "transient_error",
        "messages": [{"id": "cached-message"}],
        "completedTranscriptMessages": [{"id": "completed-message"}],
        "completedTranscriptThreadId": "thread-1",
        "transcriptSnapshotMessages": [{"id": "snapshot-message"}],
        "transcriptSnapshotThreadId": "thread-1",
        "cloudCollaborationRound": {
            "round_id": "round-1",
            "execution_ids": [41, 42],
            "loop_item_ids": ["ISSUE-HUMAN-1"]
        },
        "modelSelection": {"modelName": "gpt-5.6-sol"},
        "wegentTeam": {
            "id": 7,
            "agent_config": {"api_key": "must-not-persist"}
        },
        "teamExecutionProfile": {"agent_config": {"api_key": "must-not-persist"}}
    });

    store.upsert_task(completed);

    let persisted: Value =
        serde_json::from_slice(&fs::read(&index_path).expect("index should be readable"))
            .expect("index should contain JSON");
    let task = persisted["tasks"]["completed-task"]
        .as_object()
        .expect("completed task should be persisted");
    assert!(!task.contains_key("status"));
    assert!(!task.contains_key("running"));
    assert!(!task.contains_key("thread_status"));
    assert!(!task.contains_key("turn_status"));
    assert!(!task.contains_key("completed_at"));
    assert!(task["runtime_handle"].get("queuePosition").is_none());
    assert!(task["runtime_handle"].get("lastError").is_none());
    assert!(task["runtime_handle"].get("lastErrorCode").is_none());
    assert!(task["runtime_handle"].get("messages").is_none());
    assert!(task["runtime_handle"]
        .get("completedTranscriptMessages")
        .is_none());
    assert!(task["runtime_handle"]
        .get("completedTranscriptThreadId")
        .is_none());
    assert!(task["runtime_handle"]
        .get("transcriptSnapshotMessages")
        .is_none());
    assert!(task["runtime_handle"]
        .get("transcriptSnapshotThreadId")
        .is_none());
    assert_eq!(
        task["runtime_handle"]["modelSelection"]["modelName"],
        "gpt-5.6-sol"
    );
    assert_eq!(
        task["runtime_handle"]["cloudCollaborationRound"]["round_id"],
        "round-1"
    );
    assert_eq!(task["runtime_handle"]["wegentTeam"]["id"], 7);
    assert!(task["runtime_handle"]["wegentTeam"]
        .get("agent_config")
        .is_none());
    assert!(task["runtime_handle"].get("teamExecutionProfile").is_none());

    let restored = RuntimeWorkStore::new(index_path)
        .get_task("completed-task")
        .expect("completed task should be restored");
    assert!(!restored.running);
    assert_eq!(restored.status, "active");
    assert_eq!(restored.thread_status, "notLoaded");
    assert_eq!(restored.turn_status, None);
    assert_eq!(restored.completed_at, None);
    assert!(restored.runtime_handle.get("queuePosition").is_none());
    assert!(restored.runtime_handle.get("lastError").is_none());
    assert_eq!(
        restored.runtime_handle["cloudCollaborationRound"]["loop_item_ids"][0],
        "ISSUE-HUMAN-1"
    );
}

#[test]
fn startup_migrates_legacy_runtime_handle_payloads() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    fs::write(
        &index_path,
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "tasks": {
                "legacy-task": {
                    "local_task_id": "legacy-task",
                    "runtime_handle": {
                        "modelSelection": {"modelName": "gpt-5.6-sol"},
                        "messages": [{"id": "cached-message"}],
                        "completedTranscriptMessages": [{"id": "completed-message"}],
                        "transcriptSnapshotMessages": [{"id": "snapshot-message"}]
                    }
                }
            },
            "workspaces": {}
        }))
        .expect("legacy index should serialize"),
    )
    .expect("legacy index should be written");

    let store = RuntimeWorkStore::new(index_path.clone());

    let restored = store
        .get_task("legacy-task")
        .expect("legacy task should be restored");
    assert_eq!(
        restored.runtime_handle["modelSelection"]["modelName"],
        "gpt-5.6-sol"
    );
    assert!(restored.runtime_handle.get("messages").is_none());
    assert!(restored
        .runtime_handle
        .get("completedTranscriptMessages")
        .is_none());
    assert!(restored
        .runtime_handle
        .get("transcriptSnapshotMessages")
        .is_none());

    let migrated: Value =
        serde_json::from_slice(&fs::read(index_path).expect("index should be readable"))
            .expect("index should contain JSON");
    let runtime_handle = &migrated["tasks"]["legacy-task"]["runtime_handle"];
    assert_eq!(runtime_handle["modelSelection"]["modelName"], "gpt-5.6-sol");
    assert!(runtime_handle.get("messages").is_none());
    assert!(runtime_handle.get("completedTranscriptMessages").is_none());
    assert!(runtime_handle.get("transcriptSnapshotMessages").is_none());
}

#[test]
fn transient_runtime_updates_do_not_rewrite_the_index() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    let store = RuntimeWorkStore::new(index_path);
    store.upsert_task(RuntimeTaskLink::new_pending(
        "runtime-task".to_owned(),
        "/tmp/runtime-task".to_owned(),
        "Runtime task".to_owned(),
    ));
    let writes_after_create = store.write_attempts.load(Ordering::Relaxed);

    store.update_task("runtime-task", |task| {
        task.status = "running".to_owned();
        task.running = true;
        task.updated_at += 1;
        task.runtime_handle["messages"] = serde_json::json!([{"id": "streaming-message"}]);
        task.runtime_handle["transcriptSnapshotMessages"] =
            serde_json::json!([{"id": "snapshot-message"}]);
    });

    assert_eq!(
        store.write_attempts.load(Ordering::Relaxed),
        writes_after_create
    );

    store.update_task("runtime-task", |task| {
        task.runtime_handle["modelSelection"] = serde_json::json!({"modelName": "gpt-5.6-sol"});
    });
    assert_eq!(
        store.write_attempts.load(Ordering::Relaxed),
        writes_after_create + 1
    );
}

#[test]
fn legacy_archived_status_is_migrated_at_the_deserialization_boundary() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let index_path = directory.path().join("index.json");
    fs::write(
        &index_path,
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "tasks": {
                "legacy-task": {
                    "local_task_id": "legacy-task",
                    "status": "archived"
                }
            },
            "workspaces": {}
        }))
        .expect("legacy index should serialize"),
    )
    .expect("legacy index should be written");

    let store = RuntimeWorkStore::new(index_path.clone());
    let restored = store
        .get_task("legacy-task")
        .expect("legacy archived task should be restored");
    assert_eq!(restored.status, "archived");

    store.update_task("legacy-task", |_| {});
    let persisted: Value =
        serde_json::from_slice(&fs::read(index_path).expect("index should be readable"))
            .expect("index should contain JSON");
    let task = persisted["tasks"]["legacy-task"]
        .as_object()
        .expect("legacy task should be rewritten as metadata");
    assert_eq!(task.get("archived"), Some(&Value::Bool(true)));
    assert!(!task.contains_key("status"));
}

#[test]
fn claude_history_and_outcome_survive_restart_and_peer_writes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.json");
    let store = RuntimeWorkStore::new(path.clone());
    let mut task = RuntimeTaskLink::new_pending_with_runtime(
        "claude-1".into(),
        "/tmp/project".into(),
        "Task".into(),
        "claude_code",
    );
    task.status = "done".into();
    task.turn_status = Some("completed".into());
    task.completed_at = Some(1234);
    task.runtime_handle["messages"] = serde_json::json!([
        {"id":"user-1","role":"user","content":"request","turnId":"turn-1"},
        {"id":"assistant-1","role":"assistant","content":"answer","turnId":"turn-1", "status":"done", "blocks":[{"id":"tool-1","type":"tool","tool_output":"output"}]}
    ]);
    store.upsert_task(task.clone());
    let peer = RuntimeWorkStore::new(path.clone());
    peer.update_task("claude-1", |task| task.title = "Renamed".into());
    let reloaded = RuntimeWorkStore::new(path).get_task("claude-1").unwrap();
    assert_eq!(
        reloaded.runtime_handle["messages"],
        task.runtime_handle["messages"]
    );
    assert_eq!(reloaded.status, "done");
    assert_eq!(reloaded.turn_status.as_deref(), Some("completed"));
    assert_eq!(reloaded.completed_at, Some(1234));
    assert!(!reloaded.running);
    assert_eq!(
        store.get_task("claude-1").unwrap().runtime_handle["messages"],
        task.runtime_handle["messages"]
    );
}

#[test]
fn claude_restart_never_resurrects_a_running_process() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("index.json");
    let store = RuntimeWorkStore::new(path.clone());
    let mut task = RuntimeTaskLink::new_pending_with_runtime(
        "claude-1".into(),
        "/tmp/project".into(),
        "Task".into(),
        "claude_code",
    );
    task.status = "running".into();
    task.running = true;
    store.upsert_task(task);
    let restored = RuntimeWorkStore::new(path).get_task("claude-1").unwrap();
    assert_eq!(restored.status, "interrupted");
    assert!(!restored.running);
    assert_eq!(restored.completed_at, None);
}
