// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::local::{event_stream::event_sequence, terminal_event_journal::is_terminal};
use futures_util::{future::BoxFuture, stream::FuturesUnordered, FutureExt};
use std::collections::{BTreeMap, BTreeSet};

const ACK_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_PENDING_ACKS: usize = 8;

type TerminalAttempt = BoxFuture<'static, (u64, Result<(), String>)>;

#[derive(Default)]
struct TerminalDeliveries {
    attempts: FuturesUnordered<TerminalAttempt>,
    in_flight: BTreeSet<u64>,
    retry_after: BTreeMap<u64, Instant>,
}

pub(super) fn bind_journal(hub: &ExecutorEventHub, config: &LocalBackendConfig) {
    use sha2::{Digest, Sha256};
    let connection = crate::config::device::ConnectionConfig {
        backend_url: config.backend_url.clone(),
        socket_url: config.socket_url.clone(),
        auth_token: config.auth_token.clone(),
        runtime_auth_token: config.runtime_auth_token.clone(),
    };
    let account = crate::plugin_account_auth::local_http::account_scope(&connection);
    hub.bind_backend_journal(format!(
        "{:x}",
        Sha256::digest(format!("{account}:{}", config.device_id))
    ));
}

pub(super) async fn forward<T: LocalBackendTransport>(
    client: LocalBackendClient<T>,
    hub: ExecutorEventHub,
    connected: Arc<AtomicBool>,
) {
    tokio::join!(
        forward_streams(client.clone(), hub.clone(), Arc::clone(&connected)),
        forward_terminals(client, hub, connected),
    );
}

async fn forward_streams<T: LocalBackendTransport>(
    client: LocalBackendClient<T>,
    hub: ExecutorEventHub,
    connected: Arc<AtomicBool>,
) {
    let mut delivered = 0;
    loop {
        if !connected.load(Ordering::Acquire) {
            sleep(RUNTIME_EVENT_CONNECTION_POLL_INTERVAL).await;
            continue;
        }
        let result = relay_subscription(&client, &hub, &connected, &mut delivered).await;
        match result {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => {
                log_retry(error);
                sleep(RETRY_DELAY).await;
            }
        }
    }
}

async fn relay_subscription<T: LocalBackendTransport>(
    client: &LocalBackendClient<T>,
    hub: &ExecutorEventHub,
    connected: &AtomicBool,
    delivered: &mut u64,
) -> Result<bool, String> {
    let mut subscription = hub.subscribe_backend(*delivered);
    for event in subscription.replay {
        if !connected.load(Ordering::Acquire) {
            return Ok(false);
        }
        relay_stream(client, event, delivered, connected).await?;
    }
    *delivered = (*delivered).max(subscription.resume_after);
    loop {
        tokio::select! {
            result = subscription.receiver.recv() => match result {
                Ok(event) => {
                    let sequence = event_sequence(&event).unwrap_or_default();
                    if sequence > *delivered && !is_terminal(&event) {
                        relay_stream(client, event, delivered, connected).await?;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => return Ok(false),
                Err(broadcast::error::RecvError::Closed) => return Ok(true),
            },
            _ = sleep(RUNTIME_EVENT_CONNECTION_POLL_INTERVAL) => {
                if !connected.load(Ordering::Acquire) { return Ok(false) }
            }
        }
    }
}

async fn relay_stream<T: LocalBackendTransport>(
    client: &LocalBackendClient<T>,
    event: Value,
    delivered: &mut u64,
    connected: &AtomicBool,
) -> Result<(), String> {
    if let Err(error) = client
        .emit_raw_event(RUNTIME_EVENT_EVENT, event.clone())
        .await
    {
        connected.store(false, Ordering::Release);
        return Err(error);
    }
    *delivered = (*delivered).max(event_sequence(&event).unwrap_or_default());
    Ok(())
}

async fn forward_terminals<T: LocalBackendTransport>(
    client: LocalBackendClient<T>,
    hub: ExecutorEventHub,
    connected: Arc<AtomicBool>,
) {
    let mut deliveries = TerminalDeliveries::default();
    let mut poll = tokio::time::interval(RUNTIME_EVENT_CONNECTION_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            Some((sequence, result)) = deliveries.attempts.next(), if !deliveries.attempts.is_empty() => {
                deliveries.in_flight.remove(&sequence);
                if let Err(error) = result {
                    deliveries.retry_after.insert(sequence, Instant::now() + RETRY_DELAY);
                    log_retry(error);
                } else {
                    deliveries.retry_after.remove(&sequence);
                }
            }
            _ = poll.tick() => {}
        }
        if !connected.load(Ordering::Acquire) {
            continue;
        }
        if let Err(error) = deliveries.schedule(&client, &hub) {
            log_retry(error);
            sleep(RETRY_DELAY).await;
        }
    }
}

impl TerminalDeliveries {
    fn schedule<T: LocalBackendTransport>(
        &mut self,
        client: &LocalBackendClient<T>,
        hub: &ExecutorEventHub,
    ) -> Result<(), String> {
        if self.attempts.len() >= MAX_PENDING_ACKS {
            return Ok(());
        }
        let mut pending = hub.pending_backend_terminals()?;
        // Unattempted events precede retries, then retry deadlines ensure a
        // rejected event cannot monopolize the bounded acknowledgement pool.
        pending.sort_by_key(|event| {
            let sequence = event_sequence(event).expect("terminal event sequence");
            (self.retry_after.get(&sequence).copied(), sequence)
        });
        for event in pending {
            let sequence = event_sequence(&event).expect("terminal event sequence");
            if self.in_flight.contains(&sequence)
                || self
                    .retry_after
                    .get(&sequence)
                    .is_some_and(|at| *at > Instant::now())
            {
                continue;
            }
            let client = client.clone();
            let hub = hub.clone();
            self.in_flight.insert(sequence);
            self.attempts.push(
                async move { (sequence, acknowledge_terminal(&client, &hub, event).await) }.boxed(),
            );
            if self.attempts.len() >= MAX_PENDING_ACKS {
                break;
            }
        }
        Ok(())
    }
}

async fn acknowledge_terminal<T: LocalBackendTransport>(
    client: &LocalBackendClient<T>,
    hub: &ExecutorEventHub,
    event: Value,
) -> Result<(), String> {
    client
        .call_raw_event(RUNTIME_EVENT_EVENT, event.clone(), ACK_TIMEOUT)
        .await
        .map_err(|error| error.to_string())?;
    hub.acknowledge_backend(&event)
}

fn log_retry(error: String) {
    write_executor_error_line(&format_executor_log(
        "runtime event relay awaiting backend acceptance",
        &[("error", error)],
    ));
}

#[cfg(test)]
mod tests;
