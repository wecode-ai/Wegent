// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

const ID: &str = "00000000-0000-4000-8000-000000000001";
const CHILD: &str = "00000000-0000-4000-8000-000000000002";

#[test]
fn unpublished_empty_rollouts_keep_native_readiness_recovery_and_are_migrated_once_ready() {
    let home = tempfile::tempdir().unwrap();
    let (path, tail) = fixture(home.path(), ID, false);
    let original = fs::read(&path).unwrap();
    fs::write(&path, "").unwrap();
    migrate(home.path()).unwrap();
    assert!(fs::read(&path).unwrap().is_empty());
    fs::write(&path, original).unwrap();
    migrate(home.path()).unwrap();
    assert_eq!(content(&path).split_once('\n').unwrap().1, tail);
    assert_eq!(
        serde_json::from_str::<Value>(content(&path).split_once('\n').unwrap().0).unwrap()
            ["payload"]["model_provider"],
        ROUTER
    );
}

#[test]
fn truncated_headers_and_empty_pending_journal_entries_still_fail_closed() {
    let home = tempfile::tempdir().unwrap();
    let (path, _) = fixture(home.path(), ID, false);
    let original = fs::read(&path).unwrap();
    fs::write(&path, "{\"type\":\"session_meta\"").unwrap();
    assert!(migrate(home.path()).unwrap_err().contains("Incomplete"));
    assert!(!home.path().join(JOURNAL).exists());
    fs::write(&path, original).unwrap();
    assert!(migrate_with_checkpoint(home.path(), &mut |_| Err("interrupted".into())).is_err());
    fs::write(&path, "").unwrap();
    assert!(migrate(home.path()).unwrap_err().contains("Incomplete"));
    let journal: Journal =
        serde_json::from_slice(&fs::read(home.path().join(JOURNAL)).unwrap()).unwrap();
    assert!(!journal.complete);
    assert_eq!(journal.entries.len(), 1);
}

fn fixture(home: &Path, id: &str, compressed: bool) -> (PathBuf, String) {
    let root = home.join("sessions/2026/11/09");
    fs::create_dir_all(&root).unwrap();
    let path = root.join(format!(
        "rollout-{id}.jsonl{}",
        if compressed { ".zst" } else { "" }
    ));
    let meta = json!({"type":"session_meta", "ordinal":0, "payload":{
        "id":id,"model_provider":"legacy", "creator_account_id":"synthetic-account",
        "forked_from_id":ID,"parent_id":ID,"history_base":{"rollout_id":ID,"ordinal":5},
        "history_mode":"paginated", "cwd":"/test/workspace"
    }});
    // Preserve unknown/future items, whitespace, tool identities and compacted
    // replacement history byte for byte. Only the first metadata line is parsed.
    let tail = concat!(
        "{\"type\":\"turn_context\",\"payload\":{\"approval_policy\":\"never\",\"sandbox_policy\":{\"type\":\"workspace-write\"}}}\n",
        "{\"type\":\"compacted\", \"payload\":{\"message\":\"summary\",\"replacement_history\":[]}}\n",
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"call_id\":\"call-1\",\"name\":\"exec\",\"input\":\"raw input\"}}\n",
        "{\"type\":\"future_record\", \"ordinal\": 999, \"payload\": {\"opaque\":true}}\n"
    );
    let content = format!("{meta}\n{tail}");
    let bytes = if compressed {
        zstd::stream::encode_all(content.as_bytes(), 3).unwrap()
    } else {
        content.into_bytes()
    };
    fs::write(&path, bytes).unwrap();
    (path, tail.into())
}

fn database(home: &Path) -> Connection {
    let db = Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL, title TEXT); CREATE TABLE goals (thread_id TEXT, status TEXT, tokens INTEGER); ").unwrap();
    for id in [ID, CHILD] {
        db.execute(
            "INSERT INTO threads VALUES (?1, 'legacy', 'unchanged')",
            [id],
        )
        .unwrap();
    }
    db.execute("INSERT INTO goals VALUES (?1, 'active', 2345)", [ID])
        .unwrap();
    db
}

