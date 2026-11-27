// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bounded, process-owned execution dispatch.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use brz_http::Client as HttpClient;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::{Id, JoinSet};

type Runner<J> = for<'a> fn(&'a HttpClient, J) -> Pin<Box<dyn Future<Output = ()> + 'a>>;

/// The bounded admission queue depth.
const QUEUE_DEPTH: usize = 256;
/// The background consumer concurrency bound.
///
/// The source runs one `asyncio.create_task` per accepted background request
/// (`openapi_responses.py:960-980`), so its concurrency is request-driven and
/// unbounded. This supervisor is the bounded target equivalent: each chat-shell
/// consumer can hold one upstream SSE connection for 300 seconds, so eight
/// permits bound sockets and memory while removing the
/// serial head-of-line block. Saturation is observable through the admission
/// queue: a full queue rejects the job and logs it instead of blocking the
/// request path.
const MAX_CONSUMER_JOBS: usize = 8;

pub struct JobContext {
    pub task_id: i64,
    pub subtask_id: i64,
    pub request_id: String,
    pub target: String,
}

/// The startup-owned responses dispatch supervisor.
pub struct DispatchQueue<J> {
    sender: mpsc::Sender<J>,
    context: fn(&J) -> JobContext,
    /// The startup-owned supervisor; retained for the process lifetime.
    _supervisor: std::thread::JoinHandle<()>,
}

impl<J: Send + 'static> DispatchQueue<J> {
    /// Spawn the process-owned supervisor. Called once at startup.
    ///
    /// The source runs every background turn on its single asyncio event loop
    /// (`openapi_responses.py:960-980`), so the supervisor owns one dedicated
    /// current-thread runtime with a `LocalSet`. That is not an optimisation:
    /// the completion persistence awaits
    /// `Mysql::with_transaction`, whose future is not `Send`, so the consumer
    /// must stay on one thread. A `LocalSet` still interleaves every admitted
    /// consumer, matching the source loop.
    #[must_use]
    pub fn spawn(
        client: fn() -> brz_http::Result<HttpClient>,
        context: fn(&J) -> JobContext,
        run: Runner<J>,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(QUEUE_DEPTH);
        let supervisor = std::thread::Builder::new()
            .name("responses-dispatch".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        tracing::error!(%error, "failed to build the responses dispatch runtime");
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, supervise(receiver, client, context, run));
            })
            .expect("spawn the responses dispatch supervisor thread");
        Self {
            sender,
            context,
            _supervisor: supervisor,
        }
    }
}

/// The supervisor loop: reap finished local tasks and admit new jobs under the
/// bounded consumer permits.
async fn supervise<J: 'static>(
    mut receiver: mpsc::Receiver<J>,
    client: fn() -> brz_http::Result<HttpClient>,
    context: fn(&J) -> JobContext,
    run: Runner<J>,
) {
    // The source's OpenAI/httpx client keeps a 300-second per-read timeout for
    // the executor acknowledgement; the chat-shell consumer builds its own
    // client with the same policy.
    let http = match client() {
        Ok(http) => http,
        Err(error) => {
            tracing::error!(%error, "failed to build the responses dispatch client");
            return;
        }
    };
    let permits = Arc::new(Semaphore::new(MAX_CONSUMER_JOBS));
    let mut jobs: JoinSet<()> = JoinSet::new();
    let mut contexts: HashMap<Id, JobContext> = HashMap::new();
    loop {
        tokio::select! {
            biased;
            Some(finished) = jobs.join_next_with_id(), if !jobs.is_empty() => {
                observe_finished(finished, &mut contexts);
            }
            job = receiver.recv() => {
                let Some(job) = job else { break };
                // Wait for one of the bounded consumer slots. This is not the
                // request path: admission already happened.
                let permit = match Arc::clone(&permits).acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => break,
                };
                let job_context = context(&job);
                let http = http.clone();
                let handle = jobs.spawn_local(async move {
                    let _permit = permit;
                    run(&http, job).await;
                });
                contexts.insert(handle.id(), job_context);
            }
        }
    }
    // Drain the admitted jobs before the supervisor exits.
    while let Some(finished) = jobs.join_next_with_id().await {
        observe_finished(finished, &mut contexts);
    }
}

impl<J> DispatchQueue<J> {
    pub fn reserve(&self) -> Option<mpsc::Permit<'_, J>> {
        self.sender.try_reserve().ok()
    }

    /// Admit one background job.
    ///
    /// The bounded queue is admission. When it is full the job is rejected
    /// (never a silent block or a silent drop) and the rejection is logged with
    /// the job identity.
    pub fn submit(&self, job: J) -> bool {
        match self.sender.try_send(job) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(job)) => {
                let context = (self.context)(&job);
                tracing::warn!(
                    task_id = context.task_id,
                    subtask_id = context.subtask_id,
                    request_id = %context.request_id,
                    target = %context.target,
                    queue_depth = QUEUE_DEPTH,
                    "background dispatch queue is full; rejecting the job"
                );
                false
            }
            Err(mpsc::error::TrySendError::Closed(job)) => {
                let context = (self.context)(&job);
                tracing::warn!(
                    task_id = context.task_id,
                    subtask_id = context.subtask_id,
                    request_id = %context.request_id,
                    target = %context.target,
                    "background dispatch supervisor is closed; rejecting the job"
                );
                false
            }
        }
    }
}

/// Record one finished task: remove its identity, and log a panic or an
/// aborted/early-exiting join failure with the task's context.
fn observe_finished(
    finished: Result<(Id, ()), tokio::task::JoinError>,
    contexts: &mut HashMap<Id, JobContext>,
) {
    match finished {
        Ok((id, ())) => {
            contexts.remove(&id);
        }
        Err(error) => {
            let context = contexts.remove(&error.id());
            let task_id = context.as_ref().map_or(0, |context| context.task_id);
            let subtask_id = context.as_ref().map_or(0, |context| context.subtask_id);
            let request_id = context
                .as_ref()
                .map_or_else(String::new, |context| context.request_id.clone());
            let target = context.map_or_else(String::new, |context| context.target);
            tracing::error!(
                task_id,
                subtask_id,
                request_id = %request_id,
                target = %target,
                %error,
                "background dispatch task failed"
            );
        }
    }
}
