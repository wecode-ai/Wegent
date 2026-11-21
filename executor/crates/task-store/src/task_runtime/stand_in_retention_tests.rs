use super::*;

fn insert(connection: &Connection, id: &str, kind: &str, at: &str) {
    connection.execute(
        "INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at) VALUES (?1,?2,'not JSON',?3,?3)",
        params![id, kind, at],
    ).unwrap();
}

fn prune(connection: &Connection, at: chrono::DateTime<Utc>) -> usize {
    // Retention semantics must not depend on scheduling under the parallel suite.
    // Budget exhaustion and chunk rollback are verified independently.
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
fn exhausted_budget_yields_without_mutations_or_holding_the_writer() {
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
    assert_eq!(
        LocalTaskStore::prune_stand_in_history(&connection, at, Duration::ZERO).unwrap(),
        0
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

fn indexed(connection: &Connection, kind: &str, value: Value, at: chrono::DateTime<Utc>) {
    super::super::stand_in_processing::write(connection, kind, &value).unwrap();
    connection
        .execute(
            "UPDATE loop_items SET created_at=?2,updated_at=?2 WHERE id=?1",
            params![value["id"].as_str(), at.to_rfc3339()],
        )
        .unwrap();
}

#[test]
fn indexed_retention_preserves_recovery_references_and_deduplication() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let connection = store.connection().unwrap();
    let at = Utc::now();
    let old = at - chrono::Duration::days(8);
    for (id, status) in [
        ("pending", "pending"),
        ("claimed", "handled"),
        ("snapshot", "handled"),
        ("settled", "handled"),
    ] {
        indexed(
            &connection,
            "stand_in_event",
            json!({"id":id,"userId":7,"status":status,"createdAt":old.to_rfc3339(),"message":{"text":"payload"}}),
            old,
        );
    }
    for (id, status, batch, events) in [
        ("queued", "pending", "queued", json!([])),
        ("sending", "sending", "sending", json!(["claimed"])),
        ("current", "failed", "current", json!([])),
        ("uncertain", "failed", "other", json!([])),
        ("latest-failure", "failed", "failed", json!(["pending"])),
        ("older-failure", "failed", "older", json!(["pending"])),
        ("expired", "succeeded", "expired", json!([])),
    ] {
        let age = if id == "older-failure" {
            old - chrono::Duration::seconds(1)
        } else {
            old
        };
        indexed(
            &connection,
            "stand_in_action",
            json!({"id":id,"userId":7,"status":status,"kind":"continue_work","batchId":batch,"arguments":{"eventIds":events}}),
            age,
        );
    }
    indexed(
        &connection,
        "stand_in_processing",
        json!({"id":"state","userId":7,"batchId":"current","error":{"commandId":"uncertain"},"snapshot":{"events":[{"id":"snapshot"}]},"routerSnapshot":{"id":"router"}}),
        at,
    );
    for (id, batch) in [
        ("expired-route", "expired"),
        ("current-route", "current"),
        ("failed-route", "failed"),
        ("router-route", "router"),
    ] {
        indexed(
            &connection,
            "stand_in_route",
            json!({"id":id,"userId":7,"result":{"snapshotId":batch}}),
            old,
        );
    }
    // Invalid historical payloads prove that maintenance reads only stored facts.
    connection
        .execute(
            "UPDATE loop_items SET metadata='not JSON' WHERE resource_type!='project'",
            [],
        )
        .unwrap();
    assert_eq!(prune(&connection, at), 4);
    for id in [
        "queued",
        "sending",
        "current",
        "uncertain",
        "latest-failure",
        "pending",
        "claimed",
        "snapshot",
        "current-route",
        "failed-route",
        "router-route",
    ] {
        assert!(
            connection
                .query_row("SELECT 1 FROM loop_items WHERE id=?1", [id], |row| row
                    .get::<_, i64>(0))
                .is_ok(),
            "{id}"
        );
    }
    for id in ["expired", "older-failure", "expired-route"] {
        assert!(
            connection
                .query_row("SELECT 1 FROM loop_items WHERE id=?1", [id], |row| row
                    .get::<_, i64>(0))
                .is_err(),
            "{id}"
        );
    }
    let marker: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE id='settled'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let marker: Value = serde_json::from_str(&marker).unwrap();
    assert_eq!(marker["compacted"], true);
    assert_eq!(marker["createdAt"], old.to_rfc3339());
    assert!(marker.get("message").is_none());
    assert_eq!(prune(&connection, at), 0);
}

#[test]
fn indexed_write_replaces_references_atomically() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let connection = store.connection().unwrap();
    let at = Utc::now();
    let mut action =
        json!({"id":"action","userId":7,"status":"pending","arguments":{"eventIds":["before"]}});
    indexed(&connection, "stand_in_action", action.clone(), at);
    connection.execute_batch("CREATE TRIGGER reject_ref BEFORE INSERT ON stand_in_history_refs WHEN NEW.event_id='reject' BEGIN SELECT RAISE(ABORT,'injected write failure'); END").unwrap();
    action["status"] = json!("failed");
    action["arguments"]["eventIds"] = json!(["reject"]);
    assert!(
        super::super::stand_in_processing::write(&connection, "stand_in_action", &action).is_err()
    );
    let (status,event):(String,String)=connection.query_row("SELECT h.status,r.event_id FROM stand_in_history h JOIN stand_in_history_refs r ON r.owner_id=h.id WHERE h.id='action'",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!((status, event), ("pending".into(), "before".into()));
    let payload: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE id='action'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&payload).unwrap()["status"],
        "pending"
    );
    action["arguments"]["eventIds"] = json!(["after"]);
    super::super::stand_in_processing::write(&connection, "stand_in_action", &action).unwrap();
    let refs: Vec<String> = connection
        .prepare("SELECT event_id FROM stand_in_history_refs")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(refs, vec!["after"]);
}

