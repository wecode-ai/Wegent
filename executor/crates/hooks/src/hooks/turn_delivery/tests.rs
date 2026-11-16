// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, path::Path};

use serde_json::json;
use tempfile::tempdir;

use super::*;
use crate::hooks::model::{CommandHookConfig, HookUser};

fn git(workspace: &Path, args: &[&str]) -> Vec<u8> {
    let mut command = std::process::Command::new("git");
    wegent_workspace::native_git::clear_local_git_env(&mut command);
    let output = command
        .args(["-c", "commit.gpgsign=false", "-C"])
        .arg(workspace)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn range(workspace: &Path, content: &str) -> GitTurnRange {
    let before = wegent_workspace::turn_file_changes::GitTurnSnapshot::capture(workspace)
        .unwrap()
        .unwrap();
    fs::write(workspace.join("file.txt"), content).unwrap();
    before.freeze().unwrap()
}

fn pins(workspace: &Path) -> usize {
    String::from_utf8(git(
        workspace,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/wegent/turn-hooks",
        ],
    ))
    .unwrap()
    .lines()
    .count()
}

fn input(workspace: &Path, session: &str, turn: &str) -> TurnCompletedInput {
    TurnCompletedInput {
        event_id: String::new(),
        sequence: 0,
        user: HookUser {
            id: None,
            name: "test".to_owned(),
        },
        session_id: session.to_owned(),
        turn_id: turn.to_owned(),
        cwd: workspace.to_path_buf(),
        hook_event_name: HookEventName::TurnCompleted,
        model: None,
        permission_mode: "workspace-write".to_owned(),
        status: "completed".to_owned(),
        file_changes: json!({"version":2,"status":"error","workspace_path":workspace,"error":"capture failed"}),
    }
}

fn target(id: &str) -> Target {
    Target {
        plugin_id: "reporter".to_owned(),
        handler_id: id.to_owned(),
        directory: "/plugin".into(),
        config: CommandHookConfig {
            handler_type: "command".to_owned(),
            command: "echo frozen".to_owned(),
            command_windows: None,
            commands: BTreeMap::new(),
            timeout: 10,
            asynchronous: false,
            status_message: None,
        },
    }
}

fn complete(store: &mut Store, event: &Event, owner: &str) {
    store.ready(event.id, owner, &event.input).unwrap();
    for delivery in &event.deliveries {
        store.acknowledge(delivery.id, event.id, owner).unwrap()
    }
    assert!(store.finish(event.id, owner).unwrap());
    store.complete(event.id, owner).unwrap();
}

#[test]
fn persisted_targets_and_identity_survive_restart_without_replaying_acknowledged_handlers() {
    let home = tempdir().unwrap();
    let path = home.path().join("outbox.sqlite");
    let original = input(home.path(), "session", "turn");
    let receipt = {
        let mut store = Store::open(&path).unwrap();
        store
            .enqueue(
                original.clone(),
                None,
                vec![target("one"), target("two")],
                home.path(),
            )
            .unwrap()
    };
    let mut store = Store::open(&path).unwrap();
    let duplicate = store
        .enqueue(original, None, vec![target("changed")], home.path())
        .unwrap();
    assert_eq!(duplicate, receipt);
    let event = store
        .claim(0, "first", &["reporter".into()])
        .unwrap()
        .unwrap();
    assert_eq!(event.input.event_id, receipt.event_id);
    assert_eq!(event.input.sequence, receipt.sequence);
    assert_eq!(event.deliveries.len(), 2);
    assert_eq!(event.deliveries[0].target.config.command, "echo frozen");
    store.ready(event.id, "first", &event.input).unwrap();
    store
        .acknowledge(event.deliveries[0].id, event.id, "first")
        .unwrap();
    drop(store);

    let mut restarted = Store::open(&path).unwrap();
    assert!(
        restarted
            .claim(1, "second", &["reporter".into()])
            .unwrap()
            .is_none(),
        "live leases cannot overlap"
    );
    let recovered = restarted
        .claim(store::LEASE_MS + 1, "second", &["reporter".into()])
        .unwrap()
        .unwrap();
    assert!(recovered.ready);
    assert_eq!(recovered.deliveries.len(), 1);
    assert_eq!(recovered.deliveries[0].target.handler_id, "two");
    complete(&mut restarted, &recovered, "second");
    assert_eq!(restarted.pending().unwrap(), 0);
    assert_eq!(
        restarted
            .enqueue(
                input(home.path(), "session", "turn"),
                None,
                vec![],
                home.path()
            )
            .unwrap(),
        receipt
    );
}

