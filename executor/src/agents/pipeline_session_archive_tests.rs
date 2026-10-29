// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, os::unix::fs::PermissionsExt, pin::Pin, time::Duration};

use tokio::sync::mpsc;

use super::*;
use crate::{
    agents::build_claude_command,
    emitter::{EventEnvelope, ResponsesEventBuilder},
    envd::{
        archive::{
            create_runtime_archive_with_roots, restore_runtime_archive_with_roots, ArchiveMode,
            ArchiveOptions,
        },
        archive_sessions::SessionArchiveRoots,
    },
    process::StreamProcessEngine,
    runner::{AgentEngine, BackgroundTaskRunner, EventSink, ExecutionOutcome},
    server::TaskRunner,
};

struct TestEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl TestEnvironment {
    fn set(roots: &SessionArchiveRoots) -> Self {
        let mut previous = Vec::new();
        let workspace = roots.executor.join("test-workspaces");
        for (key, value) in [
            ("WEGENT_WORKBENCH_HOME", &roots.workbench),
            ("WEGENT_EXECUTOR_HOME", &roots.executor),
            ("WEGENT_CLAUDE_HOME", &roots.claude),
            ("WORKSPACE_ROOT", &workspace),
            ("WEGENT_WORKSPACE_ROOT", &workspace),
            ("LOCAL_WORKSPACE_ROOT", &workspace),
            ("WEGENT_EXECUTOR_PROJECTS_DIR", &workspace),
        ] {
            previous.push((key, std::env::var_os(key)));
            std::env::set_var(key, value);
        }
        Self(previous)
    }
}

impl Drop for TestEnvironment {
    fn drop(&mut self) {
        for (key, previous) in self.0.iter().rev() {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[derive(Clone)]
struct RecordingSink(mpsc::UnboundedSender<EventEnvelope>);

impl EventSink for RecordingSink {
    type SendFuture = std::future::Ready<Result<(), String>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        std::future::ready(self.0.send(event).map_err(|error| error.to_string()))
    }
}

// Exercise the real Home lease, command builder, process and cancellation runner
// without starting unrelated capability services or accessing authentication.
#[derive(Clone)]
struct TestClaudeEngine {
    workbench: PathBuf,
    binary: PathBuf,
    pause: bool,
    require_resume: bool,
}

impl AgentEngine for TestClaudeEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, _request: ExecutionRequest) -> Self::RunFuture {
        panic!("this contract exercises the cloud streaming entry point")
    }

    fn run_with_events<S>(
        &self,
        request: ExecutionRequest,
        sink: S,
        builder: ResponsesEventBuilder,
    ) -> Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>
    where
        S: EventSink,
    {
        let engine = self.clone();
        Box::pin(async move {
            let home = named_home_at(&engine.workbench, &request).unwrap();
            let _lease = acquire_at(&request, &engine.workbench, &home).unwrap();
            let spec = build_claude_command(&request, engine.binary.to_str().unwrap())
                .env(
                    "TEST_SESSION_ID",
                    format!("session-{}", request.bot[0]["id"]),
                )
                .env("TEST_PAUSE", engine.pause.to_string())
                .env("TEST_REQUIRE_RESUME", engine.require_resume.to_string());
            StreamProcessEngine::new(spec, 30)
                .run_with_events(request, sink, builder)
                .await
        })
    }
}

fn request(bot_id: u64, workspace: &Path) -> ExecutionRequest {
    serde_json::from_value(json!({
        "task_id":"42", "subtask_id":format!("turn-{bot_id}"),
        "team_id":12, "team_name":"pipeline-agent", "team_namespace":"default",
        "user":{"id":1}, "user_name":"test-user", "collaboration_model":"pipeline",
        "new_session":false, "project_workspace_path":workspace,
        "bot":[{"id":bot_id, "shell_type":"ClaudeCode"}]
    }))
    .unwrap()
}

fn write_fake_claude(path: &Path) {
    fs::write(
        path,
        r##"#!/bin/sh
set -eu
resume=''
while [ "$#" -gt 0 ]; do
    if [ "$1" = '--resume' ]; then
        shift
        resume="$1"
    fi
    shift
done
IFS= read -r query
transcript="$CLAUDE_CONFIG_DIR/projects/nested-project/$TEST_SESSION_ID.jsonl"
if [ "$TEST_REQUIRE_RESUME" = 'true' ]; then
    test "$resume" = "$TEST_SESSION_ID"
    grep -F "prior-context-$TEST_SESSION_ID" "$transcript" >/dev/null
    text="resumed-$TEST_SESSION_ID"
else
    test -z "$resume"
    mkdir -p "$(dirname "$transcript")"
    printf '{"sessionId":"%s","type":"user","message":{"content":"prior-context-%s"}}\n' "$TEST_SESSION_ID" "$TEST_SESSION_ID" > "$transcript"
    text="started-$TEST_SESSION_ID"
fi
printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$TEST_SESSION_ID"
printf '{"type":"assistant","session_id":"%s","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$TEST_SESSION_ID" "$text"
if [ "$TEST_PAUSE" = 'true' ]; then
    exec sleep 30
fi
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"%s","stop_reason":"end_turn"}\n' "$TEST_SESSION_ID"
"##,
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

async fn next_matching_event(
    events: &mut mpsc::UnboundedReceiver<EventEnvelope>,
    event_type: &str,
) -> EventEnvelope {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            assert_ne!(event.event_type, "error", "{:?}", event.data);
            if event.event_type == event_type {
                return event;
            }
        }
        panic!("stream ended before {event_type}")
    })
    .await
    .expect("expected process event must arrive")
}

