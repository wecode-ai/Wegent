// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::ready,
    sync::{Arc, Mutex},
};

use tokio::time::{timeout, Duration};
use wegent_executor::{
    emitter::EventEnvelope,
    protocol::{ExecutionRequest, TaskStatus},
    runner::{AgentEngine, BackgroundTaskRunner, EventSink, ExecutionOutcome},
    server::TaskRunner,
};

#[derive(Clone)]
struct FakeEngine {
    outcome: ExecutionOutcome,
}

impl AgentEngine for FakeEngine {
    type RunFuture = std::future::Ready<ExecutionOutcome>;

    fn run(&self, _request: ExecutionRequest) -> Self::RunFuture {
        ready(self.outcome.clone())
    }
}

#[derive(Clone, Default)]
struct RecordingSink {
    events: Arc<Mutex<Vec<EventEnvelope>>>,
    notify: Arc<tokio::sync::Notify>,
}

impl RecordingSink {
    async fn wait_for_events(&self, count: usize) -> Vec<EventEnvelope> {
        timeout(Duration::from_secs(1), async {
            loop {
                let events = self.events.lock().unwrap().clone();
                if events.len() >= count {
                    return events;
                }
                self.notify.notified().await;
            }
        })
        .await
        .unwrap()
    }
}

impl EventSink for RecordingSink {
    type SendFuture = std::future::Ready<Result<(), String>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        self.events.lock().unwrap().push(event);
        self.notify.notify_waiters();
        ready(Ok(()))
    }
}

#[tokio::test]
async fn background_runner_emits_start_and_completed_events() {
    let sink = RecordingSink::default();
    let runner = BackgroundTaskRunner::new(
        FakeEngine {
            outcome: ExecutionOutcome::Completed {
                content: "done".to_owned(),
            },
        },
        sink.clone(),
    );

    let result = runner.submit(task_request()).await;
    let events = sink.wait_for_events(2).await;

    assert_eq!(result.status, TaskStatus::Running);
    assert_eq!(events[0].event_type, "response.created");
    assert_eq!(events[1].event_type, "response.completed");
    assert_eq!(
        events[1].data["response"]["output"][0]["content"][0]["text"],
        "done"
    );
}

#[tokio::test]
async fn background_runner_emits_error_event_for_failed_outcome() {
    let sink = RecordingSink::default();
    let runner = BackgroundTaskRunner::new(
        FakeEngine {
            outcome: ExecutionOutcome::Failed {
                message: "clone failed".to_owned(),
            },
        },
        sink.clone(),
    );

    let result = runner.submit(task_request()).await;
    let events = sink.wait_for_events(2).await;

    assert_eq!(result.status, TaskStatus::Running);
    assert_eq!(events[0].event_type, "response.created");
    assert_eq!(events[1].event_type, "error");
    assert_eq!(events[1].data["message"], "clone failed");
}

fn task_request() -> ExecutionRequest {
    ExecutionRequest {
        task_id: 1,
        subtask_id: 2,
        system_prompt: "system".to_owned(),
        ..ExecutionRequest::default()
    }
}
