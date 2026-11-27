// SPDX-License-Identifier: Apache-2.0
//! Bind each native Claude permission request to its exact live desktop turn.
use super::*;
use std::{future::Future, pin::Pin};
use wegent_claude_harness::permission::ToolApproval;

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

pub(in crate::runtime_work::handler) struct PendingApproval {
    turn: String,
    deadline: i64,
    transcript: Arc<Mutex<TurnTranscript>>,
    answer: Option<oneshot::Sender<bool>>,
}

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) fn pending_claude_approval_message(
        &self,
        task: &str,
    ) -> Option<Value> {
        let active = self.active_local_executions.lock().ok()?;
        let execution = active.get(task).filter(|control| !control.stop_requested)?;
        let pending = execution.claude_approvals.values().next()?;
        let blocks = pending.transcript.lock().ok()?.blocks();
        Some(json!({
            "id":format!("{task}:assistant:{}", pending.turn),"taskId":task,"role":"assistant",
            "content":"","status":"running","runtimeStatus":"running","subtaskId":pending.turn,
            "turnId":pending.turn,"blocks":blocks,"createdAt":blocks.first()?.get("timestamp")
        }))
    }

    pub(in crate::runtime_work::handler) fn respond_to_claude_approval(
        &self,
        task: &str,
        response: &Value,
        owner: bool,
    ) -> Value {
        let rejected = || json!({"success": false, "accepted": false, "code": "stale_request_user_input", "taskId": task});
        if !owner {
            return rejected();
        }
        let mut active = self.active_local_executions.lock().unwrap();
        let Some(execution) = active
            .get_mut(task)
            .filter(|execution| !execution.stop_requested)
        else {
            return rejected();
        };
        let Some(pending) = response["requestId"]
            .as_str()
            .and_then(|id| execution.claude_approvals.get_mut(id))
        else {
            return rejected();
        };
        if response["interactionScope"] != pending.turn
            || now_ms() >= pending.deadline
            || pending.transcript.lock().unwrap().closed
        {
            return rejected();
        }
        let allowed = match &response["answers"] {
            answers if answers == &json!({"__mcp_approval":{"answers":["Allow"]}}) => true,
            answers
                if answers == &json!({"__mcp_approval":{"answers":["Decline"]}})
                    || answers == &json!({}) =>
            {
                false
            }
            _ => return rejected(),
        };
        if !pending
            .answer
            .take()
            .is_some_and(|answer| answer.send(allowed).is_ok())
        {
            return rejected();
        }
        json!({"success":true,"accepted":true,"taskId":task,"deviceId":self.device_id,"runtime":"claude_code"})
    }
}

struct ApprovalLease<'a> {
    sink: &'a ClaudeRuntimeEventSink,
    id: String,
    item: Value,
    status: &'static str,
}

impl ClaudeRuntimeEventSink {
    pub(super) fn finish_transcript(&self) -> Vec<Value> {
        let mut transcript = self.transcript.lock().unwrap();
        transcript.closed = true;
        // A cancelled process aborts its permission futures asynchronously. Close their
        // cards before persisting the final message, even if their Drop runs later.
        for block in transcript.blocks.values_mut() {
            let Some(payload) = block.get_mut("render_payload") else {
                continue;
            };
            if payload["kind"] != "request_user_input" || payload["interactionStatus"] != "pending"
            {
                continue;
            }
            let settled = now_ms();
            payload["interactionStatus"] = json!(if payload["expiresAtUnixMs"]
                .as_i64()
                .is_some_and(|ms| ms <= settled)
            {
                "expired"
            } else {
                "cancelled"
            });
            payload["settledAtUnixMs"] = json!(settled);
            block["status"] = json!("done");
            self.handler.emit_claude_runtime_event(
                &self.local_task_id,
                &self.request,
                "response.block.updated",
                json!({"block_id":block["id"],"updates":block}),
            );
        }
        transcript.blocks()
    }
}

