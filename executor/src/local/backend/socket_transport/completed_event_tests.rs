// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{correlation_tests::accept_connection, *};
use crate::{
    config::device::UpdateConfig,
    emitter::{EventEnvelope, ResponsesEventBuilder},
    local::backend::{
        CapabilityReportProvider, LocalBackendClient, LocalBackendEventSink,
        LocalRunningTaskTracker, ManagedLocalTaskRunner,
    },
    protocol::{ExecutionRequest, TaskStatus},
    runner::{AgentEngine, EventSink, ExecutionOutcome},
    server::TaskRunner,
    services::turn_file_changes::TurnFileChangeTracker,
};
use futures_util::StreamExt;
use std::{collections::BTreeMap, fs, path::Path, pin::Pin, process::Command};
use tokio::{net::TcpListener, sync::mpsc, time::timeout};
use tokio_tungstenite::tungstenite::Message;

#[test]
fn completed_events_keep_terminal_state_within_device_wire_budget() {
    if spawn_isolated_case("completed_events_keep_terminal_state_within_device_wire_budget") {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    fs::create_dir(&repo).unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["init", "-q"])
        .status()
        .unwrap()
        .success());
    let home = root.path().join("home");
    let mut first = tracker(&repo, &home, 11, 111);
    assert!(first.start());
    fs::write(
        repo.join("first.txt"),
        "first \"\\\t中文🙂\n".repeat(40_000),
    )
    .unwrap();
    first.finalize();
    let mut second = tracker(&repo, &home, 11, 112);
    assert!(second.start());
    fs::write(
        repo.join("second.txt"),
        "second \"\\\t中文🙂\n".repeat(40_000),
    )
    .unwrap();
    let large_fields = second.finalize();
    for key in ["file_changes", "task_file_changes"] {
        assert!(large_fields[key]["diff"].as_str().unwrap().len() >= 512 * 1024 - 4);
    }
    assert!(home
        .join("artifacts/turn-file-changes/11/112/changes.patch.gz")
        .is_file());
    let final_text = "answer \"中文🙂\" \\\n".repeat(2_500);
    let large = completed_event(&large_fields, 11, 112, &final_text);
    assert!(serde_json::to_vec(&large).unwrap().len() > 1_000_000);

    let mut small = tracker(&repo, &home, 12, 121);
    assert!(small.start());
    fs::write(repo.join("small.txt"), "small change\n").unwrap();
    let small_fields = small.finalize();
    let small = completed_event(&small_fields, 12, 121, "small done");
    let mut empty = tracker(&repo, &home, 13, 131);
    assert!(empty.start());
    let empty_fields = empty.finalize();
    assert_eq!(empty_fields["task_file_changes"]["files"], json!([]));
    let empty = completed_event(&empty_fields, 13, 131, "unchanged");

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let events = [large, small.clone(), empty.clone()];
    let wires = runtime.block_on(send_events_over_device_socket(events, root.path()));
    let received = wires
        .iter()
        .enumerate()
        .map(|(index, wire)| {
            assert!(wire.len() <= 1_000_000, "wire size: {}", wire.len());
            let args: Value =
                serde_json::from_str(wire.strip_prefix("42/local-executor,").unwrap()).unwrap();
            assert_eq!(args[0], "response.completed");
            assert_eq!(args[1]["event_type"], "response.completed");
            assert_eq!(args[1]["task_id"], [11, 12, 13][index]);
            assert_eq!(args[1]["subtask_id"], [112, 121, 131][index]);
            assert_eq!(args[1]["message_id"], [113, 122, 132][index]);
            assert_eq!(args[1]["data"]["response"]["status"], "completed");
            args[1].clone()
        })
        .collect::<Vec<_>>();
    let response = &received[0]["data"]["response"];
    assert_eq!(response["output"][0]["content"][0]["text"], final_text);
    assert_eq!(response["executor_session"], json!({"id": "session-1"}));
    assert_eq!(
        received[0]["executor_name"],
        "executor \"quoted\" \\".repeat(200)
    );
    assert_eq!(received[0]["executor_namespace"], "namespace\n".repeat(100));
    for key in ["file_changes", "task_file_changes"] {
        let actual = &response[key];
        for field in [
            "status",
            "files",
            "artifact_id",
            "workspace_path",
            "device_id",
        ] {
            assert_eq!(actual[field], large_fields[key][field], "{key}.{field}");
        }
        assert_eq!(actual["diff_truncated"], true);
        let diff = actual["diff"].as_str().unwrap();
        assert!(large_fields[key]["diff"]
            .as_str()
            .unwrap()
            .starts_with(diff));
        assert!(!diff.contains('\u{fffd}'));
    }
    assert!(!response["task_file_changes"]["diff"]
        .as_str()
        .unwrap()
        .is_empty());
    assert!(
        response["task_file_changes"]["diff"]
            .as_str()
            .unwrap()
            .len()
            > response["file_changes"]["diff"].as_str().unwrap().len()
    );
    assert_eq!(received[1]["data"], small.data);
    assert_eq!(received[2]["data"], empty.data);
}

