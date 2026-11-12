// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Child, Command, Output},
    sync::mpsc,
    time::{Duration, Instant},
};

use fs2::FileExt;
use rusqlite::Connection;
use serde_json::{json, Value};

const ID: &str = "00000000-0000-4000-8000-000000000041";

fn seed(home: &Path) -> (std::path::PathBuf, String) {
    fs::create_dir_all(home.join("sessions")).unwrap();
    let path = home.join(format!("sessions/rollout-{ID}.jsonl"));
    let metadata = json!({"type":"session_meta","payload":{
        "id":ID,"model_provider":"legacy-api","creator_account_id":"synthetic-account",
        "cwd":"/synthetic/workspace"
    }});
    let tail = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"before-upgrade\"}}\n";
    fs::write(&path, format!("{metadata}\n{tail}")).unwrap();
    let db = Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL); CREATE TABLE goals (thread_id TEXT, status TEXT, objective TEXT, tokens INTEGER);").unwrap();
    db.execute("INSERT INTO threads VALUES (?1,'legacy-api')", [ID])
        .unwrap();
    db.execute(
        "INSERT INTO goals VALUES (?1,'active','continue original work',1234)",
        [ID],
    )
    .unwrap();
    (path, tail.into())
}

fn invoke(root: &Path, stopped: bool) -> Output {
    command(root, stopped, false).output().unwrap()
}

fn command(root: &Path, stopped: bool, wait_for_writers: bool) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_wegent-executor"));
    command.arg("--workbench-codex-providers-migrate").arg(
        json!({
            "codex_home":root.join("codex"),"agents_root":root.join("agents"),
            "wait_for_writers":wait_for_writers
        })
        .to_string(),
    );
    if stopped {
        command.arg("--executor-stopped");
    }
    command.arg("--version");
    command.env_clear();
    for key in ["PATH", "SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}

struct OwnedPreparation(Child);

impl Drop for OwnedPreparation {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn capture_protocol_pipe(
    pipe: impl Read + Send + 'static,
    observed: mpsc::Sender<()>,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut output = Vec::new();
        loop {
            let mut line = Vec::new();
            if reader.read_until(b'\n', &mut line).unwrap() == 0 {
                return output;
            }
            if String::from_utf8_lossy(&line).contains("codex provider writer lock unavailable") {
                observed.send(()).unwrap();
            }
            output.extend(line);
        }
    })
}