fn content(path: &Path) -> String {
    let mut content = String::new();
    reader(path).unwrap().read_to_string(&mut content).unwrap();
    content
}

#[test]
fn migration_preserves_history_references_goals_and_archive_metadata() {
    let home = tempfile::tempdir().unwrap();
    let (plain, tail) = fixture(home.path(), ID, false);
    let (compressed, compressed_tail) = fixture(home.path(), CHILD, true);
    let archived = home.path().join("archived_sessions");
    fs::create_dir_all(&archived).unwrap();
    let target = archived.join(compressed.file_name().unwrap());
    fs::rename(compressed, &target).unwrap();
    let original_time = fs::metadata(&plain).unwrap().modified().unwrap();
    let db = database(home.path());
    migrate(home.path()).unwrap();
    for (path, tail) in [(&plain, &tail), (&target, &compressed_tail)] {
        let migrated = content(path);
        let (header, actual_tail) = migrated.split_once('\n').unwrap();
        assert_eq!(actual_tail, tail);
        let meta: Value = serde_json::from_str(header).unwrap();
        assert_eq!(meta["payload"]["model_provider"], ROUTER);
        assert_eq!(meta["payload"]["creator_account_id"], "synthetic-account");
        assert_eq!(meta["payload"]["history_base"]["rollout_id"], ID);
    }
    assert_eq!(
        fs::metadata(&plain).unwrap().modified().unwrap(),
        original_time
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM threads WHERE model_provider=?1 AND title='unchanged'",
            [ROUTER],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        db.query_row("SELECT status, tokens FROM goals", [], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, u32>(1)?
        )))
        .unwrap(),
        ("active".into(), 2345)
    );
    let before = fs::read(&plain).unwrap();
    migrate(home.path()).unwrap();
    assert_eq!(fs::read(plain).unwrap(), before);
}

#[test]
fn every_jsonl_record_keeps_its_original_byte_offset_in_plain_and_compressed_history() {
    for compressed in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let (path, _) = fixture(home.path(), ID, compressed);
        let original = content(&path);
        let offsets = |text: &str| {
            text.bytes()
                .enumerate()
                .filter_map(|(index, byte)| (byte == b'\n').then_some(index + 1))
                .collect::<Vec<_>>()
        };
        let references = offsets(&original);
        migrate(home.path()).unwrap();
        let migrated = content(&path);
        assert_eq!(migrated.len(), original.len());
        assert_eq!(offsets(&migrated), references);
        for offset in references.into_iter().take(3).skip(1) {
            assert_eq!(
                &migrated[original.find('\n').unwrap() + 1..offset],
                &original[original.find('\n').unwrap() + 1..offset]
            );
        }
    }
}

#[test]
fn metadata_conversion_only_replaces_the_raw_provider_and_never_normalizes_other_fields() {
    let before = concat!(
        " {\"type\":\"session_meta\",\"payload\":{\"id\":\"00000000-0000-4000-8000-000000000001\",",
        "\"model_provider\":\"a\\u0062\",\"future_float\":1e3,\"unicode\":\"\\u4e2d\",",
        "\"nested\":{\"model_provider\":\"leave-untouched\"}}}\r\n"
    );
    let after = rewrite_metadata(before).unwrap();
    let start = before.find("\"a\\u0062\"").unwrap();
    let end = start + "\"a\\u0062\"".len();
    assert_eq!(before.len(), after.len());
    assert_eq!(&before[..start], &after[..start]);
    assert_eq!(&before[end..], &after[end..]);
    assert_eq!(
        serde_json::from_str::<Value>(&after).unwrap()["payload"]["model_provider"],
        ROUTER
    );
    assert_eq!(
        ROUTER.len(),
        1,
        "all nonempty legacy provider values must have enough byte space"
    );
}

