// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicUsize, Ordering};
use wegent_execution_contracts::ipc::BoxFuture;

use tokio::{io::DuplexStream, sync::Notify};

use super::*;

#[derive(Clone, Default)]
struct ControlledRuntime {
    entered: Arc<Notify>,
    entered_methods: Arc<StdMutex<Vec<String>>>,
    release: Arc<Notify>,
    started: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}

struct DropCounter(Arc<AtomicUsize>);

impl Drop for DropCounter {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl RuntimeWorkHandler for ControlledRuntime {
    fn handle_runtime_rpc<'a>(
        &'a self,
        request: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>> {
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        Box::pin(async move {
            let _counter = DropCounter(self.dropped.clone());
            self.started.fetch_add(1, Ordering::SeqCst);
            self.entered_methods
                .lock()
                .expect("handler entries should not be poisoned")
                .push(method);
            self.entered.notify_waiters();
            self.release.notified().await;
            Ok(json!({"accepted": true}))
        })
    }
}

async fn connect(
    server: AppIpcServer,
) -> (
    BufReader<tokio::io::ReadHalf<DuplexStream>>,
    tokio::io::WriteHalf<DuplexStream>,
) {
    let (client, endpoint) = tokio::io::duplex(8192);
    let (reader, writer) = split(endpoint);
    tokio::spawn(async move { server.serve_io(reader, writer).await });
    let (reader, writer) = split(client);
    let mut reader = BufReader::new(reader);
    read_response(&mut reader).await;
    (reader, writer)
}

async fn write_frame(writer: &mut tokio::io::WriteHalf<DuplexStream>, frame: Value) {
    writer
        .write_all(format!("{frame}\n").as_bytes())
        .await
        .unwrap();
}

async fn read_response(reader: &mut BufReader<tokio::io::ReadHalf<DuplexStream>>) -> Value {
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut line))
        .await
        .expect("executor response must remain responsive")
        .unwrap();
    serde_json::from_str(&line).unwrap()
}

async fn wait_for_count(counter: &AtomicUsize, expected: usize) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while counter.load(Ordering::SeqCst) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("history request count must settle");
}

async fn wait_for_handler_entry(runtime: &ControlledRuntime, method: &str) {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            // Register before inspecting the queue so an entry cannot be lost
            // between the check and the wait.
            let notified = runtime.entered.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let entered = {
                let mut methods = runtime
                    .entered_methods
                    .lock()
                    .expect("handler entries should not be poisoned");
                methods
                    .iter()
                    .position(|entered| entered == method)
                    .map(|index| methods.remove(index))
            };
            if entered.is_some() {
                return;
            }
            notified.await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{method} must enter before the test deadline"));
}

async fn wait_for_available_permits(admission: &ReadAdmission, expected: usize) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while admission.pending.available_permits() != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("read admission permits must settle");
}

async fn start_history_reads(
    writer: &mut tokio::io::WriteHalf<DuplexStream>,
    runtime: &ControlledRuntime,
    count: usize,
) {
    for index in 0..count {
        write_frame(
            writer,
            request(&format!("read-{index}"), "runtime.tasks.transcript"),
        )
        .await;
        if index < MAX_CONCURRENT_HISTORY_READS {
            wait_for_handler_entry(runtime, "runtime.tasks.transcript").await;
        }
    }
}

fn request(id: &str, method: &str) -> Value {
    json!({"type": "request", "id": id, "method": method, "params": {}})
}

#[test]
fn cancellation_only_covers_cooperative_reads() {
    for method in cancellable_read_methods() {
        assert!(admission_kind(Some(method)).is_some());
    }
    for method in [
        "runtime.tasks.transcript.search",
        "runtime.tasks.search",
        "runtime.tasks.send",
    ] {
        assert!(admission_kind(Some(method)).is_none());
    }
}