#[test]
fn explicit_retry_indexes_legacy_and_existing_actions_before_retention() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let at = Utc::now();
    let old = at - chrono::Duration::days(8);
    {
        let connection = store.connection().unwrap();
        for id in ["legacy", "indexed"] {
            let event = format!("event-{id}");
            indexed(
                &connection,
                "stand_in_event",
                json!({"id":event,"userId":7,"status":"pending"}),
                at,
            );
            indexed(
                &connection,
                "stand_in_action",
                json!({"id":id,"userId":7,"kind":"create_work","status":"failed","arguments":{"eventIds":[event]}}),
                at,
            );
        }
        connection
            .execute("DELETE FROM stand_in_history WHERE id='legacy'", [])
            .unwrap();
        indexed(
            &connection,
            "stand_in_processing",
            json!({"id":"stand-in-processing:7","userId":7,"routingRetry":{"id":"request","before":(at + chrono::Duration::seconds(1)).to_rfc3339()}}),
            at,
        );
    }
    assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 2);
    let connection = store.connection().unwrap();
    for id in ["legacy", "indexed"] {
        let status: String = connection
            .query_row(
                "SELECT status FROM stand_in_history WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
        let reference: String = connection
            .query_row(
                "SELECT event_id FROM stand_in_history_refs WHERE owner_id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reference, format!("event-{id}"));
        connection
            .execute(
                "UPDATE loop_items SET updated_at=?2 WHERE id=?1",
                params![id, old.to_rfc3339()],
            )
            .unwrap();
    }
    assert_eq!(prune(&connection, at), 0);
    let retained: usize = connection
        .query_row(
            "SELECT count(*) FROM loop_items WHERE id IN ('legacy','indexed')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 2);
}

#[test]
fn failure_of_another_action_kind_preserves_explicit_create_retry() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let at = Utc::now();
    let old = at - chrono::Duration::days(8);
    {
        let connection = store.connection().unwrap();
        indexed(
            &connection,
            "stand_in_event",
            json!({"id":"event","userId":7,"status":"pending"}),
            old,
        );
        for (id, kind, created) in [
            ("create", "create_work", old),
            (
                "continue",
                "continue_work",
                old + chrono::Duration::seconds(1),
            ),
        ] {
            indexed(
                &connection,
                "stand_in_action",
                json!({"id":id,"userId":7,"kind":kind,"status":"failed","arguments":{"eventIds":["event"]}}),
                created,
            );
        }
        assert_eq!(prune(&connection, at), 0);
        indexed(
            &connection,
            "stand_in_processing",
            json!({"id":"stand-in-processing:7","userId":7,"routingRetry":{"id":"request","before":at.to_rfc3339()}}),
            at,
        );
    }
    assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 1);
    let connection = store.connection().unwrap();
    let status: String = connection
        .query_row(
            "SELECT status FROM stand_in_history WHERE id='create'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "pending");
}

#[test]
fn opening_existing_database_adds_indexes_without_backfilling_payloads() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    {
        let connection = store.connection().unwrap();
        insert(
            &connection,
            "legacy",
            "stand_in_event",
            &Utc::now().to_rfc3339(),
        );
        connection
            .execute_batch(
                "DROP TABLE stand_in_history_refs; DROP TABLE stand_in_history;
             DROP INDEX ix_stand_in_history_retention; DROP INDEX ix_stand_in_live_work;
             DROP INDEX ix_stand_in_recent_actions; DROP INDEX ix_stand_in_recent_suggestions;
             INSERT INTO loop_items(id,resource_type,metadata,created_at,updated_at)
             VALUES ('legacy-pending','stand_in_event',json_object('status','pending','userId',7),
                     CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
                    ('legacy-suggestion','stand_in_action',
                     json_object('id','legacy-suggestion','userId',7,'kind','suggest_action'),
                     CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
                    ('legacy-cancelled','stand_in_action',
                     json_object('id','legacy-cancelled','userId',7,'kind','suggest_action','status','cancelled'),
                     CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
                    ('legacy-foreign','stand_in_action',json_object('userId',8,'kind','suggest_action'),
                     CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
                    ('legacy-broken','stand_in_action','not JSON',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);",
            )
            .unwrap();
    }
    drop(store);
    let store = LocalTaskStore::open(&path).unwrap();
    let actions = store.recent_stand_in_actions(7, 50).unwrap();
    assert_eq!(actions.len(), 2);
    assert_eq!(actions[0]["id"], "legacy-suggestion");
    assert_eq!(actions[1]["id"], "legacy-cancelled");
    assert_eq!(store.recent_stand_in_suggestions(7).unwrap(), actions[..1]);
    assert!(store.stand_in_has_due_work(7).unwrap());
    assert!(!store.stand_in_has_due_work(8).unwrap());
    assert!(store.unfinished_arrangement_users().unwrap().is_empty());
    let connection = store.connection().unwrap();
    let count: i64 = connection
        .query_row("SELECT count(*) FROM stand_in_history", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    let metadata: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE id='legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(metadata, "not JSON");
    let plan: Vec<String> = connection
        .prepare(&format!(
            "EXPLAIN QUERY PLAN SELECT l.id FROM loop_items l WHERE {EXPIRED} LIMIT ?2"
        ))
        .unwrap()
        .query_map(params![Utc::now().to_rfc3339(), 100], |row| row.get(3))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(plan.iter().any(|step|step.contains("ix_stand_in_history_retention")&&step.contains("<expr><?")),"{plan:?}");
    let ref_plan: Vec<String> = connection
        .prepare("EXPLAIN QUERY PLAN SELECT owner_id FROM stand_in_history_refs WHERE event_id=?1")
        .unwrap()
        .query_map(["event"], |row| row.get(3))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        ref_plan
            .iter()
            .any(|step| step.contains("ix_stand_in_history_event_ref")),
        "{ref_plan:?}"
    );
    let delete_plan: Vec<String> = connection
        .prepare("EXPLAIN QUERY PLAN DELETE FROM loop_items WHERE id=?1")
        .unwrap()
        .query_map(["legacy"], |row| row.get(3))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        delete_plan
            .iter()
            .any(|step| step.contains("ix_loop_items_loop_item_id")),
        "{delete_plan:?}"
    );
    assert!(
        delete_plan
            .iter()
            .any(|step| step.contains("ix_loop_items_delivery_id")),
        "{delete_plan:?}"
    );
    assert!(
        !delete_plan
            .iter()
            .any(|step| step.starts_with("SCAN loop_items")),
        "{delete_plan:?}"
    );
}

#[test]
fn failed_chunk_keeps_committed_progress_and_resumes_after_reopening() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let at = Utc::now();
    {
        let connection = store.connection().unwrap();
        let old = (at - chrono::Duration::days(8)).to_rfc3339();
        for index in 0..60 {
            insert(
                &connection,
                &format!("old-{index:03}"),
                "stand_in_action",
                &old,
            );
        }
        connection.execute_batch("CREATE TRIGGER stop_second_chunk BEFORE DELETE ON loop_items WHEN OLD.id='old-030' BEGIN SELECT RAISE(ABORT,'injected interruption'); END").unwrap();
        assert!(
            LocalTaskStore::prune_stand_in_history(&connection, at, Duration::from_secs(10))
                .is_err()
        );
        let remaining: i64 = connection
            .query_row(
                "SELECT count(*) FROM loop_items WHERE resource_type='stand_in_action'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 35);
        let cursor:String=connection.query_row("SELECT item_id FROM stand_in_retention_cursor WHERE resource_type='stand_in_action'",[],|row|row.get(0)).unwrap();
        assert_eq!(cursor, "old-024");
        connection
            .execute_batch("DROP TRIGGER stop_second_chunk")
            .unwrap();
    }
    drop(store);
    let reopened = LocalTaskStore::open(&path).unwrap();
    let connection = reopened.connection().unwrap();
    assert_eq!(prune(&connection, at), 35);
}

#[test]
fn protected_prefix_advances_cursor_instead_of_starving_later_expired_events() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let connection = store.connection().unwrap();
    let at = Utc::now();
    let old = at - chrono::Duration::days(8);
    for index in 0..100 {
        indexed(
            &connection,
            "stand_in_event",
            json!({"id":format!("event-{index:03}"),"userId":7,"status":"pending"}),
            old,
        );
    }
    indexed(
        &connection,
        "stand_in_event",
        json!({"id":"event-100","userId":7,"status":"handled","message":{"text":"payload"}}),
        old,
    );
    assert_eq!(prune(&connection, at), 0);
    assert_eq!(prune(&connection, at), 0);
    assert_eq!(prune(&connection, at), 1);
    let payload: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE id='event-100'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&payload).unwrap()["compacted"],
        true
    );
    let pending: i64 = connection
        .query_row(
            "SELECT count(*) FROM stand_in_history WHERE status='pending'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending, 100);
}

#[test]
fn foreground_reference_write_invalidates_cleanup_snapshot_before_deletion() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    let connection = store.connection().unwrap();
    let at = Utc::now();
    indexed(
        &connection,
        "stand_in_action",
        json!({"id":"action","userId":7,"status":"succeeded","kind":"ignore_events","batchId":"batch"}),
        at - chrono::Duration::days(8),
    );
    let tx =
        rusqlite::Transaction::new_unchecked(&connection, TransactionBehavior::Deferred).unwrap();
    let change = LocalTaskStore::plan_history_record(&tx, at, "action")
        .unwrap()
        .unwrap();
    let writer = Connection::open(&path).unwrap();
    writer.busy_timeout(Duration::ZERO).unwrap();
    indexed(
        &writer,
        "stand_in_processing",
        json!({"id":"state","userId":7,"batchId":"batch"}),
        at,
    );
    let error = LocalTaskStore::apply_history_changes(&tx, vec![change]).unwrap_err();
    assert!(
        matches!(error,TaskRuntimeError::Database(rusqlite::Error::SqliteFailure(code,_)) if code.extended_code==rusqlite::ffi::SQLITE_BUSY_SNAPSHOT)
    );
    drop(tx);
    assert_eq!(prune(&connection, at), 0);
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM loop_items WHERE id='action'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}
