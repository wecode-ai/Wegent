//! Command identity and recovery facts share the encrypted Runtime queue commit.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CommandState {
    Queued,
    Dispatching,
    Started,
    Failed,
    Settled,
    AwaitingUser,
    Cancelled,
    RecoveryRequired,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeCommand {
    pub(super) id: String,
    pub(super) fingerprint: String,
    pub(super) state: CommandState,
    pub(super) accepted_at: i64,
    pub(super) turn: SpawnTurnRequest,
    #[serde(default)]
    pub(super) native: Option<(u64, String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) owner_resolution: Option<Value>,
}

pub(super) type CommandJournal = std::collections::BTreeMap<String, RuntimeCommand>;

fn command_id(turn: &SpawnTurnRequest) -> Result<Option<String>, AppIpcError> {
    let Some(value) = turn.request.extra.get("runtime_command_id") else {
        return Ok(None);
    };
    value
        .as_str()
        .map(|id| Some(id.to_owned()))
        .ok_or_else(|| AppIpcError::new("bad_request", "commandId must be a string"))
}

pub(super) fn key(task: &str, command: &str) -> String {
    json!([task, command]).to_string()
}

impl RuntimeCommand {
    pub(super) fn from_turn(
        turn: &SpawnTurnRequest,
        state: CommandState,
    ) -> Result<Option<Self>, AppIpcError> {
        let Some(id) = command_id(turn)? else {
            return Ok(None);
        };
        if id.trim() != id || id.is_empty() || id.len() > 256 {
            return Err(AppIpcError::new(
                "bad_request",
                "commandId must contain 1-256 bytes without surrounding whitespace",
            ));
        }
        if !turn
            .request
            .extra
            .get("user_id")
            .and_then(Value::as_i64)
            .is_some_and(|user| user >= 0)
        {
            return Err(AppIpcError::new(
                "bad_request",
                "A command requires its execution user identity",
            ));
        }
        // Authorization secrets, refresh times and execution generations are not identity.
        let input = json!({"taskId":turn.local_task_id, "runtime":turn.runtime,
            "input":turn.request.extra.get("runtime_command_input")});
        if turn.request.extra.get("runtime_command_input").is_none() {
            return Err(AppIpcError::new(
                "bad_request",
                "Command input identity is missing",
            ));
        }
        let fingerprint = format!("{:x}", Sha256::digest(input.to_string().as_bytes()));
        Ok(Some(Self {
            id,
            fingerprint,
            state,
            accepted_at: now_ms(),
            turn: turn.clone(),
            native: None,
            owner_resolution: None,
        }))
    }

    pub(super) fn key(&self) -> String {
        key(&self.turn.local_task_id, &self.id)
    }

    pub(super) fn validate_replay(&self, incoming: &Self) -> Result<(), AppIpcError> {
        if self.fingerprint == incoming.fingerprint {
            return Ok(());
        }
        Err(AppIpcError::new(
            "command_conflict",
            "commandId was already accepted with different input or execution identity",
        ))
    }

    fn retire_request(&mut self) {
        let user = self.turn.request.extra.get("user_id").cloned();
        let subtask = self.turn.request.subtask_id.clone();
        self.turn.request = ExecutionRequest {
            subtask_id: subtask,
            ..Default::default()
        };
        if let Some(user) = user {
            self.turn.request.extra.insert("user_id".into(), user);
        }
        self.turn.send_payload = None;
        self.turn.fork_thread_path = None;
        self.turn.initial_thread_goal = None;
    }

    fn finish(&mut self, generation: Option<u64>, state: CommandState) -> bool {
        if self
            .native
            .as_ref()
            .is_some_and(|(recorded, _, _)| Some(*recorded) != generation)
        {
            return false;
        }
        if !matches!(
            self.state,
            CommandState::Dispatching | CommandState::Started
        ) {
            return false;
        }
        self.state = state;
        if matches!(
            self.state,
            CommandState::Settled
                | CommandState::AwaitingUser
                | CommandState::Failed
                | CommandState::Cancelled
        ) {
            self.retire_request();
        }
        true
    }

