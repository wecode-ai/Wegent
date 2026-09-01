// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::automations::AutomationRunStatus;

static LAST_RUNTIME_STATUS_OBSERVATION: AtomicU64 = AtomicU64::new(0);

fn next_runtime_status_observation() -> i64 {
    let wall_clock = now_ms().max(1) as u64;
    let mut previous = LAST_RUNTIME_STATUS_OBSERVATION.load(Ordering::Relaxed);
    loop {
        let next = wall_clock.max(previous.saturating_add(1));
        match LAST_RUNTIME_STATUS_OBSERVATION.compare_exchange_weak(
            previous,
            next,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return next.min(i64::MAX as u64) as i64,
            Err(actual) => previous = actual,
        }
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn track_default_work_item_async(
        &self,
        local_task_id: String,
        task_title: String,
        description: String,
    ) {
        let handler = self.clone();
        let device_id = self.device_id.clone();
        let task_store_path = self.task_store_path.clone();
        let worker_task_id = local_task_id.clone();
        tokio::spawn(async move {
            let binding_result = tokio::task::spawn_blocking(move || {
                let store = LocalTaskStore::open(task_store_path.as_ref())?;
                store.ensure_default_work_item_binding(
                    &device_id,
                    &worker_task_id,
                    &task_title,
                    &description,
                )
            })
            .await;
            match binding_result {
                Ok(Ok(binding)) => {
                    log_executor_event(
                        "runtime task default Issue bound",
                        &[
                            ("local_task_id", binding.task_id.clone()),
                            (
                                "loop_item_id",
                                binding.loop_item_id.clone().unwrap_or_default(),
                            ),
                        ],
                    );
                    if let Some(link) = handler.local_task_link(&binding.task_id) {
                        handler.project_runtime_link_status_now(&link);
                    }
                }
                Ok(Err(error)) => log_executor_event(
                    "runtime task default Issue binding failed",
                    &[
                        ("local_task_id", local_task_id),
                        ("error", error.to_string()),
                    ],
                ),
                Err(error) => log_executor_event(
                    "runtime task default Issue binding worker failed",
                    &[
                        ("local_task_id", local_task_id),
                        ("error", error.to_string()),
                    ],
                ),
            }
        });
    }

    pub(crate) async fn reconcile_bound_task_statuses(&self) {
        for link in self.collect_links(false).await {
            self.project_runtime_link_status_now(&link);
        }
    }

    pub(super) fn project_bound_task_status(
        &self,
        local_task_id: &str,
        execution_status: &str,
        observed_at_ms: i64,
    ) {
        if !self.task_store_path.exists() {
            return;
        }
        let store = match LocalTaskStore::open(self.task_store_path.as_ref()) {
            Ok(store) => store,
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

    pub(super) fn project_runtime_link_status_now(&self, link: &RuntimeTaskLink) {
        self.project_runtime_link_status_at(link, next_runtime_status_observation());
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
        let Ok(store) = LocalTaskStore::open(self.task_store_path.as_ref()) else {
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
        let Ok(store) = LocalTaskStore::open(self.task_store_path.as_ref()) else {
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
