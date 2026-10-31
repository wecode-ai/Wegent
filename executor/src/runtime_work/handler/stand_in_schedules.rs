//! Scheduled work reuses Automations and resolves its identity at execution time.
use super::stand_in_tasks::required;
use super::*;
use crate::runtime_work::automations::{Automation, ConversationMode};
use crate::task_runtime::mcp::StandInMcpIdentity;
use crate::task_runtime::personal_stand_in::stand_in_identities;

impl RuntimeWorkRpcHandler {
    pub(super) fn validate_stand_in_schedule_start(
        &self,
        request: &ExecutionRequest,
        task_id: &str,
    ) -> Result<(), String> {
        let Some(schedule) = request.extra.get("standInSchedule") else {
            return Ok(());
        };
        let id = schedule["id"]
            .as_str()
            .ok_or("Missing arrangement identity")?;
        let current = self
            .automation_store
            .get(id)
            .ok_or("The arrangement was cancelled before starting")?;
        if json!(current.version) != schedule["version"]
            || (!current.enabled
                && schedule["manual"] != true
                && schedule["claimedOneTime"] != true)
            || current.task_request["standInOwner"]["userId"] != schedule["userId"]
            || current.task_request["standInOwner"]["roleId"] != schedule["roleId"]
        {
            return Err("The arrangement changed or was paused before starting".into());
        }
        let user = schedule["userId"]
            .as_i64()
            .ok_or("Missing arrangement owner")?;
        let store =
            LocalTaskStore::open(self.task_store_path.as_ref()).map_err(|e| e.to_string())?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(|e| e.to_string())?;
        if schedule["settingsVersion"] != settings["version"] {
            return Err("The identity settings changed before starting".into());
        }
        let role_id = schedule["roleId"]
            .as_str()
            .ok_or("Missing arrangement identity")?;
        let enabled = if role_id == "@primary" {
            settings["primary"]["enabled"] != false
        } else {
            stand_in_identities(&settings)
                .iter()
                .any(|role| role["id"] == role_id && role["enabled"] == true)
        };
        if !enabled {
            return Err("The scheduled work identity is paused or no longer exists".into());
        }
        if schedule["continuation"] == true {
            let link = self
                .local_task_link(task_id)
                .ok_or("The followed work no longer exists")?;
            if !super::stand_in_tasks::owns_task(&link, user)
                || link.status == "archived"
                || link
                    .interaction_status
                    .as_deref()
                    .is_some_and(|status| !status.is_empty())
            {
                return Err("The followed work is waiting for your answer or approval".into());
            }
        }
        Ok(())
    }

    pub(super) fn reject_stand_in_schedule_turn(
        &self,
        request: &ExecutionRequest,
        task_id: &str,
        error: String,
    ) {
        let schedule = &request.extra["standInSchedule"];
        if let Some(run) = schedule["runId"].as_str() {
            let _ = self
                .automation_store
                .mark_needs_attention(run, error.clone());
        }
        if let (Some(id), Some(run)) = (schedule["id"].as_str(), schedule["runId"].as_str()) {
            self.emit_automation_runs_changed(id, run);
        }
        if schedule["continuation"] != true {
            self.store.update_task(task_id, |link| {
                link.status = "failed".into();
                link.turn_status = Some("failed".into());
                link.runtime_handle["lastError"] = json!(error);
            });
        }
        let handler = self.clone();
        let id = task_id.to_owned();
        tokio::spawn(async move {
            handler.finish_scheduled_turn(&id).await;
        });
    }

