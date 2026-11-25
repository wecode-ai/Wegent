use super::super::tests::isolated_runtime_work_handler;
use super::*;
use std::sync::{mpsc, TryLockError};

fn active_task(label: &str) -> (RuntimeWorkRpcHandler, PathBuf, u64) {
    let (handler, root) = isolated_runtime_work_handler(label);
    let mut task = RuntimeTaskLink::new_pending("task".into(), "".into(), "Task".into());
    task.thread_id = Some("thread".into());
    handler.store.upsert_task(task);
    let (cancel, _cancelled) = oneshot::channel();
    let (_stopped, stopped_rx) = oneshot::channel();
    let execution = handler.start_local_task_execution("task".into(), cancel, stopped_rx);
    handler.record_active_codex_turn("task", execution, "thread".into(), "turn".into());
    (handler, root, execution)
}

#[test]
fn completion_keeps_its_claim_until_the_terminal_state_is_written() {
    for cancelled in [false, true] {
        let (handler, root, execution) = active_task("completion-claim");
        if cancelled {
            assert!(handler.request_active_turn_stop("task"));
        }
        let reader = handler.store.clone();
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let locked = std::thread::spawn(move || {
            reader.read_task("task", |_| {
                entered.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let completing = handler.clone();
        let (started, started_rx) = mpsc::channel();
        let completed = std::thread::spawn(move || {
            started.send(()).unwrap();
            if cancelled {
                completing.settle_cancelled_local_task_execution("task", execution)
            } else {
                completing.finish_local_task("task", execution, None, "cancelled")
            }
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let retained = loop {
            match handler.active_local_executions.try_lock() {
                Err(TryLockError::WouldBlock) => {}
                Ok(active) if !active.contains_key("task") => break false,
                Err(TryLockError::Poisoned(_)) => break false,
                _ => {}
            }
            if Instant::now() >= deadline {
                break true;
            }
            std::thread::yield_now();
        };
        release.send(()).unwrap();
        locked.join().unwrap();
        assert!(completed.join().unwrap());
        assert!(
            retained,
            "stop must not acknowledge completion before the terminal state is written"
        );
        assert_eq!(handler.store.get_task("task").unwrap().status, "cancelled");
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn completion_releases_execution_claims_before_telemetry_writes() {
    for reconcile in [false, true] {
        let (handler, root, execution) = active_task("completion-telemetry");
        let path = root.join("tasks.sqlite");
        let facts = LocalTaskStore::open(&path).unwrap();
        facts.configure_stand_in_telemetry(7, true, None).unwrap();
        handler.store.set_telemetry_path(path.clone());
        handler.store.update_task("task", |task| {
            task.runtime_handle["origin"] = json!({"initiatedBy":"stand_in_identity","userId":7});
            task.runtime_handle["lastTurnId"] = json!("turn");
        });
        let expected = handler
            .local_execution_reconciliation_guard("task")
            .unwrap();
        let writer = rusqlite::Connection::open(path).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let completing = handler.clone();
        let completed = std::thread::spawn(move || {
            if reconcile {
                completing.reconcile_terminal_local_execution(
                    "task",
                    "thread",
                    "cancelled",
                    "test",
                    &expected,
                    "turn",
                )
            } else {
                completing.finish_local_task("task", execution, None, "cancelled")
            }
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let published = loop {
            if handler
                .store
                .read_task("task", |task| task.status == "cancelled")
                .unwrap()
            {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::yield_now();
        };
        let released = handler
            .active_local_executions
            .try_lock()
            .is_ok_and(|active| !active.contains_key("task"));
        writer.execute_batch("ROLLBACK").unwrap();
        assert!(completed.join().unwrap());
        assert!(published);
        assert!(
            released,
            "SQLite telemetry cannot retain the execution-control mutex"
        );
        drop(writer);
        drop(facts);
        fs::remove_dir_all(root).unwrap();
    }
}