#[test]
fn migration_preserves_history_in_native_homes_beyond_windows_max_path() {
    let root = tempfile::tempdir().unwrap();
    let mut home = root.path().to_owned();
    for _ in 0..5 {
        home.push("long-agent-provider-migration-directory-".repeat(2));
    }
    let (path, tail) = fixture(&home, ID, false);
    assert!(path.as_os_str().len() > 260);
    let before = fs::read(&path).unwrap();
    migrate(&home).unwrap();
    let after = fs::read(&path).unwrap();
    assert_eq!(before.len(), after.len());
    assert_eq!(content(&path).split_once('\n').unwrap().1, tail);
    migrate(&home).unwrap();
    assert_eq!(fs::read(&path).unwrap(), after);
}

#[test]
fn older_metadata_without_a_saved_provider_remains_byte_identical() {
    for explicit_null in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let (path, tail) = fixture(home.path(), ID, false);
        let mut metadata: Value =
            serde_json::from_str(content(&path).lines().next().unwrap()).unwrap();
        if explicit_null {
            metadata["payload"]["model_provider"] = Value::Null;
        } else {
            metadata["payload"]
                .as_object_mut()
                .unwrap()
                .remove("model_provider");
        }
        let original = format!("{metadata}\n{tail}");
        fs::write(&path, &original).unwrap();
        let db = database(home.path());
        migrate(home.path()).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        assert_eq!(
            db.query_row(
                "SELECT model_provider FROM threads WHERE id=?1",
                [ID],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            ROUTER
        );
    }
}

#[test]
fn restart_finishes_interrupted_rollout_and_index_publication_without_replaying_history() {
    let home = tempfile::tempdir().unwrap();
    let (path, tail) = fixture(home.path(), ID, false);
    let db = database(home.path());
    migrate(home.path()).unwrap();
    let journal_path = home.path().join(JOURNAL);
    let mut journal: Journal = serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    journal.complete = false;
    save(&journal_path, &journal).unwrap();
    db.execute(
        "UPDATE threads SET model_provider='legacy' WHERE id=?1",
        [ID],
    )
    .unwrap();
    // Simulate process death after atomic rollout publication but before DB commit.
    migrate(home.path()).unwrap();
    assert_eq!(content(&path).split_once('\n').unwrap().1, tail);
    assert_eq!(
        db.query_row(
            "SELECT model_provider FROM threads WHERE id=?1",
            [ID],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        ROUTER
    );
}

#[test]
fn every_durable_boundary_converges_after_interruption_without_losing_goal_or_turn_data() {
    for stopped_at in [
        Phase::JournalPublished,
        Phase::RolloutPublished(0),
        Phase::RolloutPublished(1),
        Phase::DatabaseCommitted(0),
        Phase::DatabaseCommitted(1),
    ] {
        let home = tempfile::tempdir().unwrap();
        let (parent, tail) = fixture(home.path(), ID, false);
        let (child, child_tail) = fixture(home.path(), CHILD, true);
        let db = database(home.path());
        fs::copy(
            home.path().join("state_5.sqlite"),
            home.path().join("state_6.sqlite"),
        )
        .unwrap();
        let mut reached = false;
        let interrupted = migrate_with_checkpoint(home.path(), &mut |phase| {
            if phase == stopped_at {
                reached = true;
                return Err("simulated interruption".into());
            }
            Ok(())
        });
        assert!(reached, "fault boundary not reached: {stopped_at:?}");
        assert_eq!(interrupted, Err("simulated interruption".into()));
        migrate(home.path()).unwrap();
        migrate(home.path()).unwrap();
        assert_eq!(content(&parent).split_once('\n').unwrap().1, tail);
        assert_eq!(content(&child).split_once('\n').unwrap().1, child_tail);
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM threads WHERE model_provider=?1",
                [ROUTER],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT status, tokens FROM goals", [], |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?
            )))
            .unwrap(),
            ("active".into(), 2345)
        );
        let journal: Journal =
            serde_json::from_slice(&fs::read(home.path().join(JOURNAL)).unwrap()).unwrap();
        assert!(journal.complete);
        assert_eq!(journal.entries.len(), 2);
    }
}

