// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::automations::AutomationRunStatus;

impl RuntimeWorkRpcHandler {
    pub(super) fn track_default_work_item_async(
        &self,
        local_task_id: String,
        task_title: String,
        description: String,
    ) {
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

    pub(super) fn project_queue_progress(&self, local_task_id: &str, content: &str) {
        if !self
            .local_task_link(local_task_id)
            .is_some_and(|link| link.runtime_handle["origin"]["projectStore"] == "local")
        {
            return;
        }
        if let Err(error) = LocalTaskStore::open(self.task_store_path.as_ref())
            .and_then(|store| store.update_execution_progress(local_task_id, content))
        {
            log_executor_event(
                "local Issue progress persistence failed",
                &[
                    ("local_task_id", local_task_id.to_owned()),
                    ("error", error.to_string()),
                ],
            );
        }
    }

    pub(super) fn start_queue_run(&self, local_task_id: &str) {
        if let Err(error) = LocalTaskStore::open(self.task_store_path.as_ref())
            .and_then(|store| store.mark_runtime_running(local_task_id))
        {
            log_executor_event(
                "local Issue start persistence failed",
                &[
                    ("local_task_id", local_task_id.to_owned()),
                    ("error", error.to_string()),
                ],
            );
        }
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
        let result = (|| {
            let store = LocalTaskStore::open(self.task_store_path.as_ref())?;
            let result_text = result_content.unwrap_or_default();
            let error_text = error.unwrap_or_else(|| "Local runtime run failed".to_owned());
            let (comment_status, comment_content) = match status {
                AutomationRunStatus::Succeeded | AutomationRunStatus::NeedsAttention => {
                    ("completed", result_text.as_str())
                }
                AutomationRunStatus::Failed => ("failed", error_text.as_str()),
                AutomationRunStatus::Cancelled => ("cancelled", error_text.as_str()),
                _ => ("streaming", ""),
            };
            if comment_status != "streaming" {
                store.finish_runtime_comment(local_task_id, comment_status, comment_content)?;
            }
            let Some(execution) = store.execution_by_runtime_task_id(local_task_id)? else {
                return Ok(());
            };
            let execution_id = execution.id;
            match status {
                AutomationRunStatus::Succeeded | AutomationRunStatus::NeedsAttention => {
                    store.complete_execution(execution_id, Some(&result_text))?;
                }
                AutomationRunStatus::Failed => {
                    store.fail_execution(execution_id, &error_text, true)?;
                }
                AutomationRunStatus::Cancelled => {
                    store.cancel_execution_observed(execution_id, Some(&error_text))?;
                }
                _ => {}
            }
            Ok::<_, crate::task_runtime::TaskRuntimeError>(())
        })();
        if let Err(error) = result {
            log_executor_event(
                "local Issue result persistence failed",
                &[
                    ("local_task_id", local_task_id.to_owned()),
                    ("error", error.to_string()),
                ],
            );
        }
    }
}
