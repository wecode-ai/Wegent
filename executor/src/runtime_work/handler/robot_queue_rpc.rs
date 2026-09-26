// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::automations::AutomationRunStatus;

const LOCAL_ISSUE_PULL_INTERVAL: Duration = Duration::from_secs(1);
const LOCAL_ISSUE_LEASE_SECONDS: u64 = 300;
const LOCAL_ISSUE_HEARTBEAT_TICKS: u64 = 30;

impl RuntimeWorkRpcHandler {
    pub(super) fn start_local_issue_scheduler(&self) {
        if self
            .local_issue_scheduler_started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            self.local_issue_scheduler_started
                .store(false, Ordering::Release);
            return;
        };
        let handler = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(LOCAL_ISSUE_PULL_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut ticks = 0u64;
            loop {
                interval.tick().await;
                ticks = ticks.wrapping_add(1);
                if ticks % LOCAL_ISSUE_HEARTBEAT_TICKS == 0 {
                    handler.heartbeat_local_issue_executions();
                }
                handler.drain_local_issue_queue().await;
            }
        });
    }

    async fn drain_local_issue_queue(&self) {
        loop {
            let available = {
                let scheduler = self
                    .turn_scheduler
                    .lock()
                    .expect("runtime turn scheduler lock should not be poisoned");
                scheduler.max_concurrent_tasks.saturating_sub(
                    scheduler
                        .active_tasks
                        .saturating_add(scheduler.queued_turns.len()),
                )
            };
            if available == 0 {
                return;
            }

            let store = match LocalTaskStore::open(self.task_store_path.as_ref()) {
                Ok(store) => store,
                Err(error) => {
                    log_executor_event(
                        "local Issue queue open failed",
                        &[("error", error.to_string())],
                    );
                    return;
                }
            };
            if let Err(error) = store.tick_project_automations() {
                log_executor_event(
                    "local project automation scheduling failed",
                    &[("error", error.to_string())],
                );
            }
            let execution = match store.claim_next_execution_for_runtime(
                Some(&self.device_id),
                &self.device_id,
                LOCAL_ISSUE_LEASE_SECONDS,
            ) {
                Ok(Some(execution)) => execution,
                Ok(None) => return,
                Err(error) => {
                    log_executor_event(
                        "local Issue queue claim failed",
                        &[("error", error.to_string())],
                    );
                    return;
                }
            };
            let runtime_task_id = execution.runtime_task_id.clone().unwrap_or_default();
            let Some(payload) = execution.execution_payload.clone() else {
                let _ = store.fail_runtime_preflight(
                    execution.id,
                    "Claimed local Issue has no Runtime payload",
                );
                continue;
            };
            if execution_request(&payload).is_none() {
                let _ = store.fail_runtime_preflight(
                    execution.id,
                    "Claimed local Issue has no materialized executionRequest",
                );
                continue;
            }
            let start_requested = store
                .request_runtime_start(
                    execution.id,
                    &self.device_id,
                    &runtime_task_id,
                    LOCAL_ISSUE_LEASE_SECONDS,
                )
                .ok()
                .flatten()
                .is_some();
            if !start_requested {
                continue;
            }
            match self.create_task(payload).await {
                Ok(response)
                    if response.get("accepted").and_then(Value::as_bool) == Some(true)
                        && response.get("taskId").and_then(Value::as_str)
                            == Some(runtime_task_id.as_str()) =>
                {
                    if let Err(error) = store.confirm_runtime_accepted(
                        execution.id,
                        &self.device_id,
                        &runtime_task_id,
                        LOCAL_ISSUE_LEASE_SECONDS,
                    ) {
                        log_executor_event(
                            "local Issue Runtime acceptance persistence failed",
                            &[
                                ("execution_id", execution.id.to_string()),
                                ("error", error.to_string()),
                            ],
                        );
                    }
                }
                Ok(response) => {
                    let error = format!("Runtime rejected local Issue dispatch: {response}");
                    let _ = store.fail_execution(execution.id, &error, false);
                    return;
                }
                Err(error) => {
                    let _ = store.fail_execution(execution.id, &error.message, false);
                    return;
                }
            }
        }
    }

    fn heartbeat_local_issue_executions(&self) {
        let runtime_task_ids = {
            let scheduler = self
                .turn_scheduler
                .lock()
                .expect("runtime turn scheduler lock should not be poisoned");
            scheduler
                .active_task_ids
                .iter()
                .cloned()
                .chain(
                    scheduler
                        .queued_turns
                        .iter()
                        .map(|turn| turn.local_task_id.clone()),
                )
                .collect::<Vec<_>>()
        };
        let Ok(store) = LocalTaskStore::open(self.task_store_path.as_ref()) else {
            return;
        };
        for runtime_task_id in runtime_task_ids {
            let Ok(Some(execution)) = store.execution_by_runtime_task_id(&runtime_task_id) else {
                continue;
            };
            let _ = store.heartbeat_execution(
                execution.id,
                Some(&self.device_id),
                Some(&runtime_task_id),
                LOCAL_ISSUE_LEASE_SECONDS,
            );
        }
    }

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
    /// The Executor owns local-project queue claiming and execution. The
    /// runtime task id recorded on the execution row identifies the finished
    /// run and closes the Issue execution lifecycle in the shared local store.
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
                    store.fail_execution(execution_id, &error_text, false)?;
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