#[test]
fn active_native_writer_blocks_migration_without_changing_any_data() {
    let home = tempfile::tempdir().unwrap();
    let (path, _) = fixture(home.path(), ID, false);
    let locks = home.path().join("thread-writer-locks");
    fs::create_dir_all(&locks).unwrap();
    let _writer = lock(&locks.join(format!("{ID}.lock"))).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(migrate(home.path()).unwrap_err().contains("live writer"));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!home.path().join(JOURNAL).exists());
    drop(_writer);
    migrate(home.path()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(content(&path).lines().next().unwrap()).unwrap()["payload"]
            ["model_provider"],
        ROUTER
    );
}

#[test]
fn a_later_migration_does_not_republish_a_materialized_compressed_rollout() {
    let home = tempfile::tempdir().unwrap();
    let (compressed, _) = fixture(home.path(), ID, true);
    migrate(home.path()).unwrap();
    let plain = compressed.with_extension("");
    let mut resumed = content(&compressed);
    resumed.push_str("{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"after-upgrade\"}}\n");
    fs::write(&plain, &resumed).unwrap();
    fs::remove_file(compressed).unwrap();
    fixture(home.path(), CHILD, false);
    migrate(home.path()).unwrap();
    assert_eq!(fs::read_to_string(plain).unwrap(), resumed);
}

