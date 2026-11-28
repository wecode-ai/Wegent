// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) struct TurnSettlement {
    pub(super) status: &'static str,
    run_status: AutomationRunStatus,
    content: Option<String>,
    reason: Option<String>,
}

impl TurnSettlement {
    pub(super) fn from_outcome(outcome: Result<&ExecutionOutcome, &str>) -> Option<Self> {
        let (status, run_status, content, reason) = match outcome {
            Ok(ExecutionOutcome::Completed { content }) => (
                "done",
                AutomationRunStatus::Succeeded,
                Some(content.clone()),
                None,
            ),
            Ok(ExecutionOutcome::WaitingForUserInput { stop_reason }) => (
                "done",
                AutomationRunStatus::NeedsAttention,
                Some(String::new()),
                Some(stop_reason.clone()),
            ),
            Ok(ExecutionOutcome::Failed { message }) => (
                "failed",
                AutomationRunStatus::Failed,
                None,
                Some(message.clone()),
            ),
            Err(message) => (
                "failed",
                AutomationRunStatus::Failed,
                None,
                Some(message.to_owned()),
            ),
            Ok(ExecutionOutcome::Cancelled { message }) => (
                "cancelled",
                AutomationRunStatus::Cancelled,
                None,
                Some(message.clone()),
            ),
            Ok(ExecutionOutcome::Running) => return None,
        };
        Some(Self {
            status,
            run_status,
            content,
            reason,
        })
    }

    pub(super) fn project_assistant_message(
        &self,
        link: &mut RuntimeTaskLink,
        request: &ExecutionRequest,
        blocks: Vec<Value>,
    ) {
        let local_task_id = &link.local_task_id;
        let timestamp = now_ms();
        let mut message = json!({
            "id": format!("{local_task_id}:assistant:{}", request.subtask_id),
            "taskId": local_task_id,
            "role": "assistant",
            "content": self.content.as_deref().unwrap_or_default(),
            "status": self.status,
            "runtimeStatus": self.status,
            "subtaskId": request.subtask_id,
            "turnId": request.subtask_id,
            "createdAt": timestamp,
            "completedAt": timestamp,
        });
        if !blocks.is_empty() {
            message["blocks"] = Value::Array(blocks);
        }
        if let Some(error) = self.reason.as_ref().filter(|_| self.content.is_none()) {
            message["error"] = Value::String(error.to_owned());
        }
        if link.runtime == "codex" && !link.has_platform_history() {
            if let Some(thread) = &link.thread_id {
                append_completed_transcript_messages(
                    &mut link.runtime_handle,
                    thread,
                    vec![message],
                );
            }
        } else {
            append_runtime_handle_message(&mut link.runtime_handle, message);
        }
        link.updated_at = timestamp;
    }

    pub(super) fn deliver(
        self,
        handler: &RuntimeWorkRpcHandler,
        task: &str,
        request: &ExecutionRequest,
    ) {
        handler.finish_automation_run(task, request, self.run_status, self.reason.clone());
        handler.finish_queue_run(task, request, self.run_status, self.reason, self.content);
    }
}
