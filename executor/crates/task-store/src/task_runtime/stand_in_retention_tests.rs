use super::*;

fn insert(connection: &Connection, id: &str, kind: &str, at: &str) {
    connection.execute(
        "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES (?1,?2,'not JSON',?3,?3)",
        params![id, kind, at],
    ).unwrap();
}

fn prune(connection: &Connection, at: chrono::DateTime<Utc>) -> usize {
    // Retention semantics must not depend on scheduling under the parallel suite.
    // The zero-budget test independently verifies interruption and rollback.
    LocalTaskStore::prune_stand_in_history(connection, at, Duration::from_secs(10)).unwrap()
}

#[test]
fn retention_uses_only_type_and_time_and_preserves_recent_and_unrelated_records() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let connection = store.connection().unwrap();
    let at = Utc::now();
    let cutoff = at - chrono::Duration::days(7);
    let old = cutoff - chrono::Duration::seconds(1);
    for kind in ["stand_in_event", "stand_in_action", "stand_in_route"] {
        insert(
            &connection,
            &format!("expired-{kind}"),
            kind,
            &old.to_rfc3339(),
        );
        insert(
            &connection,
            &format!("boundary-{kind}"),
            kind,
            &cutoff.to_rfc3339(),
        );
        insert(
            &connection,
            &format!("recent-{kind}"),
            kind,
            &at.to_rfc3339(),
        );
    }
    insert(
        &connection,
        "legacy-time",
        "stand_in_event",
        &old.format("%Y-%m-%d %H:%M:%S").to_string(),
    );
    for kind in [
        "stand_in_processing",
        "personal_stand_in",
        "stand_in_settings",
        "task",
    ] {
        insert(&connection, kind, kind, &old.to_rfc3339());
    }
    assert_eq!(prune(&connection, at), 4);
    let retained: usize = connection
        .query_row(
            "SELECT count(*) FROM loop_items WHERE metadata='not JSON'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 10);
    assert_eq!(prune(&connection, at), 0);
}

#[test]
fn retention_is_bounded_and_resumes_the_backlog() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let connection = store.connection().unwrap();
    let at = Utc::now();
    let old = (at - chrono::Duration::days(8)).to_rfc3339();
    for index in 0..=CLEANUP_BATCH {
        insert(
            &connection,
            &format!("old-{index}"),
            "stand_in_action",
            &old,
        );
    }
    assert_eq!(prune(&connection, at), CLEANUP_BATCH);
    assert_eq!(prune(&connection, at), 1);
    assert_eq!(prune(&connection, at), 0);
}

#[test]
fn interrupted_retention_rolls_back_and_releases_the_writer() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let connection = store.connection().unwrap();
    let at = Utc::now();
    let old = (at - chrono::Duration::days(8)).to_rfc3339();
    for index in 0..100 {
        insert(
            &connection,
            &format!("old-{index}"),
            "stand_in_action",
            &old,
        );
    }
    let error =
        LocalTaskStore::prune_stand_in_history(&connection, at, Duration::ZERO).unwrap_err();
    assert!(
        matches!(error, TaskRuntimeError::Database(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::OperationInterrupted)
    );
    let count: usize = connection
        .query_row(
            "SELECT count(*) FROM loop_items WHERE resource_type='stand_in_action'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 100);
    let writer = Connection::open(&path).unwrap();
    writer.busy_timeout(Duration::ZERO).unwrap();
    insert(&writer, "user-event", "stand_in_event", &at.to_rfc3339());
    assert_eq!(prune(&connection, at), 100);
}

#[test]
fn maintenance_yields_to_an_existing_writer_without_schema_changes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let mut connection = store.connection().unwrap();
    let before: String = connection
        .query_row("SELECT group_concat(sql) FROM sqlite_master", [], |row| {
            row.get(0)
        })
        .unwrap();
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let error = LocalTaskStore::maintain_stand_in_history(&path).unwrap_err();
    assert!(
        matches!(error, TaskRuntimeError::Database(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::DatabaseBusy)
    );
    tx.commit().unwrap();
    assert_eq!(LocalTaskStore::maintain_stand_in_history(&path).unwrap(), 0);
    let after: String = connection
        .query_row("SELECT group_concat(sql) FROM sqlite_master", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(before, after);
}
