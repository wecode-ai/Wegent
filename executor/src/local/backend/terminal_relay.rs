// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::collections::HashMap;

impl<T, R> LocalBackendRunner<T, R>
where
    T: LocalBackendTransport,
    R: TaskRunner,
{
    pub(super) async fn relay_terminal_events_until_error(
        &self,
        notifier: Option<Arc<Notify>>,
    ) -> Result<(), String> {
        loop {
            wait_for_terminal_event(notifier.as_deref()).await;
            sleep(TERMINAL_OUTPUT_BATCH_DELAY).await;
            self.forward_terminal_events().await?;
        }
    }

    pub(super) async fn forward_terminal_events(&self) -> Result<(), String> {
        let Some(handler) = &self.session_handler else {
            return Ok(());
        };
        let events = handler
            .lock()
            .expect("session handler lock")
            .drain_terminal_events();
        stream::iter(group_terminal_events(events))
            .map(|events| self.forward_terminal_session_events(handler, events))
            .buffer_unordered(TERMINAL_SESSION_DELIVERY_CONCURRENCY)
            .try_collect::<Vec<_>>()
            .await?;
        Ok(())
    }

    pub(super) async fn forward_terminal_session_events(
        &self,
        handler: &Arc<Mutex<LocalSessionHandler>>,
        events: Vec<TerminalEvent>,
    ) -> Result<(), String> {
        for event in events {
            let (event_name, payload, error, delivery) = match event {
                TerminalEvent::Output {
                    session_id,
                    consumer_id,
                    sequence,
                    data,
                } => {
                    let mut payload = json!({"session_id": session_id, "data": data});
                    if let Some(consumer_id) = &consumer_id {
                        payload["consumer_id"] = json!(consumer_id);
                        payload["sequence"] = json!(sequence);
                    }
                    (
                        TERMINAL_OUTPUT_EVENT,
                        payload,
                        None,
                        (session_id, consumer_id, Some(sequence)),
                    )
                }
                TerminalEvent::Exit {
                    session_id,
                    consumer_id,
                    exit_code,
                    error,
                } => {
                    let mut payload = json!({
                        "session_id": session_id,
                        "exit_code": exit_code,
                    });
                    if let Some(consumer_id) = &consumer_id {
                        payload["consumer_id"] = json!(consumer_id);
                    }
                    if let Some(error) = &error {
                        payload["error"] = json!(error);
                    }
                    (
                        TERMINAL_EXIT_EVENT,
                        payload,
                        error,
                        (session_id, consumer_id, None),
                    )
                }
            };
            if let Some(error) = error {
                write_executor_error_line(&format_executor_log(
                    "terminal session failed",
                    &[("error", error)],
                ));
            }
            let (session_id, consumer_id, sequence) = delivery;
            if let Some(sequence) = sequence {
                let started = handler
                    .lock()
                    .expect("session handler lock")
                    .begin_terminal_output_delivery(
                        &session_id,
                        consumer_id.as_deref(),
                        sequence,
                    )?;
                if !started {
                    continue;
                }
            }

            if let Err(error) = self
                .client
                .call_raw_event(event_name, payload, TERMINAL_DELIVERY_TIMEOUT)
                .await
            {
                if let Some(sequence) = sequence {
                    let should_reconnect = handler
                        .lock()
                        .expect("session handler lock")
                        .retry_terminal_output_delivery(&session_id, sequence);
                    if !should_reconnect {
                        continue;
                    }
                }
                return Err(format!("{event_name}: {error}"));
            }

            let mut handler = handler.lock().expect("session handler lock");
            if let Some(sequence) = sequence {
                handler.complete_terminal_output_delivery(&session_id, sequence)?;
            } else {
                handler.complete_terminal_exit(&session_id, consumer_id.as_deref())?;
            }
        }
        Ok(())
    }
}

fn group_terminal_events(events: Vec<TerminalEvent>) -> Vec<Vec<TerminalEvent>> {
    let mut batch_index: HashMap<String, usize> = HashMap::new();
    let mut session_batches: Vec<Vec<TerminalEvent>> = Vec::new();
    for event in events {
        let session_id = terminal_event_session_id(&event);
        if let Some(&index) = batch_index.get(session_id) {
            session_batches[index].push(event);
        } else {
            batch_index.insert(session_id.to_owned(), session_batches.len());
            session_batches.push(vec![event]);
        }
    }
    session_batches
}

fn terminal_event_session_id(event: &TerminalEvent) -> &str {
    match event {
        TerminalEvent::Output { session_id, .. } | TerminalEvent::Exit { session_id, .. } => {
            session_id
        }
    }
}

async fn wait_for_terminal_event(notifier: Option<&Notify>) {
    match notifier {
        Some(notifier) => notifier.notified().await,
        None => pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_interleaved_output_and_exit_in_first_seen_session_order() {
        let output = |session_id: &str, sequence| TerminalEvent::Output {
            session_id: session_id.to_owned(),
            consumer_id: Some("consumer-1".to_owned()),
            sequence,
            data: format!("{session_id}-{sequence}"),
        };
        let exit = |session_id: &str| TerminalEvent::Exit {
            session_id: session_id.to_owned(),
            consumer_id: Some("consumer-1".to_owned()),
            exit_code: Some(0),
            error: None,
        };

        assert!(group_terminal_events(Vec::new()).is_empty());
        assert_eq!(
            group_terminal_events(vec![
                output("z", 1),
                output("a", 1),
                output("z", 2),
                exit("b"),
                exit("a"),
                exit("z"),
            ]),
            vec![
                vec![output("z", 1), output("z", 2), exit("z")],
                vec![output("a", 1), exit("a")],
                vec![exit("b")],
            ],
        );
    }
}
