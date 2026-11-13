// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl<T, R> LocalBackendRunner<T, R>
where
    T: LocalBackendTransport,
    R: TaskRunner,
{
    pub(super) fn start_runtime_event_forwarder(&mut self, event_hub: ExecutorEventHub) {
        if let Some(forwarder) = self.runtime_event_forwarder.take() {
            forwarder.abort();
        }
        let client = self.client.clone();
        let connection_status = Arc::clone(&self.connection_status);
        let cursor = Arc::clone(&self.runtime_event_cursor);
        self.runtime_event_forwarder = Some(tokio::spawn(async move {
            let mut delivered_sequence = cursor.load(Ordering::Acquire);
            loop {
                while !connection_status.load(Ordering::Acquire) {
                    sleep(RUNTIME_EVENT_CONNECTION_POLL_INTERVAL).await;
                }
                let mut subscription = event_hub.subscribe_for_relay(delivered_sequence);
                let mut reconnect = false;
                for event in subscription.replay.drain(..) {
                    if !connection_status.load(Ordering::Acquire) {
                        reconnect = true;
                        break;
                    }
                    match client
                        .emit_raw_event(RUNTIME_EVENT_EVENT, event.clone())
                        .await
                    {
                        Ok(()) => {
                            delivered_sequence =
                                event_sequence(&event).unwrap_or(delivered_sequence);
                            cursor.fetch_max(delivered_sequence, Ordering::AcqRel);
                        }
                        Err(error) => {
                            connection_status.store(false, Ordering::Release);
                            write_executor_error_line(&format_executor_log(
                                "runtime event relay paused until reconnect",
                                &[("error", error)],
                            ));
                            reconnect = true;
                            break;
                        }
                    }
                }
                if reconnect {
                    while connection_status.load(Ordering::Acquire) {
                        sleep(RUNTIME_EVENT_CONNECTION_POLL_INTERVAL).await;
                    }
                    continue;
                }
                delivered_sequence = delivered_sequence.max(subscription.resume_after);
                cursor.fetch_max(delivered_sequence, Ordering::AcqRel);
                loop {
                    if !connection_status.load(Ordering::Acquire) {
                        break;
                    }
                    match subscription.receiver.recv().await {
                        Ok(event) => {
                            let sequence = event_sequence(&event).unwrap_or(delivered_sequence);
                            if sequence <= delivered_sequence {
                                continue;
                            }
                            match client
                                .emit_raw_event(RUNTIME_EVENT_EVENT, event.clone())
                                .await
                            {
                                Ok(()) => {
                                    delivered_sequence = sequence;
                                    cursor.fetch_max(delivered_sequence, Ordering::AcqRel);
                                }
                                Err(error) => {
                                    connection_status.store(false, Ordering::Release);
                                    write_executor_error_line(&format_executor_log(
                                        "runtime event relay paused until reconnect",
                                        &[("error", error)],
                                    ));
                                    break;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => break,
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        }));
    }
}
