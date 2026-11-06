// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use futures_util::FutureExt;
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(test)]
mod tests;

#[derive(Default)]
pub(super) struct SharedTurnPreparations(Arc<AtomicUsize>);

impl SharedTurnPreparations {
    pub(super) fn begin(&self) -> SharedTurnPreparation {
        self.0.fetch_add(1, Ordering::AcqRel);
        SharedTurnPreparation(Arc::clone(&self.0))
    }

    pub(super) fn count(&self) -> usize {
        self.0.load(Ordering::Acquire)
    }
}

pub(super) struct SharedTurnPreparation(Arc<AtomicUsize>);

impl Drop for SharedTurnPreparation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) async fn wait_for_shared_startup<T: Send>(
    client: &CodexAppServerClient,
    thread_id: &str,
    deadline: &mut Instant,
    timeout_seconds: u64,
    cancellation: &mut Option<oneshot::Receiver<()>>,
    request: impl Future<Output = Result<T, String>> + Send,
) -> Result<T, String> {
    tokio::pin!(request);
    loop {
        let response = timeout_at(*deadline, &mut request);
        let received = if let Some(cancel_rx) = cancellation.as_mut() {
            tokio::select! {
                biased;
                _ = cancel_rx => {
                    let _ = interrupt_shared_turn(client, thread_id, "").await;
                    return Err(CODEX_APP_SERVER_TURN_CANCELLED.to_owned());
                }
                response = response => response,
            }
        } else {
            response.await
        };
        match received {
            Ok(result) => return result,
            Err(_) => {
                let mut ready = None;
                let mut cancelled = false;
                recover_stalled_shared_turn(client, thread_id, timeout_seconds, || {
                    cancelled = ensure_codex_turn_not_cancelled(cancellation).is_err();
                    if cancelled {
                        return true;
                    }
                    ready = request.as_mut().now_or_never();
                    ready.is_some()
                })
                .await?;
                if cancelled {
                    let _ = interrupt_shared_turn(client, thread_id, "").await;
                    return Err(CODEX_APP_SERVER_TURN_CANCELLED.to_owned());
                }
                if let Some(result) = ready {
                    return result;
                }
                // Preserve the same request while retrying recovery when other
                // active turns may have finished since the previous deadline.
                // Carry the protected deadline into the caller's model-progress wait.
                *deadline = Instant::now() + Duration::from_secs(timeout_seconds);
            }
        }
    }
}

pub(super) async fn recover_stalled_shared_turn(
    client: &CodexAppServerClient,
    thread_id: &str,
    timeout_seconds: u64,
    has_ready_data: impl FnOnce() -> bool + Send,
) -> Result<(), String> {
    let restarted = client
        .restart_stalled_turn_process(thread_id, has_ready_data)
        .await;
    log_executor_event(
        "codex shared turn startup stalled",
        &[
            ("thread_id", thread_id.to_owned()),
            ("timeout_seconds", timeout_seconds.to_string()),
            ("app_server_restarted", restarted.to_string()),
        ],
    );
    if restarted {
        return Err(format!(
            "codex app-server turn made no model or tool progress for {timeout_seconds}s; the shared app-server was restarted"
        ));
    }
    Ok(())
}
