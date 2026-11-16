// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use std::{
    ffi::OsString,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use serde_json::{json, Value};
use wegent_executor::{
    agents::{AgentCommandPlanner, AgentProcessEngine},
    emitter::{EventEnvelope, ResponsesEventBuilder},
    envd::{
        archive::{
            create_runtime_archive_with_roots, restore_runtime_archive_with_roots, ArchiveMode,
            ArchiveOptions,
        },
        archive_sessions::SessionArchiveRoots,
    },
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
};

const TASK_ID: &str = "resume-task";
const SESSION_ID: &str = "11111111-2222-4333-8444-555555555555";
const MARKER: &str = "sessions/resume-task/.claude_session_id_7";

#[tokio::test]
async fn restored_claude_session_resumes_by_transcript_after_workspace_moves() {
    let _lock = env_lock().lock().await;
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let source_roots = SessionArchiveRoots::for_home(&source.join("home"));
    let old_workspace = source.join("workspace").join(TASK_ID);
    let relative = PathBuf::from("projects")
        .join(project_directory_name(&old_workspace))
        .join(format!("{SESSION_ID}.jsonl"));
    seed_session(&source_roots, &old_workspace, &relative);
    let archive = create_runtime_archive_with_roots(
        archive_options(&source.join("home"), &old_workspace),
        None,
        &source_roots,
    )
    .unwrap();
    assert!(archive.session_file_included);

    let home = root.path().join("restored/home");
    let roots = SessionArchiveRoots::for_home(&home);
    let workspace = root.path().join("restored/workspace").join(TASK_ID);
    let restored = restore_runtime_archive_with_roots(
        &archive.bytes,
        ArchiveMode::Executor,
        TASK_ID,
        &workspace,
        &home,
        &roots,
    )
    .unwrap();
    assert!(restored.session_restored);
    let _environment = isolated_environment(root.path(), &home, &workspace, &roots);
    let native = write_fake_claude(root.path());
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        native.display().to_string(),
        "unused-codex",
    ));
    let selected = roots.workbench.join("agents/test-user/default/test-agent");
    let transcript = selected.join(&relative);
    let restored_transcript = fs::read(roots.claude.join(&relative)).unwrap();

    for turn in ["first-import", "existing-binding"] {
        let outcome = engine.run(resume_request(&workspace, turn)).await;
        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: "restored".to_owned()
            },
            "{turn}"
        );
        assert_eq!(
            fs::read_to_string(roots.executor.join(MARKER)).unwrap(),
            SESSION_ID
        );
        assert_eq!(
            fs::read(roots.claude.join(&relative)).unwrap(),
            restored_transcript,
            "The imported source conversation must remain unchanged"
        );
        assert!(!selected
            .join("projects")
            .join(project_directory_name(&workspace))
            .exists());
    }

    assert_observed_calls(&selected, &transcript, &workspace);
    assert_eq!(
        fs::read_to_string(&transcript)
            .unwrap()
            .matches("continued")
            .count(),
        2,
        "Both turns must append to the selected original transcript"
    );
    assert_eq!(
        fs::read(
            transcript
                .with_extension("")
                .join("tool-results/result.txt")
        )
        .unwrap(),
        b"saved tool result"
    );
    let binding: Value = serde_json::from_slice(
        &fs::read(selected.join(format!("runtime/tasks/{TASK_ID}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(binding["migrated_session"]["id"], SESSION_ID);
    assert_eq!(binding["migrated_session"]["path"], json!(relative));
    let next_archive =
        create_runtime_archive_with_roots(archive_options(&home, &workspace), None, &roots)
            .unwrap();
    assert!(next_archive.session_file_included);
}

#[tokio::test]
async fn successful_uuid_resume_does_not_resolve_a_transcript() {
    let _lock = env_lock().lock().await;
    for streaming in [false, true] {
        let fixture = BoundSession::new("id-success");
        fs::remove_file(&fixture.transcript).unwrap();

        assert_eq!(
            fixture.run(streaming).await,
            ExecutionOutcome::Completed {
                content: "restored".to_owned()
            }
        );
        fixture.assert_attempts(&[SESSION_ID]);
        fixture.assert_marker_preserved();
    }
}

#[tokio::test]
async fn errors_unrelated_to_the_requested_session_do_not_retry_a_transcript() {
    let _lock = env_lock().lock().await;
    for streaming in [false, true] {
        for (mode, expected) in [
            ("other-failure", "authentication failed"),
            // The existing isolated-session guard keeps its user-facing error.
            ("different-session", "no new conversation"),
        ] {
            let fixture = BoundSession::new(mode);

            let ExecutionOutcome::Failed { message } = fixture.run(streaming).await else {
                panic!("{mode} must fail");
            };
            assert!(message.contains(expected), "{message}");
            fixture.assert_attempts(&[SESSION_ID]);
            fixture.assert_marker_preserved();
        }
    }
}

#[tokio::test]
async fn early_missing_session_exit_preserves_the_error_when_stdin_is_still_writing() {
    let _lock = env_lock().lock().await;
    let prompt = "x".repeat(1024 * 1024);
    for streaming in [false, true] {
        let fixture = BoundSession::new("early-missing");

        assert_eq!(
            fixture.run_with_prompt(streaming, &prompt).await,
            ExecutionOutcome::Completed {
                content: "restored".to_owned()
            }
        );
        let transcript = fixture.transcript.canonicalize().unwrap();
        fixture.assert_attempts(&[SESSION_ID, transcript.to_str().unwrap()]);
        fixture.assert_marker_preserved();
        let retried_input =
            fs::read_to_string(fixture.selected.join("runtime/resumed-input-2")).unwrap();
        assert!(retried_input.contains(&prompt));
    }
}

#[tokio::test]
async fn native_json_result_without_stderr_can_recover_the_same_session() {
    let _lock = env_lock().lock().await;
    for streaming in [false, true] {
        let fixture = BoundSession::new("json-only-missing");

        assert_eq!(
            fixture.run(streaming).await,
            ExecutionOutcome::Completed {
                content: "restored".to_owned()
            }
        );
        let transcript = fixture.transcript.canonicalize().unwrap();
        fixture.assert_attempts(&[SESSION_ID, transcript.to_str().unwrap()]);
        fixture.assert_marker_preserved();
    }
}

#[tokio::test]
async fn transcript_resume_failure_does_not_start_a_third_attempt() {
    let _lock = env_lock().lock().await;
    for streaming in [false, true] {
        let fixture = BoundSession::new("path-failure");

        assert!(matches!(
            fixture.run(streaming).await,
            ExecutionOutcome::Failed { .. }
        ));
        let transcript = fixture.transcript.canonicalize().unwrap();
        fixture.assert_attempts(&[SESSION_ID, transcript.to_str().unwrap()]);
        fixture.assert_marker_preserved();
    }
}

#[tokio::test]
async fn unavailable_or_invalid_transcripts_never_start_the_path_attempt() {
    let _lock = env_lock().lock().await;
    for streaming in [false, true] {
        for invalid in ["missing", "ambiguous", "incomplete"] {
            let fixture = BoundSession::new("missing-id");
            match invalid {
                "missing" => fs::remove_file(&fixture.transcript).unwrap(),
                "ambiguous" => {
                    let duplicate = fixture
                        .selected
                        .join("projects/another-project")
                        .join(format!("{SESSION_ID}.jsonl"));
                    write_file(
                        &duplicate,
                        &fs::read_to_string(&fixture.transcript).unwrap(),
                    );
                }
                "incomplete" => {
                    write_file(
                        &fixture.transcript,
                        &format!("{{\"sessionId\":\"{SESSION_ID}\"}}"),
                    );
                }
                _ => unreachable!(),
            }

            assert!(
                matches!(
                    fixture.run(streaming).await,
                    ExecutionOutcome::Failed { .. }
                ),
                "{invalid} transcript must fail"
            );
            fixture.assert_attempts(&[SESSION_ID]);
            fixture.assert_marker_preserved();
        }
    }
}

struct BoundSession {
    _environment: Vec<EnvGuard>,
    _root: tempfile::TempDir,
    roots: SessionArchiveRoots,
    workspace: PathBuf,
    selected: PathBuf,
    transcript: PathBuf,
    engine: AgentProcessEngine,
}

impl BoundSession {
    fn new(mode: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let roots = SessionArchiveRoots::for_home(&home);
        let workspace = root.path().join("workspace").join(TASK_ID);
        let environment = isolated_environment(root.path(), &home, &workspace, &roots);
        let selected = roots.workbench.join("agents/test-user/default/test-agent");
        let transcript = selected
            .join("projects/old-project")
            .join(format!("{SESSION_ID}.jsonl"));
        write_file(&roots.executor.join(MARKER), SESSION_ID);
        write_file(
            &transcript,
            &format!("{{\"sessionId\":\"{SESSION_ID}\"}}\n"),
        );
        write_file(
            &selected.join("agent.json"),
            &json!({"schema_version": 5, "user_id": "7", "team_id": "12", "bot_id": "7", "shell_type": "claudecode", "user_name": "test-user"}).to_string(),
        );
        write_file(
            &selected.join(format!("runtime/tasks/{TASK_ID}.json")),
            &json!({"task_id": TASK_ID, "migrated_session": null}).to_string(),
        );
        write_file(&selected.join("runtime/fake-mode"), mode);
        let native = write_fake_claude(root.path());
        let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
            native.display().to_string(),
            "unused-codex",
        ));
        Self {
            _environment: environment,
            _root: root,
            roots,
            workspace,
            selected,
            transcript,
            engine,
        }
    }

    async fn run(&self, streaming: bool) -> ExecutionOutcome {
        self.run_with_prompt(streaming, "continue").await
    }

    async fn run_with_prompt(&self, streaming: bool, prompt: &str) -> ExecutionOutcome {
        let mut request = resume_request(&self.workspace, "bound-turn");
        request.prompt = json!(prompt);
        if streaming {
            self.engine
                .run_with_events(
                    request,
                    NoopSink,
                    ResponsesEventBuilder::new(TASK_ID, "bound-turn", "claude"),
                )
                .await
        } else {
            self.engine.run(request).await
        }
    }

    fn assert_attempts(&self, expected: &[&str]) {
        let observed = fs::read_to_string(self.selected.join("runtime/resume-attempts")).unwrap();
        assert_eq!(observed.lines().collect::<Vec<_>>(), expected);
    }

    fn assert_marker_preserved(&self) {
        assert_eq!(
            fs::read_to_string(self.roots.executor.join(MARKER)).unwrap(),
            SESSION_ID
        );
    }
}

#[derive(Clone)]
struct NoopSink;

impl EventSink for NoopSink {
    type SendFuture = std::future::Ready<Result<(), String>>;

    fn send(&self, _event: EventEnvelope) -> Self::SendFuture {
        std::future::ready(Ok(()))
    }
}

fn env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn seed_session(roots: &SessionArchiveRoots, workspace: &Path, relative: &Path) {
    write_file(&workspace.join("README.md"), "restored task workspace");
    write_file(&roots.executor.join(MARKER), SESSION_ID);
    write_file(
        &roots.claude.join(relative),
        &format!(
            "{}\n",
            json!({
                "sessionId": SESSION_ID,
                "type": "user",
                "cwd": workspace,
                "message": {"role": "user", "content": "previous turn"}
            })
        ),
    );
    write_file(
        &roots
            .claude
            .join(relative)
            .with_extension("")
            .join("tool-results/result.txt"),
        "saved tool result",
    );
}

fn resume_request(workspace: &Path, turn: &str) -> ExecutionRequest {
    ExecutionRequest {
        task_id: TASK_ID.to_owned(),
        subtask_id: turn.to_owned(),
        user_name: Some("test-user".to_owned()),
        team_namespace: Some("default".to_owned()),
        backend_url: Some("https://backend.example".to_owned()),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        prompt: json!("continue"),
        project_workspace_path: Some(workspace.display().to_string()),
        extra: serde_json::Map::from_iter([
            ("user_id".to_owned(), json!(7)),
            ("team_id".to_owned(), json!(12)),
            ("team_name".to_owned(), json!("test-agent")),
        ]),
        ..ExecutionRequest::default()
    }
}

fn assert_observed_calls(selected: &Path, transcript: &Path, workspace: &Path) {
    let expected = transcript.canonicalize().unwrap();
    let attempts = fs::read_to_string(selected.join("runtime/resume-attempts")).unwrap();
    assert_eq!(
        attempts.lines().collect::<Vec<_>>(),
        [
            SESSION_ID,
            expected.to_str().unwrap(),
            SESSION_ID,
            expected.to_str().unwrap()
        ]
    );
    let observed = fs::read_to_string(selected.join("runtime/resumed-paths")).unwrap();
    assert_eq!(
        observed.lines().collect::<Vec<_>>(),
        vec![expected.to_str().unwrap(); 2]
    );
    let expected_cwd = workspace.canonicalize().unwrap();
    let observed = fs::read_to_string(selected.join("runtime/resumed-cwds")).unwrap();
    assert_eq!(
        observed.lines().collect::<Vec<_>>(),
        vec![expected_cwd.to_str().unwrap(); 4]
    );
    for (first, second) in [(1, 2), (3, 4)] {
        assert_eq!(
            fs::read(selected.join(format!("runtime/resumed-input-{first}"))).unwrap(),
            fs::read(selected.join(format!("runtime/resumed-input-{second}"))).unwrap(),
            "The path retry must preserve the original prompt"
        );
    }
    let observed = fs::read_to_string(selected.join("runtime/resumed-config-dirs")).unwrap();
    let configurations = observed.lines().map(PathBuf::from).collect::<Vec<_>>();
    assert_eq!(configurations.len(), 4);
    assert_eq!(configurations[0], configurations[1]);
    assert_eq!(configurations[2], configurations[3]);
    assert_ne!(configurations[0], configurations[2]);
    for configuration in configurations {
        assert_eq!(
            configuration.parent().unwrap(),
            selected.join("runtime/executions")
        );
    }
}

fn archive_options(home: &Path, workspace: &Path) -> ArchiveOptions {
    ArchiveOptions {
        mode: ArchiveMode::Executor,
        task_id: TASK_ID.to_owned(),
        workspace_path: workspace.to_owned(),
        home_path: home.to_owned(),
        max_size_bytes: 1024 * 1024,
    }
}

fn project_directory_name(workspace: &Path) -> String {
    workspace
        .to_str()
        .unwrap()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn write_fake_claude(root: &Path) -> PathBuf {
    let native = root.join("fake-claude");
    write_file(
        &native,
        r#"#!/bin/sh
resume=
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--resume' ]; then
    shift
    resume=$1
  fi
  shift
done
test "$CLAUDE_CONFIG_DIR" != "$WEGENT_AGENT_HOME" || exit 82
test -f "$CLAUDE_CONFIG_DIR/settings.json" || exit 83
printf '%s\n' "$CLAUDE_CONFIG_DIR" >> "$WEGENT_AGENT_HOME/runtime/resumed-config-dirs"
printf '%s\n' "$resume" >> "$WEGENT_AGENT_HOME/runtime/resume-attempts"
pwd -P >> "$WEGENT_AGENT_HOME/runtime/resumed-cwds"
attempt=1
if [ -f "$WEGENT_AGENT_HOME/runtime/attempt-count" ]; then
  read -r attempt < "$WEGENT_AGENT_HOME/runtime/attempt-count"
  attempt=$((attempt + 1))
fi
printf '%s\n' "$attempt" > "$WEGENT_AGENT_HOME/runtime/attempt-count"
mode=missing-id
if [ -f "$WEGENT_AGENT_HOME/runtime/fake-mode" ]; then
  mode=$(cat "$WEGENT_AGENT_HOME/runtime/fake-mode")
fi
if [ "$resume" = '11111111-2222-4333-8444-555555555555' ] && [ "$mode" = 'early-missing' ]; then
  printf 'No conversation found with session ID: 11111111-2222-4333-8444-555555555555\n' >&2
  exit 1
fi
cat > "$WEGENT_AGENT_HOME/runtime/resumed-input-$attempt"
if [ "$resume" = '11111111-2222-4333-8444-555555555555' ]; then
  case "$mode" in
    id-success) ;;
    other-failure) printf 'API Error: authentication failed\n' >&2; exit 1 ;;
    different-session) printf 'No conversation found with session ID: different-session-id\n' >&2; exit 1 ;;
    json-only-missing) printf '%s\n' '{"type":"result","is_error":true,"subtype":"error_during_execution","num_turns":0,"duration_api_ms":0,"session_id":"11111111-2222-4333-8444-555555555555","errors":["No conversation found with session ID: 11111111-2222-4333-8444-555555555555"]}'; exit 1 ;;
    *) printf 'No conversation found with session ID: 11111111-2222-4333-8444-555555555555\n' >&2; exit 1 ;;
  esac
