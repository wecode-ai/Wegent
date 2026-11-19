// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) async fn wait_for_project_space(
    client: &CodexAppServerClient,
    thread_id: &str,
    request: &ExecutionRequest,
    launch_config: &CodexLaunchConfig,
    context: &mut CodexTurnRequestContext,
    cancellation: &mut Option<oneshot::Receiver<()>>,
) -> Result<(), String> {
    if !crate::task_runtime::mcp::has_bound_project_context(request)? {
        return Ok(());
    }
    // Exact native snapshots await this thread's connection and its canonical
    // tools. Bulk status reads may omit a server whose discovery is pending.
    let snapshot = context.request(
        client,
        "mcpServerStatus/list",
        json!({
            "threadId": thread_id,
            "serverName": crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME,
            "detail": "toolsAndAuthOnly",
        }),
        launch_config,
    );
    await_discovery(
        snapshot,
        Duration::from_secs(codex_turn_startup_timeout_seconds()),
        cancellation,
    )
    .await
}

async fn await_discovery(
    snapshot: impl Future<Output = Result<Value, String>>,
    budget: Duration,
    cancellation: &mut Option<oneshot::Receiver<()>>,
) -> Result<(), String> {
    let response = timeout(budget, snapshot);
    let response = if let Some(cancelled) = cancellation.as_mut() {
        tokio::select! {
            biased;
            _ = cancelled => return Err(CODEX_APP_SERVER_TURN_CANCELLED.to_owned()),
            response = response => response,
        }
    } else {
        response.await
    };
    let snapshot = response
        .map_err(|_| "required project-space capability discovery timed out".to_owned())?
        .map_err(|error| format!("required project-space capability failed to connect: {error}"))?;
    let status = snapshot["data"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry["name"] == crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME)
        .and_then(|entry| entry["runtimeStatus"].as_str())
        .unwrap_or("unavailable");
    if status != "connected" {
        return Err(format!(
            "required project-space capability failed to connect ({status})"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unavailable_native_discovery_never_admits_model_work() {
        for status in [
            "failed",
            "cancelled",
            "disabled",
            "authenticationRequired",
            "starting",
        ] {
            let snapshot = json!({"data":[{"name":"wework_space","runtimeStatus":status}]});
            let error = await_discovery(async { Ok(snapshot) }, Duration::from_secs(1), &mut None)
                .await
                .unwrap_err();
            assert!(error.contains("required project-space capability"));
            assert!(error.contains(status));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_discovery_uses_the_startup_budget_without_retries() {
        let error = await_discovery(std::future::pending(), Duration::from_secs(3), &mut None)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "required project-space capability discovery timed out"
        );
    }

    #[tokio::test]
    async fn discovery_respects_cancellation() {
        let (cancelled, receiver) = oneshot::channel();
        cancelled.send(()).unwrap();
        let error = await_discovery(
            std::future::pending(),
            Duration::from_secs(3),
            &mut Some(receiver),
        )
        .await
        .unwrap_err();
        assert_eq!(error, CODEX_APP_SERVER_TURN_CANCELLED);
    }
}
