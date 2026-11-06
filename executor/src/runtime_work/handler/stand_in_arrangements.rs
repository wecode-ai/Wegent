//! Durable Automation runs enter the same DSH Router without waking a semantic model.
use super::stand_in::settings_error;
use super::*;
use crate::runtime_work::automations::{Automation, AutomationRun, ConversationMode};

fn active(run: &AutomationRun) -> bool {
    matches!(
        run.status,
        AutomationRunStatus::Pending | AutomationRunStatus::Running
    )
}

#[cfg(test)]
#[path = "stand_in_arrangements_tests.rs"]
mod tests;

fn command_id(run: &AutomationRun) -> String {
    format!("arrangement-run:{}", run.id)
}

fn arrangement_error(message: impl Into<String>) -> AppIpcError {
    AppIpcError::new("arrangement_changed", message)
}

impl RuntimeWorkRpcHandler {
    pub(super) fn arrangement_contexts(
        &self,
        store: &LocalTaskStore,
    ) -> Result<Vec<Value>, AppIpcError> {
        let mut users = HashSet::new();
        for run in self
            .automation_store
            .list_runs(None)
            .iter()
            .filter(|run| active(run))
        {
            if let Some(automation) = self.automation_store.get(&run.automation_id) {
                if automation.task_request["standInCalendar"].is_object()
                    && run.status == AutomationRunStatus::Pending
                    && run.trigger != "manual"
                {
                    if let Err(error) = self.queue_calendar_run(store, &automation, run) {
                        self.automation_store
                            .mark_needs_attention(&run.id, error.message)
                            .map_err(|error| AppIpcError::new("calendar_store_error", error))?;
                    }
                    continue;
                }
            }
            let user = run
                .coordination
                .as_ref()
                .map(|binding| binding.user_id)
                .or_else(|| {
                    self.automation_store
                        .get(&run.automation_id)
                        .and_then(|automation| {
                            automation.task_request["standInOwner"]["userId"].as_i64()
                        })
                });
            if let Some(user) = user.filter(|user| *user >= 0) {
                users.insert(user);
            }
        }
        let mut contexts = Vec::new();
        users.extend(
            store
                .unfinished_arrangement_users()
                .map_err(settings_error)?,
        );
        for user in users {
            let settings = store
                .personal_stand_in(user, &self.device_id)
                .map_err(settings_error)?;
            contexts.push(json!({"id":format!("arrangements:{user}"),"revision":LocalTaskStore::arrangement_configuration_version(&settings),"enabled":true,"needsProcessing":true}));
        }
        Ok(contexts)
    }

    pub(super) async fn arrangement_rpc(
        &self,
        store: &LocalTaskStore,
        user: i64,
        settings: &Value,
        method: &str,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        match method {
            "runtime.coordination.snapshot" => {
                self.arrangement_snapshot(store, user, settings, payload)
                    .await
            }
            "runtime.coordination.commit" => {
                self.arrangement_commit(store, user, settings, payload)
                    .await
            }
            _ => Err(AppIpcError::new(
                "method_not_found",
                "Unsupported arrangement operation",
            )),
        }
    }