    pub(super) async fn stand_in_schedule_operation(
        &self,
        identity: &StandInMcpIdentity,
        name: &str,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let owned = |automation: &Automation| {
            automation.task_request["standInOwner"]["userId"] == identity.user
        };
        if name == "list_schedules" {
            return Ok(
                json!({"items": self.automation_store.list().into_iter().filter(owned).map(|a| json!({"id":a.id,"name":a.name,"schedule":a.schedule,"timezone":a.timezone,"enabled":a.enabled,"nextRunAt":a.next_run_at,"lastRunAt":a.last_run_at})).collect::<Vec<_>>()}),
            );
        }
        if name == "cancel_schedule" {
            let id = required(args, "scheduleId")?;
            if !self.automation_store.get(id).is_some_and(|a| owned(&a)) {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Arrangement does not belong to this user",
                ));
            }
            return self.delete_automation(json!({"automationId":id})).await;
        }
        self.create_stand_in_schedule(identity, args).await
    }

    async fn create_stand_in_schedule(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        use sha2::{Digest, Sha256};
        let key = json!([
            identity.user,
            identity.task_id,
            required(args, "requestId")?
        ])
        .to_string();
        let id = format!("stand-in-schedule-{:x}", Sha256::digest(key.as_bytes()));
        let gate = self.task_send_gate(&format!("stand-in-schedule:{id}"));
        let _guard = gate.lock().await;
        if let Some(automation) = self.automation_store.get(&id) {
            return Ok(json!({"automation":automation,"alreadyExists":true}));
        }
        let schedule = if let Some(at) = args["at"].as_str() {
            let at = chrono::DateTime::parse_from_rfc3339(at).map_err(|_| {
                AppIpcError::new("bad_request", "A future RFC3339 timestamp is required")
            })?;
            if at <= chrono::Utc::now() || args["cron"].is_string() {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Choose one future time or a recurring schedule",
                ));
            }
            json!({"type":"one_time","execute_at":at.to_rfc3339()})
        } else {
            json!({"type":"cron","expression":required(args,"cron")?})
        };
        let task = args["taskId"].as_str();
        if task.is_some_and(|id| {
            !self
                .local_task_link(id)
                .is_some_and(|link| super::stand_in_tasks::owns_task(&link, identity.user))
        }) {
            return Err(AppIpcError::new(
                "permission_denied",
                "Scheduled continuation must belong to this user",
            ));
        }
        let request = json!({"schemaVersion":2,"runtime":"codex","deviceId":self.device_id,"message":required(args,"message")?,"title":required(args,"title")?,"standInOwner":{"userId":identity.user,"roleId":"@primary"}});
        self.create_automation(json!({"automation":{"id":id,"version":0,"name":required(args,"title")?,"prompt":required(args,"message")?,"schedule":schedule,"timezone":args["timezone"].as_str().unwrap_or("UTC"),"enabled":true,"conversationMode":if task.is_some(){"continue_thread"}else{"independent"},"notificationPolicy":"attention_only","taskRequest":request,"taskPayload":{"runtime":"codex"},"continuationPayload":task.map(|id|json!({"taskId":id}))}})).await
    }

    pub(super) async fn prepare_stand_in_schedule(
        &self,
        automation: &Automation,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let owner = &automation.task_request["standInOwner"];
        let user = owner["userId"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or_else(|| AppIpcError::new("permission_denied", "Invalid scheduled work owner"))?;
        let role_id = owner["roleId"].as_str().ok_or_else(|| {
            AppIpcError::new("permission_denied", "Missing scheduled work identity")
        })?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let mut identities = stand_in_identities(&settings);
        if role_id == "@primary" && !settings["primary"].is_object() {
            identities.push(json!({"id":"@primary","enabled":true,"userId":user}));
        }
        let mut config = identities
            .into_iter()
            .find(|role| role["id"] == role_id && role["enabled"] == true)
            .ok_or_else(|| {
                AppIpcError::new(
                    "permission_denied",
                    "The scheduled work identity is paused or no longer exists",
                )
            })?;
        config["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":true});
        if config["agentProject"].is_object() {
            config["projectId"] = config["agentProject"]["id"].clone();
            config["projectStore"] = config["agentProject"]["store"].clone();
        }
        if matches!(
            automation.conversation_mode,
            ConversationMode::ContinueThread
        ) {
            return self
                .prepare_scheduled_continuation(payload, user, role_id, &config)
                .await;
        }
        let mut payload = payload;
        payload["origin"] = json!({"type":"stand_in_schedule","initiatedBy":"stand_in","userId":user,"standInId":role_id,"automationId":automation.id,"deviceId":self.device_id,"askBeforeAct":true});
        let mut prepared = self.prepare_stand_in_execution(payload, &config).await?;
        let system = prepared["executionRequest"]["system_prompt"]
            .as_str()
            .unwrap_or_default();
        prepared["executionRequest"]["system_prompt"] = json!(format!(
            "{system}\n\n{}",
            config["preferences"].as_str().unwrap_or_default()
        ));
        Ok(prepared)
    }

    async fn prepare_scheduled_continuation(
        &self,
        mut payload: Value,
        user: i64,
        role_id: &str,
        config: &Value,
    ) -> Result<Value, AppIpcError> {
        let id = payload["taskId"].as_str().unwrap_or_default();
        let link = self.local_task_link(id).ok_or_else(|| {
            AppIpcError::new("not_found", "Scheduled work is no longer available")
        })?;
        if matches!(
            link.runtime_handle["origin"]["type"].as_str(),
            Some("project_coordinator" | "stand_in_identity" | "stand_in_processing")
        ) {
            return Err(AppIpcError::new(
                "bad_request",
                "Choose the concrete work to continue, rather than a coordinator conversation",
            ));
        }
        if !super::stand_in_tasks::owns_task(&link, user)
            || (role_id != "@primary" && link.runtime_handle["origin"]["standInId"] != role_id)
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Scheduled continuation is outside this identity's work",
            ));
        }
        if link.status == "archived"
            || link
                .interaction_status
                .as_deref()
                .is_some_and(|status| !status.is_empty())
        {
            return Err(AppIpcError::new(
                "work_awaiting_user",
                "This work is waiting for your answer or approval; a schedule cannot answer it",
            ));
        }
        if self.is_busy_local_task(id) {
            return Err(AppIpcError::new(
                "work_busy",
                "This work is still running; retry the arrangement when it is ready",
            ));
        }
        if !is_codex_runtime(&link.runtime) {
            return Err(AppIpcError::new(
                "confirmation_runtime_unsupported",
                "Use a Codex task to retain native confirmation controls",
            ));
        }
        self.validate_primary_task_followup(user, &link).await?;
        // Re-resolve the current agent and its execution policy before continuing.
        self.stand_in_agent(config).await?;
        let mut request = link.runtime_handle["executionRequest"].clone();
        request["prompt"] = payload["message"].clone();
        request["standInDelegation"] =
            json!({"sourceTaskId":"stand-in-schedule","userId":user,"askBeforeAct":true});
        payload["executionRequest"] = request;
        payload["queueIfBusy"] = json!(false);
        Ok(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> RuntimeWorkRpcHandler {
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
        handler.automation_store =
            crate::runtime_work::automations::AutomationStore::new(root.join("automations.json"));
        handler
    }

    #[tokio::test]
    async fn schedules_cannot_answer_questions_or_continue_coordinator_conversations() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        for (kind, waiting, expected) in [
            ("stand_in_task", true, "work_awaiting_user"),
            ("project_coordinator", false, "bad_request"),
            ("stand_in_identity", false, "bad_request"),
        ] {
            let mut link = RuntimeTaskLink::new_pending("work".into(), "".into(), "Work".into());
            link.runtime_handle["executionRequest"] = json!({"user_id":7});
            link.runtime_handle["origin"] =
                json!({"type":kind,"userId":7,"initiatedBy":"stand_in"});
            if waiting {
                link.interaction_status = Some("awaiting_user_input".into());
            }
            handler.store.upsert_task(link);
            let error = handler
                .prepare_scheduled_continuation(
                    json!({"taskId":"work","message":"Follow progress"}),
                    7,
                    "@primary",
                    &json!({}),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, expected);
            assert_eq!(
                handler
                    .local_task_link("work")
                    .unwrap()
                    .interaction_status
                    .is_some(),
                waiting
            );
        }
    }

    #[test]
    fn claimed_one_time_schedule_can_start_but_later_changes_revoke_it() {
        use crate::runtime_work::automations::AutomationRunStatus;
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let settings = store.personal_stand_in(7, "mac").unwrap();
        let automation: Automation = serde_json::from_value(json!({"id":"once","version":0,"name":"Once","prompt":"Review","taskPayload":{"runtime":"codex"},"schedule":{"type":"one_time","execute_at":"2000-01-01T00:00:00Z"},"taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"}}})).unwrap();
        handler.automation_store.create(automation).unwrap();
        let (current, run) = handler
            .automation_store
            .due(chrono::Utc::now())
            .unwrap()
            .pop()
            .unwrap();
        assert!(!current.enabled);
        let mut request: ExecutionRequest =
            serde_json::from_value(json!({"task_id":"task","subtask_id":"turn","prompt":"Review"}))
                .unwrap();
        request.extra.insert("standInSchedule".into(), json!({"id":current.id,"version":current.version,"userId":7,"roleId":"@primary","claimedOneTime":true,"settingsVersion":settings["version"]}));
        assert!(handler
            .validate_stand_in_schedule_start(&request, "task")
            .is_ok());
        handler
            .automation_store
            .mark_needs_attention(&run.id, "Keep original question".into())
            .unwrap();
        handler
            .automation_store
            .mark_running(&run.id, "task".into())
            .unwrap();
        assert_eq!(
            handler.automation_store.list_runs(Some(&current.id))[0].status,
            AutomationRunStatus::NeedsAttention
        );
        let mut changed = current.clone();
        changed.prompt = "Changed".into();
        handler.automation_store.update(changed).unwrap();
        assert!(handler
            .validate_stand_in_schedule_start(&request, "task")
            .is_err());
    }
}
