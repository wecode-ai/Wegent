// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Recover the winning terminal result or report a persistence failure to the stream.

use serde_json::json;

use super::Bridge;
use wegent_execution_completion::StoredTerminal;

impl Bridge {
    pub(super) async fn read_committed_winner(
        &mut self,
    ) -> brz_mysql::MysqlResult<Option<StoredTerminal>> {
        self.host
            .read_terminal_result(self.task_id, self.subtask_id)
            .await
    }

    pub(super) async fn finish_committed_winner(&mut self) {
        let winner = self.read_committed_winner().await;
        self.finish_committed_winner_result(winner).await;
    }

    pub(super) async fn finish_committed_winner_result(
        &mut self,
        winner: brz_mysql::MysqlResult<Option<StoredTerminal>>,
    ) {
        match winner {
            Ok(Some(StoredTerminal {
                status,
                result,
                error,
            })) => {
                self.dispatch_exit_unregister().await;
                self.cleanup().await;
                if self.device_callback_mode() {
                    self.state
                        .use_callback_result(&mut self.queue, result.as_ref());
                } else {
                    self.state
                        .use_committed_result(&mut self.queue, result.as_ref());
                }
                self.state.finish(
                    &mut self.queue,
                    if status == "FAILED" {
                        "failed"
                    } else {
                        "completed"
                    },
                    error
                        .filter(|_| status == "FAILED")
                        .map(|message| json!({"code": "stream_error", "message": message})),
                );
                self.finished = true;
            }
            // A Task can become CANCELLING while its subtask is still live.
            // Keep the subscribed device reader for that producer's terminal
            // callback instead of dispatching again or inventing an outcome.
            Ok(None) if self.device_callback_mode() => {}
            Ok(None) => {
                self.finish_persistence_error("The execution was already settled")
                    .await
            }
            Err(_) => {
                self.finish_persistence_error("Could not read the committed execution result")
                    .await
            }
        }
    }

    pub(super) async fn finish_persistence_error(&mut self, message: &str) {
        self.dispatch_exit_unregister().await;
        // Keep the streamed result available after a database failure.
        self.registered = false;
        self.state.finish(
            &mut self.queue,
            "failed",
            Some(json!({"code": "stream_error", "message": message})),
        );
        self.finished = true;
    }
}
