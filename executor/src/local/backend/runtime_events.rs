// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::local::{event_stream::event_sequence, terminal_event_journal::is_terminal};

const ACK_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_DELAY: Duration = Duration::from_secs(1);

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
                write_executor_error_line(&format_executor_log(
                    "runtime event relay awaiting backend acceptance",
                    &[("error", error)],
                ));
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
    let mut subscription = hub.subscribe_backend(*delivered)?;
    for event in subscription.replay {
        if !connected.load(Ordering::Acquire) {
            return Ok(false);
        }
        relay_event(client, hub, event, delivered, connected).await?;
    }
    *delivered = (*delivered).max(subscription.resume_after);
    loop {
        tokio::select! {
            result = subscription.receiver.recv() => match result {
                Ok(event) => {
                    let sequence = event_sequence(&event).unwrap_or_default();
                    if sequence > *delivered || is_terminal(&event) {
                        relay_event(client, hub, event, delivered, connected).await?;
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

async fn relay_event<T: LocalBackendTransport>(
    client: &LocalBackendClient<T>,
    hub: &ExecutorEventHub,
    event: Value,
    delivered: &mut u64,
    connected: &AtomicBool,
) -> Result<(), String> {
    if is_terminal(&event) {
        let result = client
            .call_raw_event(RUNTIME_EVENT_EVENT, event.clone(), ACK_TIMEOUT)
            .await;
        if matches!(result, Err(super::client::RawEventCallError::Transport(_))) {
            connected.store(false, Ordering::Release);
        }
        result.map_err(|error| error.to_string())?;
        hub.acknowledge_backend(&event)?;
    } else if let Err(error) = client
        .emit_raw_event(RUNTIME_EVENT_EVENT, event.clone())
        .await
    {
        connected.store(false, Ordering::Release);
        return Err(error);
    }
    *delivered = (*delivered).max(event_sequence(&event).unwrap_or_default());
    Ok(())
}

#[cfg(test)]
mod tests;
