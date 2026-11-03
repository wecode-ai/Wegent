use super::*;

fn write_pending(path: &Path) {
    let record = CodexGlobalStateOplogRecord {
        version: CODEX_GLOBAL_STATE_OPLOG_VERSION,
        kind: OPLOG_KIND_UPSERT.into(),
        workspace_path: "/pending".into(),
        label: Some("Pending".into()),
        updated_at: now_ms(),
        ..Default::default()
    };
    fs::write(path, serde_json::to_string(&record).unwrap()).unwrap();
}

#[test]
fn index_snapshot_keeps_pending_changes_without_requiring_a_flush() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state.json");
    let oplog = directory.path().join("oplog.jsonl");
    fs::write(&state, "{}").unwrap();
    write_pending(&oplog);
    let (payload, pending) = read_codex_global_project_snapshot(&state, &oplog);
    let mut payload = payload.unwrap();
    apply_codex_global_state_ops(&mut payload, &pending);
    assert!(index_from_payload(&payload)
        .project_for_path("/pending")
        .is_some());
    assert!(oplog.exists());
}

#[cfg(unix)]
#[test]
fn watcher_cannot_remove_the_log_between_state_and_log_snapshot_reads() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, sync::mpsc, time::Duration};
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state.json");
    let oplog = directory.path().join("oplog.jsonl");
    let fifo = CString::new(state.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    write_pending(&oplog);
    let reader_state = state.clone();
    let reader_oplog = oplog.clone();
    let reader =
        thread::spawn(move || read_codex_global_project_snapshot(&reader_state, &reader_oplog));
    // Opening the write end proves the reader has opened state; retain it to
    // hold the read before EOF while the real flush lock is contended.
    let mut pipe = fs::OpenOptions::new().write(true).open(&state).unwrap();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let flusher = thread::spawn(move || {
        let _guard = match codex_global_state_oplog_io_lock().try_lock() {
            Ok(guard) => {
                attempt_tx.send(true).unwrap();
                guard
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                attempt_tx.send(false).unwrap();
                codex_global_state_oplog_io_lock().lock().unwrap()
            }
            Err(error) => panic!("Unexpected poisoned flush lock: {error}"),
        };
        let payload = json!({"electron-saved-workspace-roots":["/pending"]})
            .as_object()
            .unwrap()
            .clone();
        write_state_payload(&state, &payload).unwrap();
        fs::remove_file(&oplog).unwrap();
        done_tx.send(()).unwrap();
    });
    let acquired_during_read = attempt_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    if acquired_during_read {
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    pipe.write_all(b"{}").unwrap();
    drop(pipe);
    let (payload, pending) = reader.join().unwrap();
    flusher.join().unwrap();
    assert!(
        !acquired_during_read,
        "The snapshot must own the flush lock while reading state"
    );
    let mut payload = payload.unwrap();
    apply_codex_global_state_ops(&mut payload, &pending);
    assert!(index_from_payload(&payload)
        .project_for_path("/pending")
        .is_some());
}