    pub(super) fn is_owner_abandoned(&self) -> bool {
        self.state == CommandState::RecoveryRequired && self.owner_resolution.is_some()
    }

    pub(super) fn receipt(&self) -> Value {
        let mut receipt = json!({"success":true,"accepted":true,"taskId":self.turn.local_task_id,"commandId":self.id,
            "state":self.state,"acceptedAt":self.accepted_at,"runtime":self.turn.runtime,"native":self.native,
            "commandFingerprint":self.fingerprint,
            "requiresUserReview":!self.is_owner_abandoned() && matches!(self.state, CommandState::RecoveryRequired | CommandState::AwaitingUser)});
        if self.is_owner_abandoned() {
            receipt["state"] = json!("abandoned");
        }
        if self.state == CommandState::RecoveryRequired {
            receipt["nativeOutcome"] = json!("unknown");
        }
        if let Some(resolution) = &self.owner_resolution {
            receipt["ownerResolution"] = resolution.clone();
        }
        receipt
    }
}

pub(super) fn project_queue(
    journal: &mut CommandJournal,
    queued: &VecDeque<SpawnTurnRequest>,
    starting: &[SpawnTurnRequest],
) -> Result<(), AppIpcError> {
    let mut present = HashSet::new();
    for (turns, state) in [
        (queued.iter().collect::<Vec<_>>(), CommandState::Queued),
        (starting.iter().collect(), CommandState::Dispatching),
    ] {
        for turn in turns {
            let Some(command) = RuntimeCommand::from_turn(turn, state.clone())? else {
                continue;
            };
            let id = command.key();
            present.insert(id.clone());
            if let Some(existing) = journal.get_mut(&id) {
                // A Goal recovery request intentionally has an empty prompt. Its
                // immutable command input remains the identity of the accepted request.
                existing.validate_replay(&command)?;
                if matches!(
                    existing.state,
                    CommandState::Settled
                        | CommandState::AwaitingUser
                        | CommandState::Cancelled
                        | CommandState::Failed
                        | CommandState::RecoveryRequired
                ) {
                    return Err(AppIpcError::new(
                        "command_not_dispatchable",
                        "An ended or unconfirmed command cannot re-enter the execution queue",
                    ));
                }
                existing.state = state.clone();
                existing.turn = turn.clone();
            } else {
                journal.insert(id, command);
            }
        }
    }
    for (id, command) in journal.iter_mut() {
        if present.contains(id) {
            continue;
        }
        if command.state == CommandState::Queued {
            command.state = CommandState::Cancelled;
            command.retire_request();
        }
    }
    Ok(())
}

