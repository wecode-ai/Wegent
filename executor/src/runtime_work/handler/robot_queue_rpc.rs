// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, time::Duration};

use serde_json::{json, Value};

use super::*;
use crate::runtime_work::automations::AutomationRunStatus;
use crate::task_runtime::{LocalExecutionClaim, LocalTaskStore};

const QUEUE_SCHEDULER_INTERVAL_SECONDS: u64 = 3;
const QUEUE_DEFAULT_DEVICE_CAPACITY: u64 = 5;

/// Context needed to report a claimed local-project run back to the store.
#[derive(Clone)]
pub(super) struct QueueRunContext {
    pub execution_id: i64,
}

fn set_payload_string(payload: &mut Value, key: &str, value: &str) {
    payload[key] = Value::String(value.to_owned());
}

impl RuntimeWorkRpcHandler {
    /// Start the local queue puller. Cloud-project local runs are claimed and
    /// dispatched by the App (which owns the backend credentials); this
    /// scheduler only consumes local-project executions from tasks.sqlite.
    pub(super) fn start_queue_scheduler(&self) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let handler = self.clone();
        handle.spawn(async move {
            let period = Duration::from_secs(QUEUE_SCHEDULER_INTERVAL_SECONDS);
            let mut interval =
                tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                handler.pull_robot_queue().await;
            }
        });
    }

    async fn pull_robot_queue(&self) {
        self.pull_local_queue().await;
    }

    /// Claim and run local-project robot executions from tasks.sqlite.
    async fn pull_local_queue(&self) {
        let capacity = env::var("WEWORK_LOCAL_QUEUE_SLOTS")
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(QUEUE_DEFAULT_DEVICE_CAPACITY);
        let Ok(store) = LocalTaskStore::from_env() else {
            return;
        };
        let claim = LocalExecutionClaim {
            execution_device_id: Some(self.device_id.clone()),
            device_capacity: capacity,
            lease_seconds: 300,
        };
        let execution = match store.claim_next_local_execution(&claim) {
            Ok(execution) => execution,
            Err(error) => {
                log_executor_event(
                    "local robot queue claim failed",
                    &[("error", error.to_string())],
                );
                return;
            }
        };
        let Some(execution) = execution else {
            return;
        };
        let payload = execution
            .execution_payload
            .clone()
            .unwrap_or_else(|| build_local_payload(&execution));
        let task_id = format!(
            "codex-queue-{}-{}",
            execution.id,
            chrono::Utc::now().timestamp_millis()
        );
        let mut payload = payload;
        set_payload_string(&mut payload, "taskId", &task_id);
        let context = QueueRunContext {
            execution_id: execution.id,
        };
        match self.create_task(payload).await {
            Ok(_) => {
                self.queue_runs
                    .lock()
                    .unwrap()
                    .insert(task_id.clone(), context);
                let _ = store.heartbeat_execution(
                    execution.id,
                    Some(&self.device_id),
                    Some(&task_id),
                    300,
                );
            }
            Err(error) => {
                log_executor_event(
                    "local robot queue task creation failed",
                    &[
                        ("execution_id", execution.id.to_string()),
                        ("error", error.message),
                    ],
                );
                let _ =
                    store.fail_execution(execution.id, "Local runtime task creation failed", true);
            }
        }
    }

    /// Report a finished local-project run back to the store.
    pub(super) fn finish_queue_run(
        &self,
        local_task_id: &str,
        status: AutomationRunStatus,
        error: Option<String>,
    ) {
        let Some(context) = self.queue_runs.lock().unwrap().remove(local_task_id) else {
            return;
        };
        let execution_id = context.execution_id;
        let error_text = error.unwrap_or_else(|| "Local runtime run failed".to_owned());
        let Ok(store) = LocalTaskStore::from_env() else {
            return;
        };
        match status {
            AutomationRunStatus::Succeeded | AutomationRunStatus::NeedsAttention => {
                let _ = store.complete_execution(execution_id, None);
            }
            AutomationRunStatus::Failed | AutomationRunStatus::Cancelled => {
                let _ = store.fail_execution(execution_id, &error_text, true);
            }
            _ => {}
        }
    }
}

fn build_local_payload(execution: &crate::task_runtime::LocalExecution) -> Value {
    let task_id = format!("codex-queue-local-{}", execution.id);
    let prompt = format!(
        "请开始执行任务 {}：{}\n\n你是 {}，这个项目任务的 AI 执行者。\n{}\n\n完成后请总结实际改动、验证结果、未完成事项和风险，提交给人类验收。",
        execution.loop_item_id,
        execution.task_title,
        execution.agent_name,
        execution.agent_system_prompt,
    );
    let identity = format!(
        "你是 {}，这个项目任务的 AI 执行者。\n{}",
        execution.agent_name, execution.agent_system_prompt
    );
    json!({
        "taskId": task_id,
        "teamId": 0,
        "runtime": "codex",
        "message": prompt,
        "title": execution.task_title,
        "ephemeral": true,
        "cloudProjectId": execution.cloud_project_id,
        "executionRequest": {
            "task_id": task_id,
            "subtask_id": format!("{task_id}-assistant"),
            "team_id": 0,
            "team_name": "",
            "team_namespace": "default",
            "task_title": execution.task_title,
            "subtask_title": format!("{} - Assistant", execution.task_title),
            "user_id": 0,
            "user_name": "local",
            "user": {"id": 0, "name": "local", "user_name": "local"},
            "bot": [{
                "id": execution.agent_id,
                "name": execution.agent_name,
                "shell_type": "codex",
                "system_prompt": identity,
            }],
            "system_prompt": identity,
            "prompt": prompt,
            "extra": {"standalone_chat_workspace": true},
            "enable_tools": true,
            "enable_web_search": false,
            "enable_deep_thinking": true,
            "skill_names": [],
            "mcp_servers": [],
        },
    })
}
