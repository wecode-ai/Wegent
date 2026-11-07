// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use tokio::io::{AsyncBufReadExt, BufReader};

impl RuntimeWorkRpcHandler {
    pub(super) async fn prepare_side_source(
        &self,
        source: &mut SideSourceThread,
    ) -> Result<(), AppIpcError> {
        self.wait_for_running_side_source_turn(&source.thread_id)
            .await;
        let started = Instant::now();
        log_executor_event(
            "runtime side source persistence awaiting",
            &[("thread_id", source.thread_id.clone())],
        );
        tokio::time::timeout(
            Duration::from_secs(30),
            self.wait_for_side_source_rollout(source),
        )
        .await
        .map_err(|_| {
            AppIpcError::new(
                "side_source_not_ready",
                format!(
                    "Source thread {} did not persist its session metadata",
                    source.thread_id
                ),
            )
        })??;
        log_executor_event(
            "runtime side source persistence ready",
            &[
                ("thread_id", source.thread_id.clone()),
                ("elapsed_ms", started.elapsed().as_millis().to_string()),
            ],
        );
        Ok(())
    }

    async fn wait_for_side_source_rollout(
        &self,
        source: &mut SideSourceThread,
    ) -> Result<(), AppIpcError> {
        loop {
            if source.thread_path.is_none() {
                source.thread_path = self.thread_path_for_id(&source.thread_id).await;
            }
            if let Some(path) = source.thread_path.as_deref() {
                if rollout_metadata_ready(Path::new(path), &source.thread_id).await? {
                    return Ok(());
                }
            }
            sleep(Duration::from_millis(ACTIVE_CODEX_TURN_WAIT_MS)).await;
        }
    }
}

async fn rollout_metadata_ready(path: &Path, thread_id: &str) -> Result<bool, AppIpcError> {
    let error = |message| {
        AppIpcError::new(
            "side_source_not_ready",
            format!(
                "Cannot read source thread {thread_id} at {}: {message}",
                path.display()
            ),
        )
    };
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(failure) => return Err(error(failure.to_string())),
    };
    let mut line = Vec::new();
    BufReader::new(file)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|failure| error(failure.to_string()))?;
    if !line.ends_with(b"\n") {
        return Ok(false);
    }
    let metadata: Value =
        serde_json::from_slice(&line).map_err(|failure| error(failure.to_string()))?;
    if metadata["type"] != "session_meta" || metadata["payload"]["id"] != thread_id {
        return Err(error(
            "session metadata does not match the source thread".to_owned(),
        ));
    }
    Ok(true)
}

#[cfg(test)]
mod tests;
