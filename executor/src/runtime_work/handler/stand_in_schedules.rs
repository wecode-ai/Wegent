//! Scheduled work reuses Automations and resolves its identity at execution time.
use super::stand_in_tasks::required;
use super::*;
use crate::runtime_work::automations::{Automation, ConversationMode};
use crate::task_runtime::mcp::StandInMcpIdentity;
use crate::task_runtime::personal_stand_in::stand_in_identities;

fn schedule_asks_before_act(automation: &Automation, role: &Value) -> bool {
    use crate::runtime_work::automations::{MEMORY_REVIEW_TEMPLATE, WEEKLY_REVIEW_TEMPLATE};
    matches!(
        automation.task_request["standInCalendar"]["template"].as_str(),
        Some(MEMORY_REVIEW_TEMPLATE | WEEKLY_REVIEW_TEMPLATE)
    ) || role["calendar"]["policy"]["askBeforeAct"] == true
}

impl RuntimeWorkRpcHandler {
    pub(super) fn validate_stand_in_schedule_start(
        &self,
        request: &ExecutionRequest,
        task_id: &str,
    ) -> Result<(), String> {
        if let Some(info) = request.extra.get("automation_info") {
            if let (Some(id), Some(run_id)) =
                (info["automationId"].as_str(), info["runId"].as_str())
            {
                if let Some(automation) = self.automation_store.get(id) {
                    if let Some(run) = self
                        .automation_store
                        .list_runs(Some(id))
                        .into_iter()
                        .find(|run| run.id == run_id)
                    {
                        if !self.automation_store.allow_dispatch(
                            &automation,
                            &run,
                            chrono::Utc::now(),
                        )? {
                            self.emit_automation_runs_changed(id, run_id);
                            return Err(
                                "Scheduled execution is not allowed by the China workday calendar"
                                    .into(),
                            );
                        }
                    }
                }
            }
        }
        let Some(schedule) = request.extra.get("standInSchedule") else {
            return Ok(());
        };
        if let Some(at) = schedule.get("scheduledFor") {
            if !at
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .is_some_and(|at| at <= chrono::Utc::now())
            {
                return Err("The arrangement deadline has not arrived".into());
            }
        }
        let id = schedule["id"]
            .as_str()
            .ok_or("Missing arrangement identity")?;
        let current = self
            .automation_store
            .get(id)
            .ok_or("The arrangement was cancelled before starting")?;
        if schedule["manual"] != true
            && !wegent_automation::scheduled_dispatch_allowed(
                &current.schedule,
                chrono::Utc::now(),
            )?
        {
            return Err("Scheduled execution skipped on a China non-workday".into());
        }
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
        let memory_review = role_id == "@primary"
            && current.task_request["standInCalendar"]["template"]
                == crate::runtime_work::automations::MEMORY_REVIEW_TEMPLATE;
        let identities = stand_in_identities(&settings);
        let role = if role_id == "@primary"
            && (settings["primary"]["enabled"] != false || memory_review)
        {
            Some(&settings["primary"])
        } else {
            identities
                .iter()
                .find(|role| role["id"] == role_id && role["enabled"] == true)
        };
        let role = role.ok_or("The scheduled work identity is paused or no longer exists")?;
        if schedule["askBeforeAct"]
            .as_bool()
            .is_some_and(|ask| ask != schedule_asks_before_act(&current, role))
        {
            return Err("The scheduled approval policy changed before starting".into());
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
            let _ = self.automation_store.settle_coordinated_run(
                run,
                AutomationRunStatus::NeedsAttention,
                None,
                Some(error.clone()),
            );
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
                && automation.task_request["standInCalendar"].is_object()
        };
        if name == "list_schedules" {
            return Ok(
                json!({"items": self.automation_store.list().into_iter().filter(owned).map(|a| json!({"id":a.id,"version":a.version,"name":a.name,"message":a.prompt,"schedule":a.schedule,"timezone":a.timezone,"enabled":a.enabled,"nextRunAt":a.next_run_at,"lastRunAt":a.last_run_at})).collect::<Vec<_>>()}),
            );
        }
        if name == "update_schedule" {
            return self.update_stand_in_schedule(identity, args).await;
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

    async fn update_stand_in_schedule(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let id = required(args, "scheduleId")?;
        let automation = self
            .automation_store
            .get(id)
            .filter(|automation| {
                automation.task_request["standInOwner"]["userId"] == identity.user
                    && automation.task_request["standInCalendar"].is_object()
            })
            .ok_or_else(|| {
                AppIpcError::new(
                    "permission_denied",
                    "Arrangement does not belong to this user",
                )
            })?;
        let version = args["version"].as_u64().ok_or_else(|| {
            AppIpcError::new("bad_request", "The version from list_schedules is required")
        })?;
        let mut value = serde_json::to_value(automation)
            .map_err(|_| AppIpcError::new("invalid_configuration", "Invalid arrangement"))?;
        value["version"] = json!(version);
        let fields = [
            "title",
            "message",
            "at",
            "cron",
            "workdayOnly",
            "timezone",
            "enabled",
        ];
        if !fields.iter().any(|field| args.get(*field).is_some()) {
            return Err(AppIpcError::new(
                "bad_request",
                "At least one arrangement field is required",
            ));
        }
        for (input, field, request_field) in
            [("title", "name", "title"), ("message", "prompt", "message")]
        {
            if args.get(input).is_some() {
                let text = required(args, input)?;
                value[field] = json!(text);
                value["taskRequest"][request_field] = json!(text);
            }
        }
        if args.get("at").is_some() || args.get("cron").is_some() {
            let mut trigger = args.clone();
            if trigger.get("workdayOnly").is_none() && trigger.get("at").is_none() {
                trigger["workdayOnly"] = value["schedule"]
                    .get("workdayOnly")
                    .cloned()
                    .unwrap_or(json!(false));
            }
            value["schedule"] = schedule_from_args(&trigger)?;
        } else if let Some(filter) = args.get("workdayOnly") {
            if !filter.is_boolean() || value["schedule"]["type"] != "cron" {
                return Err(AppIpcError::new(
                    "bad_request",
                    "workdayOnly requires a recurring cron schedule and a boolean",
                ));
            }
            value["schedule"]["workdayOnly"] = filter.clone();
        }
        if args.get("timezone").is_some() {
            value["timezone"] = json!(required(args, "timezone")?);
        }
        if let Some(enabled) = args.get("enabled") {
            if !enabled.is_boolean() {
                return Err(AppIpcError::new("bad_request", "enabled must be a boolean"));
            }
            value["enabled"] = enabled.clone();
        }
        self.update_automation(value).await
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
        let schedule = schedule_from_args(args)?;
        if args.get("taskId").is_some() {
            return Err(AppIpcError::new("bad_request", "Calendar events inherit connection settings and cannot select an execution conversation"));
        }
        let calendar = match args["template"].as_str() {
            None => json!({}),
            Some("weekly_review") => json!({"template":"weekly_review"}),
            Some(_) => return Err(AppIpcError::new("bad_request", "Unknown calendar template")),
        };
        let request = json!({"schemaVersion":2,"runtime":"codex","deviceId":self.device_id,"message":required(args,"message")?,"title":required(args,"title")?,"standInOwner":{"userId":identity.user,"roleId":"@primary"},"standInCalendar":calendar});
        self.create_automation(json!({"automation":{"id":id,"version":0,"name":required(args,"title")?,"prompt":required(args,"message")?,"schedule":schedule,"timezone":args["timezone"].as_str().unwrap_or("UTC"),"enabled":true,"conversationMode":"independent","notificationPolicy":"attention_only","taskRequest":request,"taskPayload":{"runtime":"codex"},"continuationPayload":null}})).await
    }

    /// Revalidate the scheduled identity and prepare work from its current device-owned settings.
    pub(super) async fn prepare_stand_in_schedule(
        &self,
        automation: &Automation,
        payload: Value,
    ) -> Result<(Value, bool), AppIpcError> {
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
        let memory_review = role_id == "@primary"
            && automation.task_request["standInCalendar"]["template"]
                == crate::runtime_work::automations::MEMORY_REVIEW_TEMPLATE;
        let mut config = identities
            .into_iter()
            .find(|role| role["id"] == role_id && (role["enabled"] == true || memory_review))
            .ok_or_else(|| {
                AppIpcError::new(
                    "permission_denied",
                    "The scheduled work identity is paused or no longer exists",
                )
            })?;
        let review = role_id == "@primary"
            && automation.task_request["standInCalendar"]["template"]
                == crate::runtime_work::automations::WEEKLY_REVIEW_TEMPLATE;
        let ask_before_act = schedule_asks_before_act(automation, &config);
        if matches!(
            automation.conversation_mode,
            ConversationMode::ContinueThread
        ) {
            let prepared = self
                .prepare_scheduled_continuation(payload, user, role_id)
                .await?;
            return Ok((prepared, ask_before_act));
        }
        config["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":ask_before_act});
        let mut payload = payload;
        payload["title"] = json!(automation.name);
        payload["origin"] = json!({"type":"stand_in_schedule","initiatedBy":"stand_in","userId":user,"standInId":role_id,"automationId":automation.id,"deviceId":self.device_id,"askBeforeAct":ask_before_act});
        if review {
            payload["origin"]["weeklyReview"] = json!(true);
        }
        if memory_review {
            payload["origin"]["memoryReview"] = json!(true);
        }
        let mut prepared = if memory_review {
            self.prepare_background_stand_in_execution(payload, &config)
                .await?
        } else {
            self.prepare_stand_in_execution(payload, &config).await?
        };
        if prepared["runtime"].as_str().is_some_and(is_claude_runtime) {
            return Err(AppIpcError::new(
                "confirmation_runtime_unsupported",
                "Choose Codex for scheduled operation review controls",
            ));
        }
        if review || memory_review {
            let invalid = || AppIpcError::new("bad_request", "Invalid review execution context");
            let request = prepared["executionRequest"]
                .as_object_mut()
                .ok_or_else(invalid)?;
            let additional = request
                .entry("additionalContext")
                .or_insert_with(|| json!({}));
            additional.as_object_mut().ok_or_else(invalid)?.insert(
                "wework.stand-in-review".into(),
                json!({"kind":"application","value":if memory_review {crate::runtime_work::automations::MEMORY_REVIEW_INSTRUCTIONS} else {crate::runtime_work::automations::WEEKLY_REVIEW_INSTRUCTIONS}}),
            );
        }
        let system = prepared["executionRequest"]["system_prompt"]
            .as_str()
            .unwrap_or_default();
        prepared["executionRequest"]["system_prompt"] = json!(format!(
            "{system}\n\n{}",
            config["preferences"].as_str().unwrap_or_default()
        ));
        Ok((prepared, ask_before_act))
    }

    /// Continue only owned, available Codex work without answering pending native interactions.
    async fn prepare_scheduled_continuation(
        &self,
        mut payload: Value,
        user: i64,
        role_id: &str,
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
        let mut request = link.runtime_handle["executionRequest"].clone();
        request["prompt"] = payload["message"].clone();
        payload["executionRequest"] = request;
        payload["queueIfBusy"] = json!(false);
        Ok(payload)
    }
}

fn schedule_from_args(args: &Value) -> Result<Value, AppIpcError> {
    for key in ["at", "cron"] {
        if args.get(key).is_some() {
            required(args, key)?;
        }
    }
    Ok(if let Some(at) = args["at"].as_str() {
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
        let workday_only = args
            .get("workdayOnly")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| AppIpcError::new("bad_request", "workdayOnly must be a boolean"))
            })
            .transpose()?
            .unwrap_or(false);
        json!({"type":"cron","expression":required(args,"cron")?,"workdayOnly":workday_only})
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> StandInMcpIdentity {
        StandInMcpIdentity {
            task_id: "primary-chat".into(),
            user: 7,
            device: "mac".into(),
            role: Some("@primary".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: false,
        }
    }

    async fn daily(handler: &RuntimeWorkRpcHandler) -> Value {
        handler
            .create_stand_in_schedule(
                &owner(),
                &json!({
                    "requestId":"daily", "title":"Daily report", "message":"Summarize progress",
                    "cron":"0 18 * * *", "timezone":"Asia/Shanghai", "workdayOnly":true
                }),
            )
            .await
            .unwrap()["automation"]
            .clone()
    }

    #[tokio::test]
    async fn update_schedule_preserves_identity_history_and_omitted_fields() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        let before = daily(&handler).await;
        let id = before["id"].as_str().unwrap();
        handler.automation_store.start_manual_run(id).unwrap();
        let history = handler.automation_store.list_runs(Some(id));
        let listed = handler
            .stand_in_schedule_operation(&owner(), "list_schedules", &json!({}))
            .await
            .unwrap();
        assert_eq!(listed["items"][0]["version"], before["version"]);
        assert_eq!(listed["items"][0]["message"], before["prompt"]);
        let after = handler.stand_in_schedule_operation(&owner(), "update_schedule", &json!({
            "scheduleId":id, "version":before["version"],
            "message":"Summarize progress; include owner, collaborator, waiting time and next step"
        })).await.unwrap()["automation"].clone();
        for key in [
            "id",
            "createdAt",
            "name",
            "schedule",
            "timezone",
            "enabled",
            "conversationMode",
            "taskPayload",
            "notificationPolicy",
        ] {
            assert_eq!(after[key], before[key], "{key}");
        }
        assert_eq!(after["version"], before["version"].as_u64().unwrap() + 1);
        assert_eq!(after["taskRequest"]["message"], after["prompt"]);
        assert_eq!(
            after["taskRequest"]["standInOwner"],
            before["taskRequest"]["standInOwner"]
        );
        assert_eq!(
            after["taskRequest"]["standInCalendar"],
            before["taskRequest"]["standInCalendar"]
        );
        assert_eq!(handler.automation_store.list().len(), 1);
        assert_eq!(
            serde_json::to_value(handler.automation_store.list_runs(Some(id))).unwrap(),
            serde_json::to_value(history).unwrap()
        );
        let reopened = crate::runtime_work::automations::AutomationStore::new(
            root.path().join("automations.json"),
        );
        assert_eq!(
            serde_json::to_value(reopened.get(id).unwrap()).unwrap(),
            after
        );
        let error = handler
            .stand_in_schedule_operation(
                &owner(),
                "update_schedule",
                &json!({
                    "scheduleId":id,"version":before["version"],"message":"Stale overwrite"
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "conflict");
        assert_eq!(
            serde_json::to_value(handler.automation_store.get(id).unwrap()).unwrap(),
            after
        );
    }

    #[tokio::test]
    async fn update_schedule_changes_trigger_without_resuming_a_paused_arrangement() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        let before = daily(&handler).await;
        let id = before["id"].as_str().unwrap();
        let paused = handler.automation_store.toggle(id, false).unwrap();
        let after = handler.stand_in_schedule_operation(&owner(), "update_schedule", &json!({
            "scheduleId":id,"version":paused.version,"cron":"0 19 * * *", "title":"Evening report"
        })).await.unwrap()["automation"].clone();
        assert_eq!(
            after["schedule"],
            json!({"type":"cron","expression":"0 19 * * *","workdayOnly":true})
        );
        assert_eq!(after["enabled"], false);
        assert_eq!(after["nextRunAt"], Value::Null);
        assert_eq!(after["taskRequest"]["title"], "Evening report");
        let once = handler.stand_in_schedule_operation(&owner(), "update_schedule", &json!({
            "scheduleId":id,"version":after["version"],"at":"2099-01-01T00:00:00Z", "enabled":true
        })).await.unwrap()["automation"].clone();
        assert_eq!(once["schedule"]["type"], "one_time");
        assert!(once["nextRunAt"].is_string());
        assert_eq!(handler.automation_store.list().len(), 1);
    }

    #[tokio::test]
    async fn invalid_or_unauthorized_updates_leave_the_arrangement_intact() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        let before = daily(&handler).await;
        let id = before["id"].as_str().unwrap();
        for patch in [
            json!({}),
            json!({"message":""}),
            json!({"cron":"invalid"}),
            json!({"timezone":"invalid"}),
            json!({"enabled":"true"}),
            json!({"workdayOnly":"true"}),
            json!({"at":"2000-01-01T00:00:00Z"}),
            json!({"at":null}),
            json!({"at":"2099-01-01T00:00:00Z","cron":"0 18 * * *"}),
            json!({"message":"changed","version":null}),
        ] {
            let mut args = json!({"scheduleId":id,"version":before["version"]});
            args.as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            let error = handler
                .stand_in_schedule_operation(&owner(), "update_schedule", &args)
                .await
                .unwrap_err();
            assert_eq!(error.code, "bad_request", "{args}");
            assert_eq!(
                serde_json::to_value(handler.automation_store.get(id).unwrap()).unwrap(),
                before
            );
        }
        let mut other = owner();
        other.user = 8;
        let error = handler
            .stand_in_schedule_operation(
                &other,
                "update_schedule",
                &json!({
                    "scheduleId":id,"version":before["version"],"message":"Hijack"
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "permission_denied");
        let mut ordinary = handler.automation_store.get(id).unwrap();
        ordinary.id = "ordinary".into();
        ordinary
            .task_request
            .as_object_mut()
            .unwrap()
            .remove("standInCalendar");
        handler.automation_store.create(ordinary).unwrap();
        let error = handler
            .stand_in_schedule_operation(
                &owner(),
                "update_schedule",
                &json!({
                    "scheduleId":"ordinary","version":1,"message":"Hijack"
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "permission_denied");
    }

    #[tokio::test]
    async fn chat_schedule_preserves_explicit_workday_filter_and_defaults_old_requests() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        let identity = StandInMcpIdentity {
            task_id: "primary-chat".into(),
            user: 7,
            device: "mac".into(),
            role: Some("@primary".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: false,
        };
        for filtered in [false, true] {
            let mut args = json!({"requestId":format!("filtered-{filtered}"),"title":"Review","message":"Review outstanding items","cron":"0 9 * * *","timezone":"Asia/Shanghai"});
            if filtered {
                args["workdayOnly"] = json!(true);
            }
            let saved = handler
                .create_stand_in_schedule(&identity, &args)
                .await
                .unwrap();
            assert_eq!(
                saved["automation"]["schedule"].get("workdayOnly"),
                filtered.then_some(&json!(true))
            );
        }
    }

    #[tokio::test]
    async fn memory_review_rejects_a_non_codex_primary_model_before_creating_work() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store.materialize_implicit_primary(7, "mac").unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"]["model"] =
            json!({"runtime":"claude_code","provider":"claude","model_id":"chosen"});
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let entry = crate::runtime_work::automations::memory_review(7, "mac").unwrap();

        let error = handler
            .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
            .await
            .unwrap_err();

        assert_eq!(error.code, "model_unavailable");
        assert!(handler.local_task_links(true).is_empty());
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), settings);
    }

    #[tokio::test]
    async fn chat_created_calendar_events_use_connection_routing_and_reject_execution_targets() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        let identity = StandInMcpIdentity {
            task_id: "primary-chat".into(),
            user: 7,
            device: "mac".into(),
            role: Some("@primary".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: false,
        };
        let args = json!({"requestId":"event","title":"Review","message":"Review outstanding items","at":"2099-01-01T00:00:00Z","timezone":"UTC"});
        let saved = handler
            .create_stand_in_schedule(&identity, &args)
            .await
            .unwrap();
        assert_eq!(
            saved["automation"]["taskRequest"]["standInCalendar"],
            json!({})
        );
        assert_eq!(saved["automation"]["conversationMode"], "independent");
        let entry: Automation = serde_json::from_value(saved["automation"].clone()).unwrap();
        let (prepared, _) = handler
            .prepare_stand_in_schedule(&entry, json!({"message":entry.prompt}))
            .await
            .unwrap();
        assert_eq!(prepared["title"], "Review");
        assert_eq!(prepared["message"], "Review outstanding items");
        assert_eq!(
            prepared["executionRequest"]["prompt"],
            "Review outstanding items"
        );
        assert!(handler.local_task_links(true).is_empty());
        let mut conflicting = args;
        conflicting["requestId"] = json!("conflicting");
        conflicting["taskId"] = json!("work");
        assert_eq!(
            handler
                .create_stand_in_schedule(&identity, &conflicting)
                .await
                .unwrap_err()
                .code,
            "bad_request"
        );
        assert_eq!(handler.automation_store.list().len(), 1);
        let mut ordinary = handler.automation_store.list().pop().unwrap();
        ordinary.id = "ordinary-schedule".into();
        ordinary
            .task_request
            .as_object_mut()
            .unwrap()
            .remove("standInCalendar");
        handler.automation_store.create(ordinary).unwrap();
        let listed = handler
            .stand_in_schedule_operation(&identity, "list_schedules", &json!({}))
            .await
            .unwrap();
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            handler
                .stand_in_schedule_operation(
                    &identity,
                    "cancel_schedule",
                    &json!({"scheduleId":"ordinary-schedule"})
                )
                .await
                .unwrap_err()
                .code,
            "permission_denied"
        );
        assert_eq!(handler.automation_store.list().len(), 2);
    }

