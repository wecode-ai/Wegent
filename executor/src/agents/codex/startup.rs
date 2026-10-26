// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[cfg(test)]
mod tests;

pub(super) async fn wait_for_shared_startup<T>(
    client: &CodexAppServerClient,
    thread_id: &str,
    deadline: Instant,
    timeout_seconds: u64,
    request: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::pin!(request);
    match timeout_at(deadline, &mut request).await {
        Ok(result) => result,
        Err(_) => {
            recover_stalled_shared_turn(client, thread_id, timeout_seconds).await?;
            // A timeout does not cancel a request already sent to Codex. If the
            // process survives, retain the same future and consume its response.
            request.await
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