#[tokio::test]
async fn cancelling_history_read_releases_handler_and_preserves_control_requests() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (mut reader, mut writer) = connect(server).await;
    write_frame(&mut writer, request("read", "runtime.tasks.transcript")).await;
    wait_for_handler_entry(&runtime, "runtime.tasks.transcript").await;
    write_frame(&mut writer, json!({"type": "cancel", "id": "read"})).await;
    write_frame(&mut writer, request("control", "executor.health")).await;
    let mut responses = [
        read_response(&mut reader).await,
        read_response(&mut reader).await,
    ];
    responses.sort_by_key(|response| response["id"].as_str().unwrap().to_owned());
    assert_eq!(responses[0]["id"], "control");
    assert_eq!(responses[0]["ok"], true);
    assert_eq!(responses[1]["error"]["code"], "request_cancelled");
    assert_eq!(runtime.dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelling_connection_capability_reads_releases_their_native_handlers() {
    for method in [
        "runtime.connections.mcp",
        "runtime.connections.cli",
        "runtime.connections.git.read",
    ] {
        let runtime = ControlledRuntime::default();
        let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
        let (mut reader, mut writer) = connect(server).await;
        write_frame(&mut writer, request("collection", method)).await;
        wait_for_handler_entry(&runtime, method).await;
        write_frame(&mut writer, json!({"type":"cancel","id":"collection"})).await;
        let response = read_response(&mut reader).await;
        assert_eq!(response["error"]["code"], "request_cancelled");
        assert_eq!(runtime.dropped.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn cancellation_is_connection_scoped_and_cannot_interrupt_sends() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (mut reader, mut writer) = connect(server.clone()).await;
    let (mut other_reader, mut other_writer) = connect(server).await;
    write_frame(&mut writer, request("send", "runtime.tasks.send")).await;
    wait_for_handler_entry(&runtime, "runtime.tasks.send").await;
    write_frame(&mut writer, json!({"type": "cancel", "id": "send"})).await;
    write_frame(&mut writer, request("send-control", "executor.health")).await;
    assert_eq!(read_response(&mut reader).await["id"], "send-control");
    assert_eq!(runtime.dropped.load(Ordering::SeqCst), 0);
    runtime.release.notify_one();
    assert_eq!(read_response(&mut reader).await["result"]["accepted"], true);

    write_frame(&mut writer, request("read", "runtime.tasks.transcript")).await;
    wait_for_handler_entry(&runtime, "runtime.tasks.transcript").await;
    write_frame(&mut other_writer, json!({"type": "cancel", "id": "read"})).await;
    write_frame(
        &mut other_writer,
        request("other-control", "executor.health"),
    )
    .await;
    assert_eq!(
        read_response(&mut other_reader).await["id"],
        "other-control"
    );
    assert_eq!(runtime.dropped.load(Ordering::SeqCst), 1);
    runtime.release.notify_one();
    assert_eq!(read_response(&mut reader).await["result"]["accepted"], true);
}

#[tokio::test(start_paused = true)]
async fn history_deadline_drops_work_and_releases_admission() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (mut reader, mut writer) = connect(server.clone()).await;
    start_history_reads(&mut writer, &runtime, MAX_PENDING_HISTORY_READS).await;
    write_frame(&mut writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut reader).await["id"], "health");
    wait_for_count(&runtime.started, MAX_CONCURRENT_HISTORY_READS).await;
    tokio::time::advance(Duration::from_secs(APP_IPC_REQUEST_TIMEOUT_SECONDS)).await;
    let mut timed_out = Vec::new();
    for _ in 0..MAX_PENDING_HISTORY_READS {
        let response = read_response(&mut reader).await;
        assert_eq!(response["error"]["code"], "request_timeout");
        timed_out.push(response["id"].as_str().unwrap().to_owned());
    }
    timed_out.sort();
    assert_eq!(
        timed_out,
        (0..MAX_PENDING_HISTORY_READS)
            .map(|index| format!("read-{index}"))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_HISTORY_READS
    );
    assert_eq!(
        runtime.dropped.load(Ordering::SeqCst),
        MAX_CONCURRENT_HISTORY_READS
    );
    assert_eq!(
        server.history_read_admission.active.available_permits(),
        MAX_CONCURRENT_HISTORY_READS
    );
    assert_eq!(
        server.history_read_admission.pending.available_permits(),
        MAX_PENDING_HISTORY_READS
    );
    write_frame(&mut writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut reader).await["ok"], true);
}

#[tokio::test]
async fn history_reads_wait_across_connections_without_blocking_control_requests() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (mut reader, mut writer) = connect(server.clone()).await;
    let (mut other_reader, mut other_writer) = connect(server.clone()).await;
    for id in ["first", "second"] {
        write_frame(&mut writer, request(id, "runtime.tasks.transcript")).await;
        wait_for_handler_entry(&runtime, "runtime.tasks.transcript").await;
    }
    write_frame(
        &mut other_writer,
        request("queued", "runtime.tasks.transcript"),
    )
    .await;
    write_frame(&mut other_writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut other_reader).await["ok"], true);
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_HISTORY_READS
    );
    runtime.release.notify_one();
    assert_eq!(read_response(&mut reader).await["result"]["accepted"], true);
    wait_for_handler_entry(&runtime, "runtime.tasks.transcript").await;
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_HISTORY_READS + 1
    );
    runtime.release.notify_one();
    runtime.release.notify_one();
    assert_eq!(read_response(&mut reader).await["result"]["accepted"], true);
    assert_eq!(read_response(&mut other_reader).await["id"], "queued");
}

