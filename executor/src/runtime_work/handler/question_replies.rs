//! Validate question ownership before file I/O, then serialize the final delivery.
use super::*;
use crate::agents::runtime_capabilities::PreparedUserInputResponse;

pub(super) enum PreparedQuestionReply {
    Async {
        session: Option<String>,
        answer: PreparedUserInputResponse,
    },
    Blocking {
        execution_id: u64,
        key: Option<String>,
        answer: PreparedUserInputResponse,
    },
}

struct PendingQuestionReply {
    pending: ActiveRequestUserInput,
    turn: Option<ActiveCodexTurn>,
    key: Option<String>,
}

fn has_question_files(response: &Value) -> bool {
    response["answers"].as_object().is_some_and(|answers| {
        answers.values().any(|answer| {
            answer["attachments"]
                .as_array()
                .is_some_and(|files| !files.is_empty())
        })
    })
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn prepare_question_reply(
        &self,
        payload: &Value,
    ) -> Result<Option<PreparedQuestionReply>, AppIpcError> {
        let Some(response) = request_user_input_response(payload) else {
            return Ok(None);
        };
        let task = runtime_task_id(payload)
            .map(|id| self.canonical_local_task_id(&id))
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        if response["delivery"] == "async" {
            self.unanswered_async_question_reply(payload)?;
            return self
                .prepare_async_question_answer(&task, &response, payload)
                .await
                .map(Some);
        }
        self.prepare_blocking_question_reply(&task, &response, payload)
            .await
    }

    async fn prepare_blocking_question_reply(
        &self,
        task: &str,
        response: &Value,
        payload: &Value,
    ) -> Result<Option<PreparedQuestionReply>, AppIpcError> {
        if !has_question_files(response) {
            return Ok(None);
        }
        // Invalid questions must never initiate attachment downloads.
        let Ok(pending) = self.pending_question_reply(task, response) else {
            return Ok(None);
        };
        // Cloud question replies omit executionRequest: reuse the profile bound
        // to this pending task, replacing only this reply's attachment records.
        let mut request = if let Some(request) = execution_request(payload) {
            request
        } else {
            let link = self
                .local_task_link(task)
                .ok_or_else(|| AppIpcError::new("not_found", "Task no longer exists"))?;
            let mut request = execution_request(&link.runtime_handle).ok_or_else(|| {
                AppIpcError::new("bad_request", "Task execution request is missing")
            })?;
            request.extra.insert("attachments".into(), json!([]));
            self.restore_question_execution_request(task, &mut request, &link.runtime_handle)?;
            request
        };
        if let Some(files) = payload.get("attachments").filter(|files| files.is_array()) {
            request.extra.insert("attachments".into(), files.clone());
        }
        let answer = crate::agents::runtime_capabilities::prepare_user_input_response(
            request,
            response.clone(),
        )
        .await
        .map_err(|error| AppIpcError::new("attachment_preparation_failed", error))?;
        Ok(Some(PreparedQuestionReply::Blocking {
            execution_id: pending.pending.execution_id,
            key: pending.key,
            answer,
        }))
    }

    pub(super) fn restore_question_execution_request(
        &self,
        task: &str,
        request: &mut ExecutionRequest,
        runtime_handle: &Value,
    ) -> Result<(), AppIpcError> {
        // Persisted profiles intentionally omit credentials and per-send identity.
        // Restore them only in memory, after validating the pending question.
        request.task_id = task.to_owned();
        if request.subtask_id.trim().is_empty() {
            request.subtask_id = uuid::Uuid::new_v4().to_string();
        }
        crate::runtime_work::api_context::bind_task_identity(request, &self.device_id, task);
        if !request.is_local_project() {
            super::project_coordination_execution::restore_identity(request, runtime_handle)
                .map_err(|error| AppIpcError::new("attachment_preparation_failed", error))?;
        }
        self.apply_backend_connection(request);
        Ok(())
    }

    fn pending_question_reply(
        &self,
        local_task_id: &str,
        response: &Value,
    ) -> Result<PendingQuestionReply, Value> {
        let pending_request = self
            .active_request_user_inputs
            .lock()
            .ok()
            .and_then(|requests| requests.get(local_task_id).cloned());
        let Some(pending_request) = pending_request else {
            return Err(json!({
                "success": false,
                "error": "request_user_input is not pending",
                "code": "missing_request_user_input",
                "taskId": local_task_id,
                "runtime": "codex",
            }));
        };
        let active_turn = self.active_codex_turn(local_task_id);
        let scoped_to_other_turn = response.get("interactionScope").is_some_and(|scope| {
            active_turn
                .as_ref()
                .is_none_or(|turn| scope.as_str() != Some(turn.turn_id.as_str()))
        }) || active_turn
            .as_ref()
            .is_some_and(|turn| turn.execution_id != pending_request.execution_id);
        let invalid_interaction_response =
            self.question_response_rejected_by_transcript(local_task_id, response);
        if scoped_to_other_turn || invalid_interaction_response {
            return Err(json!({
                "success": false, "code": "stale_request_user_input",
                "error": "This interaction is expired, settled, or belongs to another turn",
                "taskId": local_task_id, "runtime": "codex",
            }));
        }

        if !self.is_current_local_task_execution(local_task_id, pending_request.execution_id) {
            return Err(
                json!({"success":false,"code":"stale_request_user_input","error":"The question execution changed"}),
            );
        }
        let key = active_turn.as_ref().and_then(|turn| {
            self.request_user_input_response_key(local_task_id, &turn.turn_id, response)
        });
        Ok(PendingQuestionReply {
            pending: pending_request,
            turn: active_turn,
            key,
        })
    }

    fn question_response_rejected_by_transcript(
        &self,
        local_task_id: &str,
        response: &Value,
    ) -> bool {
        self.active_codex_transcript_items
            .lock()
            .ok()
            .and_then(|items| {
                items.get(local_task_id).map(|active| {
                    active
                        .items
                        .iter()
                        .find_map(|item| {
                            super::super::mcp_elicitation::accepts_response(item, response)
                        })
                        .map(|accepted| !accepted)
                        .unwrap_or_else(|| {
                            if let Some(id) = super::super::mcp_elicitation::response_id(response) {
                                let key = id
                                    .as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| id.to_string());
                                return !active
                                    .user_input_requests
                                    .get(&key)
                                    .copied()
                                    .unwrap_or(false);
                            }
                            super::super::mcp_elicitation::response_id(response).is_none()
                                && active.items.iter().any(|item| {
                                    item["type"] == "mcpElicitation"
                                        && item["renderPayload"]["interactionStatus"] == "pending"
                                })
                        })
                })
            })
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub(super) async fn send_request_user_input_response(
        &self,
        task: &str,
        response: Value,
        request: Option<ExecutionRequest>,
    ) -> Result<Value, AppIpcError> {
        let prepared = self
            .prepare_blocking_question_reply(task, &response, &json!({"executionRequest":request}))
            .await?;
        let gate = self.task_send_gate(task);
        let _guard = gate.lock().await;
        self.send_prepared_question_response(task, response, prepared)
    }

    pub(super) async fn respond_to_child_approval(
        &self,
        local_task_id: &str,
        response: &Value,
    ) -> Result<Option<Value>, AppIpcError> {
        let Some((request_id, scope)) = super::super::mcp_elicitation::response_id(response)
            .zip(response["interactionScope"].as_str())
        else {
            return Ok(None);
        };
        let Some(turn) = self.active_codex_turn(local_task_id) else {
            return Ok(None);
        };
        if scope == turn.turn_id {
            return Ok(None);
        }
        let accepted = self
            .codex_app_server
            .answer_child_approval(request_id, response, |thread| {
                if !self.is_local_task_execution_accepting_notifications(
                    local_task_id,
                    turn.execution_id,
                ) {
                    return None;
                }
                let routing = self.thread_event_routing.lock().ok()?;
                let route = routing.routes.get(thread)?;
                (route.active
                    && route.nested
                    && route.local_task_id == local_task_id
                    && route.request.subtask_id == turn.turn_id)
                    .then(|| crate::runtime_work::stand_in_requires_confirmation(&route.request))
            })
            .await
            .map_err(|error| AppIpcError::new("child_approval_delivery_failed", error))?;
        Ok(accepted.map(|accepted| {
            if accepted {
                json!({"success":true,"accepted":true,"deviceId":self.device_id,"taskId":local_task_id,"runtime":"codex"})
            } else {
                json!({"success":false,"code":"stale_request_user_input","error":"The child approval is no longer pending or the decision is invalid"})
            }
        }))
    }

    // Called under the task send gate. No attachment or channel I/O may wait here.
    pub(super) fn send_prepared_question_response(
        &self,
        local_task_id: &str,
        response: Value,
        prepared: Option<PreparedQuestionReply>,
    ) -> Result<Value, AppIpcError> {
        let pending = match self.pending_question_reply(local_task_id, &response) {
            Ok(pending) => pending,
            Err(rejection) => return Ok(rejection),
        };
        let native_response = if has_question_files(&response) {
            match prepared {
                Some(PreparedQuestionReply::Blocking {
                    execution_id,
                    key,
                    answer,
                }) if execution_id == pending.pending.execution_id && key == pending.key => {
                    answer.response
                }
                _ => {
                    return Ok(
                        json!({"success":false,"code":"stale_request_user_input","error":"The question changed while preparing attachments"}),
                    )
                }
            }
        } else {
            response.clone()
        };
        // Reserving synchronously keeps validation, settlement and delivery atomic
        // with respect to other senders; a full/closed channel remains retryable.
        let permit = match pending.pending.sender.try_reserve() {
            Ok(permit) => permit,
            Err(error) => {
                let code = if matches!(error, mpsc::error::TrySendError::Full(_)) {
                    "busy_request_user_input"
                } else {
                    "closed_request_user_input"
                };
                return Ok(
                    json!({"success":false,"code":code,"error":error.to_string(),"taskId":local_task_id,"runtime":"codex"}),
                );
            }
        };
        if let Some(turn) = pending.turn {
            if !self.settle_request_user_input_response(
                local_task_id,
                &turn.turn_id,
                pending.key.as_deref(),
                &response,
            ) {
                return Ok(
                    json!({"success":false,"code":"stale_request_user_input","error":"The question is no longer pending"}),
                );
            }
        }
        permit.send(native_response);
        Ok(
            json!({"success":true,"accepted":true,"deviceId":self.device_id,"taskId":local_task_id,"runtime":"codex"}),
        )
    }
}