    #[test]
    fn a_queued_arrangement_cannot_start_before_its_deadline() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        for at in [json!("2099-01-01T00:00:00Z"), json!("invalid"), Value::Null] {
            let mut request = ExecutionRequest::default();
            request
                .extra
                .insert("standInSchedule".into(), json!({"scheduledFor":at}));
            assert_eq!(
                handler
                    .validate_stand_in_schedule_start(&request, "work")
                    .unwrap_err(),
                "The arrangement deadline has not arrived"
            );
        }
        assert!(handler.store.list_task_summaries(true).is_empty());
    }

    fn fixture(root: &Path) -> RuntimeWorkRpcHandler {
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
        handler.automation_store =
            crate::runtime_work::automations::AutomationStore::new(root.join("automations.json"));
        handler
    }

    #[tokio::test]
    async fn calendar_triggers_use_the_current_saved_policy_in_both_conversation_modes() {
        let root = tempfile::tempdir().unwrap();
        let handler = fixture(root.path());
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] = json!({"enabled":true,"prompt":"","preferences":""});
        let entry: Automation = serde_json::from_value(json!({
            "id":"calendar","version":0,"name":"Calendar","prompt":"Read updates",
            "taskPayload":{"runtime":"codex"},
            "schedule":{"type":"cron","expression":"0 9 * * *"},
            "taskRequest":{"standInOwner":{"userId":7,"roleId":"@primary"},"standInCalendar":{}}
        }))
        .unwrap();
        let mut legacy = entry.clone();
        legacy.id = "legacy-continuation".into();
        legacy
            .task_request
            .as_object_mut()
            .unwrap()
            .remove("standInCalendar");
        legacy.conversation_mode = ConversationMode::ContinueThread;
        legacy.continuation_payload = Some(json!({"taskId":"work"}));
        let entries = [
            handler.automation_store.create(entry).unwrap(),
            handler.automation_store.create(legacy).unwrap(),
        ];
        let mut link = RuntimeTaskLink::new_pending("work".into(), "".into(), "Work".into());
        link.status = "completed".into();
        link.runtime_handle = json!({"executionRequest":{"user_id":7}});
        handler.store.upsert_task(link);

        for saved_policy in [None, Some(false), Some(true)] {
            if let Some(ask) = saved_policy {
                settings["primary"]["calendar"] =
                    json!({"policy":{"automatic":true,"askBeforeAct":ask}});
            }
            settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
            for entry in &entries {
                let (payload, ask_before_act) = handler
                    .prepare_stand_in_schedule(
                        entry,
                        json!({"taskId":"work","message":entry.prompt}),
                    )
                    .await
                    .unwrap();
                let expected = saved_policy.unwrap_or(false);
                assert_eq!(ask_before_act, expected);
                if matches!(entry.conversation_mode, ConversationMode::Independent) {
                    assert_eq!(payload["origin"]["askBeforeAct"], expected);
                }
            }
        }
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