#[tokio::test]
async fn queued_history_admission_is_fifo_across_connections() {
    let admission = new_history_read_admission();
    let first_connection =
        ConnectionReadRequests::new(admission.clone(), new_connection_read_admission());
    let second_connection =
        ConnectionReadRequests::new(admission.clone(), new_connection_read_admission());
    let (mut first, _) = first_connection
        .admit(Some("runtime.tasks.transcript"), "first")
        .unwrap()
        .unwrap();
    let (mut second, _) = second_connection
        .admit(Some("runtime.tasks.transcript"), "second")
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), first.wait_for_admission())
        .await
        .expect("the first connection read must acquire an active permit")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), second.wait_for_admission())
        .await
        .expect("the second connection read must acquire an active permit")
        .unwrap();
    let (mut queued_first, _) = second_connection
        .admit(Some("runtime.tasks.transcript"), "queued-first")
        .unwrap()
        .unwrap();
    let (mut queued_second, _) = first_connection
        .admit(Some("runtime.tasks.transcript"), "queued-second")
        .unwrap()
        .unwrap();
    {
        let first_wait = queued_first.wait_for_admission();
        let second_wait = queued_second.wait_for_admission();
        tokio::pin!(first_wait, second_wait);
        assert!(futures_util::poll!(first_wait.as_mut()).is_pending());
        assert!(futures_util::poll!(second_wait.as_mut()).is_pending());
        drop(first);
        assert!(futures_util::poll!(second_wait.as_mut()).is_pending());
        first_wait.await.unwrap();
        drop(second);
        second_wait.await.unwrap();
    }
    assert_eq!(admission.active.available_permits(), 0);
    drop(queued_first);
    drop(queued_second);
    assert_eq!(
        admission.active.available_permits(),
        MAX_CONCURRENT_HISTORY_READS
    );
    assert_eq!(
        admission.pending.available_permits(),
        MAX_PENDING_HISTORY_READS
    );
}

