// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Exercise cancellation against a real cold endpoint in an isolated process.
use super::*;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar,
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct StartupProbe {
    initializations: AtomicUsize,
    callers: AtomicUsize,
    started: StdMutex<Option<oneshot::Sender<PathBuf>>>,
    second_entered: StdMutex<Option<oneshot::Sender<()>>>,
    released: StdMutex<bool>,
    release: Condvar,
}

static PROBE: OnceLock<Arc<StartupProbe>> = OnceLock::new();

pub(super) fn waiter_entered() {
    if let Some(probe) = PROBE.get() {
        if probe.callers.fetch_add(1, Ordering::SeqCst) == 1 {
            if let Some(entered) = probe.second_entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
        }
    }
}

pub(super) fn cold_startup_entered(path: &Path) {
    let Some(probe) = PROBE.get() else { return };
    probe.initializations.fetch_add(1, Ordering::SeqCst);
    if let Some(started) = probe.started.lock().unwrap().take() {
        let _ = started.send(path.to_owned());
    }
    let (released, _) = probe
        .release
        .wait_timeout_while(
            probe.released.lock().unwrap(),
            Duration::from_secs(10),
            |released| !*released,
        )
        .unwrap();
    assert!(
        *released,
        "cold startup prevented the async caller from releasing it"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_cold_startup_keeps_one_initializer_and_its_database() {
    const CHILD: &str = "WEGENT_MCP_STARTUP_CANCEL_TEST_CHILD";
    if std::env::var(CHILD).as_deref() != Ok("1") {
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "task_runtime::mcp_http::startup_tests::cancelled_cold_startup_keeps_one_initializer_and_its_database",
                "--nocapture",
            ])
            .env_clear()
            .env(CHILD, "1")
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), child.output())
            .await
            .expect("isolated cold-start cancellation case must finish")
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let first_home = tempfile::tempdir().unwrap();
    let second_home = tempfile::tempdir().unwrap();
    std::env::set_var("WEGENT_EXECUTOR_HOME", first_home.path());
    let first_path = LocalTaskStore::default_path();
    let (started_tx, started_rx) = oneshot::channel();
    let (entered_tx, entered_rx) = oneshot::channel();
    let probe = Arc::new(StartupProbe {
        initializations: AtomicUsize::new(0),
        callers: AtomicUsize::new(0),
        started: StdMutex::new(Some(started_tx)),
        second_entered: StdMutex::new(Some(entered_tx)),
        released: StdMutex::new(false),
        release: Condvar::new(),
    });
    assert!(PROBE.set(probe.clone()).is_ok());
    let first = tokio::spawn(ensure_space_mcp_http_endpoint());
    assert_eq!(started_rx.await.unwrap(), first_path);
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    std::env::set_var("WEGENT_EXECUTOR_HOME", second_home.path());
    let second_path = LocalTaskStore::default_path();
    assert_ne!(first_path, second_path);
    let second = tokio::spawn(ensure_space_mcp_http_endpoint());
    entered_rx.await.unwrap();
    assert!(SPACE_MCP_START_LOCK.try_lock().is_err());
    assert!(!second.is_finished());
    *probe.released.lock().unwrap() = true;
    probe.release.notify_all();
    let endpoint = second.await.unwrap().unwrap();
    assert_eq!(probe.initializations.load(Ordering::SeqCst), 1);
    assert!(first_path.exists());
    assert!(!second_path.exists());
    let cached = ensure_space_mcp_http_endpoint().await.unwrap();
    assert_eq!(endpoint.url, cached.url);
    assert_eq!(endpoint.token, cached.token);
    let address = endpoint
        .url
        .trim_start_matches("http://")
        .trim_end_matches("/mcp");
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            format!(
                "GET /health HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
                endpoint.token
            ).as_bytes()
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    assert!(response.starts_with(b"HTTP/1.1 200"));
    let running = running_endpoint().lock().unwrap().take().unwrap();
    running.stop();
}