    async fn arrangement_snapshot(
        &self,
        store: &LocalTaskStore,
        user: i64,
        settings: &Value,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let revision = LocalTaskStore::arrangement_configuration_version(settings);
        if payload["revision"] != revision {
            return Err(arrangement_error("Arrangement settings changed"));
        }
        self.execute_arrangement_actions(store, user, settings)
            .await?;
        let mut facts = Vec::new();
        for run in self
            .automation_store
            .list_runs(None)
            .into_iter()
            .filter(active)
        {
            if run.trigger != "manual"
                && self
                    .automation_store
                    .get(&run.automation_id)
                    .is_some_and(|a| a.task_request["standInCalendar"].is_object())
            {
                if run.status == AutomationRunStatus::Running {
                    self.reconcile_arrangement(&run).await?;
                }
                continue;
            }
            let owner = run
                .coordination
                .as_ref()
                .map(|binding| binding.user_id)
                .or_else(|| {
                    self.automation_store
                        .get(&run.automation_id)
                        .and_then(|a| a.task_request["standInOwner"]["userId"].as_i64())
                });
            if owner != Some(user) {
                continue;
            }
            let Some(binding) = &run.coordination else {
                self.settle_arrangement(&run, AutomationRunStatus::NeedsAttention, None, Some("This older arrangement has no durable command receipt; review its original work before retrying".into()))?;
                continue;
            };
            if self.reconcile_arrangement(&run).await? {
                continue;
            }
            match self.current_arrangement(&run) {
                Ok(_) => facts.push(json!({"id":run.id,"userId":user,"roleId":binding.role_id,"automationId":run.automation_id,"automationVersion":binding.automation_version,"taskId":binding.task_id,"scheduledFor":run.scheduled_for})),
                Err(error) => self.settle_arrangement(&run, AutomationRunStatus::NeedsAttention, None, Some(error.message))?,
            }
        }
        facts.truncate(100);
        if facts.is_empty() {
            return Ok(json!({"skip":true}));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let events: Vec<Value> = facts.iter().map(|run| json!({"id":run["id"],"kind":"schedule_due","arrangement":true,"sourceKey":run["automationId"],"receivedAt":run["scheduledFor"],"notBefore":run["scheduledFor"],"processingMode":"immediate"})).collect();
        let snapshot = json!({"id":id,"deviceId":self.device_id,"configurationVersion":revision,"runs":facts,"context":{"id":format!("arrangements:{user}"),"revision":revision,"enabled":true},"now":now,"events":events});
        store
            .save_arrangement_snapshot(user, &snapshot)
            .map_err(settings_error)?;
        Ok(json!({"id":id,"context":snapshot["context"],"now":now,"events":events}))
    }

    async fn arrangement_commit(
        &self,
        store: &LocalTaskStore,
        user: i64,
        settings: &Value,
        payload: &Value,
    ) -> Result<Value, AppIpcError> {
        let id = payload["snapshotId"]
            .as_str()
            .ok_or_else(|| arrangement_error("Missing arrangement snapshot"))?;
        let digest = LocalTaskStore::coordination_event_version(payload);
        let actions = payload["actions"]
            .as_array()
            .ok_or_else(|| arrangement_error("Missing arrangement actions"))?;
        let receipt = store
            .commit_arrangement_route(user, &self.device_id, id, &digest, actions)
            .map_err(settings_error)?;
        self.execute_arrangement_actions(store, user, settings)
            .await?;
        Ok(receipt)
    }

    pub(super) fn current_arrangement(
        &self,
        run: &AutomationRun,
    ) -> Result<Automation, AppIpcError> {
        let binding = run
            .coordination
            .as_ref()
            .ok_or_else(|| arrangement_error("Missing durable arrangement identity"))?;
        let automation = self
            .automation_store
            .get(&run.automation_id)
            .ok_or_else(|| arrangement_error("The arrangement was cancelled"))?;
        if automation.version != binding.automation_version
            || automation.task_request["standInOwner"]["userId"] != binding.user_id
            || automation.task_request["standInOwner"]["roleId"] != binding.role_id
            || (!automation.enabled
                && run.trigger != "manual"
                && !matches!(
                    automation.schedule,
                    crate::runtime_work::automations::AutomationSchedule::OneTime { .. }
                ))
        {
            return Err(arrangement_error(
                "The arrangement changed or was paused before execution",
            ));
        }
        Ok(automation)
    }

    fn settle_arrangement(
        &self,
        run: &AutomationRun,
        status: AutomationRunStatus,
        task: Option<String>,
        error: Option<String>,
    ) -> Result<(), AppIpcError> {
        self.automation_store
            .settle_coordinated_run(&run.id, status, task, error)
            .map_err(arrangement_error)?;
        self.emit_automation_runs_changed(&run.automation_id, &run.id);
        Ok(())
    }

    /// Query the original accepted command before re-reading mutable configuration.
    async fn reconcile_arrangement(&self, run: &AutomationRun) -> Result<bool, AppIpcError> {
        let binding = run
            .coordination
            .as_ref()
            .ok_or_else(|| arrangement_error("Missing arrangement binding"))?;
        let receipt = match self.command_receipt(json!({"taskId":binding.task_id,"commandId":command_id(run),"userId":binding.user_id})).await {
            Ok(receipt) => receipt,
            Err(error) if error.code == "not_found" && run.status == AutomationRunStatus::Pending => return Ok(false),
            Err(error) if error.code == "not_found" => {
                self.settle_arrangement(run, AutomationRunStatus::NeedsAttention, Some(binding.task_id.clone()), Some("Execution cannot be confirmed; inspect the original work before retrying".into()))?;
                return Ok(true);
            }
            Err(error) => return Err(error),
        };
        let (status, error) = match receipt["state"].as_str() {
            Some("awaiting_user") => (
                AutomationRunStatus::NeedsAttention,
                Some("The original work is waiting for your answer or approval".into()),
            ),
            Some("settled") => (AutomationRunStatus::Succeeded, None),
            Some("failed") => (
                AutomationRunStatus::Failed,
                Some("The scheduled command failed; inspect the original work".into()),
            ),
            Some("cancelled") => (
                AutomationRunStatus::Cancelled,
                Some("The scheduled command was cancelled".into()),
            ),
            Some("queued" | "dispatching" | "started") => (AutomationRunStatus::Running, None),
            _ => (
                AutomationRunStatus::NeedsAttention,
                Some("Execution is uncertain; inspect the original work before retrying".into()),
            ),
        };
        if run.status != status {
            self.settle_arrangement(run, status, Some(binding.task_id.clone()), error)?;
        }
        Ok(true)
    }

    async fn execute_arrangement_actions(
        &self,
        store: &LocalTaskStore,
        user: i64,
        settings: &Value,
    ) -> Result<(), AppIpcError> {
        for mut action in store
            .stand_in_actions(user)
            .map_err(settings_error)?
            .into_iter()
            .filter(|action| {
                action["kind"] == "run_arrangement"
                    && matches!(action["status"].as_str(), Some("pending" | "sending"))
            })
        {
            let Some(run) = self
                .automation_store
                .list_runs(None)
                .into_iter()
                .find(|run| {
                    run.coordination
                        .as_ref()
                        .is_some_and(|binding| binding.user_id == user)
                        && run.id == action["arguments"]["runId"]
                })
            else {
                action["status"] = json!("cancelled");
                action["error"] = json!({"code":"arrangement_missing","message":"The original arrangement run is no longer available"});
                store
                    .save_stand_in_action(user, &action)
                    .map_err(settings_error)?;
                continue;
            };
            if !active(&run) {
                action["status"] = json!("succeeded");
            } else {
                let gate =
                    self.task_send_gate(&format!("automation-operation:{}", run.automation_id));
                let _guard = gate.lock().await;
                if self.reconcile_arrangement(&run).await? {
                    action["status"] = json!("succeeded");
                } else if action["arguments"]["configurationVersion"]
                    != LocalTaskStore::arrangement_configuration_version(settings)
                {
                    action["status"] = json!("cancelled");
                } else {
                    match self.dispatch_arrangement(&run, settings).await {
                        Ok(()) => action["status"] = json!("succeeded"),
                        Err(error) => {
                            // A native acceptance may precede an IPC failure. Its receipt wins.
                            if !self.reconcile_arrangement(&run).await? {
                                self.settle_arrangement(
                                    &run,
                                    AutomationRunStatus::NeedsAttention,
                                    None,
                                    Some(error.message.clone()),
                                )?;
                            }
                            action["status"] = json!("failed");
                            action["error"] = json!({"code":error.code,"message":error.message});
                        }
                    }
                }
            }
            store
                .save_stand_in_action(user, &action)
                .map_err(settings_error)?;
        }
        Ok(())
    }

    pub(super) async fn dispatch_arrangement(
        &self,
        run: &AutomationRun,
        settings: &Value,
    ) -> Result<(), AppIpcError> {
        let automation = self.current_arrangement(run)?;
        let binding = run
            .coordination
            .as_ref()
            .ok_or_else(|| arrangement_error("Missing arrangement binding"))?;
        let mut payload = match automation.conversation_mode {
            ConversationMode::Independent => automation.task_payload.clone(),
            ConversationMode::ContinueThread => automation
                .continuation_payload
                .clone()
                .unwrap_or_else(|| automation.task_payload.clone()),
        };
        payload["taskId"] = json!(binding.task_id);
        payload["message"] = json!(automation.prompt);
        payload["commandId"] = json!(command_id(run));
        payload["clientUserMessageId"] = json!(command_id(run));
        payload = self.prepare_stand_in_schedule(&automation, payload).await?;
        super::automation_rpc::add_automation_context(
            &mut payload,
            &automation.id,
            &run.id,
            run.scheduled_for,
        );
        payload["executionRequest"]["standInSchedule"] = json!({"id":automation.id,"version":automation.version,"runId":run.id,"scheduledFor":run.scheduled_for,"userId":binding.user_id,"roleId":binding.role_id,"settingsVersion":settings["version"],"manual":run.trigger=="manual","claimedOneTime":matches!(automation.schedule, crate::runtime_work::automations::AutomationSchedule::OneTime { .. }),"continuation":matches!(automation.conversation_mode,ConversationMode::ContinueThread)});
        let response = match automation.conversation_mode {
            ConversationMode::Independent => self.create_task(payload).await?,
            ConversationMode::ContinueThread => self.send_message(payload).await?,
        };
        if response["accepted"] == false || response["success"] == false {
            return Err(arrangement_error("The scheduled command was rejected"));
        }
        if !self.reconcile_arrangement(run).await? {
            return Err(arrangement_error(
                "The scheduled command has no durable receipt",
            ));
        }
        Ok(())
    }
}