#[test]
fn managed_runner_reports_oversized_completions_and_recovers_remaining_diff() {
    if spawn_isolated_case(
        "managed_runner_reports_oversized_completions_and_recovers_remaining_diff",
    ) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let small_task_diff =
        "diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-before\n+after\n";
    let small_fields = json!({
        "file_changes": {"status":"active", "artifact_id":"turn-file-changes/202/1202", "files":[{"path":"b.txt"}], "diff":small_task_diff, "diff_truncated":false},
        "task_file_changes": {"status":"active", "files":[{"path":"b.txt"}], "diff":small_task_diff, "diff_truncated":false}
    });
    let many_files = (0..20_000)
        .map(|index| json!({"path":format!("nested-folder/changed-file-{index}.txt"), "additions":1, "deletions":0}))
        .collect::<Vec<_>>();
    let metadata_fields = json!({
        "file_changes": {"status":"active", "artifact_id":"turn-file-changes/203/1203", "files":many_files, "diff":"", "diff_truncated":false},
        "task_file_changes": small_fields["task_file_changes"]
    });
    assert!(serde_json::to_vec(&metadata_fields).unwrap().len() > 1_000_000);
    let mut small_turn = small_fields["file_changes"].clone();
    small_turn["artifact_id"] = json!("turn-file-changes/204/1204");
    let cumulative_metadata_fields = json!({
        "file_changes": small_turn,
        "task_file_changes": {"status":"active", "files":metadata_fields["file_changes"]["files"], "diff":"", "diff_truncated":false}
    });
    let cases = vec![
        ScriptedCompletion {
            fields: None,
            content: "中".repeat(340_000),
        },
        ScriptedCompletion {
            fields: Some(small_fields.clone()),
            content: "中".repeat(340_000),
        },
        ScriptedCompletion {
            fields: Some(metadata_fields.clone()),
            content: "metadata done".to_owned(),
        },
        ScriptedCompletion {
            fields: Some(cumulative_metadata_fields.clone()),
            content: "cumulative metadata done".to_owned(),
        },
        ScriptedCompletion {
            fields: None,
            content: "same connection remains healthy".to_owned(),
        },
    ];
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let wires = runtime.block_on(send_managed_completions(cases, root.path()));
    let events = wires
        .iter()
        .map(|wire| {
            assert!(wire.len() <= 1_000_000, "wire size: {}", wire.len());
            serde_json::from_str::<Value>(wire.strip_prefix("42/local-executor,").unwrap()).unwrap()
        })
        .collect::<Vec<_>>();
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event[1]["task_id"], 201 + index);
        assert_eq!(event[1]["subtask_id"], 1201 + index);
        assert_eq!(event[1]["message_id"], 2201 + index);
    }
    for event in &events[..2] {
        assert_eq!(event[0], "error");
        assert_eq!(event[1]["event_type"], "error");
        assert_eq!(event[1]["data"]["type"], "error");
        assert_eq!(event[1]["data"]["code"], "device_callback_too_large");
        assert!(!event[1]["data"]["message"].as_str().unwrap().is_empty());
        assert!(event[1]["data"].get("response").is_none());
    }
    assert_eq!(events[2][0], "response.completed");
    let response = &events[2][1]["data"]["response"];
    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["content"][0]["text"], "metadata done");
    assert_eq!(response["file_changes"]["status"], "error");
    assert_eq!(
        response["file_changes"]["artifact_id"],
        metadata_fields["file_changes"]["artifact_id"]
    );
    assert_eq!(
        response["task_file_changes"],
        small_fields["task_file_changes"]
    );
    assert_eq!(events[3][0], "response.completed");
    let response = &events[3][1]["data"]["response"];
    assert_eq!(response["status"], "completed");
    assert_eq!(
        response["output"][0]["content"][0]["text"],
        "cumulative metadata done"
    );
    assert_eq!(response["task_file_changes"]["status"], "error");
    assert_eq!(
        response["file_changes"],
        cumulative_metadata_fields["file_changes"]
    );
    assert_eq!(events[4][0], "response.completed");
    assert_eq!(
        events[4][1]["data"]["response"]["output"][0]["content"][0]["text"],
        "same connection remains healthy"
    );
}