else
case "$resume" in
  /*/projects/*/11111111-2222-4333-8444-555555555555.jsonl) ;;
  *) printf 'Expected an absolute transcript path\n' >&2; exit 80 ;;
esac
test -f "$resume" || exit 81
if [ "$mode" = 'path-failure' ]; then
  printf 'No conversation found with session ID: 11111111-2222-4333-8444-555555555555\n' >&2
  exit 1
fi
printf '%s\n' "$resume" >> "$WEGENT_AGENT_HOME/runtime/resumed-paths"
printf '%s\n' '{"sessionId":"11111111-2222-4333-8444-555555555555","type":"system","message":"continued"}' >> "$resume"
fi
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"restored"}]}}'
printf '%s\n' '{"type":"result","is_error":false,"session_id":"11111111-2222-4333-8444-555555555555"}'
"#,
    );
    fs::set_permissions(&native, fs::Permissions::from_mode(0o700)).unwrap();
    native
}

fn write_file(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn isolated_environment(
    root: &Path,
    home: &Path,
    workspace: &Path,
    roots: &SessionArchiveRoots,
) -> Vec<EnvGuard> {
    let mut environment = Vec::new();
    for (key, path) in [
        ("HOME", home.to_owned()),
        ("USERPROFILE", home.to_owned()),
        ("WEGENT_EXECUTOR_HOME", roots.executor.clone()),
        ("WEGENT_WORKBENCH_HOME", roots.workbench.clone()),
        ("WEGENT_CLAUDE_HOME", roots.claude.clone()),
        ("CLAUDE_CONFIG_DIR", roots.claude.clone()),
        ("WEGENT_CODEX_HOME", roots.codex.clone()),
        ("CODEX_HOME", roots.codex.clone()),
        ("WEGENT_CAPABILITIES_HOME", root.join("capabilities")),
        ("WORKSPACE_ROOT", workspace.parent().unwrap().to_owned()),
    ] {
        fs::create_dir_all(&path).unwrap();
        environment.push(EnvGuard::set(key, &path));
    }
    for key in [
        "WEGENT_BACKEND_URL",
        "TASK_API_DOMAIN",
        "WEGENT_WORKSPACE_ROOT",
        "LOCAL_WORKSPACE_ROOT",
        "WEGENT_EXECUTOR_PROJECTS_DIR",
        "SKILLS_DIR",
    ] {
        environment.push(EnvGuard::remove(key));
    }
    environment
}

struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &Path) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }

    fn remove(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}