#[test]
fn failed_workspace_keeps_its_order_without_blocking_other_workspaces() {
    let home = tempdir().unwrap();
    let mut store = Store::open(&home.path().join("queue.sqlite")).unwrap();
    let first = home.path().join("first");
    let second = home.path().join("second");
    for (workspace, session, turn) in [(&first, "a", "1"), (&first, "b", "2"), (&second, "c", "3")]
    {
        store
            .enqueue(
                input(workspace, session, turn),
                None,
                vec![target("one")],
                home.path(),
            )
            .unwrap();
    }
    let blocked = store
        .claim(0, "worker", &["reporter".into()])
        .unwrap()
        .unwrap();
    store.ready(blocked.id, "worker", &blocked.input).unwrap();
    store
        .retry_delivery(
            blocked.deliveries[0].id,
            blocked.id,
            "worker",
            0,
            "not ready",
        )
        .unwrap();
    assert!(!store.finish(blocked.id, "worker").unwrap());
    let independent = store
        .claim(0, "worker", &["reporter".into()])
        .unwrap()
        .unwrap();
    assert_eq!(independent.input.turn_id, "3");
    complete(&mut store, &independent, "worker");
    assert!(store
        .claim(999, "worker", &["reporter".into()])
        .unwrap()
        .is_none());
    let retry = store
        .claim(1000, "worker", &["reporter".into()])
        .unwrap()
        .unwrap();
    assert_eq!(retry.input.turn_id, "1");
    complete(&mut store, &retry, "worker");
    let next = store
        .claim(1000, "worker", &["reporter".into()])
        .unwrap()
        .unwrap();
    assert_eq!(next.input.turn_id, "2");
    complete(&mut store, &next, "worker");
}

#[test]
fn unfinished_artifact_cleanup_is_recovered_after_restart() {
    let home = tempdir().unwrap();
    let path = home.path().join("queue.sqlite");
    let mut store = Store::open(&path).unwrap();
    store
        .enqueue(
            input(home.path(), "session", "turn"),
            None,
            vec![],
            home.path(),
        )
        .unwrap();
    let event = store
        .claim(0, "old", &["reporter".into()])
        .unwrap()
        .unwrap();
    store.ready(event.id, "old", &event.input).unwrap();
    assert!(store.finish(event.id, "old").unwrap());
    assert_eq!(
        store.pending().unwrap(),
        1,
        "cleanup must remain durable work"
    );
    drop(store);
    let mut restarted = Store::open(&path).unwrap();
    let event = restarted
        .claim(store::LEASE_MS + 1, "new", &["reporter".into()])
        .unwrap()
        .unwrap();
    assert!(event.ready);
    assert!(event.deliveries.is_empty());
    restarted.complete(event.id, "new").unwrap();
    assert_eq!(restarted.pending().unwrap(), 0);
}

#[test]
fn metadata_and_database_are_private_and_contain_no_inline_source() {
    let home = tempdir().unwrap();
    let path = home.path().join("queue.sqlite");
    let mut store = Store::open(&path).unwrap();
    store
        .enqueue(
            input(home.path(), "session", "turn"),
            None,
            vec![target("one")],
            home.path(),
        )
        .unwrap();
    let event = store
        .claim(0, "worker", &["reporter".into()])
        .unwrap()
        .unwrap();
    assert!(event.input.file_changes.get("diff").is_none());
    assert!(serde_json::to_vec(&event.input).unwrap().len() < 1024);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn duplicate_ranges_release_only_redundant_pins_and_cleanup_is_durable() {
    let home = tempdir().unwrap();
    let workspace = home.path().join("repo");
    fs::create_dir(&workspace).unwrap();
    git(&workspace, &["init", "--quiet", "--template="]);
    let mut store = Store::open(&home.path().join("queue.sqlite")).unwrap();
    let original = range(&workspace, "first\n");
    let event = input(&workspace, "session", "turn");
    let receipt = store
        .enqueue(
            event.clone(),
            Some(original.clone()),
            vec![target("one")],
            home.path(),
        )
        .unwrap();
    assert_eq!(pins(&workspace), 2);
    assert_eq!(
        store
            .enqueue(event.clone(), Some(original.clone()), vec![], home.path())
            .unwrap(),
        receipt
    );
    assert!(
        store.discarded_range(0).unwrap().is_none(),
        "the original range is still needed"
    );
    let redundant = range(&workspace, "second\n");
    assert_eq!(pins(&workspace), 4);
    assert_eq!(
        store
            .enqueue(event, Some(redundant), vec![], home.path())
            .unwrap(),
        receipt
    );
    drop(store);
    let restarted = Store::open(&home.path().join("queue.sqlite")).unwrap();
    let (serialized, redundant) = restarted.discarded_range(0).unwrap().unwrap();
    redundant.release().unwrap();
    restarted.discard_released(&serialized).unwrap();
    assert_eq!(
        pins(&workspace),
        2,
        "discarding a duplicate must not release the queued range"
    );
    original.release().unwrap();
}

#[test]
fn failed_enqueue_releases_new_pins_after_transaction_rollback() {
    let home = tempdir().unwrap();
    let workspace = home.path().join("repo");
    fs::create_dir(&workspace).unwrap();
    git(&workspace, &["init", "--quiet", "--template="]);
    let mut store = Store::open(&home.path().join("queue.sqlite")).unwrap();
    rusqlite::Connection::open(home.path().join("queue.sqlite"))
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fail_enqueue BEFORE INSERT ON turn_deliveries
        BEGIN SELECT RAISE(FAIL,'injected enqueue failure'); END;",
        )
        .unwrap();
    let snapshot = range(&workspace, "new\n");
    assert_eq!(pins(&workspace), 2);

    let error = store
        .enqueue(
            input(&workspace, "session", "turn"),
            Some(snapshot),
            vec![target("one")],
            home.path(),
        )
        .unwrap_err();

    assert!(error.contains("injected enqueue failure"));
    assert_eq!(store.pending().unwrap(), 0);
    assert_eq!(pins(&workspace), 0);
}

