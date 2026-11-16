// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{ffi::OsString, future::Future, path::PathBuf, pin::Pin, sync::Arc, time::Duration};

use serde_json::json;
use tokio::{
    io::AsyncWriteExt,
    sync::{mpsc, oneshot, Notify},
    time::timeout,
};

use super::*;
use crate::{
    emitter::{EventEnvelope, ResponsesEventBuilder},
    runner::EventSink,
};

struct ExecutorHome {
    root: tempfile::TempDir,
    previous: Option<OsString>,
}

impl ExecutorHome {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("WEGENT_EXECUTOR_HOME");
        std::env::set_var("WEGENT_EXECUTOR_HOME", root.path());
        Self { root, previous }
    }

    fn marker(&self) -> PathBuf {
        self.root.path().join("sessions/42/.claude_session_id_7")
    }
}

impl Drop for ExecutorHome {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("WEGENT_EXECUTOR_HOME", previous);
        } else {
            std::env::remove_var("WEGENT_EXECUTOR_HOME");
        }
    }
}

fn request() -> ExecutionRequest {
    ExecutionRequest {
        task_id: "42".into(),
        subtask_id: "43".into(),
        bot: json!([{"id":7,"shell_type":"ClaudeCode"}]),
        ..ExecutionRequest::default()
    }
}

fn init(id: &str) -> Value {
    json!({"type":"system", "subtype":"init", "session_id":id})
}

#[test]
fn only_root_init_with_a_valid_id_records_the_current_task_bot() {
    let _lock = crate::test_env::lock();
    let home = ExecutorHome::new();
    let recorder = SessionRecorder::new(&request());
    for event in [
        json!({"type":"assistant", "session_id":"assistant-session"}),
        json!({"type":"result", "session_id":"result-session"}),
        json!({"type":"system", "subtype":"status", "session_id":"status-session"}),
        json!({"type":"system", "subtype":"init", "parent_tool_use_id":"child", "session_id":"child-session"}),
        json!({"type":"system", "subtype":"init", "session_id":42}),
    ] {
        recorder.observe(&event);
        assert!(!home.marker().exists());
    }
    for id in [
        "",
        "../escape",
        " spaced",
        "line\nfeed",
        "dotted.id",
        "会话",
    ] {
        recorder.observe(&init(id));
        assert!(!home.marker().exists());
    }
    recorder.observe(&init("main-session_7"));
    assert_eq!(
        std::fs::read_to_string(home.marker()).unwrap(),
        "main-session_7"
    );
    assert!(!home
        .root
        .path()
        .join("sessions/42/.claude_session_id")
        .exists());
}

#[test]
fn each_retry_has_an_independent_reader_lifetime() {
    let _lock = crate::test_env::lock();
    let home = ExecutorHome::new();
    let execution = SessionRecorder::new(&request());
    let first = execution.for_reader();
    first.observe(&init("first-session"));
    first.stop();
    let retry = execution.for_reader();
    retry.observe(&init("retry-session"));
    first.observe(&init("late-first-session"));
    assert_eq!(
        std::fs::read_to_string(home.marker()).unwrap(),
        "retry-session"
    );
}

#[derive(Clone)]
struct BlockingSink {
    entered: mpsc::UnboundedSender<()>,
    release: Arc<Notify>,
}

impl EventSink for BlockingSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, _event: EventEnvelope) -> Self::SendFuture {
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.send(()).unwrap();
            release.notified().await;
            Ok(())
        })
    }
}

#[test]
fn init_is_saved_before_a_slow_callback_and_parent_cancel_stops_the_reader() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(assert_init_is_saved_and_parent_cancel_stops_the_reader());
}

async fn assert_init_is_saved_and_parent_cancel_stops_the_reader() {
    let home = ExecutorHome::new();
    let request = request();
    let recorder = SessionRecorder::new(&request);
    let stale_recorder = recorder.clone();
    let (mut writer, reader) = tokio::io::duplex(4096);
    let (entered, mut callbacks) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let sink = BlockingSink {
        entered,
        release: release.clone(),
    };
    let (started, handle) = oneshot::channel();
    let parent = tokio::spawn(async move {
        let read = tokio::spawn(super::super::read_streaming_stdout(
            reader,
            sink,
            ResponsesEventBuilder::new("42", "43", "test"),
            "42".into(),
            "43".into(),
            None,
            Some(recorder.clone()),
        ));
        let _guard = ReaderGuard::new(read.abort_handle(), recorder);
        assert!(started.send(read).is_ok());
        std::future::pending::<()>().await;
    });
    let reader = handle.await.unwrap();
    writer
        .write_all(
            format!(
                "{}\n{}\n",
                init("interrupted-session"),
                json!({
                    "type":"assistant", "message":{"content":[{"type":"text", "text":"working"}]}
                })
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    timeout(Duration::from_secs(2), callbacks.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(home.marker()).unwrap(),
        "interrupted-session"
    );
    assert!(!reader.is_finished());
    parent.abort();
    assert!(parent.await.unwrap_err().is_cancelled());
    assert!(matches!(reader.await, Err(error) if error.is_cancelled()));
    agent_session::save_session_id(&request, "next-session");
    stale_recorder.observe(&init("late-session"));
    assert_eq!(
        std::fs::read_to_string(home.marker()).unwrap(),
        "next-session"
    );
    release.notify_one();
}