impl ApprovalLease<'_> {
    fn publish(&self, created: bool) {
        let sink = self.sink;
        let block = crate::runtime_work::codex_user_input::interaction_block(&self.item, false);
        let (kind, data) = if created {
            ("response.block.created", json!({"block":block}))
        } else {
            (
                "response.block.updated",
                json!({"block_id":block["id"],"updates":block}),
            )
        };
        let builder =
            ResponsesEventBuilder::new(&sink.request.task_id, &sink.request.subtask_id, "");
        let event = builder.envelope(kind, data.clone());
        let mut transcript = sink.transcript.lock().unwrap();
        if transcript.closed {
            return;
        }
        transcript.record(&event);
        sink.handler
            .emit_claude_runtime_event(&sink.local_task_id, &sink.request, kind, data);
    }
}

impl Drop for ApprovalLease<'_> {
    fn drop(&mut self) {
        let handler = &self.sink.handler;
        let _lifecycle = handler.stand_in_lifecycle_gate.lock().unwrap();
        let mut active = handler.active_local_executions.lock().unwrap();
        let Some(execution) = active
            .get_mut(&self.sink.local_task_id)
            .filter(|control| control.execution_id == self.sink.execution_id)
        else {
            return;
        };
        execution.claude_approvals.remove(&self.id);
        self.item["renderPayload"]["interactionStatus"] = json!(self.status);
        self.item["renderPayload"]["settledAtUnixMs"] = json!(now_ms());
        self.publish(false);
        if execution.claude_approvals.is_empty() {
            handler.set_interaction_status_under_gate(&self.sink.local_task_id, None);
        }
    }
}

impl ToolApproval for ClaudeRuntimeEventSink {
    fn decide(
        &self,
        id: String,
        tool: String,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        Box::pin(async move {
            let (sender, receiver) = oneshot::channel();
            let created = now_ms();
            let deadline = created + APPROVAL_TIMEOUT.as_millis() as i64;
            let turn = &self.request.subtask_id;
            let question = format!("{tool}\n{input}");
            let item = json!({
                "id":format!("request-user-input-{id}"), "createdAt":created,
                "renderPayload":{
                    "kind":"request_user_input","requestId":id,"interactionScope":turn,
                    "interactionStatus":"pending","interactionKind":"mcp_form","expiresAtUnixMs":deadline,
                    "toolName":tool,"toolArguments":input,
                    "questions":[{"id":"__mcp_approval","header":tool,"question":question,
                        "options":[{"label":"Allow","description":"Allow this call once."},{"label":"Decline","description":"Deny this call."}]}]
                }
            });
            let mut lease;
            {
                let _lifecycle = self.handler.stand_in_lifecycle_gate.lock().unwrap();
                let mut active = self.handler.active_local_executions.lock().unwrap();
                let Some(execution) = active.get_mut(&self.local_task_id).filter(|control| {
                    control.execution_id == self.execution_id && !control.stop_requested
                }) else {
                    return false;
                };
                if self.transcript.lock().unwrap().closed {
                    return false;
                }
                let std::collections::hash_map::Entry::Vacant(slot) =
                    execution.claude_approvals.entry(id.clone())
                else {
                    return false;
                };
                slot.insert(PendingApproval {
                    turn: turn.clone(),
                    deadline,
                    transcript: self.transcript.clone(),
                    answer: Some(sender),
                });
                lease = ApprovalLease {
                    sink: self,
                    id,
                    item,
                    status: "cancelled",
                };
                self.handler.set_interaction_status_under_gate(
                    &self.local_task_id,
                    Some(INTERACTION_WAITING_FOR_USER_INPUT),
                );
                lease.publish(true);
            }
            match tokio::time::timeout(APPROVAL_TIMEOUT, receiver).await {
                Ok(Ok(decision)) => {
                    lease.status = if decision { "answered" } else { "cancelled" };
                    lease.item["renderPayload"]["response"] = json!({"requestId":lease.id,"interactionScope":turn,"answers":{"__mcp_approval":{"answers":[if decision {"Allow"} else {"Decline"}]}}});
                    decision
                }
                Err(_) => {
                    lease.status = "expired";
                    false
                }
                Ok(Err(_)) => false,
            }
        })
    }
}
