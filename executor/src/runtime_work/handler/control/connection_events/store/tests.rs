use super::*;
use rusqlite::StatementStatus;

#[test]
fn legacy_data_is_ignored_and_cannot_block_the_new_store() {
    let root = tempfile::tempdir().unwrap();
    for (index, legacy) in [
        "{broken",
        "{\"version\":1,\"operations\":{\"old\":{}},\"observers\":[]}",
    ]
    .into_iter()
    .enumerate()
    {
        let path = root.path().join(format!("events-{index}.sqlite"));
        std::fs::write(path.with_extension("json"), legacy).unwrap();
        assert!(
            read(&path, Scope::Task("old"), |state| Ok(state["operations"]
                .as_object()
                .unwrap()
                .is_empty()))
            .unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(path.with_extension("json")).unwrap(),
            legacy
        );
    }
}

#[test]
fn indexed_waits_and_reclamation_do_not_scan_archived_records() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("events.sqlite");
    transact(&path, |state| {
        state["observations"]["source"] = json!({"events":[],"checkpoint":{}});
        for index in 0..2000 {
            state["operations"][format!("old-{index}")] = json!({"task_id":"task","status":"cancelled","observation_id":"source","events":[{"text":"x".repeat(1024)}]});
        }
        state["operations"]["current"] = json!({"task_id":"task","status":"armed","observation_id":"source","waiting_goal":{"objective":"wait"}});
        Ok(())
    }).unwrap();
    let connection = open(&path).unwrap();
    let mut query = connection
        .prepare("SELECT id FROM records WHERE section='operations' AND task=?1 AND waiting=1")
        .unwrap();
    assert_eq!(
        query
            .query_row(["task"], |row| row.get::<_, String>(0))
            .unwrap(),
        "current"
    );
    assert_eq!(query.get_status(StatementStatus::FullscanStep), 0);
    assert!(query.get_status(StatementStatus::VmStep) < 100);
    assert!(unreferenced(&path).unwrap().is_empty());
    update(&path, Scope::Row("operations", "current"), |state| {
        state["operations"]["current"]["status"] = json!("cancelled");
        Err::<(), _>(storage("injected failure"))
    })
    .unwrap_err();
    assert!(
        unreferenced(&path).unwrap().is_empty(),
        "A rolled-back cancellation cannot retire the collector"
    );
    update(&path, Scope::Row("operations", "current"), |state| {
        state["operations"]["current"]["status"] = json!("delivered");
        Ok(())
    })
    .unwrap();
    remove_unreferenced(&path, "source").unwrap();
    assert!(
        read(&path, Scope::Row("observations", "source"), |state| Ok(
            state["observations"].get("source").is_none()
        ))
        .unwrap()
    );
    assert_eq!(
        read(&path, Scope::Row("operations", "old-1999"), |state| Ok(
            state["operations"]["old-1999"]["events"][0]["text"]
                .as_str()
                .unwrap()
                .len()
        ))
        .unwrap(),
        1024
    );
}

#[test]
fn source_refcounts_follow_activation_cancellation_and_bounded_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("events.sqlite");
    for index in 0..100 {
        let id = format!("source-{index}");
        update(&path, Scope::Row("observations", &id), |state| {
            state["observations"][&id] =
                json!({"events":[{"text":"payload"}],"checkpoint":{"cursor":10}});
            Ok(())
        })
        .unwrap();
        update(&path, Scope::Row("observers", "ui"), |state| {
            state["observers"]["ui"] =
                json!({"id":"ui","status":"observing","observation_id":id,"expires_at":100});
            Ok(())
        })
        .unwrap();
        assert!(!unreferenced(&path).unwrap().contains(&id));
        for retired in unreferenced(&path).unwrap() {
            remove_unreferenced(&path, &retired).unwrap();
        }
        let count: i64 = open(&path)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM records WHERE section='observations'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "Old activations must not accumulate collector histories"
        );
    }
    update(&path, Scope::Row("observers", "ui"), |state| {
        state["observers"]["ui"]["status"] = json!("stopped");
        Ok(())
    })
    .unwrap();
    for retired in unreferenced(&path).unwrap() {
        remove_unreferenced(&path, &retired).unwrap();
    }
    assert_eq!(
        open(&path)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM records WHERE section='observations'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn activation_preserves_a_batch_already_captured_by_another_collector() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("events.sqlite");
    let pending = json!({"task_id":"task","observation_id":"source","status":"pending","events":[{"id":"captured"}]});
    transact(&path, |state| {
        state["observations"]["source"] = json!({"events":[],"checkpoint":{}});
        state["operations"]["wait"] = pending.clone();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        update(&path, Scope::Activation("source", "wait"), |state| Ok(
            state["operations"]["wait"].clone()
        ))
        .unwrap(),
        pending
    );
    assert_eq!(
        read(&path, Scope::Row("operations", "wait"), |state| Ok(state
            ["operations"]["wait"]
            .clone()))
        .unwrap(),
        pending
    );
}

#[test]
fn failed_projection_rolls_back_subscription_and_collector_reference() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("events.sqlite");
    transact(&path, |state| {
        state["observations"]["source"] = json!({"events":[]});
        for id in ["first", "second"] {
            state["operations"][id] =
                json!({"task_id":"task","observation_id":"source","status":"armed"});
        }
        Ok(())
    })
    .unwrap();
    open(&path)
        .unwrap()
        .execute(
            "UPDATE records SET metadata='invalid' WHERE section='operations' AND id='second'",
            [],
        )
        .unwrap();
    update_and_read(
        &path,
        Scope::Row("operations", "first"),
        |state| {
            state["operations"]["first"]["status"] = json!("cancelled");
            Ok(())
        },
        Scope::TaskProjection("task"),
    )
    .unwrap_err();
    assert_eq!(
        read(&path, Scope::Row("operations", "first"), |state| Ok(state
            ["operations"]["first"]["status"]
            .clone()))
        .unwrap(),
        "armed"
    );
    assert_eq!(
        open(&path)
            .unwrap()
            .query_row(
                "SELECT consumers FROM records WHERE section='observations' AND id='source'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );
}

#[test]
fn renewal_waits_for_an_in_process_collection_transaction() {
    use std::sync::mpsc;
    use std::thread;

    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("events.sqlite");
    let (collecting, collection_started) = mpsc::channel();
    let (commit, release_collection) = mpsc::channel();
    let (renewing, renewal_started) = mpsc::channel();
    let (renewed, renewal_finished) = mpsc::channel();

    let path = path.as_path();
    thread::scope(|scope| {
        let collection = scope.spawn(move || {
            update(path, Scope::Row("observations", "source"), |state| {
                state["observations"]["source"] = json!({"sequence":1});
                collecting.send(()).unwrap();
                release_collection.recv().unwrap();
                Ok(())
            })
        });
        collection_started.recv().unwrap();
        let renewal = scope.spawn(move || {
            renewing.send(()).unwrap();
            renewed
                .send(update(path, Scope::Row("observers", "ui"), |state| {
                    state["observers"]["ui"] = json!({"expires_at": 90_000});
                    Ok(())
                }))
                .unwrap();
        });
        renewal_started.recv().unwrap();
        let while_collecting = renewal_finished.recv_timeout(Duration::from_millis(750));
        commit.send(()).unwrap();
        collection.join().unwrap().unwrap();
        renewal.join().unwrap();

        assert!(matches!(
            while_collecting,
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        renewal_finished.recv().unwrap().unwrap();
    });
}