#[derive(Clone)]
struct ScriptedCompletion {
    fields: Option<Value>,
    content: String,
}

// This protocol test controls the engine output; the E2E suite runs the real CLI.
#[derive(Clone)]
struct CompletionEngine {
    cases: Arc<Mutex<BTreeMap<String, ScriptedCompletion>>>,
    release: Arc<tokio::sync::Notify>,
}

impl AgentEngine for CompletionEngine {
    type RunFuture = std::future::Ready<ExecutionOutcome>;

    fn run(&self, _request: ExecutionRequest) -> Self::RunFuture {
        panic!("ManagedLocalTaskRunner must execute run_with_events")
    }

    fn run_with_events<S>(
        &self,
        request: ExecutionRequest,
        _sink: S,
        builder: ResponsesEventBuilder,
    ) -> Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>
    where
        S: EventSink,
    {
        let case = self.cases.lock().unwrap().remove(&request.task_id).unwrap();
        let release = self.release.clone();
        Box::pin(async move {
            release.notified().await;
            if let Some(fields) = case.fields {
                builder.record_completed_file_change_fields(fields);
            }
            ExecutionOutcome::Completed {
                content: case.content,
            }
        })
    }
}

async fn send_managed_completions(cases: Vec<ScriptedCompletion>, root: &Path) -> Vec<String> {
    let count = cases.len();
    let mut device = WireDevice::connect(root).await;
    let engine = CompletionEngine {
        cases: Arc::new(Mutex::new(
            cases
                .into_iter()
                .enumerate()
                .map(|(index, case)| ((201 + index).to_string(), case))
                .collect(),
        )),
        release: Arc::new(tokio::sync::Notify::new()),
    };
    let running = LocalRunningTaskTracker::default();
    let runner = ManagedLocalTaskRunner::new(
        engine.clone(),
        LocalBackendEventSink::new(device.client.clone()),
        running.clone(),
    );
    let mut terminals = Vec::new();
    for index in 0..count {
        let task_id = (201 + index).to_string();
        let accepted = runner
            .submit(ExecutionRequest {
                task_id: task_id.clone(),
                subtask_id: (1201 + index).to_string(),
                message_id: Some((2201 + index) as i64),
                task_type: Some("code".to_owned()),
                bot: json!({"shell_type":"ClaudeCode"}),
                model_config: json!({"model_id":"wire-test-model"}),
                device_id: Some("device-wire-test".to_owned()),
                executor_name: Some("device-wire-test".to_owned()),
                ..ExecutionRequest::default()
            })
            .await;
        assert_eq!(accepted.status, TaskStatus::Running);
        assert_eq!(running.running_task_ids(), [task_id]);
        let created = device.next_frame().await;
        let created: Value =
            serde_json::from_str(created.strip_prefix("42/local-executor,").unwrap()).unwrap();
        assert_eq!(created[0], "response.created");
        assert_eq!(created[1]["data"]["shell_type"], "claudecode");
        engine.release.notify_one();
        terminals.push(device.next_frame().await);
        assert!(running.running_task_ids().is_empty());
    }
    assert!(engine.cases.lock().unwrap().is_empty());
    device.close().await;
    terminals
}