async fn roundtrip(cancel_last: bool) {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let roots = SessionArchiveRoots::for_home(source.path());
    let _source_environment = TestEnvironment::set(&roots);
    let workspace = source.path().join("workspace/42");
    fs::create_dir_all(&workspace).unwrap();
    let binary = source.path().join("fake-claude");
    write_fake_claude(&binary);
    let engine = TestClaudeEngine {
        workbench: roots.workbench.clone(),
        binary,
        pause: false,
        require_resume: false,
    };
    for bot_id in [23, 24] {
        let (sender, mut events) = mpsc::unbounded_channel();
        let mut stage_engine = engine.clone();
        stage_engine.pause = cancel_last && bot_id == 24;
        let runner = BackgroundTaskRunner::new(stage_engine, RecordingSink(sender));
        let request = request(bot_id, &workspace);
        runner.submit(request.clone()).await;
        if cancel_last && bot_id == 24 {
            next_matching_event(&mut events, "response.output_text.delta").await;
            assert!(
                runner
                    .cancel(request.task_id, Some(request.subtask_id))
                    .await
            );
            next_matching_event(&mut events, "response.incomplete").await;
        } else {
            next_matching_event(&mut events, "response.completed").await;
        }
    }
    let archive = create_runtime_archive_with_roots(
        ArchiveOptions {
            mode: ArchiveMode::Executor,
            task_id: "42".into(),
            workspace_path: workspace,
            home_path: source.path().to_owned(),
            max_size_bytes: 1_000_000,
        },
        None,
        &roots,
    )
    .unwrap();
    assert!(archive.session_file_included);
    // The restored execution must not be able to read the original state.
    fs::remove_dir_all(roots.workbench.join("agents")).unwrap();
    fs::remove_dir_all(roots.executor.join("sessions")).unwrap();
    let restored_roots = SessionArchiveRoots::for_home(target.path());
    let restored_workspace = target.path().join("workspace/42");
    let restored = restore_runtime_archive_with_roots(
        &archive.bytes,
        ArchiveMode::Executor,
        "42",
        &restored_workspace,
        target.path(),
        &restored_roots,
    )
    .unwrap();
    assert!(restored.session_restored);
    let _target_environment = TestEnvironment::set(&restored_roots);
    for bot_id in [23, 24] {
        let restored_home = restored_roots.workbench.join(format!(
            "agents/test-user/default/pipeline-agent/bots/{bot_id}"
        ));
        for relative in [
            "agent.json".to_owned(),
            "runtime/tasks/42.json".to_owned(),
            format!("projects/nested-project/session-{bot_id}.jsonl"),
        ] {
            assert!(restored_home.join(relative).is_file());
        }
        let marker = restored_roots
            .executor
            .join(format!("sessions/42/.claude_session_id_{bot_id}"));
        assert_eq!(
            fs::read_to_string(marker).unwrap(),
            format!("session-{bot_id}")
        );
        let mut resumed = request(bot_id, &restored_workspace);
        resumed.new_session = false;
        // A cancelled stage has no successful result in the Backend. Its
        // restored, authenticated task binding must still allow exact-Bot resume.
        resumed.inherited_sessions = vec![json!({
            "agent":"ClaudeCode", "botId":"23", "sessionId":"session-23"
        })];
        resumed
            .extra
            .insert("legacy_session_bindings".into(), json!([]));
        let restored_engine = TestClaudeEngine {
            workbench: restored_roots.workbench.clone(),
            pause: false,
            require_resume: true,
            ..engine.clone()
        };
        let (sender, _events) = mpsc::unbounded_channel();
        let outcome = restored_engine
            .run_with_events(
                resumed,
                RecordingSink(sender),
                ResponsesEventBuilder::new("42", "resume", "test"),
            )
            .await;
        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: format!("resumed-session-{bot_id}")
            }
        );
    }
}

fn verify_roundtrip(cancel_last: bool) {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(roundtrip(cancel_last));
}

#[test]
fn completed_pipeline_backs_up_both_bots_and_resumes_each_original_session() {
    verify_roundtrip(false);
}

#[test]
fn cancelled_pipeline_backs_up_both_bots_and_resumes_each_original_session() {
    verify_roundtrip(true);
}