impl RuntimeWorkRpcHandler {
    /// Recover only exact native command evidence; unresolved execution is never restarted.
    pub(super) fn recover_settled_command_session(
        &self,
        task: &str,
        user: i64,
    ) -> Result<Option<String>, AppIpcError> {
        let journal = self
            .command_journal
            .lock()
            .map_err(|_| AppIpcError::new("internal_error", "Command journal is unavailable"))?;
        let commands = journal
            .values()
            .filter(|command| command.turn.local_task_id == task)
            .collect::<Vec<_>>();
        for command in &commands {
            if command
                .turn
                .request
                .extra
                .get("user_id")
                .and_then(Value::as_i64)
                != Some(user)
            {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Command owner does not match the conversation",
                ));
            }
            if !command.is_owner_abandoned()
                && !matches!(
                    command.state,
                    CommandState::Failed | CommandState::Settled | CommandState::Cancelled
                )
            {
                return Err(AppIpcError::new(
                    "command_recovery_required",
                    "Resolve the original command before starting a native session",
                ));
            }
        }
        Ok(commands
            .into_iter()
            .filter_map(|command| {
                command
                    .native
                    .as_ref()
                    .map(|native| (command.accepted_at, native.1.clone()))
            })
            .max_by_key(|(at, _)| *at)
            .map(|(_, thread)| thread))
    }

    pub(super) async fn existing_payload_command(
        &self,
        payload: &Value,
    ) -> Result<Option<Value>, AppIpcError> {
        if payload.get("commandId").is_none() {
            return Ok(None);
        }
        let mut request = execution_request(payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        apply_runtime_payload_metadata(&mut request, payload);
        let task = runtime_task_id(payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required with commandId"))?;
        let runtime = string_field(payload, "runtime").unwrap_or_else(|| "codex".to_owned());
        let turn = SpawnTurnRequest {
            task_kind: None,
            local_task_id: task,
            runtime,
            request,
            send_payload: Some(payload.clone()),
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        };
        if self.backend_connection_snapshot()?.is_some() {
            self.verify_runtime_user(&json!({"userId":turn.request.extra.get("user_id")}))
                .await?;
        }
        if matches!(self.existing_command(&turn),Err(ref error) if error.code == "command_recovery_required")
        {
            if let Some(id) = command_id(&turn)? {
                self.reconcile_native_command(&turn.local_task_id, &id)
                    .await?;
            }
        }
        self.existing_command(&turn)
    }

    pub(super) fn existing_command(
        &self,
        turn: &SpawnTurnRequest,
    ) -> Result<Option<Value>, AppIpcError> {
        let Some(incoming) = RuntimeCommand::from_turn(turn, CommandState::Queued)? else {
            return Ok(None);
        };
        let commands = self
            .command_journal
            .lock()
            .expect("command journal lock should not be poisoned");
        let Some(existing) = commands.get(&incoming.key()) else {
            return Ok(None);
        };
        existing.validate_replay(&incoming)?;
        if existing.is_owner_abandoned() {
            return Err(AppIpcError::new("command_abandoned", "The owner abandoned this unconfirmed command. Its outcome remains unknown and the original command cannot be replayed."));
        }
        if existing.state == CommandState::RecoveryRequired {
            return Err(AppIpcError::new("command_recovery_required", "The command was accepted before the Runtime stopped, but native execution cannot be confirmed. Review the original task before retrying; it will not be resent automatically."));
        }
        Ok(Some(existing.receipt()))
    }

    pub(super) async fn command_receipt(&self, payload: Value) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(&payload)?;
        if self.backend_connection_snapshot()?.is_some() {
            self.verify_runtime_user(&payload).await?;
        }
        let task = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let id = string_field(&payload, "commandId")
            .ok_or_else(|| AppIpcError::new("bad_request", "commandId is required"))?;
        let owned = self
            .command_journal
            .lock()
            .expect("command journal poisoned")
            .get(&key(&task, &id))
            .is_some_and(|command| {
                command
                    .turn
                    .request
                    .extra
                    .get("user_id")
                    .and_then(Value::as_i64)
                    == Some(user)
            });
        if !owned {
            return Err(AppIpcError::new(
                "not_found",
                "Command receipt was not found for this user and task",
            ));
        }
        self.reconcile_native_command(&task, &id).await?;
        let commands = self
            .command_journal
            .lock()
            .expect("command journal lock should not be poisoned");
        let command = commands
            .get(&key(&task, &id))
            .filter(|command| {
                command
                    .turn
                    .request
                    .extra
                    .get("user_id")
                    .and_then(Value::as_i64)
                    == Some(user)
            })
            .cloned();
        drop(commands);
        match command {
            Some(command) => {
                let mut receipt = command.receipt();
                let link = self.local_task_link(&task);
                receipt["taskTitle"] = link
                    .as_ref()
                    .map(|link| json!(link.title))
                    .unwrap_or(Value::Null);
                receipt["ownerReview"] = json!({
                    "commandOwnerMatches":command.turn.request.extra.get("user_id") == Some(&json!(user)),
                    "commandDeviceMatches":command.turn.request.device_id.as_deref() == Some(self.device_id.as_str()),
                    "taskOwnerMatches":link.as_ref().is_some_and(|link| link.runtime_handle["executionRequest"]["user_id"] == user),
                    "taskDeviceMatches":link.as_ref().is_some_and(|link| link.runtime_handle["executionRequest"]["device_id"] == self.device_id),
                });
                Ok(receipt)
            }
            None => Err(AppIpcError::new(
                "not_found",
                "Command receipt was not found for this user and task",
            )),
        }
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn bind_command_turn(
        &self,
        task: &str,
        request: &ExecutionRequest,
        generation: u64,
        thread: &str,
        turn: &str,
    ) {
        let Some(id) = request
            .extra
            .get("runtime_command_id")
            .and_then(Value::as_str)
        else {
            return;
        };
        let (id, task, thread, turn) = (
            id.to_owned(),
            task.to_owned(),
            thread.to_owned(),
            turn.to_owned(),
        );
        let handler = self.clone();
        tokio::spawn(async move {
            let _operation = handler.turn_queue_operation.lock().await;
            if !handler.is_current_local_task_execution(&task, generation) {
                return;
            }
            let previous = handler
                .command_journal
                .lock()
                .expect("command journal poisoned")
                .clone();
            {
                let mut commands = handler
                    .command_journal
                    .lock()
                    .expect("command journal poisoned");
                let Some(command) = commands.get_mut(&key(&task, &id)) else {
                    return;
                };
                if command.is_owner_abandoned()
                    || !matches!(
                        command.state,
                        CommandState::Dispatching | CommandState::RecoveryRequired
                    )
                {
                    return;
                }
                command.state = CommandState::Started;
                command.native = Some((generation, thread, turn));
            }
            let queued = handler
                .turn_scheduler
                .lock()
                .expect("turn scheduler poisoned")
                .queued_turns
                .clone();
            if let Err(error) = handler.persist_turn_queue(queued, None, &[]).await {
                *handler
                    .command_journal
                    .lock()
                    .expect("command journal poisoned") = previous;
                log_executor_event(
                    "runtime command binding persistence failed",
                    &[("task_id", task), ("code", error.code)],
                );
            }
        });
    }

    pub(super) async fn finish_command_execution(
        &self,
        task: &str,
        generation: u64,
        id: Option<&str>,
        outcome: Option<CommandState>,
    ) {
        let operation = self.turn_queue_operation.clone().lock_owned().await;
        {
            if self
                .active_local_executions
                .lock()
                .expect("active execution map poisoned")
                .get(task)
                .is_some_and(|execution| execution.execution_id != generation)
            {
                return;
            }
            if let Some(id) = id {
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
                    if let Some(command) = commands.get_mut(&key(task, id)) {
                        if command
                            .native
                            .as_ref()
                            .is_some_and(|(recorded, _, _)| *recorded != generation)
                        {
                            return;
                        }
                        if matches!(
                            command.state,
                            CommandState::Dispatching | CommandState::Started
                        ) {
                            let outcome = outcome.unwrap_or(CommandState::RecoveryRequired);
                            command.finish(Some(generation), outcome);
                        }
                    }
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
                    log_executor_event(
                        "runtime command result persistence failed",
                        &[("task_id", task.to_owned()), ("code", error.code)],
                    );
                }
            }
        }
        self.finish_scheduled_turn_locked(task, operation).await;
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn reconcile_command_recovery(&self) {
        let mut commands = self
            .command_journal
            .lock()
            .expect("command journal poisoned");
        for command in commands.values_mut() {
            if command.state != CommandState::RecoveryRequired || command.is_owner_abandoned() {
                continue;
            }
            let link = self.local_task_link(&command.turn.local_task_id);
            let native = command
                .native
                .as_ref()
                .map(|(_, thread, turn)| (thread.clone(), turn.clone()))
                .or_else(|| {
                    link.as_ref()
                        .filter(|link| {
                            link.runtime_handle["executionRequest"]["runtime_command_id"]
                                == command.id
                        })
                        .and_then(|link| {
                            let turn = link
                                .runtime_handle
                                .get("turnIdsBySubtask")?
                                .get(&command.turn.request.subtask_id)?
                                .as_str()?;
                            Some((link.thread_id.clone()?, turn.to_owned()))
                        })
                });
            if let Some((thread, turn)) = native {
                // Binding proves acceptance, not the terminal outcome. Verify the
                // exact native turn asynchronously when its receipt is requested.
                command.native = Some((0, thread, turn));
                continue;
            }
        }
    }
}

impl RuntimeWorkRpcHandler {
    async fn reconcile_native_command(&self, task: &str, id: &str) -> Result<(), AppIpcError> {
        let command = self
            .command_journal
            .lock()
            .expect("command journal poisoned")
            .get(&key(task, id))
            .cloned();
        let Some(command) = command.filter(|command| {
            command.state == CommandState::RecoveryRequired && !command.is_owner_abandoned()
        }) else {
            return Ok(());
        };
        let Some((_, thread, turn)) = command.native.as_ref() else {
            if self.local_task_link(task).is_some_and(|link| {
                link.runtime_handle["executionRequest"]["runtime_command_id"] == command.id
            }) {
                self.retain_failed_runtime_task(task,&AppIpcError::new("command_recovery_required","A command was accepted before the Runtime stopped. Its execution is unconfirmed; review this work before retrying. It has not been resent."));
            }
            return Ok(());
        };
        let cursor = crate::runtime_work::codex_timeline::turn_cursor(turn);
        let page = crate::runtime_work::codex_timeline::load_timeline_page(
            &self.codex_app_server,
            json!({}),
            thread,
            Some(&cursor),
            1,
            false,
            false,
        );
        #[cfg(test)]
        let page = match self.transcript_test_workers.clone() {
            Some(workers) => {
                crate::runtime_work::transcript_work::with_test_workers(workers, page).await
            }
            None => page.await,
        };
        #[cfg(not(test))]
        let page = page.await;
        let page = page.map_err(|error| {
            AppIpcError::new(
                "command_recovery_unavailable",
                format!("Native command history could not be verified: {error}"),
            )
        })?;
        let native = page.thread["turns"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|native| native["id"] == *turn);
        let outcome = match native {
            Some(native) if native["timelineCompleted"] == true => {
                match native["status"].as_str() {
                    Some("completed") => CommandState::Settled,
                    Some("interrupted" | "cancelled") => CommandState::Cancelled,
                    Some("failed") => CommandState::Failed,
                    _ => CommandState::RecoveryRequired,
                }
            }
            _ if self
                .active_codex_turn(task)
                .is_some_and(|active| active.thread_id == *thread && active.turn_id == *turn) =>
            {
                CommandState::Started
            }
            _ => CommandState::RecoveryRequired,
        };
        if outcome == CommandState::RecoveryRequired {
            return Ok(());
        }
        let _operation = self.turn_queue_operation.lock().await;
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
            let Some(current) = commands.get_mut(&command.key()) else {
                return Ok(());
            };
            if current.state != CommandState::RecoveryRequired
                || current.is_owner_abandoned()
                || current.fingerprint != command.fingerprint
            {
                return Ok(());
            }
            current.state = outcome;
            if current.state != CommandState::Started {
                current.retire_request();
            }
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
        Ok(())
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn finish_prepared_command(
        &self,
        turn: &SpawnTurnRequest,
        state: CommandState,
    ) {
        if turn.request.extra.contains_key(quota_recovery::MARKER) {
            self.finish_quota_command(turn).await;
            return;
        }
        let operation = self.turn_queue_operation.clone().lock_owned().await;
        if self
            .active_local_executions
            .lock()
            .expect("active execution map poisoned")
            .contains_key(&turn.local_task_id)
        {
            return;
        }
        if let Ok(Some(id)) = command_id(turn) {
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
                if let Some(command) = commands.get_mut(&key(&turn.local_task_id, &id)) {
                    if command.native.is_some() {
                        return;
                    }
                    command.finish(None, state);
                }
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
                log_executor_event(
                    "prepared command result persistence failed",
                    &[("code", error.code)],
                );
            }
        }
        self.finish_scheduled_turn_locked(&turn.local_task_id, operation)
            .await;
    }
}

impl CommandState {
    pub(super) fn from_execution(outcome: &ExecutionOutcome) -> Self {
        match outcome {
            ExecutionOutcome::Completed { .. } => Self::Settled,
            ExecutionOutcome::WaitingForUserInput { .. } => Self::AwaitingUser,
            ExecutionOutcome::Cancelled { .. } => Self::Cancelled,
            ExecutionOutcome::Failed { .. } => Self::Failed,
            ExecutionOutcome::Running => Self::RecoveryRequired,
        }
    }
}

#[cfg(test)]
#[path = "command_journal_tests.rs"]
mod tests;

#[path = "command_owner_resolution.rs"]
mod owner_resolution;
