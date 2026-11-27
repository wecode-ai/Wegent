//! Device-owned pipeline state. Each member runs as a separate native command.
use super::*;
use sha2::{Digest, Sha256};
use wegent_protocol::pipeline::handoff_text;

const STATE: &str = "personalPipeline";

pub(super) fn strip_personal_bot_mcp(bots: &mut Value) {
    for bot in bots.as_array_mut().into_iter().flatten() {
        if bot["native_capability_scope"] == "bot" {
            if let Some(fields) = bot.as_object_mut() {
                fields.remove("mcp_servers");
            }
        }
    }
}

fn stage_request(request: &mut ExecutionRequest, state: &Value) -> Result<String, AppIpcError> {
    let invalid = || AppIpcError::new("invalid_team_stage", "Personal Team stage is unavailable");
    let stage = state["stage"].as_u64().ok_or_else(invalid)? as usize;
    let bot = state["members"].get(stage).ok_or_else(invalid)?;
    let shell_changed = request
        .bot
        .get(0)
        .is_some_and(|previous| previous["shell_type"] != bot["shell_type"]);
    let provider_changed = bot
        .get("model_provider")
        .is_some_and(|provider| request.model_config.get("model_provider") != Some(provider));
    if shell_changed || provider_changed {
        // Resolve the new native provider through its own account on this device.
        request.model_config = json!({});
        for key in [
            "submittedModelBinding",
            "modelSelection",
            "model_selection",
            "runnerModelProvider",
        ] {
            request.extra.remove(key);
        }
    }
    if let Some(provider) = bot["model_provider"].as_str() {
        request.model_config["model_provider"] = json!(provider);
    }
    request.bot = json!([bot]);
    request.system_prompt = super::stand_in_agent::bot_instructions(
        state["instructions"].as_str().unwrap_or_default(),
        bot,
    );
    if let Some(model) = bot["model_id"].as_str() {
        request.model_config["model_id"] = json!(model);
    }
    request
        .extra
        .insert("personalPipelineTurn".into(), json!([state["root"], stage]));
    match bot["shell_type"].as_str() {
        Some("Codex") => Ok("codex".into()),
        Some("ClaudeCode") => Ok("claude_code".into()),
        _ => Err(invalid()),
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn restore_personal_bot_grants(
        &self,
        task: &str,
        request: &mut ExecutionRequest,
    ) -> Result<(), AppIpcError> {
        if request.bot[0]["native_capability_scope"] != "bot"
            || !request
                .extra
                .get("team_ref")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("stand-in-team-"))
        {
            return Ok(());
        }
        let denied =
            || AppIpcError::new("permission_denied", "Personal Team binding is unavailable");
        let link = self.local_task_link(task).ok_or_else(denied)?;
        let origin = &link.runtime_handle["origin"];
        let user = super::stand_in_lifecycle::stand_in_owner(origin).ok_or_else(denied)?;
        if request.extra.get("user_id").and_then(Value::as_i64) != Some(user) {
            return Err(denied());
        }
        self.verify_local_stand_in_owner(user)?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let role = origin["standInId"].as_str().unwrap_or("@primary");
        let current = store
            .owned_personal_role_team(user, &self.device_id, role)
            .map_err(super::stand_in::settings_error)?;
        if request.extra.get("team_ref") != current.get("id") {
            return Err(denied());
        }
        let current_bots = current["bot"].as_array().ok_or_else(denied)?;
        let stage = if let Some(marker) = request.extra.get("personalPipelineTurn") {
            let saved = &link.runtime_handle[STATE];
            if *marker != json!([saved["root"], saved["stage"]]) {
                return Err(denied());
            }
            Some(marker[1].as_u64().ok_or_else(denied)? as usize)
        } else {
            None
        };
        let bots = request.bot.as_array_mut().ok_or_else(denied)?;
        if bots.len() != stage.map_or(current_bots.len(), |_| 1) {
            return Err(denied());
        }
        for (index, target) in bots.iter_mut().enumerate() {
            let bot = current_bots
                .get(stage.unwrap_or(index))
                .filter(|bot| bot["id"] == target["id"])
                .ok_or_else(denied)?;
            for key in ["skills", "skill_refs", "mcp_servers"] {
                target.as_object_mut().expect("validated Bot").remove(key);
                if let Some(value) = bot.get(key) {
                    target[key] = value.clone();
                }
            }
        }
        Ok(())
    }

    pub(super) fn begin_personal_pipeline(
        &self,
        turn: &mut SpawnTurnRequest,
    ) -> Result<(), AppIpcError> {
        let request = &mut turn.request;
        if request
            .extra
            .get("collaboration_model")
            .and_then(Value::as_str)
            != Some("pipeline")
            || !request.extra.get("team_ref").is_some_and(Value::is_string)
            || turn.task_kind == Some(RuntimeTaskKind::Agent)
        {
            return Ok(());
        }
        let (prior, terminated, awaiting_reply) = self
            .store
            .read_task(&turn.local_task_id, |link| {
                (
                    link.runtime_handle[STATE].clone(),
                    matches!(link.status.as_str(), "failed" | "cancelled" | "archived"),
                    link.interaction_status.is_some(),
                )
            })
            .unwrap_or_default();
        if let Some(marker) = request.extra.get("personalPipelineTurn") {
            if terminated
                || marker != &json!([prior["root"], prior["stage"]])
                || !matches!(prior["phase"].as_str(), Some("dispatching" | "active"))
            {
                return Err(AppIpcError::new(
                    "stale_stage",
                    "Personal Team stage has changed",
                ));
            }
            turn.runtime = stage_request(request, &prior)?;
            return Ok(());
        }
        if prior["phase"] == "active" && awaiting_reply {
            turn.runtime = stage_request(request, &prior)?;
            return Ok(());
        }
        if !terminated
            && matches!(
                prior["phase"].as_str(),
                Some("active" | "ready" | "dispatching" | "confirmation")
            )
        {
            return Err(AppIpcError::new(
                "pipeline_active",
                "The personal Team already has a running pipeline",
            ));
        }
        request.new_session = true;
        turn.resume_thread_id = None;
        turn.direct_thread_id = None;
        let mut members = request.bot.clone();
        if request.extra["team_ref"]
            .as_str()
            .is_some_and(|id| id.starts_with("stand-in-team-"))
        {
            strip_personal_bot_mcp(&mut members);
        }
        redact_execution_profile_secrets(&mut members);
        let state = json!({"root":request.subtask_id,"stage":0,"phase":"active","members":members,"original":request.prompt,"instructions":request.system_prompt});
        let mut state = state;
        state["useSavedPermissions"] =
            json!(request.extra.get("useSavedStandInTaskPermissions") == Some(&Value::Bool(true)));
        turn.runtime = stage_request(request, &state)?;
        self.store
            .try_update_task(&turn.local_task_id, |link| {
                link.runtime_handle[STATE] = state
            })
            .map_err(|e| AppIpcError::new("pipeline_save_failed", e.to_string()))?
            .ok_or_else(|| AppIpcError::new("not_found", "Personal Task is unavailable"))?;
        Ok(())
    }

    pub(super) fn settle_personal_pipeline(
        &self,
        task: &str,
        request: &ExecutionRequest,
        outcome: &ExecutionOutcome,
    ) -> bool {
        let Some(marker) = request.extra.get("personalPipelineTurn") else {
            return false;
        };
        let mut phase = None;
        let mut stale = false;
        let updated = self.store.try_update_task(task, |link| {
            let state = &mut link.runtime_handle[STATE];
            if marker != &json!([state["root"], state["stage"]])
                || !matches!(state["phase"].as_str(), Some("active" | "dispatching"))
            {
                stale = true;
                return;
            }
            let stage = state["stage"].as_u64().unwrap_or_default() as usize;
            match outcome {
                ExecutionOutcome::Completed { content }
                    if state["members"].get(stage + 1).is_some() =>
                {
                    let member = &state["members"][stage];
                    let confirmation = member
                        .get("requireConfirmation")
                        .or_else(|| member.get("require_confirmation"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let mode = member
                        .get("contextPassing")
                        .or_else(|| member.get("context_passing"))
                        .and_then(Value::as_str)
                        .unwrap_or("none");
                    let prompt = handoff_text(
                        mode,
                        state["original"].as_str().unwrap_or_default(),
                        content,
                    );
                    state["handoff"] = json!(prompt);
                    let next = if confirmation {
                        "confirmation"
                    } else {
                        "ready"
                    };
                    phase = Some(next);
                    state["phase"] = json!(next);
                    link.status = "running".into();
                    link.completed_at = None;
                    if confirmation {
                        link.interaction_status = Some(INTERACTION_AWAITING_USER_REPLY.into());
                    }
                }
                ExecutionOutcome::Running | ExecutionOutcome::WaitingForUserInput { .. } => {}
                _ => state["phase"] = json!("finished"),
            }
        });
        if let Err(ref error) = updated {
            self.retain_failed_runtime_task(
                task,
                &AppIpcError::new("pipeline_save_failed", error.to_string()),
            );
            return true;
        }
        if let Ok(Some(link)) = updated {
            if phase.is_some() {
                self.publish_native_execution(task, request, link);
            }
        }
        if phase == Some("ready") {
            let handler = self.clone();
            let task = task.to_owned();
            tokio::spawn(async move {
                if let Err(error) = handler.advance_personal_pipeline(&task, None).await {
                    if error.code != "stale_stage" {
                        handler.retain_failed_runtime_task(&task, &error);
                    }
                }
            });
        }
        stale || phase.is_some()
    }

    pub(super) async fn resume_personal_handoffs(&self) {
        for link in self.store.list_filtered_task_summaries(false, |link| {
            matches!(
                link.runtime_handle[STATE]["phase"].as_str(),
                Some("ready" | "dispatching")
            ) && !matches!(link.status.as_str(), "archived" | "cancelled" | "failed")
        }) {
            if self.is_busy_local_task(&link.local_task_id) {
                continue;
            }
            if let Err(error) = self
                .advance_personal_pipeline(&link.local_task_id, None)
                .await
            {
                if error.code != "stale_stage" {
                    self.retain_failed_runtime_task(&link.local_task_id, &error);
                }
            }
        }
    }

    pub(super) async fn advance_personal_pipeline(
        &self,
        task: &str,
        confirmation: Option<&Value>,
    ) -> Result<Value, AppIpcError> {
        let gate = self.task_send_gate(&format!("pipeline:{task}"));
        let _guard = gate.lock().await;
        let link = self
            .local_task_link(task)
            .ok_or_else(|| AppIpcError::new("not_found", "Personal Task is unavailable"))?;
        let mut state = link.runtime_handle[STATE].clone();
        let confirm = confirmation.is_some();
        if confirmation.is_some_and(|id| id != &json!([state["root"], state["stage"]])) {
            return Err(AppIpcError::new(
                "stale_stage",
                "Personal Team stage has changed",
            ));
        }
        let expected = if confirm { "confirmation" } else { "ready" };
        let replay = !confirm && state["phase"] == "dispatching";
        if (!replay && state["phase"] != expected)
            || matches!(link.status.as_str(), "archived" | "cancelled" | "failed")
        {
            return Err(AppIpcError::new(
                "stale_stage",
                "Personal Team stage has changed",
            ));
        }
        let user = link.runtime_handle["origin"]["userId"]
            .as_i64()
            .or_else(|| link.runtime_handle["executionRequest"]["user_id"].as_i64())
            .ok_or_else(|| {
                AppIpcError::new("permission_denied", "Personal Task owner is unavailable")
            })?;
        self.verify_local_stand_in_owner(user)?;
        let mut request = runtime_event_request_from_link(&link);
        let reference = request
            .extra
            .get("team_ref")
            .and_then(Value::as_str)
            .ok_or_else(|| AppIpcError::new("not_found", "Personal Team binding is unavailable"))?;
        let current = LocalTaskStore::open(self.task_store_path.as_ref())
            .and_then(|store| store.personal_execution_team(user, reference))
            .map_err(super::stand_in::settings_error)?;
        if let Some(role_id) = current["accountRoleId"].as_str() {
            let account = self
                .runtime_http(reqwest::Method::GET, "/v1/personal-assistant", None)
                .await?;
            if !account["assistant"]["definitions"]
                .as_array()
                .is_some_and(|defs| {
                    defs.iter().any(|d| {
                        d["roleId"] == role_id
                            && d["team"]["metadata"]["name"] == current["accountTeam"]["name"]
                            && d["team"]["metadata"]["namespace"]
                                == current["accountTeam"]["namespace"]
                    })
                })
            {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Account Team binding is no longer available",
                ));
            }
        }
        if let Some(model) = self.runtime_model_config(task) {
            request.model_config = model;
        }
        let stage = state["stage"].as_u64().unwrap_or_default() + u64::from(!replay);
        state["stage"] = json!(stage);
        state["phase"] = json!("dispatching");
        let runtime = stage_request(&mut request, &state)?;
        request.new_session = true;
        request.history.clear();
        request.prompt = state["handoff"].clone();
        let command_input = json!([state["root"], stage, request.bot[0]["id"], request.prompt]);
        request.subtask_id = format!(
            "pipeline:{:x}",
            Sha256::digest(command_input.to_string().as_bytes())
        );
        request
            .extra
            .insert("runtime_command_id".into(), json!(request.subtask_id));
        request
            .extra
            .insert("runtime_command_input".into(), command_input);
        let previous = link.runtime_handle[STATE].clone();
        let saved_permissions = state["useSavedPermissions"] == true;
        let mut claimed = false;
        self.store
            .try_update_task(task, |link| {
                if link.runtime_handle[STATE] != previous
                    || matches!(link.status.as_str(), "cancelled" | "archived" | "failed")
                {
                    return;
                }
                claimed = true;
                link.runtime_handle[STATE] = state;
                link.interaction_status = None;
            })
            .map_err(|e| AppIpcError::new("pipeline_save_failed", e.to_string()))?;
        if !claimed {
            return Err(AppIpcError::new(
                "stale_stage",
                "Personal Team stage has changed",
            ));
        }
        if let Err(error) = self
            .submit_continuation(
                SpawnTurnRequest::new(task.into(), runtime, request),
                saved_permissions,
            )
            .await
        {
            self.store
                .update_task(task, |link| link.runtime_handle[STATE] = previous);
            return Err(error);
        }
        Ok(json!({"accepted":true,"taskId":task,"stage":stage,"status":"running"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run_two_stages(confirm: bool) {
        let (handler, root) =
            super::super::tests::isolated_runtime_work_handler("personal-pipeline");
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "device-1").unwrap();
        settings["roles"] = json!([{"id":"copied","name":"Reviewer","enabled":true,"prompt":"","executionDeviceId":"device-1",
            "version":0,"tags":[],"migrationSource":"[\"previous-device\",7,\"original\"]",
            "collaboration":{"enabled":false,"allProjects":true,"projects":[],"excludedProjects":[],"tags":[]}}]);
        settings["transferredTeamDefinition"] = json!({"roleId":"copied","definition":{
        "name":"Reviewer","collaboration_model":"pipeline","bot":[
            {"id":"a","shell_type":"Codex","contextPassing":"previous_bot","requireConfirmation":confirm},
            {"id":"b","shell_type":"ClaudeCode","system_prompt":"review"}
        ]}});
        let saved = store
            .save_personal_stand_in(7, "device-1", settings)
            .unwrap();
        let reference = saved["roles"][0]["teamRef"].as_str().unwrap();
        let grants = json!({"roleId":"copied","botGrants":[
            {"id":"a","mcp_servers":{"probe":{"headers":{"X-Test-Token":"first"}}}},
            {"id":"b","mcp_servers":{"probe":{"headers":{"X-Test-Token":"second"}}}}
        ]});
        store
            .save_verified_personal_settings(
                7,
                "device-1",
                None,
                saved.clone(),
                crate::task_runtime::personal_stand_in::VerifiedPersonalSettings {
                    workspace_owner: true,
                    owned_team: Some(&grants),
                    ..Default::default()
                },
            )
            .unwrap();
        let team = store.personal_execution_team(7, reference).unwrap();
        let origin = json!({"type":"stand_in_identity","deviceId":"device-1","userId":7,"standInId":"copied"});
        let request:ExecutionRequest = serde_json::from_value(json!({
            "task_id":"personal","subtask_id":"root","user_id":7,"origin":origin,
            "team_ref":reference,"collaboration_model":team["collaboration_model"],"prompt":"original",
            "bot":team["bot"]
        })).unwrap();
        let mut link = RuntimeTaskLink::new_pending(
            "personal".into(),
            root.to_string_lossy().into_owned(),
            "Review".into(),
        );
        link.runtime_handle["origin"] = origin;
        store_runtime_execution_request(&mut link.runtime_handle, &request);
        handler.store.upsert_task(link);
        handler
            .turn_scheduler
            .lock()
            .unwrap()
            .settings
            .max_concurrent_stand_in_tasks = 0;
        let mut first = SpawnTurnRequest::new("personal".into(), "codex".into(), request);
        first.bind_task_kind(&handler.store);
        handler.begin_personal_pipeline(&mut first).unwrap();
        assert_eq!(first.request.bot.as_array().unwrap().len(), 1);
        handler
            .restore_personal_bot_grants("personal", &mut first.request)
            .unwrap();
        assert_eq!(
            first.request.bot[0]["mcp_servers"]["probe"]["headers"]["X-Test-Token"],
            "first"
        );
        assert!(!handler
            .local_task_link("personal")
            .unwrap()
            .runtime_handle
            .to_string()
            .contains("X-Test-Token"));
        assert!(handler.settle_personal_pipeline(
            "personal",
            &first.request,
            &ExecutionOutcome::Completed {
                content: "finding".into()
            }
        ));
        let intermediate = handler.local_task_link("personal").unwrap();
        assert_eq!(intermediate.status, "running");
        assert!(intermediate.completed_at.is_none());
        if confirm {
            assert_eq!(intermediate.runtime_handle[STATE]["phase"], "confirmation");
            assert!(handler
                .turn_scheduler
                .lock()
                .unwrap()
                .queued_turns
                .is_empty());
            assert!(handler
                .advance_personal_pipeline("personal", Some(&json!(["old", 0])))
                .await
                .is_err());
            handler.send_message_from_owner(json!({"taskId":"personal","action":"pipeline:confirm","expectedStage":["root",0]}),true).await.unwrap();
        }
        let mut next = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Some(turn) = handler
                    .turn_scheduler
                    .lock()
                    .unwrap()
                    .queued_turns
                    .front()
                    .cloned()
                {
                    break turn;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("second Team stage should enter the durable native queue");
        let handoff = handler.task_send_gate("pipeline:personal");
        let _completed_handoff = handoff.lock().await;
        assert_eq!(next.runtime, "claude_code");
        assert!(next.request.new_session);
        assert_eq!(next.request.prompt, "Previous stage output:\nfinding");
        assert_eq!(next.request.bot[0]["id"], "b");
        handler
            .restore_personal_bot_grants("personal", &mut next.request)
            .unwrap();
        assert_eq!(
            next.request.bot[0]["mcp_servers"]["probe"]["headers"]["X-Test-Token"],
            "second"
        );
        assert_eq!(next.request.system_prompt, "review");
        assert!(!handler.settle_personal_pipeline(
            "personal",
            &next.request,
            &ExecutionOutcome::Completed {
                content: "approved".into()
            }
        ));
        assert_eq!(
            handler.local_task_link("personal").unwrap().runtime_handle[STATE]["phase"],
            "finished"
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn confirmed_team_waits_for_owner_before_second_bot() {
        run_two_stages(true).await;
    }

    #[tokio::test]
    async fn automatic_team_delivers_after_second_bot() {
        run_two_stages(false).await;
    }
}