#[tokio::test]
async fn connection_reads_do_not_consume_transcript_admission() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (mut reader, mut writer) = connect(server.clone()).await;
    let (mut other_reader, mut other_writer) = connect(server.clone()).await;

    for index in 0..MAX_PENDING_CONNECTION_READS {
        write_frame(
            &mut writer,
            request(
                &format!("connection-{index}"),
                "runtime.connections.git.read",
            ),
        )
        .await;
        if index < MAX_CONCURRENT_CONNECTION_READS {
            wait_for_handler_entry(&runtime, "runtime.connections.git.read").await;
        }
    }
    wait_for_available_permits(&server.connection_read_admission, 0).await;
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_CONNECTION_READS
    );

    write_frame(
        &mut other_writer,
        request("connection-overflow", "runtime.connections.git.read"),
    )
    .await;
    let overflow = read_response(&mut other_reader).await;
    assert_eq!(overflow["error"]["code"], "runtime_read_busy");

    write_frame(
        &mut other_writer,
        request("transcript", "runtime.tasks.transcript"),
    )
    .await;
    wait_for_handler_entry(&runtime, "runtime.tasks.transcript").await;
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_CONNECTION_READS + 1
    );
    assert_eq!(runtime.dropped.load(Ordering::SeqCst), 0);

    let expected_entries = MAX_PENDING_CONNECTION_READS + 1;
    tokio::time::timeout(Duration::from_secs(1), async {
        while runtime.started.load(Ordering::SeqCst) < expected_entries {
            runtime.release.notify_one();
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("all admitted reads must enter after releasing capacity");
    runtime.release.notify_one();
    tokio::time::sleep(Duration::from_millis(1)).await;
    runtime.release.notify_one();

    let mut responses = Vec::new();
    for _ in 0..MAX_PENDING_CONNECTION_READS {
        responses.push(read_response(&mut reader).await);
    }
    responses.push(read_response(&mut other_reader).await);
    assert!(responses.iter().all(|response| response["ok"] == true));
    assert!(responses
        .iter()
        .any(|response| response["id"] == json!("transcript")));
}

#[tokio::test]
async fn padded_connection_read_methods_are_limited_and_cancellable() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (mut reader, mut writer) = connect(server.clone()).await;
    let padded_method = " runtime.connections.git.read ";

    for id in ["first", "second"] {
        write_frame(&mut writer, request(id, padded_method)).await;
        wait_for_handler_entry(&runtime, "runtime.connections.git.read").await;
    }
    write_frame(
        &mut writer,
        json!({"type":"request","id":"invalid","method":padded_method,"params":[]}),
    )
    .await;
    let invalid = read_response(&mut reader).await;
    assert_eq!(invalid["error"]["code"], "invalid_request");
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_CONNECTION_READS,
        "an invalid request must not consume active admission"
    );

    write_frame(&mut writer, request("third", padded_method)).await;
    wait_for_available_permits(
        &server.connection_read_admission,
        MAX_PENDING_CONNECTION_READS - 3,
    )
    .await;
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_CONNECTION_READS,
        "a padded method must not bypass the connection admission limit"
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(50),
            wait_for_handler_entry(&runtime, "runtime.connections.git.read"),
        )
        .await
        .is_err(),
        "the third read must wait for an active admission permit"
    );

    write_frame(&mut writer, json!({"type":"cancel","id":"first"})).await;
    let cancelled = read_response(&mut reader).await;
    assert_eq!(cancelled["id"], "first");
    assert_eq!(cancelled["error"]["code"], "request_cancelled");
    assert_eq!(runtime.dropped.load(Ordering::SeqCst), 1);

    wait_for_handler_entry(&runtime, "runtime.connections.git.read").await;
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_CONNECTION_READS + 1
    );
    let mut responses = Vec::new();
    for _ in 0..MAX_CONCURRENT_CONNECTION_READS {
        runtime.release.notify_one();
        responses.push(read_response(&mut reader).await);
    }
    assert!(responses.iter().all(|response| response["ok"] == true));
}

#[tokio::test]
async fn connection_read_waits_for_active_capacity() {
    let admission = new_connection_read_admission();
    let requests = ConnectionReadRequests::new(new_history_read_admission(), admission.clone());
    let method = "runtime.connections.git.read";
    let (mut first, _) = requests.admit(Some(method), "first").unwrap().unwrap();
    let (mut second, _) = requests.admit(Some(method), "second").unwrap().unwrap();
    let (mut third, _) = requests.admit(Some(method), "third").unwrap().unwrap();

    first.wait_for_admission().await.unwrap();
    second.wait_for_admission().await.unwrap();
    {
        let third_wait = third.wait_for_admission();
        tokio::pin!(third_wait);
        assert!(
            futures_util::poll!(third_wait.as_mut()).is_pending(),
            "the third connection read must wait for an active permit"
        );

        drop(first);
        tokio::time::timeout(Duration::from_secs(1), third_wait.as_mut())
            .await
            .expect("the third connection read must acquire the released permit")
            .unwrap();
    }
    assert_eq!(admission.active.available_permits(), 0);
    drop(second);
    drop(third);
    assert_eq!(
        admission.active.available_permits(),
        MAX_CONCURRENT_CONNECTION_READS
    );
}

#[tokio::test]
async fn history_queue_is_bounded_globally_and_waiting_cancellation_releases_capacity() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (mut reader, mut writer) = connect(server.clone()).await;
    let (mut other_reader, mut other_writer) = connect(server.clone()).await;
    start_history_reads(&mut writer, &runtime, MAX_PENDING_HISTORY_READS).await;
    write_frame(&mut writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut reader).await["id"], "health");
    wait_for_count(&runtime.started, MAX_CONCURRENT_HISTORY_READS).await;
    assert_eq!(server.history_read_admission.pending.available_permits(), 0);
    write_frame(
        &mut other_writer,
        request("overflow", "runtime.tasks.transcript"),
    )
    .await;
    let busy = read_response(&mut other_reader).await;
    assert_eq!(busy["error"]["code"], "runtime_read_busy");
    assert_eq!(busy["error"]["retryable"], true);
    // Another authenticated connection cannot cancel a queued request with the same ID.
    write_frame(&mut other_writer, json!({"type":"cancel", "id":"read-9"})).await;
    write_frame(&mut other_writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut other_reader).await["id"], "health");
    assert_eq!(server.history_read_admission.pending.available_permits(), 0);
    write_frame(&mut writer, json!({"type":"cancel", "id":"read-9"})).await;
    let cancelled = read_response(&mut reader).await;
    assert_eq!(cancelled["id"], "read-9");
    assert_eq!(cancelled["error"]["code"], "request_cancelled");
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_HISTORY_READS
    );
    write_frame(
        &mut other_writer,
        request("replacement", "runtime.tasks.transcript"),
    )
    .await;
    write_frame(&mut other_writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut other_reader).await["id"], "health");
    assert_eq!(server.history_read_admission.pending.available_permits(), 0);
}

