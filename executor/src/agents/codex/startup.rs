// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[cfg(test)]
mod tests;

pub(super) async fn wait_for_shared_startup<T>(
    client: &CodexAppServerClient,
    thread_id: &str,
    mut deadline: Instant,
    timeout_seconds: u64,
    cancellation: &mut Option<oneshot::Receiver<()>>,
    request: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(request);
    loop {
        let response = timeout_at(deadline, &mut request);
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
                recover_stalled_shared_turn(client, thread_id, timeout_seconds).await?;
                // Preserve the same request while retrying recovery when other
                // active turns may have finished since the previous deadline.
                deadline = Instant::now() + Duration::from_secs(timeout_seconds);
            }
        }
    }
}

pub(super) async fn recover_stalled_shared_turn(
    client: &CodexAppServerClient,
    thread_id: &str,
    timeout_seconds: u64,
) -> Result<(), String> {
    let restarted = client.restart_stalled_turn_process(thread_id).await;
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