#[test]
fn paused_consumers_preserve_data_without_blocking_other_consumers_and_resume_in_order() {
    let home = tempdir().unwrap();
    let path = home.path().join("outbox.sqlite");
    let mut store = Store::open(&path).unwrap();
    let mut bad = target("one");
    bad.plugin_id = "bad".into();
    let mut good = target("one");
    good.plugin_id = "good".into();
    for (turn, targets) in [
        ("first", vec![bad.clone(), good.clone()]),
        ("second", vec![bad, good]),
    ] {
        store
            .enqueue(
                input(home.path(), "session", turn),
                None,
                targets,
                home.path(),
            )
            .unwrap();
    }
    let active = ["bad".into(), "good".into()];
    let first = store.claim(0, "worker", &active).unwrap().unwrap();
    store.ready(first.id, "worker", &first.input).unwrap();
    store
        .retry_delivery(first.deliveries[0].id, first.id, "worker", 0, "failed")
        .unwrap();
    store
        .acknowledge(first.deliveries[1].id, first.id, "worker")
        .unwrap();
    assert!(!store.finish(first.id, "worker").unwrap());
    drop(store);

    let mut store = Store::open(&path).unwrap();
    let enabled = ["good".into()];
    let second = store.claim(0, "worker", &active).unwrap().unwrap();
    assert_eq!(second.input.turn_id, "second");
    assert_eq!(second.deliveries.len(), 1);
    assert_eq!(second.deliveries[0].target.plugin_id, "good");
    store.ready(second.id, "worker", &second.input).unwrap();
    store
        .acknowledge(second.deliveries[0].id, second.id, "worker")
        .unwrap();
    assert!(!store.finish(second.id, "worker").unwrap());
    assert_eq!(store.deliverable(&enabled).unwrap(), 0);
    assert_eq!(store.pending().unwrap(), 2, "paused inputs remain durable");
    assert_eq!(store.next_due(&enabled).unwrap(), None);
    assert!(store.claim(999, "worker", &active).unwrap().is_none());
    let resumed = store.claim(1000, "worker", &active).unwrap().unwrap();
    assert_eq!(resumed.input.turn_id, "first");
    assert_eq!(
        resumed.deliveries.len(),
        1,
        "acknowledged handler is never replayed"
    );
    complete(&mut store, &resumed, "worker");
    let next = store.claim(1000, "worker", &active).unwrap().unwrap();
    assert_eq!(next.input.turn_id, "second");
    complete(&mut store, &next, "worker");
    assert_eq!(store.pending().unwrap(), 0);
}

