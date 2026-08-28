// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::automations::AutomationRunStatus;
use crate::task_runtime::LocalTaskStore;

impl RuntimeWorkRpcHandler {
    pub(crate) async fn reconcile_bound_task_statuses(&self) {
        let observed_at_ms = now_ms();
        for link in self.collect_links(false).await {
            self.project_runtime_link_status_at(
                &link,
                observed_at_ms.max(link.updated_at.saturating_add(1)),
            );
        }
    }

    pub(super) fn project_bound_task_status(
        &self,
        local_task_id: &str,
        execution_status: &str,
        observed_at_ms: i64,
    ) {
        let store = match LocalTaskStore::from_env_if_exists() {
            Ok(Some(store)) => store,
            Ok(None) => return,
            Err(error) => {
                log_executor_event(
                    "runtime task Issue status store unavailable",
                    &[
                        ("local_task_id", local_task_id.to_owned()),
                        ("error", error.to_string()),
                    ],
                );
                return;
            }
        };
        match store.project_bound_task_status(
            &self.device_id,
            local_task_id,
            execution_status,
            observed_at_ms,
        ) {
            Ok(0) => {}
            Ok(changed) => log_executor_event(
                "runtime task Issue status projected",
                &[
                    ("local_task_id", local_task_id.to_owned()),
                    ("execution_status", execution_status.to_owned()),
                    ("observed_at_ms", observed_at_ms.to_string()),
                    ("changed", changed.to_string()),
                ],
            ),
            Err(error) => log_executor_event(
                "runtime task Issue status projection failed",
                &[
                    ("local_task_id", local_task_id.to_owned()),
                    ("execution_status", execution_status.to_owned()),
                    ("observed_at_ms", observed_at_ms.to_string()),
                    ("error", error.to_string()),
                ],
            ),
        }
    }

    pub(super) fn project_runtime_link_status(&self, link: &RuntimeTaskLink) {
        self.project_runtime_link_status_at(link, link.updated_at);
    }

    fn project_runtime_link_status_at(&self, link: &RuntimeTaskLink, observed_at_ms: i64) {
        let execution_status = if link.status == "archived" {
            Some("archived")
        } else if link.running || link.status == "running" {
            Some("running")
        } else {
            match link.status.as_str() {
                "queued" | "pending" => Some("queued"),
                "failed" | "error" => Some("failed"),
                "cancelled" | "canceled" | "interrupted" => Some("cancelled"),
                "done" | "completed" | "succeeded" => Some("succeeded"),
                _ if link.completed_at.is_some() => Some("succeeded"),
                _ => None,
            }
        };
        if let Some(execution_status) = execution_status {
            self.project_bound_task_status(&link.local_task_id, execution_status, observed_at_ms);
        }
    }

    pub(super) fn start_queue_run(&self, local_task_id: &str) {
        let Ok(store) = LocalTaskStore::from_env() else {
            return;
        };
        let _ = store.mark_runtime_running(local_task_id);
    }

    /// Report a finished local-project robot run back to the store.
    ///
    /// Local-project executions are claimed and dispatched by the App, which
    /// owns the model catalog and cloud gateway configuration; the executor
    /// only stores the run and writes back the outcome. The runtime task id
    /// recorded on the execution row identifies the finished run.
    pub(super) fn finish_queue_run(
        &self,
        local_task_id: &str,
        status: AutomationRunStatus,
        error: Option<String>,
        result_content: Option<String>,
    ) {
        let Ok(store) = LocalTaskStore::from_env() else {
            return;
        };
        let Ok(Some(execution)) = store.execution_by_runtime_task_id(local_task_id) else {
            return;
        };
        let execution_id = execution.id;
        let error_text = error.unwrap_or_else(|| "Local runtime run failed".to_owned());
        match status {
            AutomationRunStatus::Succeeded | AutomationRunStatus::NeedsAttention => {
                let content = result_content.unwrap_or_default();
                let _ = store.complete_execution(execution_id, Some(&content));
            }
            AutomationRunStatus::Failed => {
                let _ = store.fail_execution(execution_id, &error_text, true);
            }
            AutomationRunStatus::Cancelled => {
                let _ = store.cancel_execution_observed(execution_id, Some(&error_text));
            }
            _ => {}
        }
    }
}
