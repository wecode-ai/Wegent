//! One end-to-end budget for a federated read, inside the MCP client deadline.
use std::{future::Future, time::Duration};

use tokio::time::Instant;

use crate::{local::app_ipc::AppIpcError, logging::log_executor_event};

pub(crate) const TOOL_TIMEOUT_SECONDS: u64 = 180;
const READ_TIMEOUT_SECONDS: u64 = 150;

#[derive(Clone, Copy)]
pub(crate) struct ReadBudget {
    deadline: Instant,
}

impl Default for ReadBudget {
    fn default() -> Self {
        Self::new(Duration::from_secs(READ_TIMEOUT_SECONDS))
    }
}

impl ReadBudget {
    pub(crate) fn new(duration: Duration) -> Self {
        Self {
            deadline: Instant::now() + duration,
        }
    }

    pub(crate) fn remaining(self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub(crate) async fn read<T>(
        self,
        source: &str,
        operation: &str,
        read: impl Future<Output = Result<T, AppIpcError>>,
    ) -> Result<T, AppIpcError> {
        let started = Instant::now();
        log_executor_event(
            "Wework control read started",
            &[
                ("source", source.to_owned()),
                ("operation", operation.to_owned()),
                ("remaining_ms", self.remaining().as_millis().to_string()),
            ],
        );
        let result = if self.remaining().is_zero() {
            Err(timeout_error())
        } else {
            tokio::time::timeout_at(self.deadline, read)
                .await
                .unwrap_or_else(|_| Err(timeout_error()))
        };
        log_executor_event(
            "Wework control read finished",
            &[
                ("source", source.to_owned()),
                ("operation", operation.to_owned()),
                ("elapsed_ms", started.elapsed().as_millis().to_string()),
                (
                    "code",
                    result
                        .as_ref()
                        .err()
                        .map(|error| error.code.as_str())
                        .unwrap_or("ok")
                        .to_owned(),
                ),
            ],
        );
        result
    }
}

fn timeout_error() -> AppIpcError {
    AppIpcError::new("query_timeout", "The conversation read deadline was exceeded; inspect coverage and retry the affected device")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn control_read_budget_cancels_pending_reads_and_never_restarts_the_deadline() {
        const _: () = assert!(READ_TIMEOUT_SECONDS < TOOL_TIMEOUT_SECONDS);
        let budget = ReadBudget::new(Duration::from_millis(20));
        let error = budget
            .read(
                "slow-device",
                "list",
                std::future::pending::<Result<(), AppIpcError>>(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "query_timeout");
        let error = budget
            .read("slow-device", "archive", async { Ok(()) })
            .await
            .unwrap_err();
        assert_eq!(error.code, "query_timeout");
    }
}
