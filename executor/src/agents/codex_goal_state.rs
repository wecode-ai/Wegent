//! Task-scoped native Goal data. Codex owns the SQLite schema and migrations.
use std::{fs, io, path::Path, time::Duration};

use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const DIRECTORY: &str = "goal-restoration";

#[cfg(test)]
#[path = "codex_goal_state/native_tests.rs"]
mod native_tests;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Snapshot {
    version: u32,
    pub thread_id: String,
    goal_id: String,
    objective: String,
    status: String,
    token_budget: Option<i64>,
    tokens_used: i64,
    time_used_seconds: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    continuation_deferred: bool,
}

fn invalid() -> io::Error {
    io::Error::other("Native Goal recovery data is invalid")
}

fn sql_error(_: rusqlite::Error) -> io::Error {
    io::Error::other("Native Goal storage is unavailable for recovery")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn file_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(true),
        Ok(_) => Err(io::Error::other(
            "Native Goal recovery requires regular files",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn open(home: &Path, name: &str, write: bool) -> io::Result<Option<Connection>> {
    let path = home.join(name);
    if !file_exists(&path)? {
        return Ok(None);
    }
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(path, flags).map_err(sql_error)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(sql_error)?;
    Ok(Some(db))
}

fn pending_path(home: &Path, id: &str) -> io::Result<std::path::PathBuf> {
    if !valid_id(id) {
        return Err(invalid());
    }
    let directory = home.join(DIRECTORY);
    if fs::symlink_metadata(&directory).is_ok_and(|meta| !meta.is_dir()) {
        return Err(invalid());
    }
    Ok(directory.join(format!("{id}.json")))
}

fn lock(path: &Path) -> io::Result<crate::file_lease::FileLease> {
    let parent = path.parent().ok_or_else(invalid)?;
    let mut directories = fs::DirBuilder::new();
    directories.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directories.mode(0o700);
    }
    directories.create(parent)?;
    let lock_path = path.with_extension("lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|meta| !meta.is_file()) {
        return Err(invalid());
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(lock_path)?;
    file.lock_exclusive()?;
    Ok(crate::file_lease::FileLease(file))
}

fn capture_pending(home: &Path, id: &str) -> io::Result<Option<Vec<u8>>> {
    let path = pending_path(home, id)?;
    if !file_exists(&path)? {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let snapshot = Snapshot::decode(&bytes)?;
    if snapshot.thread_id != id {
        return Err(invalid());
    }
    Ok(Some(bytes))
}

impl Snapshot {
    pub(crate) fn archive_evidence(
        &self,
        bytes: &[u8],
    ) -> wegent_protocol::session_archive::ArchivedGoal {
        use sha2::{Digest, Sha256};
        wegent_protocol::session_archive::ArchivedGoal {
            id: self.goal_id.clone(),
            objective: self.objective.clone(),
            status: self.status.clone(),
            token_budget: self.token_budget,
            created_at_ms: self.created_at_ms,
            continuation_deferred: self.continuation_deferred,
            snapshot_sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    pub(crate) fn decode(bytes: &[u8]) -> io::Result<Self> {
        let value: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if value.version != 1
            || !valid_id(&value.thread_id)
            || value.goal_id.is_empty()
            || !matches!(
                value.status.as_str(),
                "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete"
            )
            || value.token_budget.is_some_and(|budget| budget < 0)
            || value.tokens_used < 0
            || value.time_used_seconds < 0
        {
            return Err(invalid());
        }
        Ok(value)
    }
}

pub(crate) fn capture(home: &Path, id: &str) -> io::Result<Option<Vec<u8>>> {
    if !valid_id(id) {
        return Err(invalid());
    }
    let Some(db) = open(home, "goals_1.sqlite", false)? else {
        return capture_pending(home, id);
    };
    let transaction = db.unchecked_transaction().map_err(sql_error)?;
    let snapshot = transaction.query_row(
        "SELECT goal_id,objective,status,token_budget,tokens_used,time_used_seconds,created_at_ms,updated_at_ms FROM thread_goals WHERE thread_id=?1",
        [id], |row| Ok(Snapshot {version:1,thread_id:id.to_owned(),goal_id:row.get(0)?,objective:row.get(1)?,status:row.get(2)?,token_budget:row.get(3)?,tokens_used:row.get(4)?,time_used_seconds:row.get(5)?,created_at_ms:row.get(6)?,updated_at_ms:row.get(7)?,continuation_deferred:false})
    ).optional().map_err(sql_error)?;
    let Some(mut snapshot) = snapshot else {
        return capture_pending(home, id);
    };
    let has_deferrals: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_goal_continuation_deferrals')", [], |row|row.get(0)).map_err(sql_error)?;
    if has_deferrals {
        snapshot.continuation_deferred = transaction.query_row("SELECT EXISTS(SELECT 1 FROM thread_goal_continuation_deferrals WHERE thread_id=?1)", [id], |row|row.get(0)).map_err(sql_error)?;
    }
    let bytes = serde_json::to_vec(&snapshot).map_err(|_| invalid())?;
    Snapshot::decode(&bytes)?;
    Ok(Some(bytes))
}

/// Compare archived evidence with the real native API in conformance tests.
#[cfg(test)]
fn wait_context(home: &Path, id: &str, goal: &Value) -> Result<Value, &'static str> {
    let bytes = capture(home, id).map_err(|_| "native_goal_unavailable")?;
    let Some(bytes) = bytes else {
        return if goal.is_null() {
            Ok(serde_json::json!({"kind":"none"}))
        } else {
            Err("native_goal_changed")
        };
    };
    let snapshot = Snapshot::decode(&bytes).map_err(|_| "native_goal_unavailable")?;
    if !matches!(snapshot.status.as_str(), "active" | "blocked") {
        return Err("native_goal_not_waitable");
    }
    if goal["threadId"] != id
        || goal["objective"] != snapshot.objective
        || goal["status"] != snapshot.status
        || goal["tokenBudget"] != serde_json::json!(snapshot.token_budget)
        || goal["createdAt"].as_i64() != Some(snapshot.created_at_ms.div_euclid(1000))
    {
        return Err("native_goal_changed");
    }
    Ok(serde_json::json!({"kind":"goal","status":snapshot.status,
        "identity":snapshot.archive_evidence(&bytes).identity()}))
}

/// Restored rollouts do not write the native state DB; an existing row records newer local ownership.
pub(crate) fn stage(home: &Path, snapshot: &Snapshot) -> io::Result<()> {
    let path = pending_path(home, &snapshot.thread_id)?;
    let _lease = lock(&path)?;
    if let Some(db) = open(home, "state_5.sqlite", false)? {
        let present: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
                [&snapshot.thread_id],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if present {
            return Ok(());
        }
    }
    if file_exists(&path)? {
        return Ok(());
    }
    let bytes = serde_json::to_vec(snapshot).map_err(|_| invalid())?;
    crate::runtime_work::store::atomic_write_file(&path, &bytes)
}

pub(crate) fn before_request(home: &Path, method: &str, params: &Value) -> io::Result<()> {
    let Some(id) = params["threadId"].as_str() else {
        return Ok(());
    };
    if !matches!(
        method,
        "thread/resume" | "thread/goal/get" | "thread/goal/set" | "thread/goal/clear"
    ) {
        return Ok(());
    }
    let path = pending_path(home, id)?;
    if !file_exists(&path)? {
        return Ok(());
    }
    let _lease = lock(&path)?;
    if !file_exists(&path)? {
        return Ok(());
    }
    let snapshot = Snapshot::decode(&fs::read(&path)?)?;
    if snapshot.thread_id != id {
        return Err(invalid());
    }
    let mut db = open(home, "goals_1.sqlite", true)?.ok_or_else(|| {
        io::Error::other("Codex must initialize native Goal storage before recovery")
    })?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    // Preserve a newer pause, replacement or budget update. Never recreate a Goal through goal/set.
    let inserted = transaction.execute(
        "INSERT INTO thread_goals(thread_id,goal_id,objective,status,token_budget,tokens_used,time_used_seconds,created_at_ms,updated_at_ms) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE NOT EXISTS(SELECT 1 FROM thread_goals WHERE thread_id=?1)",
        params![snapshot.thread_id,snapshot.goal_id,snapshot.objective,snapshot.status,snapshot.token_budget,snapshot.tokens_used,snapshot.time_used_seconds,snapshot.created_at_ms,snapshot.updated_at_ms]
    ).map_err(sql_error)?;
    if inserted > 0 && snapshot.continuation_deferred {
        transaction
            .execute(
                "INSERT INTO thread_goal_continuation_deferrals(thread_id) VALUES(?1)",
                [id],
            )
            .map_err(sql_error)?;
    }
    transaction.commit().map_err(sql_error)?;
    fs::remove_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // SQL fixtures verify merge behavior; they do not establish real Codex compatibility.
    fn initialize(home: &Path) {
        let db = Connection::open(home.join("goals_1.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,objective TEXT NOT NULL,status TEXT NOT NULL,token_budget INTEGER,tokens_used INTEGER NOT NULL,time_used_seconds INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL); CREATE TABLE thread_goal_continuation_deferrals(thread_id TEXT PRIMARY KEY);").unwrap();
    }

    fn snapshot(id: &str) -> Snapshot {
        Snapshot {
            version: 1,
            thread_id: id.into(),
            goal_id: format!("goal-{id}"),
            objective: "Wait for resource changes".into(),
            status: "paused".into(),
            token_budget: Some(20_000),
            tokens_used: 1234,
            time_used_seconds: 56,
            created_at_ms: 100,
            updated_at_ms: 200,
            continuation_deferred: true,
        }
    }

    fn read(home: &Path, id: &str) -> Option<Snapshot> {
        capture(home, id)
            .unwrap()
            .map(|bytes| Snapshot::decode(&bytes).unwrap())
    }

    #[test]
    fn native_goal_control_inspection_uses_private_identity_and_keeps_millisecond_precision() {
        let home = tempfile::tempdir().unwrap();
        initialize(home.path());
        let mut expected = snapshot("thread-a");
        expected.status = "active".into();
        expected.created_at_ms = 1_234;
        stage(home.path(), &expected).unwrap();
        before_request(
            home.path(),
            "thread/goal/get",
            &json!({"threadId":"thread-a"}),
        )
        .unwrap();
        let api = json!({"threadId":"thread-a","objective":expected.objective,"status":"active",
            "tokenBudget":expected.token_budget,"createdAt":1});
        let context = wait_context(home.path(), "thread-a", &api).unwrap();
        assert_eq!(context["identity"]["id"], expected.goal_id);
        assert_eq!(context["identity"]["createdAtMs"], 1_234);
        for (field, value) in [
            ("threadId", json!("thread-b")),
            ("objective", json!("changed")),
            ("status", json!("blocked")),
            ("tokenBudget", json!(1)),
            ("createdAt", json!(2)),
        ] {
            let mut changed = api.clone();
            changed[field] = value;
            assert_eq!(
                wait_context(home.path(), "thread-a", &changed),
                Err("native_goal_changed")
            );
        }
    }

    #[test]
    fn native_goal_control_inspection_distinguishes_absence_from_a_paused_goal() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            wait_context(home.path(), "thread-a", &Value::Null).unwrap(),
            json!({"kind":"none"})
        );
        assert_eq!(
            wait_context(home.path(), "thread-a", &json!({"status":"active"})),
            Err("native_goal_changed")
        );
        initialize(home.path());
        let paused = snapshot("thread-a");
        stage(home.path(), &paused).unwrap();
        before_request(
            home.path(),
            "thread/goal/get",
            &json!({"threadId":"thread-a"}),
        )
        .unwrap();
        assert_eq!(
            wait_context(home.path(), "thread-a", &Value::Null),
            Err("native_goal_not_waitable")
        );
    }

    #[test]
    fn exact_goal_identity_usage_and_deferral_survive_a_fresh_home() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        initialize(source.path());
        let expected = snapshot("thread-a");
        stage(source.path(), &expected).unwrap();
        before_request(
            source.path(),
            "thread/goal/get",
            &json!({"threadId":"thread-a"}),
        )
        .unwrap();
        let other = snapshot("thread-private");
        stage(source.path(), &other).unwrap();
        before_request(
            source.path(),
            "thread/goal/get",
            &json!({"threadId":"thread-private"}),
        )
        .unwrap();
        let bytes = capture(source.path(), "thread-a").unwrap().unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("thread-private"));
        stage(target.path(), &Snapshot::decode(&bytes).unwrap()).unwrap();
        assert!(!target.path().join("goals_1.sqlite").exists());
        assert!(before_request(
            target.path(),
            "thread/resume",
            &json!({"threadId":"thread-a"})
        )
        .is_err());
        assert_eq!(read(target.path(), "thread-a"), Some(expected.clone()));
        initialize(target.path());
        before_request(
            target.path(),
            "thread/resume",
            &json!({"threadId":"thread-a"}),
        )
        .unwrap();
        assert_eq!(read(target.path(), "thread-a"), Some(expected));
        assert_eq!(read(target.path(), "thread-private"), None);
        assert!(!pending_path(target.path(), "thread-a").unwrap().exists());
    }

    #[test]
    fn newer_goal_and_explicit_goal_mutations_win_over_a_staged_snapshot() {
        let root = tempfile::tempdir().unwrap();
        initialize(root.path());
        let old = snapshot("thread-a");
        stage(root.path(), &old).unwrap();
        let db = Connection::open(root.path().join("goals_1.sqlite")).unwrap();
        db.execute("INSERT INTO thread_goals VALUES(?1,'new-goal','New objective','paused',50000,999,12,300,400)", [&old.thread_id]).unwrap();
        before_request(
            root.path(),
            "thread/resume",
            &json!({"threadId":"thread-a"}),
        )
        .unwrap();
        let current = read(root.path(), "thread-a").unwrap();
        assert_eq!(current.goal_id, "new-goal");
        assert_eq!(current.tokens_used, 999);
        assert!(!current.continuation_deferred);
        for method in ["thread/goal/set", "thread/goal/clear"] {
            let id = if method.ends_with("set") {
                "set-thread"
            } else {
                "clear-thread"
            };
            stage(root.path(), &snapshot(id)).unwrap();
            before_request(root.path(), method, &json!({"threadId":id})).unwrap();
            assert_eq!(
                read(root.path(), id),
                Some(snapshot(id)),
                "Native can reject the mutation without losing the original Goal"
            );
            before_request(root.path(), "thread/resume", &json!({"threadId":id})).unwrap();
            assert_eq!(read(root.path(), id), Some(snapshot(id)));
            db.execute(
                "DELETE FROM thread_goal_continuation_deferrals WHERE thread_id=?1",
                [id],
            )
            .unwrap();
            db.execute("DELETE FROM thread_goals WHERE thread_id=?1", [id])
                .unwrap();
            before_request(root.path(), "thread/resume", &json!({"threadId":id})).unwrap();
            assert_eq!(
                read(root.path(), id),
                None,
                "successful Native clear cannot be undone by the original snapshot"
            );
        }
    }

    #[test]
    fn a_preexisting_native_thread_keeps_its_cleared_goal() {
        let root = tempfile::tempdir().unwrap();
        initialize(root.path());
        let db = Connection::open(root.path().join("state_5.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE threads(id TEXT PRIMARY KEY); INSERT INTO threads VALUES('thread-a');",
        )
        .unwrap();
        stage(root.path(), &snapshot("thread-a")).unwrap();
        before_request(
            root.path(),
            "thread/resume",
            &json!({"threadId":"thread-a"}),
        )
        .unwrap();
        assert_eq!(read(root.path(), "thread-a"), None);
        assert!(!pending_path(root.path(), "thread-a").unwrap().exists());
    }

    #[test]
    fn invalid_goal_identity_cannot_escape_the_restored_home() {
        let root = tempfile::tempdir().unwrap();
        for id in ["../other", "", "other/thread"] {
            assert!(stage(root.path(), &snapshot(id)).is_err());
            assert!(before_request(root.path(), "thread/resume", &json!({"threadId":id})).is_err());
        }
        assert!(!root.path().join(DIRECTORY).exists());
    }

    #[test]
    fn archive_restores_only_its_bound_goal_after_the_source_home_is_destroyed() {
        use crate::envd::{
            archive::{
                create_runtime_archive, restore_runtime_archive, ArchiveMode, ArchiveOptions,
            },
            archive_sessions::SessionArchiveRoots,
        };
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source_home = source.path().join("home");
        let roots = SessionArchiveRoots::for_home(&source_home);
        let workspace = source.path().join("workspace/42");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(workspace.join(DIRECTORY)).unwrap();
        fs::write(
            workspace.join(DIRECTORY).join("user-data.json"),
            "{\"ordinary\":true}",
        )
        .unwrap();
        fs::create_dir_all(roots.executor.join("sessions/42")).unwrap();
        fs::create_dir_all(roots.codex.join("sessions")).unwrap();
        fs::write(
            roots.executor.join("sessions/42/.codex_thread_id"),
            "thread-a",
        )
        .unwrap();
        fs::write(
            roots.codex.join("sessions/rollout-date-thread-a.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
        )
        .unwrap();
        initialize(&roots.codex);
        let expected = snapshot("thread-a");
        for value in [&expected, &snapshot("private-thread")] {
            stage(&roots.codex, value).unwrap();
            before_request(
                &roots.codex,
                "thread/goal/get",
                &json!({"threadId":value.thread_id}),
            )
            .unwrap();
        }
        let archive = create_runtime_archive(ArchiveOptions {
            mode: ArchiveMode::Executor,
            task_id: "42".into(),
            workspace_path: workspace,
            home_path: source_home.clone(),
            max_size_bytes: 1_000_000,
        })
        .unwrap();
        let archived_goal = archive
            .receipt
            .sessions
            .iter()
            .find(|session| session.id == "thread-a")
            .and_then(|session| session.goal.as_ref())
            .unwrap();
        assert_eq!(archived_goal.id, expected.goal_id);
        assert_eq!(archived_goal.objective, expected.objective);
        assert_eq!(archived_goal.status, expected.status);
        assert_eq!(archived_goal.token_budget, expected.token_budget);
        assert_eq!(archived_goal.created_at_ms, expected.created_at_ms);
        assert!(archive
            .receipt
            .sessions
            .iter()
            .all(|session| session.id != "private-thread"));
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive.bytes.as_slice()));
        let names: Vec<_> = tar
            .entries()
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .path()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(names.contains(&"native-codex/goal-restoration/thread-a.json".into()));
        assert!(names
            .iter()
            .all(|name| !name.ends_with(".sqlite") && !name.contains("private-thread")));
        fs::remove_dir_all(&source_home).unwrap();
        let home = target.path().join("home");
        let workspace = target.path().join("workspace/42");
        let restored = restore_runtime_archive(
            &archive.bytes,
            ArchiveMode::Executor,
            "42",
            &workspace,
            &home,
        )
        .unwrap();
        assert!(restored.session_restored);
        assert_eq!(restored.restored_sessions, archive.receipt.sessions);
        assert_eq!(
            fs::read_to_string(workspace.join(DIRECTORY).join("user-data.json")).unwrap(),
            "{\"ordinary\":true}"
        );
        let codex = SessionArchiveRoots::for_home(&home).codex;
        assert!(!codex.join("goals_1.sqlite").exists());
        assert_eq!(read(&codex, "thread-a"), Some(expected.clone()));
        initialize(&codex);
        before_request(&codex, "thread/resume", &json!({"threadId":"thread-a"})).unwrap();
        assert_eq!(read(&codex, "thread-a"), Some(expected));
        assert_eq!(read(&codex, "private-thread"), None);
        let db = Connection::open(codex.join("goals_1.sqlite")).unwrap();
        db.execute("DELETE FROM thread_goal_continuation_deferrals", [])
            .unwrap();
        db.execute("DELETE FROM thread_goals", []).unwrap();
        let state = Connection::open(codex.join("state_5.sqlite")).unwrap();
        state.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY); INSERT INTO threads VALUES('thread-a');").unwrap();
        let cleared = restore_runtime_archive(
            &archive.bytes,
            ArchiveMode::Executor,
            "42",
            &workspace,
            &home,
        )
        .unwrap();
        assert!(cleared
            .restored_sessions
            .iter()
            .all(|session| session.goal.is_none()));
        before_request(&codex, "thread/resume", &json!({"threadId":"thread-a"})).unwrap();
        assert_eq!(
            read(&codex, "thread-a"),
            None,
            "replaying an archive cannot undo a newer Goal clear"
        );
    }

    #[test]
    fn archive_cannot_stage_a_goal_for_an_unrelated_conversation() {
        use crate::envd::archive::{restore_runtime_archive, ArchiveMode};
        let target = tempfile::tempdir().unwrap();
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let foreign = serde_json::to_string(&snapshot("thread-b")).unwrap();
        for (name, data) in [
            ("executor-state/sessions/42/.codex_thread_id", "thread-a"),
            (
                "native-codex/sessions/rollout-date-thread-a.jsonl",
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-a\"}}\n",
            ),
            (
                "native-codex/goal-restoration/thread-b.json",
                foreign.as_str(),
            ),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o600);
            header.set_cksum();
            builder
                .append_data(&mut header, name, data.as_bytes())
                .unwrap();
        }
        let bytes = builder.into_inner().unwrap().finish().unwrap();
        let home = target.path().join("home");
        let error = restore_runtime_archive(
            &bytes,
            ArchiveMode::Executor,
            "42",
            &target.path().join("workspace/42"),
            &home,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("no native conversation in this task archive"));
        assert!(!home.join(".codex/goal-restoration/thread-b.json").exists());
        assert!(!home.join(".codex/goals_1.sqlite").exists());
    }
}
