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
    fn handle_runtime_rpc<'a>(&'a self, _: Value) -> BoxFuture<'a, Result<Value, AppIpcError>> {
        Box::pin(async move {
            let _counter = DropCounter(self.dropped.clone());
            self.started.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
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

async fn wait_for_handler_entry(runtime: &ControlledRuntime) {
    tokio::time::timeout(Duration::from_secs(1), runtime.entered.notified())
        .await
        .expect("read handler must enter before the test deadline");
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
            runtime.entered.notified().await;
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
    runtime.entered.notified().await;
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
        runtime.entered.notified().await;
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
    runtime.entered.notified().await;
    write_frame(&mut writer, json!({"type": "cancel", "id": "send"})).await;
    write_frame(&mut writer, request("send-control", "executor.health")).await;
    assert_eq!(read_response(&mut reader).await["id"], "send-control");
    assert_eq!(runtime.dropped.load(Ordering::SeqCst), 0);
    runtime.release.notify_one();
    assert_eq!(read_response(&mut reader).await["result"]["accepted"], true);

    write_frame(&mut writer, request("read", "runtime.tasks.transcript")).await;
    runtime.entered.notified().await;
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
        runtime.entered.notified().await;
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
    runtime.entered.notified().await;
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
    first.wait_for_admission().await.unwrap();
    second.wait_for_admission().await.unwrap();
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
            wait_for_handler_entry(&runtime).await;
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
    wait_for_handler_entry(&runtime).await;
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
        wait_for_handler_entry(&runtime).await;
    }
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

    write_frame(&mut writer, json!({"type":"cancel","id":"first"})).await;
    let cancelled = read_response(&mut reader).await;
    assert_eq!(cancelled["id"], "first");
    assert_eq!(cancelled["error"]["code"], "request_cancelled");
    assert_eq!(runtime.dropped.load(Ordering::SeqCst), 1);

    wait_for_handler_entry(&runtime).await;
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
    runtime.entered.notified().await;
    runtime.release.notify_one();
    assert_eq!(read_response(&mut other_reader).await["id"], "fresh");
}