#[test]
fn stopped_wait_entry_resumes_after_native_writer_releases_coordination_and_unlinks_lease() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("codex");
    let (path, tail) = seed(&home);
    let locks = home.join("thread-writer-locks");
    fs::create_dir(&locks).unwrap();
    let lease_path = locks.join(format!("{ID}.lock"));
    let writer = fs::File::create(&lease_path).unwrap();
    writer.lock_exclusive().unwrap();
    let before = fs::read(&path).unwrap();
    let mut preparation = OwnedPreparation(
        command(root.path(), true, true)
            .env("WEGENT_EXECUTOR_DISABLE_FILE_LOG", "1")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let (observed, waiting) = mpsc::channel();
    let stdout = capture_protocol_pipe(preparation.0.stdout.take().unwrap(), observed.clone());
    let stderr = capture_protocol_pipe(preparation.0.stderr.take().unwrap(), observed);
    waiting
        .recv_timeout(Duration::from_secs(10))
        .expect("Migration must reach the real contended writer before release");
    let observed = Instant::now();
    while observed.elapsed() < Duration::from_millis(100) {
        assert!(preparation.0.try_wait().unwrap().is_none());
        assert_eq!(fs::read(&path).unwrap(), before);
        std::thread::sleep(Duration::from_millis(5));
    }
    // Match native WriterLockGuard::drop: coordinate before closing/unlinking.
    let coordination = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(locks.join(".coordination.lock"))
        .unwrap();
    coordination.try_lock_exclusive().unwrap();
    drop(writer);
    fs::remove_file(lease_path).unwrap();
    drop(coordination);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = preparation.0.try_wait().unwrap() {
            assert!(status.success(), "Stopped migration failed: {status}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Stopped migration did not resume"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let response: Value = serde_json::from_slice(&stdout.join().unwrap())
        .expect("Contended migration must reserve stdout for its JSON protocol");
    assert_eq!(response["codex_provider_migration"], 1);
    assert_eq!(response["complete"], true);
    assert!(String::from_utf8(stderr.join().unwrap())
        .unwrap()
        .contains("codex provider writer lock unavailable"));
    let content = fs::read_to_string(path).unwrap();
    let (metadata, remaining) = content.split_once('\n').unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(metadata).unwrap()["payload"]["model_provider"],
        "~"
    );
    assert_eq!(remaining, tail);
}

#[test]
fn real_offline_entry_preserves_goal_journals_identity_and_credentials_before_runtime_startup() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("codex");
    let (path, tail) = seed(&home);
    let original_size = fs::metadata(&path).unwrap().len();
    let queue = root.path().join("turn-queue.json");
    let journal =
        json!({"active_goal_turns":{"task":{"thread_id":ID,"request_id":"original-user-command"}}})
            .to_string();
    fs::write(&queue, &journal).unwrap();
    let auth = "synthetic-auth-must-not-be-opened-or-normalized";
    let config = "model_provider='legacy-api'\n";
    fs::write(home.join("auth.json"), auth).unwrap();
    fs::write(home.join("config.toml"), config).unwrap();
    let result = invoke(root.path(), true);
    assert!(
        result.status.success(),
        "offline entry failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let response: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(response["codex_provider_migration"], 1);
    assert_eq!(response["complete"], true);
    assert_eq!(response["checked_homes"], 1);
    let content = fs::read_to_string(&path).unwrap();
    assert_eq!(content.len() as u64, original_size);
    let (metadata, remaining) = content.split_once('\n').unwrap();
    let metadata: Value = serde_json::from_str(metadata).unwrap();
    assert_eq!(metadata["payload"]["id"], ID);
    assert_eq!(
        metadata["payload"]["creator_account_id"],
        "synthetic-account"
    );
    assert_eq!(metadata["payload"]["model_provider"], "~");
    assert_eq!(remaining, tail);
    assert_eq!(fs::read_to_string(queue).unwrap(), journal);
    assert_eq!(fs::read_to_string(home.join("auth.json")).unwrap(), auth);
    assert_eq!(
        fs::read_to_string(home.join("config.toml")).unwrap(),
        config
    );
    let db = Connection::open(home.join("state_5.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT status,objective,tokens FROM goals", [], |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, u32>(2)?
        )))
        .unwrap(),
        ("active".into(), "continue original work".into(), 1234)
    );
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(invoke(root.path(), true).status.success());
    assert_eq!(fs::read_to_string(path).unwrap(), content);
}

#[test]
fn missing_quiescence_acknowledgement_never_starts_or_mutates_the_runtime() {
    let root = tempfile::tempdir().unwrap();
    let (path, _) = seed(&root.path().join("codex"));
    let before = fs::read(&path).unwrap();
    let result = invoke(root.path(), false);
    assert!(!result.status.success());
    assert_eq!(fs::read(path).unwrap(), before);
    assert!(!root
        .path()
        .join("codex/.wework-provider-migration.json")
        .exists());
}

#[test]
fn a_live_named_home_writer_keeps_history_intact_and_release_allows_the_same_upgrade_to_finish() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("agents/user/project/agent");
    let (path, _) = seed(&home);
    let writer = fs::File::create(home.join(".execution.lock")).unwrap();
    writer.try_lock_exclusive().unwrap();
    let before = fs::read(&path).unwrap();
    let result = invoke(root.path(), true);
    assert!(!result.status.success());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!home.join(".wework-provider-migration.json").exists());
    drop(writer);
    let result = invoke(root.path(), true);
    assert!(result.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&result.stdout).unwrap()["checked_homes"],
        1
    );
    let metadata: Value =
        serde_json::from_str(fs::read_to_string(path).unwrap().lines().next().unwrap()).unwrap();
    assert_eq!(metadata["payload"]["model_provider"], "~");
}
