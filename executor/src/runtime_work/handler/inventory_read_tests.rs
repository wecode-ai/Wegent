use super::*;

#[cfg(unix)]
fn process_cpu_seconds() -> f64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // getrusage initializes the complete structure on success.
    assert_eq!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
        0
    );
    let usage = unsafe { usage.assume_init() };
    (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as f64
        + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as f64 / 1_000_000.0
}

#[tokio::test]
async fn cached_inventory_reads_do_not_write_issue_statuses() {
    let (handler, root) = isolated_runtime_work_handler("read-only-inventory");
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let binding = store
        .ensure_default_work_item_binding("device-1", "task-0", "Inventory", "")
        .unwrap();
    let issue_id = binding.loop_item_id.unwrap();
    let connection = rusqlite::Connection::open(handler.task_store_path.as_ref()).unwrap();
    // A synthetic history approximates a long-lived profile, without reading personal data.
    connection
        .execute_batch(
            "WITH RECURSIVE history(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2000
         ) INSERT INTO loop_items (
            id, resource_type, device_id, task_id, metadata, created_at, updated_at
         ) SELECT 'history-' || n, 'execution', 'other-device', 'history-' || n,
            json_object('history', hex(zeroblob(4096))), '2026-01-01', '2026-01-01'
         FROM history;",
        )
        .unwrap();
    for index in 0..157 {
        let mut link = RuntimeTaskLink::new_pending(
            format!("task-{index}"),
            root.display().to_string(),
            format!("Task {index}"),
        );
        link.status = "done".into();
        link.updated_at = 100;
        link.interaction_status = (index < 10).then(|| "awaitingUserReply".into());
        // Import a cached snapshot without producing a lifecycle transition.
        handler.store.upsert_task(link);
    }
    let version = || {
        connection
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    let before = version();
    let started = Instant::now();
    #[cfg(unix)]
    let cpu_started = process_cpu_seconds();
    let project_index = CodexGlobalProjectIndex::from_test_payload(&Map::new());
    for _ in 0..6 {
        let response = handler
            .list_tasks_with_project_index(
                &json!({"preferCached":true, "pendingOnly":true}),
                &project_index,
                Instant::now(),
            )
            .await
            .unwrap();
        let count: usize = response["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|workspace| workspace["tasks"].as_array().unwrap().len())
            .sum();
        assert_eq!(count, 10);
    }
    eprintln!(
        "inventory workload: 157 cached tasks, 2000 history rows, 6 reads, elapsed_ms={}",
        started.elapsed().as_millis()
    );
    #[cfg(unix)]
    eprintln!(
        "inventory cpu_seconds={:.6}",
        process_cpu_seconds() - cpu_started
    );
    assert_eq!(
        version(),
        before,
        "inventory reads must not mutate Issue storage"
    );
    // Lifecycle writes, unlike reads, must still project terminal status.
    let link = handler.local_task_link("task-0").unwrap();
    handler.project_runtime_link_status_now(&link);
    assert_eq!(
        store
            .get_task(&binding.cloud_project_id, &issue_id)
            .unwrap()
            .status
            .as_deref(),
        Some("in_review")
    );
    drop(connection);
    drop(store);
    let _ = fs::remove_dir_all(root);
}