#[tokio::test]
async fn disconnect_cancels_active_and_queued_reads_without_starting_waiting_work() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (mut reader, mut writer) = connect(server.clone()).await;
    let (mut other_reader, mut other_writer) = connect(server.clone()).await;
    start_history_reads(&mut writer, &runtime, MAX_PENDING_HISTORY_READS).await;
    write_frame(&mut writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut reader).await["id"], "health");
    wait_for_count(&runtime.started, MAX_CONCURRENT_HISTORY_READS).await;
    drop(writer);
    drop(reader);
    wait_for_count(&runtime.dropped, MAX_CONCURRENT_HISTORY_READS).await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while server.history_read_admission.pending.available_permits() != MAX_PENDING_HISTORY_READS
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("disconnect must release active and queued registrations");
    assert_eq!(
        runtime.started.load(Ordering::SeqCst),
        MAX_CONCURRENT_HISTORY_READS
    );
    assert_eq!(
        server.history_read_admission.active.available_permits(),
        MAX_CONCURRENT_HISTORY_READS
    );
    write_frame(
        &mut other_writer,
        request("fresh", "runtime.tasks.transcript"),
    )
    .await;
    wait_for_handler_entry(&runtime, "runtime.tasks.transcript").await;
    runtime.release.notify_one();
    assert_eq!(read_response(&mut other_reader).await["id"], "fresh");
}

#[cfg(unix)]
#[test]
fn slow_project_git_discovery_does_not_block_ipc_health() {
    use std::os::unix::fs::PermissionsExt;
    const CHILD: &str = "WEWORK_SLOW_GIT_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let test_name = format!(
            "{}::slow_project_git_discovery_does_not_block_ipc_health",
            module_path!().split_once("::").unwrap().1
        );
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &test_name, "--nocapture"])
            .env(CHILD, "1")
            .env("WEWORK_PROJECT_INDEX_DIAGNOSTICS", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let git = root.path().join("git");
    std::fs::write(&git, "#!/bin/sh\ndir=$(/usr/bin/dirname \"$0\")\n: > \"$dir/entered\"\nwhile [ ! -e \"$dir/release\" ]; do /bin/sleep 0.01; done\nexit 1\n").unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        root.path().join(".codex-global-state.json"),
        json!({"electron-saved-workspace-roots":[root.path()]}).to_string(),
    )
    .unwrap();
    for key in ["PATH", "CODEX_HOME", "WEGENT_EXECUTOR_HOME"] {
        std::env::set_var(key, root.path());
    }
    let (release, released) = std::sync::mpsc::channel();
    let release_file = root.path().join("release");
    let watchdog = std::thread::spawn(move || {
        let signaled = released
            .recv_timeout(std::time::Duration::from_secs(3))
            .is_ok();
        std::fs::write(release_file, "release").unwrap();
        signaled
    });
    let outcome = std::panic::catch_unwind(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let (mut reader, mut writer) = connect(AppIpcServer::new()).await;
                write_frame(&mut writer, request("projects", "projects.list")).await;
                tokio::time::timeout(Duration::from_secs(2), async {
                    while !root.path().join("entered").exists() {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .expect("project discovery must reach Git");
                write_frame(&mut writer, request("health", "executor.health")).await;
                let health = read_response(&mut reader).await;
                assert_eq!(
                    health["id"], "health",
                    "Git discovery must not occupy the IPC reactor"
                );
                assert_eq!(health["ok"], true);
                release.send(()).unwrap();
                let projects = read_response(&mut reader).await;
                assert_eq!(projects["id"], "projects");
                assert_eq!(projects["ok"], true, "{projects}");
            });
    });
    let signaled = watchdog.join().unwrap();
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
    assert!(signaled, "Git must stay blocked until health responds");
}