#[test]
fn interrupted_migration_recovers_after_rollback_materializes_and_extends_compressed_history() {
    let home = tempfile::tempdir().unwrap();
    let (compressed, _) = fixture(home.path(), ID, true);
    let db = database(home.path());
    let result = migrate_with_checkpoint(home.path(), &mut |phase| {
        if phase == Phase::RolloutPublished(0) {
            Err("interrupted".into())
        } else {
            Ok(())
        }
    });
    assert_eq!(result, Err("interrupted".into()));
    let plain = compressed.with_extension("");
    let mut resumed = content(&compressed);
    resumed.push_str("{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"continued-during-rollback\"}}\n");
    fs::write(&plain, &resumed).unwrap();
    fs::remove_file(compressed).unwrap();
    db.execute(
        "UPDATE threads SET model_provider='secondary-api' WHERE id=?1",
        [ID],
    )
    .unwrap();
    migrate(home.path()).unwrap();
    assert_eq!(fs::read_to_string(plain).unwrap(), resumed);
    let journal: Journal =
        serde_json::from_slice(&fs::read(home.path().join(JOURNAL)).unwrap()).unwrap();
    assert!(journal.complete);
    assert!(journal.index_routes["state_5.sqlite"][ID].contains("secondary-api"));
    assert_eq!(
        db.query_row(
            "SELECT model_provider FROM threads WHERE id=?1",
            [ID],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        ROUTER
    );
    assert_eq!(
        db.query_row("SELECT status FROM goals", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "active"
    );
}

#[test]
fn immutable_rollouts_keep_independent_original_providers_for_the_same_logical_thread() {
    let home = tempfile::tempdir().unwrap();
    let (original, tail) = fixture(home.path(), ID, false);
    let archive = home.path().join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    let historical = archive.join(format!("rollout-{ID}_historical.jsonl"));
    let source = content(&original);
    let (header, _) = source.split_once('\n').unwrap();
    let mut metadata: Value = serde_json::from_str(header).unwrap();
    metadata["payload"]["model_provider"] = json!("secondary-api");
    fs::write(&historical, format!("{metadata}\n{tail}")).unwrap();
    migrate(home.path()).unwrap();
    assert_eq!(content(&original).split_once('\n').unwrap().1, tail);
    assert_eq!(content(&historical).split_once('\n').unwrap().1, tail);
    let journal: Journal =
        serde_json::from_slice(&fs::read(home.path().join(JOURNAL)).unwrap()).unwrap();
    assert_eq!(journal.entries.len(), 2);
    assert!(journal
        .entries
        .iter()
        .any(|entry| entry.provider == "legacy" && entry.thread_id == ID));
    assert!(journal
        .entries
        .iter()
        .any(|entry| entry.provider == "secondary-api" && entry.thread_id == ID));
}

#[test]
fn upgrading_again_after_legacy_resume_reconciles_the_index_without_restoring_stale_history() {
    let home = tempfile::tempdir().unwrap();
    let (path, _) = fixture(home.path(), ID, false);
    let db = database(home.path());
    migrate(home.path()).unwrap();
    // Observed with the real 0.165.0 binary: resume rewrites this index column
    // while the migrated rollout header remains wework-router.
    db.execute(
        "UPDATE threads SET model_provider='legacy' WHERE id=?1",
        [ID],
    )
    .unwrap();
    let mut after_rollback = content(&path);
    after_rollback.push_str("{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"continued-after-rollback\"}}\n");
    fs::write(&path, &after_rollback).unwrap();
    migrate(home.path()).unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), after_rollback);
    assert_eq!(
        db.query_row(
            "SELECT model_provider FROM threads WHERE id=?1",
            [ID],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        ROUTER
    );
    assert_eq!(
        db.query_row("SELECT status FROM goals", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "active"
    );
}

#[test]
fn migration_journal_cannot_change_permissions_or_account_identity() {
    let home = tempfile::tempdir().unwrap();
    let (path, _) = fixture(home.path(), ID, false);
    let db = database(home.path());
    migrate(home.path()).unwrap();
    let mut journal: Journal =
        serde_json::from_slice(&fs::read(home.path().join(JOURNAL)).unwrap()).unwrap();
    journal.complete = false;
    let current = content(&path);
    let (header, tail) = current.split_once('\n').unwrap();
    let mut forged: Value = serde_json::from_str(header).unwrap();
    forged["payload"]["creator_account_id"] = json!("another-account");
    let forged = rewrite_metadata(&format!("{forged}\n").replace("\"~\"", "\"legacy\"")).unwrap();
    journal.entries[0].after_sha256 = metadata_hash(&forged);
    fs::write(&path, format!("{forged}{tail}")).unwrap();
    save(&home.path().join(JOURNAL), &journal).unwrap();
    assert!(migrate(home.path())
        .unwrap_err()
        .contains("only change the provider"));
    assert_eq!(content(&path), format!("{forged}{tail}"));
    assert_eq!(
        db.query_row("SELECT tokens FROM goals", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        2345
    );
}

#[test]
fn migration_journal_does_not_duplicate_base_instructions() {
    let home = tempfile::tempdir().unwrap();
    let (path, tail) = fixture(home.path(), ID, false);
    let mut header: Value =
        serde_json::from_str(content(&path).split_once('\n').unwrap().0).unwrap();
    header["payload"]["base_instructions"] = json!("private-instruction-sentinel".repeat(4096));
    fs::write(&path, format!("{header}\n{tail}")).unwrap();
    migrate(home.path()).unwrap();
    let journal = fs::read_to_string(home.path().join(JOURNAL)).unwrap();
    assert!(journal.len() < 2048);
    assert!(!journal.contains("private-instruction-sentinel"));
    assert!(content(&path).contains("private-instruction-sentinel"));
}

#[test]
fn legacy_snapshot_journal_compacts_and_recovers_after_publication_interruption() {
    for already_published in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let (path, tail) = fixture(home.path(), ID, false);
        let before = first_line(&mut reader(&path).unwrap()).unwrap();
        let after = rewrite_metadata(&before).unwrap();
        let legacy = json!({"version":2,"complete":false,"pending_from":0,"entries":[{
            "path":path.strip_prefix(home.path()).unwrap(), "thread_id":ID,
            "provider":"legacy", "before":before, "after":after
        }]});
        fs::write(
            home.path().join(JOURNAL),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        if already_published {
            fs::write(&path, format!("{after}{tail}")).unwrap();
        }
        let db = database(home.path());
        assert!(migrate_with_checkpoint(home.path(), &mut |phase| {
            assert_eq!(phase, Phase::JournalPublished);
            Err("interrupted compaction".into())
        })
        .unwrap_err()
        .contains("interrupted compaction"));
        let journal: Value =
            serde_json::from_slice(&fs::read(home.path().join(JOURNAL)).unwrap()).unwrap();
        assert_eq!(journal["version"], JOURNAL_VERSION);
        assert!(journal["entries"][0].get("before").is_none());
        migrate(home.path()).unwrap();
        assert_eq!(content(&path), format!("{after}{tail}"));
        assert_eq!(
            db.query_row("SELECT tokens FROM goals", [], |r| r.get::<_, u32>(0))
                .unwrap(),
            2345
        );
    }
}

#[test]
fn a_busy_database_is_retried_to_consistency_after_its_writer_releases() {
    let home = tempfile::tempdir().unwrap();
    let (path, tail) = fixture(home.path(), ID, false);
    let db = database(home.path());
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = fs::read(&path).unwrap();
    assert!(migrate(home.path()).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    db.execute_batch("ROLLBACK").unwrap();
    migrate(home.path()).unwrap();
    assert_eq!(content(&path).split_once('\n').unwrap().1, tail);
    assert_eq!(
        db.query_row(
            "SELECT model_provider FROM threads WHERE id=?1",
            [ID],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        ROUTER
    );
}

#[test]
fn legacy_provider_switch_rebuilds_the_derived_index_and_retains_its_provenance() {
    let home = tempfile::tempdir().unwrap();
    let (path, _) = fixture(home.path(), ID, false);
    let db = database(home.path());
    db.execute(
        "UPDATE threads SET model_provider='another-provider' WHERE id=?1",
        [ID],
    )
    .unwrap();
    let tail = content(&path).split_once('\n').unwrap().1.to_owned();
    migrate(home.path()).unwrap();
    assert_eq!(content(&path).split_once('\n').unwrap().1, tail);
    assert_eq!(
        db.query_row(
            "SELECT model_provider FROM threads WHERE id=?1",
            [ID],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        ROUTER
    );
    let journal: Journal =
        serde_json::from_slice(&fs::read(home.path().join(JOURNAL)).unwrap()).unwrap();
    assert!(journal.index_routes["state_5.sqlite"][ID].contains("another-provider"));
}

#[test]
fn corrupt_rollout_does_not_migrate_other_sessions() {
    let home = tempfile::tempdir().unwrap();
    let (path, _) = fixture(home.path(), ID, false);
    fs::write(
        path.parent().unwrap().join("rollout-corrupt.jsonl"),
        "{invalid}\n",
    )
    .unwrap();
    let before = fs::read(&path).unwrap();
    assert!(migrate(home.path()).is_err());
    assert_eq!(fs::read(path).unwrap(), before);
    assert!(!home.path().join(JOURNAL).exists());
}

#[cfg(unix)]
#[test]
fn linked_storage_is_rejected_without_reading_or_mutating_its_target() {
    let home = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let (path, _) = fixture(other.path(), ID, false);
    let before = fs::read(&path).unwrap();
    std::os::unix::fs::symlink(other.path().join("sessions"), home.path().join("sessions"))
        .unwrap();
    assert!(migrate(home.path()).unwrap_err().contains("Symlink"));
    assert_eq!(fs::read(path).unwrap(), before);
}
