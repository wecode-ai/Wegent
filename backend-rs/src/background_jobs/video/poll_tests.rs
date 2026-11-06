// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::background_jobs::{
    BackgroundJobsClient, client::Providers, config::BackgroundJobsConfig, with_lock_watchdog,
};
use brz_schedule::{
    Job, JobProvider, JobStatus, Registry, Worker, WorkerOptions, memory::MemoryProvider,
};
use tokio::sync::{Notify, oneshot};

#[test]
fn estimated_progress_is_monotonic_and_below_completion() {
    assert_eq!(estimate(10, 1, 50), 50);
    assert_eq!(estimate(100, 1, 0), 99);
    assert_eq!(estimate(0, 10000, 0), 99);
    assert!(estimate(0, 1, 0) >= 5);
}

fn input() -> Poll {
    serde_json::from_value(json!({
        "subtask_id":42,"task_id":7,"user_id":3,"job_id":"generation-1",
        "provider_protocol":"seedance","video_block_id":"block-1",
        "model_config":{},"message_id":null,"poll_count":8,"last_progress":60,
        "intent_result":{"generation_mode_id":"text_to_video"},
    }))
    .unwrap()
}

fn client(provider: Arc<MemoryProvider>) -> BackgroundJobsClient {
    let client = BackgroundJobsClient::new(BackgroundJobsConfig {
        scheduler_enabled: false,
        worker_enabled: true,
        job_allowlist: [super::super::POLL.to_owned()].into(),
        shutdown_grace: Duration::from_secs(1),
    });
    client
        .providers
        .set(Providers {
            jobs: provider.clone(),
            locks: provider,
            policies: Default::default(),
        })
        .ok()
        .unwrap();
    client
}

#[tokio::test]
async fn worker_shutdown_during_polling_keeps_the_cursor_and_failure_budget() {
    let provider = Arc::new(MemoryProvider::new(4).unwrap());
    let client = client(provider.clone());
    let poll = input();
    let mut job = Job::new("video-poll", super::super::POLL, &poll).unwrap();
    // Even the last available attempt must survive an ordinary process stop.
    job.max_failures = 1;
    provider.submit(job).await.unwrap();
    let started = Arc::new(Notify::new());
    let observed = started.clone();
    let mut registry = Registry::default();
    registry
        .register(super::super::POLL, move |context, payload| {
            let client = client.clone();
            let started = started.clone();
            async move {
                let poll: Poll = serde_json::from_value(payload)?;
                let result = with_lock_watchdog(
                    &client,
                    &context,
                    "wegent:lock:video:poll:42",
                    Duration::from_secs(5),
                    async move {
                        started.notify_one();
                        std::future::pending::<Result<Completion>>().await
                    },
                )
                .await;
                finish_attempt(&context, &poll, result)
                    .map_err(|error| brz_schedule::Error::Worker(error.to_string()))
            }
        })
        .unwrap();
    let worker = Worker::new(
        provider.clone(),
        registry,
        WorkerOptions {
            shutdown_grace: Duration::from_secs(1),
            ..Default::default()
        },
    )
    .unwrap();
    let (stop, stopped) = oneshot::channel();
    let running = tokio::spawn(async move {
        worker
            .run_until(async {
                let _ = stopped.await;
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), observed.notified())
        .await
        .unwrap();
    let stopping_at = brz_schedule::now_ms();
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let record = provider.get("video-poll").await.unwrap().unwrap();
    assert_eq!(record.status, JobStatus::Queued);
    assert_eq!(record.failures, 0);
    assert_eq!(record.deliveries, 1);
    assert!(record.last_error.is_none());
    assert_eq!(record.job.payload, serde_json::to_value(&poll).unwrap());
    assert!(record.job.run_at_ms >= stopping_at + super::super::interval() * 1000);
}

#[tokio::test]
async fn a_watchdog_error_without_shutdown_still_consumes_a_failed_attempt() {
    let provider = Arc::new(MemoryProvider::new(4).unwrap());
    let mut job = Job::new("video-poll", super::super::POLL, input()).unwrap();
    job.max_failures = 1;
    provider.submit(job).await.unwrap();
    let mut registry = Registry::default();
    registry
        .register(super::super::POLL, |context, payload| async move {
            let poll: Poll = serde_json::from_value(payload)?;
            finish_attempt(
                &context,
                &poll,
                Err(anyhow::anyhow!("business lock ownership lost")),
            )
            .map_err(|error| brz_schedule::Error::Worker(error.to_string()))
        })
        .unwrap();
    Worker::new(provider.clone(), registry, WorkerOptions::default())
        .unwrap()
        .run_once()
        .await
        .unwrap();
    let record = provider.get("video-poll").await.unwrap().unwrap();
    assert_eq!(record.status, JobStatus::Failed);
    assert_eq!(record.failures, 1);
    assert!(
        record
            .last_error
            .unwrap()
            .contains("business lock ownership lost")
    );
}
