//! An owner may abandon an unconfirmed command without inventing its native outcome.
use super::*;

fn field<'a>(payload: &'a Value, name: &str) -> Result<&'a str, AppIpcError> {
    payload[name]
        .as_str()
        .filter(|value| !value.is_empty() && value.trim() == *value && value.len() <= 256)
        .ok_or_else(|| {
            AppIpcError::new(
                "bad_request",
                format!("{name} must be a nonempty bounded string"),
            )
        })
}

fn conflict() -> AppIpcError {
    AppIpcError::new(
        "command_resolution_conflict",
        "This execution changed. Review its current receipt before deciding again.",
    )
}

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) async fn review_command_receipt(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let receipt = self.command_receipt(payload).await?;
        if receipt["state"] == "recovery_required" {
            let task = receipt["taskId"].as_str().unwrap_or_default();
            let thread = receipt["native"][1]
                .as_str()
                .map(str::to_owned)
                .or_else(|| self.local_task_link(task).and_then(|link| link.thread_id));
            let native = if let Some(thread) = thread {
                self.read_codex_recent_turns(&thread)
                    .await
                    .ok()
                    .map(|snapshot| snapshot.diagnostic_summary())
            } else {
                None
            };
            self.log_command_resolution_control(task, "owner-review", native);
        }
        Ok(receipt)
    }

    pub(in crate::runtime_work::handler) async fn resolve_command_owner(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = super::super::runtime_owner::runtime_user(&payload)?;
        let task = field(&payload, "taskId")?.to_owned();
        let id = field(&payload, "commandId")?.to_owned();
        let request_id = field(&payload, "requestId")?.to_owned();
        let expected = field(&payload, "expectedFingerprint")?;
        let native = payload.get("expectedNative").ok_or_else(conflict)?;
        if payload["decision"] != "abandon" {
            return Err(conflict());
        }
        let gate = self.task_send_gate(&task);
        let _task_guard = gate.lock().await;
        // The private device-control transport is the same authority as stop.
        // Receipt reads additionally verify the connected account and recorded owner.
        self.command_receipt(json!({"taskId":task,"commandId":id,"userId":user}))
            .await?;
        let command = self
            .command_journal
            .lock()
            .expect("command journal poisoned")
            .get(&key(&task, &id))
            .cloned()
            .ok_or_else(conflict)?;
        self.check_command_resolution_owner(&command, user)?;
        if command.fingerprint != expected || json!(command.native) != *native {
            return Err(conflict());
        }
        if command.is_owner_abandoned() {
            if command
                .owner_resolution
                .as_ref()
                .is_some_and(|resolution| resolution["requestId"] == request_id)
            {
                return self
                    .command_receipt(json!({"taskId":task,"commandId":id,"userId":user}))
                    .await;
            }
            return Err(conflict());
        }
        if command.state != CommandState::RecoveryRequired {
            return Err(conflict());
        }
        if self.command_resolution_is_busy(&task) {
            return Err(self.command_resolution_active(&task, "local-before-native", None));
        }
        let thread = command
            .native
            .as_ref()
            .map(|(_, thread, _)| thread.clone())
            .or_else(|| self.local_task_link(&task).and_then(|link| link.thread_id));
        if let Some(thread) = thread {
            let state = self
                .read_codex_recent_turns(&thread)
                .await
                .map_err(|_| unavailable())?;
            if !state.is_inactive_for_owner_resolution() {
                if !state.has_active_owner_resolution_control() {
                    self.log_command_resolution_control(
                        &task,
                        "native-control-unavailable",
                        Some(state.diagnostic_summary()),
                    );
                    return Err(unavailable());
                }
                return Err(self.command_resolution_active(
                    &task,
                    "native-control",
                    Some(state.diagnostic_summary()),
                ));
            }
        }
        let _operation = self.turn_queue_operation.lock().await;
        if self.command_resolution_is_busy(&task) {
            return Err(self.command_resolution_active(&task, "local-before-commit", None));
        }
        self.check_command_resolution_owner(&command, user)?;
        let previous = self
            .command_journal
            .lock()
            .expect("command journal poisoned")
            .clone();
        {
            let mut commands = self
                .command_journal
                .lock()
                .expect("command journal poisoned");
            let current = commands.get_mut(&command.key()).ok_or_else(conflict)?;
            if current.state != CommandState::RecoveryRequired
                || current.is_owner_abandoned()
                || current.fingerprint != command.fingerprint
                || current.native != command.native
            {
                return Err(conflict());
            }
            current.owner_resolution = Some(
                json!({"requestId":request_id,"userId":user,"deviceId":self.device_id,
                "at":now_ms(),"previousState":"recovery_required","nativeOutcome":"unknown"}),
            );
        }
        let queued = self
            .turn_scheduler
            .lock()
            .expect("turn scheduler poisoned")
            .queued_turns
            .clone();
        if let Err(error) = self.persist_turn_queue(queued, None, &[]).await {
            *self
                .command_journal
                .lock()
                .expect("command journal poisoned") = previous;
            return Err(error);
        }
        let mut receipt = self
            .command_journal
            .lock()
            .expect("command journal poisoned")
            .get(&command.key())
            .ok_or_else(conflict)?
            .receipt();
        receipt["taskTitle"] = self
            .local_task_link(&task)
            .map(|link| json!(link.title))
            .unwrap_or(Value::Null);
        Ok(receipt)
    }

    fn command_resolution_active(
        &self,
        task: &str,
        stage: &str,
        native: Option<Value>,
    ) -> AppIpcError {
        self.log_command_resolution_control(task, stage, native);
        active()
    }

    fn log_command_resolution_control(&self, task: &str, stage: &str, native: Option<Value>) {
        let preparing = self
            .preparing_turns
            .lock()
            .expect("preparation map poisoned")
            .contains_key(task);
        let goal = self.command_resolution_has_goal(task);
        log_executor_event(
            "Runtime owner resolution control",
            &[
                ("stage", stage.to_owned()),
                ("local_active", self.is_active_local_task(task).to_string()),
                ("local_queued", self.is_queued_local_task(task).to_string()),
                ("local_preparing", preparing.to_string()),
                ("local_goal", goal.to_string()),
                ("native_control", native.unwrap_or(Value::Null).to_string()),
            ],
        );
    }

    fn command_resolution_has_goal(&self, task: &str) -> bool {
        self.active_goal_turns
            .lock()
            .expect("active goal map poisoned")
            .contains_key(task)
            || self
                .local_task_link(task)
                .is_some_and(|link| link.goal_status.as_deref() == Some("active"))
    }

    fn command_resolution_is_busy(&self, task: &str) -> bool {
        self.is_busy_local_task(task) || self.command_resolution_has_goal(task)
    }

    fn check_command_resolution_owner(
        &self,
        command: &RuntimeCommand,
        user: i64,
    ) -> Result<(), AppIpcError> {
        let link = self
            .local_task_link(&command.turn.local_task_id)
            .ok_or_else(conflict)?;
        let request = &command.turn.request;
        let saved = &link.runtime_handle["executionRequest"];
        if request.extra.get("user_id") != Some(&json!(user))
            || saved["user_id"] != user
            || request.device_id.as_deref() != Some(self.device_id.as_str())
            || saved["device_id"] != self.device_id
            || request.extra.get("origin").is_some_and(|origin| {
                origin.get("userId").is_some_and(|id| *id != user)
                    || origin
                        .get("deviceId")
                        .is_some_and(|id| *id != self.device_id)
            })
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Only the recorded owner on the original device can resolve this execution.",
            ));
        }
        Ok(())
    }
}

fn active() -> AppIpcError {
    AppIpcError::new("command_resolution_active", "The original execution is still active. Stop it through the native task controls before reviewing its result.")
}

fn unavailable() -> AppIpcError {
    AppIpcError::new(
        "command_resolution_unavailable",
        "The original native execution could not be checked. It has not been retried or abandoned.",
    )
}

#[cfg(test)]
#[path = "command_owner_resolution_tests.rs"]
mod tests;