fn completed_event(fields: &Value, task: i64, turn: i64, content: &str) -> EventEnvelope {
    let builder = ResponsesEventBuilder::new(task.to_string(), turn.to_string(), "coding-test")
        .with_response_id(format!("response-{turn}"))
        .with_message_id(Some(turn + 1))
        .with_executor_info(
            Some(&"executor \"quoted\" \\".repeat(200)),
            Some(&"namespace\n".repeat(100)),
        )
        .with_executor_session(Some(json!({"id": "session-1"})));
    builder.record_completed_file_change_fields(fields.clone());
    builder.response_completed(content)
}

fn tracker(repo: &Path, home: &Path, task: i64, turn: i64) -> TurnFileChangeTracker {
    TurnFileChangeTracker::new(
        repo.into(),
        task,
        turn,
        home.into(),
        Some("device-wire-test"),
    )
    .with_task_baseline()
}

async fn send_events_over_device_socket(events: [EventEnvelope; 3], root: &Path) -> Vec<String> {
    let mut device = WireDevice::connect(root).await;
    let sink = LocalBackendEventSink::new(device.client.clone());
    for event in events {
        sink.send(event).await.unwrap();
    }
    let mut wires = Vec::new();
    for _ in 0..3 {
        wires.push(device.next_frame().await);
    }
    device.close().await;
    wires
}

struct WireDevice {
    client: LocalBackendClient<SocketIoTransport>,
    frames: mpsc::UnboundedReceiver<String>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for WireDevice {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl WireDevice {
    async fn connect(root: &Path) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, frames) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let mut socket = accept_connection(listener).await;
            while let Some(message) = socket.next().await {
                let Message::Text(packet) = message.unwrap() else {
                    panic!("expected a text packet");
                };
                if packet == "3" {
                    continue;
                }
                if packet == "41/local-executor," {
                    return;
                }
                sender.send(packet).unwrap();
            }
        });
        let config = socket_config(&format!("http://{address}"), root);
        let client = LocalBackendClient::with_capability_reporter(
            config,
            SocketIoTransport::default(),
            EmptyCapabilities,
        );
        let device = Self {
            client,
            frames,
            server,
        };
        device.client.connect().await.unwrap();
        device
    }

    async fn next_frame(&mut self) -> String {
        timeout(Duration::from_secs(5), self.frames.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn close(mut self) {
        self.client.disconnect().await.unwrap();
        timeout(Duration::from_secs(5), &mut self.server)
            .await
            .unwrap()
            .unwrap();
    }
}

struct EmptyCapabilities;

impl CapabilityReportProvider for EmptyCapabilities {
    fn build_report(&self) -> Value {
        json!({})
    }
}

fn socket_config(url: &str, root: &Path) -> LocalBackendConfig {
    LocalBackendConfig {
        backend_url: url.to_owned(),
        socket_url: url.to_owned(),
        auth_token: "test-auth".to_owned(),
        runtime_auth_token: String::new(),
        device_id: "device-wire-test".to_owned(),
        runtime_instance_id: "runtime-wire-test".to_owned(),
        device_name: "Wire Test".to_owned(),
        device_type: "local".to_owned(),
        app_device_id: String::new(),
        bind_shell: "codex".to_owned(),
        executor_version: "test".to_owned(),
        client_ip: "127.0.0.1".to_owned(),
        runtime_transfer_host: "127.0.0.1".to_owned(),
        heartbeat_interval: Duration::from_secs(30),
        heartbeat_timeout: Duration::from_secs(10),
        runtime_work_poll_interval: Duration::from_secs(2),
        registration_timeout: Duration::from_secs(10),
        reconnect_delay: Duration::from_secs(1),
        reconnect_delay_max: Duration::from_secs(1),
        configured_capabilities: Vec::new(),
        local_workspace_root: root.join("workspace"),
        update: UpdateConfig::default(),
    }
}

fn spawn_isolated_case(name: &str) -> bool {
    const CASE: &str = "WEGENT_COMPLETED_WIRE_TEST";
    if std::env::var(CASE).as_deref() == Ok(name) {
        return false;
    }
    let config_root = tempfile::tempdir().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .args([
            "--exact",
            &format!("local::backend::socket_transport::completed_event_tests::{name}"),
            "--test-threads=1",
        ])
        .env(CASE, name)
        .env("WEGENT_EXECUTOR_HOME", config_root.path().join("home"))
        .env("XDG_CONFIG_HOME", config_root.path())
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}
