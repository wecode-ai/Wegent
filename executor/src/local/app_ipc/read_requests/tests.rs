// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::{io::DuplexStream, sync::Notify};

use super::*;

#[derive(Clone, Default)]
struct ControlledRuntime {
    entered: Arc<Notify>,
    release: Arc<Notify>,
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

fn request(id: &str, method: &str) -> Value {
    json!({"type": "request", "id": id, "method": method, "params": {}})
}

#[test]
fn cancellation_only_covers_cooperative_transcript_reads() {
    assert!(is_cancellable_read(Some("runtime.tasks.transcript")));
    for method in [
        "runtime.tasks.transcript.search",
        "runtime.tasks.search",
        "runtime.tasks.send",
    ] {
        assert!(!is_cancellable_read(Some(method)));
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
    let mut responses = vec![
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
    write_frame(&mut writer, request("deadline", "runtime.tasks.transcript")).await;
    runtime.entered.notified().await;
    tokio::time::advance(Duration::from_secs(APP_IPC_REQUEST_TIMEOUT_SECONDS)).await;
    let response = read_response(&mut reader).await;
    assert_eq!(response["error"]["code"], "request_timeout");
    assert_eq!(runtime.dropped.load(Ordering::SeqCst), 1);
    assert_eq!(
        server.history_read_admission.available_permits(),
        MAX_CONCURRENT_HISTORY_READS
    );
    write_frame(&mut writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut reader).await["ok"], true);
}

#[tokio::test]
async fn history_admission_is_bounded_across_connections_and_disconnect_cancels_reads() {
    let runtime = ControlledRuntime::default();
    let server = AppIpcServer::new().with_runtime_work_handler(runtime.clone());
    let (reader, mut writer) = connect(server.clone()).await;
    let (mut other_reader, mut other_writer) = connect(server.clone()).await;
    for id in ["first", "second"] {
        write_frame(&mut writer, request(id, "runtime.tasks.transcript")).await;
        runtime.entered.notified().await;
    }
    write_frame(
        &mut other_writer,
        request("busy", "runtime.tasks.transcript"),
    )
    .await;
    let busy = read_response(&mut other_reader).await;
    assert_eq!(busy["error"]["code"], "runtime_read_busy");
    assert_eq!(busy["error"]["retryable"], true);
    write_frame(&mut other_writer, request("health", "executor.health")).await;
    assert_eq!(read_response(&mut other_reader).await["ok"], true);
    drop(writer);
    drop(reader);
    tokio::time::timeout(Duration::from_secs(1), async {
        while runtime.dropped.load(Ordering::SeqCst) != 2
            || server.history_read_admission.available_permits() != MAX_CONCURRENT_HISTORY_READS
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("disconnect must stop connection-owned reads");
    write_frame(
        &mut other_writer,
        request("fresh", "runtime.tasks.transcript"),
    )
    .await;
    runtime.entered.notified().await;
    runtime.release.notify_one();
    assert_eq!(read_response(&mut other_reader).await["id"], "fresh");
}
