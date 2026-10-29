// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::time::Duration;
use wegent_executor::emitter::{EventEnvelope, ResponsesEventBuilder};
use wegent_executor::runner::EventSink;

#[derive(Clone, Default)]
struct RecordingSink(Arc<Mutex<Vec<EventEnvelope>>>);

impl EventSink for RecordingSink {
    type SendFuture = std::future::Ready<Result<(), String>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        self.0.lock().unwrap().push(event);
        std::future::ready(Ok(()))
    }
}

#[tokio::test]
async fn same_agent_tasks_run_concurrently_with_private_skills_mcp_and_settings() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let probe = unique_dir("concurrent-claude");
    fs::create_dir_all(&probe).unwrap();
    let _probe = EnvGuard::set("CONCURRENCY_PROBE", probe.to_str().unwrap());
    let fake_claude = write_fake_executable(
        "fake-claude-concurrent",
        r#"#!/bin/sh
set -eu
cat >/dev/null
printf '%s\n' "$CLAUDE_CONFIG_DIR" > "$CONCURRENCY_PROBE/$WEGENT_TASK_ID.config"
touch "$CONCURRENCY_PROBE/$WEGENT_TASK_ID.started"
while [ ! -f "$CONCURRENCY_PROBE/release" ]; do sleep 0.02; done
test -f "$SKILLS_DIR/$WEGENT_TASK_ID-skill/SKILL.md"
grep -q "http://$WEGENT_TASK_ID.invalid" "$CLAUDE_CONFIG_DIR/mcp.json"
test -f "$CLAUDE_CONFIG_DIR/settings.json"
mkdir -p "$CLAUDE_CONFIG_DIR/projects/$WEGENT_TASK_ID"
printf '{"sessionId":"session-%s","type":"user","message":{"content":"history-%s"}}\n' "$WEGENT_TASK_ID" "$WEGENT_TASK_ID" > "$CLAUDE_CONFIG_DIR/projects/$WEGENT_TASK_ID/session-$WEGENT_TASK_ID.jsonl"
printf '{"type":"system","subtype":"init","session_id":"session-%s"}\n' "$WEGENT_TASK_ID"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"completed-%s"}]}}\n' "$WEGENT_TASK_ID"
"#,
    );
    let workbench = PathBuf::from(std::env::var_os("WEGENT_WORKBENCH_HOME").unwrap());
    let mut requests = Vec::new();
    for task in ["one", "two"] {
        let name = format!("{task}-skill");
        let archive = skill_zip_bytes(&name);
        let package =
            wegent_executor::services::workbench::publish_skill_archive(&workbench, &archive, None)
                .unwrap();
        let workspace = probe.join(task);
        fs::create_dir_all(&workspace).unwrap();
        requests.push(with_backend_identity(ExecutionRequest {
            task_id: task.to_owned(), subtask_id: format!("{task}-turn"), new_session: true,
            project_workspace_path: Some(workspace.display().to_string()),
            prompt: json!("run concurrently"), auth_token: Some(format!("secret-{task}")),
            bot: json!([{"id": 327, "shell_type": "ClaudeCode", "skills": [name],
                "skill_refs": {name: {"skill_id": 42, "namespace": "default", "is_public": false, "content_hash": package.archive_hash}},
                "mcp_servers": {"task-service": {"type": "http", "url": format!("http://{task}.invalid"), "headers": {"Authorization": "${{auth_token}}"}}}}]),
            model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
            ..ExecutionRequest::default()
        }));
    }
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let first_engine = engine.clone();
    let first = requests.remove(0);
    let one = tokio::spawn(async move { first_engine.run(first).await });
    let second = requests.remove(0);
    let sink = RecordingSink::default();
    let events = sink.0.clone();
    let two = tokio::spawn(async move {
        engine
            .run_with_events(
                second,
                sink,
                ResponsesEventBuilder::new("two", "two-turn", "claude-sonnet-4"),
            )
            .await
    });
    let overlap = tokio::time::timeout(Duration::from_secs(10), async {
        while !probe.join("one.started").exists() || !probe.join("two.started").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    // Always release real children, including when the overlap assertion fails.
    fs::write(probe.join("release"), "release").unwrap();
    let (one, two) = tokio::join!(one, two);
    assert!(
        overlap.is_ok(),
        "both tasks must start before either is released: {one:?}, {two:?}"
    );
    assert_eq!(
        one.unwrap(),
        ExecutionOutcome::Completed {
            content: "completed-one".to_owned()
        }
    );
    assert_eq!(
        two.unwrap(),
        ExecutionOutcome::Completed {
            content: "completed-two".to_owned()
        }
    );
    let configs = ["one", "two"].map(|task| {
        PathBuf::from(
            fs::read_to_string(probe.join(format!("{task}.config")))
                .unwrap()
                .trim(),
        )
    });
    assert_ne!(configs[0], configs[1]);
    let shared = fixture_agent_home();
    for (index, task) in ["one", "two"].iter().enumerate() {
        let config = &configs[index];
        assert!(config.starts_with(shared.join("runtime/executions")));
        assert_eq!(
            fs::canonicalize(config.join("projects")).unwrap(),
            fs::canonicalize(shared.join("projects")).unwrap()
        );
        assert!(shared
            .join(format!("projects/{task}/session-{task}.jsonl"))
            .is_file());
        let other = if *task == "one" { "two" } else { "one" };
        assert!(config
            .join(format!("skills/{task}-skill/SKILL.md"))
            .is_file());
        assert!(!config.join(format!("skills/{other}-skill")).exists());
        let mcp = fs::read_to_string(config.join("mcp.json")).unwrap();
        assert!(mcp.contains(&format!("http://{task}.invalid")));
        assert!(!mcp.contains(&format!("http://{other}.invalid")));
        assert!(!mcp.contains(&format!("secret-{task}")));
    }
    assert!(!events.lock().unwrap().is_empty());
}