#[test]
fn a_paused_range_survives_restart_and_later_writes_without_losing_its_original_patch() {
    let home = tempdir().unwrap();
    let workspace = home.path().join("repo");
    fs::create_dir(&workspace).unwrap();
    git(&workspace, &["init", "--quiet", "--template="]);
    let path = home.path().join("outbox.sqlite");
    let mut store = Store::open(&path).unwrap();
    store
        .enqueue(
            input(&workspace, "session", "turn"),
            Some(range(&workspace, "original turn\n")),
            vec![target("one")],
            &home.path().join("artifacts"),
        )
        .unwrap();
    assert!(store.claim(0, "worker", &[]).unwrap().is_none());
    assert_eq!(pins(&workspace), 2);
    drop(store);
    fs::write(workspace.join("file.txt"), "later workspace contents\n").unwrap();

    let mut store = Store::open(&path).unwrap();
    let mut event = store
        .claim(0, "worker", &["reporter".into()])
        .unwrap()
        .unwrap();
    let range = event.range.take().unwrap();
    event.input.file_changes = range.materialize(&event.directory).unwrap();
    let patch = fs::read_to_string(
        event.input.file_changes["diff_artifact"]["path"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert!(patch.contains("+original turn\n"));
    assert!(!patch.contains("later workspace contents"));
    store.ready(event.id, "worker", &event.input).unwrap();
    range.release().unwrap();
    store.released(event.id, "worker").unwrap();
    complete(&mut store, &event, "worker");
    assert_eq!(pins(&workspace), 0);
    assert_eq!(store.pending().unwrap(), 0);
}

#[test]
fn paused_zero_deadline_does_not_spin_or_prevent_recovery_after_the_last_ack() {
    let home = tempdir().unwrap();
    let mut store = Store::open(&home.path().join("outbox.sqlite")).unwrap();
    let mut paused = target("paused");
    paused.plugin_id = "paused".into();
    store
        .enqueue(
            input(home.path(), "session", "turn"),
            None,
            vec![paused, target("active")],
            home.path(),
        )
        .unwrap();
    let active = ["reporter".into()];
    let event = store.claim(0, "worker", &active).unwrap().unwrap();
    store.ready(event.id, "worker", &event.input).unwrap();
    store
        .retry_delivery(event.deliveries[0].id, event.id, "worker", 0, "failure")
        .unwrap();
    assert!(!store.finish(event.id, "worker").unwrap());
    assert_eq!(store.next_due(&active).unwrap(), Some(1000));
    assert!(store.claim(999, "worker", &active).unwrap().is_none());
    let event = store.claim(1000, "worker", &active).unwrap().unwrap();
    store
        .acknowledge(event.deliveries[0].id, event.id, "worker")
        .unwrap();
    // A crash after the final acknowledgment must still leave cleanup claimable.
    store.release_owner("worker").unwrap();
    let event = store
        .claim(1000, "worker", &["paused".into()])
        .unwrap()
        .unwrap();
    store
        .acknowledge(event.deliveries[0].id, event.id, "worker")
        .unwrap();
    store.release_owner("worker").unwrap();
    let recovered = store.claim(1000, "new", &[]).unwrap().unwrap();
    assert!(recovered.deliveries.is_empty());
    assert!(store.finish(recovered.id, "new").unwrap());
    store.complete(recovered.id, "new").unwrap();
    assert_eq!(store.pending().unwrap(), 0);
}

#[test]
fn database_open_failure_releases_new_pins_and_preserves_queued_clones() {
    let home = tempdir().unwrap();
    let workspace = home.path().join("repo");
    fs::create_dir(&workspace).unwrap();
    git(&workspace, &["init", "--quiet", "--template="]);
    let registry = HookRegistryStore::new(home.path().join("executor"));
    let outbox = TurnHookOutbox::new(registry, Arc::new(Mutex::new(None)));
    let database = &outbox.inner.database;
    fs::create_dir_all(database).unwrap();
    let unqueued = range(&workspace, "unqueued\n");
    assert_eq!(pins(&workspace), 2);

    let error = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(outbox.enqueue(input(&workspace, "session", "unqueued"), Some(unqueued)));

    assert!(error.is_err());
    assert_eq!(
        pins(&workspace),
        0,
        "opening the database never transferred ownership"
    );
    fs::remove_dir(database).unwrap();
    fs::write(database, "not a SQLite database").unwrap();
    let unqueued = range(&workspace, "unreadable database\n");
    assert!(Store::enqueue_at(
        database,
        input(&workspace, "session", "corrupt-database"),
        Some(unqueued),
        vec![],
        home.path(),
    )
    .is_err());
    assert_eq!(
        pins(&workspace),
        0,
        "new pins are not owned by a corrupt database"
    );
    fs::remove_file(database).unwrap();
    let queued = range(&workspace, "queued\n");
    let event = input(&workspace, "session", "queued");
    Store::enqueue_at(
        database,
        event.clone(),
        Some(queued.clone()),
        vec![target("one")],
        home.path(),
    )
    .unwrap();
    let corrupt = rusqlite::Connection::open(database).unwrap();
    corrupt
        .execute_batch("DROP INDEX turn_pending; CREATE VIEW turn_pending AS SELECT 1;")
        .unwrap();
    drop(corrupt);

    let error = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(outbox.enqueue(event, Some(queued.clone())));

    assert!(
        error.is_err(),
        "the conflicting view must prevent Store::open"
    );
    assert_eq!(
        pins(&workspace),
        2,
        "a duplicate clone must preserve the durable range"
    );
    let restored: GitTurnRange =
        serde_json::from_value(serde_json::to_value(&queued).unwrap()).unwrap();
    let error = Store::enqueue_at(
        database,
        input(&workspace, "session", "queued"),
        Some(restored),
        vec![],
        home.path(),
    );
    assert!(error.is_err());
    assert_eq!(
        pins(&workspace),
        2,
        "restored durable ranges keep their pins"
    );
    queued.release().unwrap();
}
