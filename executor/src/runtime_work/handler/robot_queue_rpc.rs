// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::automations::AutomationRunStatus;
use crate::task_runtime::LocalTaskStore;

impl RuntimeWorkRpcHandler {
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
                let _ = store.complete_execution(execution_id, None);
                let _ = store.update_agent_comment_for_execution(
                    execution_id,
                    "completed",
                    &result_content.unwrap_or_default(),
                );
            }
            AutomationRunStatus::Failed | AutomationRunStatus::Cancelled => {
                let _ = store.fail_execution(execution_id, &error_text, true);
                let _ =
                    store.update_agent_comment_for_execution(execution_id, "failed", &error_text);
            }
            _ => {}
        }
    }
}
