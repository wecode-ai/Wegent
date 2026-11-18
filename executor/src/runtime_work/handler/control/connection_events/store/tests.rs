use super::*;
use rusqlite::StatementStatus;

#[test]
fn import_is_atomic_idempotent_and_keeps_the_original_for_recovery() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("events.sqlite");
    let legacy = path.with_extension("json");
    let original = json!({"version":1,"operations":{"wait":{"task_id":"任务","status":"armed","observation_id":"source","waiting_goal":{"objective":"wait"}}},"observations":{"source":{"checkpoint":{"cursor":42},"events":[{"text":"original"}]}},"observers":{}});
    std::fs::write(&legacy, original.to_string()).unwrap();
    assert_eq!(
        transact(&path, |state| Ok(state.clone())).unwrap(),
        original
    );
    update(&path, Scope::Row("operations", "wait"), |state| {
        state["operations"]["wait"]["status"] = json!("cancelled");
        Ok(())
    })
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(&legacy).unwrap(),
        original.to_string()
    );
    assert_eq!(
        read(&path, Scope::Row("operations", "wait"), |state| Ok(state
            ["operations"]["wait"]["status"]
            .clone()))
        .unwrap(),
        "cancelled"
    );
    assert_eq!(unreferenced(&path).unwrap(), vec!["source"]);
    std::fs::write(&legacy, "corrupt old snapshot").unwrap();
    assert!(read(&path, Scope::Waiting("任务"), |state| Ok(state
        ["operations"]
        .as_object()
        .unwrap()
        .is_empty()))
    .unwrap());

    let failed = root.path().join("failed.sqlite");
    std::fs::write(failed.with_extension("json"), "{broken").unwrap();
    assert!(open(&failed).is_err());
    let connection = Connection::open(&failed).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    std::fs::write(failed.with_extension("json"), original.to_string()).unwrap();
    assert!(open(&failed).is_ok());
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
