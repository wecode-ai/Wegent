//! Automatic input stays in the native durable queue until human participation ends.
use super::*;

pub(super) fn is_automatic_input(request: &ExecutionRequest) -> bool {
    request.extra.get("standInAutomatic") == Some(&Value::Bool(true))
        || request
            .extra
            .get("resource_event_keys")
            .and_then(Value::as_array)
            .is_some_and(|keys| !keys.is_empty())
}

impl RuntimeWorkRpcHandler {
    pub(super) fn automatic_input_admission(
        &self,
        task: &str,
        request: &ExecutionRequest,
    ) -> Option<crate::agents::CodexInputAdmission> {
        if !is_automatic_input(request) {
            return None;
        }
        let handler = self.clone();
        let task = task.to_owned();
        let source_input = request
            .extra
            .get("resource_event_keys")
            .and_then(Value::as_array)
            .is_some_and(|keys| !keys.is_empty());
        let operation = request
            .extra
            .get("client_user_message_id")
            .or_else(|| request.extra.get("clientUserMessageId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Some(Box::new(move || {
            let _guard = handler
                .stand_in_lifecycle_gate
                .lock()
                .expect("turn lifecycle gate poisoned");
            let link = handler
                .store
                .get_task_summary(&task)
                .ok_or("Automatic input conversation is unavailable")?;
            if source_input {
                handler
                    .validate_event_input_session(&task, operation.as_deref(), &link)
                    .map_err(|error| {
                        if error.code == "subscription_cancelled" {
                            CODEX_APP_SERVER_TURN_CANCELLED.to_owned()
                        } else {
                            error.message
                        }
                    })?;
            }
            if link
                .interaction_status
                .as_deref()
                .is_some_and(|status| !status.is_empty())
            {
                return Err(crate::agents::AUTOMATIC_INPUT_WAITING_FOR_HUMAN.into());
            }
            Ok(())
        }))
    }

    pub(super) async fn defer_automatic_input(
        &self,
        task: &str,
        request: &ExecutionRequest,
        execution: u64,
    ) -> Result<bool, AppIpcError> {
        let id = request
            .extra
            .get("runtime_command_id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppIpcError::new("command_missing", "Automatic input has no durable command")
            })?;
        let turn = {
            let commands = self
                .command_journal
                .lock()
                .expect("command journal poisoned");
            let command = commands
                .get(&super::command_journal::key(task, id))
                .ok_or_else(|| {
                    AppIpcError::new("command_missing", "Automatic input command is unavailable")
                })?;
            if command.native.is_some()
                || command.state != super::command_journal::CommandState::Dispatching
            {
                return Ok(false);
            }
            command.turn.clone()
        };
        self.park_automatic_turn(turn, Some(execution)).await
    }

    pub(super) async fn start_automatic_turn(
        &self,
        mut turn: SpawnTurnRequest,
        permit: Option<tokio::sync::OwnedSemaphorePermit>,
    ) {
        let user = turn.request.extra.get("user_id").and_then(Value::as_i64);
        let gate = self.task_send_gate(&format!("stand-in-processing:{}", user.unwrap_or(-1)));
        let _guard = gate.lock().await;
        if let Err(error) = self.validate_automatic_turn(&turn).await {
            self.retain_failed_runtime_task(&turn.local_task_id, &error);
            self.finish_prepared_command(&turn, super::command_journal::CommandState::Failed)
                .await;
            return;
        }
        if let Err(error) =
            self.refresh_stand_in_confirmation(&turn.local_task_id, &mut turn.request)
        {
            self.retain_failed_runtime_task(&turn.local_task_id, &error);
            self.finish_prepared_command(&turn, super::command_journal::CommandState::Failed)
                .await;
            return;
        }
        self.start_authorized_turn(turn, permit);
    }

    pub(super) async fn validate_automatic_turn(
        &self,
        turn: &SpawnTurnRequest,
    ) -> Result<(), AppIpcError> {
        let user = turn
            .request
            .extra
            .get("user_id")
            .and_then(Value::as_i64)
            .filter(|user| *user >= 0)
            .ok_or_else(|| {
                AppIpcError::new(
                    "permission_denied",
                    "Automatic work has no execution identity",
                )
            })?;
        if self.backend_connection_snapshot()?.is_some() {
            self.verify_runtime_user(&json!({"userId":user})).await?;
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        if turn.request.extra.get("standInAutomaticVersion")
            != Some(&json!(LocalTaskStore::coordination_configuration_version(
                &settings
            )))
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Automatic input configuration changed before execution",
            ));
        }
        let link = self.local_task_link(&turn.local_task_id);
        let source_authorized = match link.as_ref() {
            Some(link) => self.authorized_manual_source_turn(link, &turn.request)?,
            None => false,
        };
        if !source_authorized && settings["primary"]["enabled"] == false {
            return Err(AppIpcError::new(
                "permission_denied",
                "The primary stand-in was paused before execution",
            ));
        }
        let origin = turn.request.extra.get("origin").unwrap_or(&Value::Null);
        if origin["type"] == "stand_in_coordinator" {
            let state = store
                .stand_in_processing_state(user)
                .map_err(super::stand_in::settings_error)?;
            if origin["userId"] != user
                || origin["deviceId"] != self.device_id
                || state["batchId"].is_null()
                || state["batchId"] != origin["batchId"]
            {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "The coordination batch was revoked before execution",
                ));
            }
            return Ok(());
        }
        let link =
            link.ok_or_else(|| AppIpcError::new("not_found", "Automatic work no longer exists"))?;
        if link.runtime_handle["executionRequest"]["user_id"] != user
            && link.runtime_handle["origin"]["userId"] != user
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Automatic work belongs to another user",
            ));
        }
        if source_authorized {
            return Ok(());
        }
        self.validate_primary_task_followup(user, &link).await
    }

    pub(super) fn automatic_input_waits(&self, turn: &SpawnTurnRequest) -> bool {
        turn.is_automatic_input()
            && self
                .store
                .get_task_summary(&turn.local_task_id)
                .is_some_and(|link| {
                    link.interaction_status
                        .as_deref()
                        .is_some_and(|status| !status.is_empty())
                })
    }

    pub(super) async fn park_waiting_automatic_turn(&self, turn: SpawnTurnRequest) {
        let task = turn.local_task_id.clone();
        if let Err(error) = self.park_automatic_turn(turn, None).await {
            log_executor_event(
                "Automatic input queue persistence failed",
                &[("task_id", task), ("code", error.code)],
            );
        }
    }

    async fn park_automatic_turn(
        &self,
        turn: SpawnTurnRequest,
        execution: Option<u64>,
    ) -> Result<bool, AppIpcError> {
        let operation = self.turn_queue_operation.clone().lock_owned().await;
        if execution.is_some_and(|id| {
            !self.is_local_task_execution_accepting_notifications(&turn.local_task_id, id)
        }) {
            return Ok(false);
        }
        if self
            .automatic_input_admission(&turn.local_task_id, &turn.request)
            .is_some_and(
                |admit| matches!(admit(), Err(error) if error == CODEX_APP_SERVER_TURN_CANCELLED),
            )
        {
            if execution.is_some() {
                return Err(AppIpcError::new(
                    "subscription_cancelled",
                    CODEX_APP_SERVER_TURN_CANCELLED,
                ));
            }
            self.preparing_turns
                .lock()
                .expect("preparation map poisoned")
                .remove(&turn.local_task_id);
            self.store.update_task(&turn.local_task_id, |link| {
                if crate::runtime_work::lifecycle::native_execution_state(link)
                    .is_some_and(|state| state.awaits_admission())
                {
                    crate::runtime_work::lifecycle::settle_native_execution(link, "cancelled");
                }
            });
            drop(operation);
            self.finish_prepared_command(&turn, command_journal::CommandState::Cancelled)
                .await;
            return Ok(true);
        }
        let (previous, ready, queued) = {
            let mut scheduler = self.turn_scheduler.lock().expect("turn scheduler poisoned");
            let previous = scheduler.clone();
            scheduler.active_task_ids.remove(&turn.local_task_id);
            scheduler.queued_turns.push_front(turn.clone());
            scheduler.refresh_automatic_waits(&self.store, None);
            let ready = scheduler.take_available();
            (previous, ready, scheduler.queued_turns.clone())
        };
        if let Err(error) = self
            .persist_turn_queue(queued, Some(&previous), &ready)
            .await
        {
            *self.turn_scheduler.lock().expect("turn scheduler poisoned") = previous;
            return Err(error);
        }
        if let Some(execution) = execution {
            // Retire the old publication before any immediately ready command
            // can acquire this task's new execution and publication route.
            self.clear_active_codex_turn(&turn.local_task_id, execution);
            self.clear_active_request_user_input(&turn.local_task_id, execution);
            self.mark_thread_event_routes_idle_for_local_task(&turn.local_task_id);
            self.finish_local_task_execution(&turn.local_task_id, execution);
            let position = self
                .queued_local_task_position(&turn.local_task_id)
                .unwrap_or(0);
            self.store.update_task(&turn.local_task_id, |link| {
                crate::runtime_work::lifecycle::settle_native_execution(link, "cancelled");
                apply_local_execution_state(link, false, Some(position));
            });
            emit_runtime_work_changed(&self.event_tx, &self.device_id, &turn.local_task_id);
        }
        self.preparing_turns
            .lock()
            .expect("preparation map poisoned")
            .remove(&turn.local_task_id);
        self.dispatch_queued_turns(operation, ready);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work::handler::tests::isolated_runtime_work_handler;

    fn automatic_turn() -> SpawnTurnRequest {
        let payload = json!({"taskId":"waiting-work","commandId":"automatic-followup","message":"Original source input","automaticStandIn":true});
        let mut request = ExecutionRequest {
            prompt: json!("Original source input"),
            subtask_id: "followup-input".into(),
            ..Default::default()
        };
        request.extra.insert("user_id".into(), json!(7));
        apply_runtime_payload_metadata(&mut request, &payload);
        SpawnTurnRequest {
            platform_command: None,
            task_kind: None,
            local_task_id: "waiting-work".into(),
            runtime: "codex".into(),
            request,
            send_payload: Some(payload),
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        }
    }

    #[tokio::test]
    async fn immediate_redispatch_retires_old_routes_before_transferring_the_reservation() {
        let (mut handler, root) = isolated_runtime_work_handler("automatic-immediate-redispatch");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.restore_startup_semaphore = Arc::new(Semaphore::new(0));
        handler.command_journal.lock().unwrap().clear();
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "waiting-work".into(),
            status: "active".into(),
            thread_id: Some("original-thread".into()),
            ..Default::default()
        });
        let mut input = automatic_turn();
        // The existing restoration permit keeps the next worker before launch,
        // while the scheduler exercises an immediate same-command handoff.
        input
            .request
            .extra
            .insert(RESTORED_TURN_MARKER.into(), json!(true));
        handler.queue_turn(input).await.unwrap();
        let (previous, turn) = {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            let previous = scheduler.clone();
            (previous, scheduler.force_start("waiting-work").unwrap())
        };
        handler
            .persist_turn_queue(
                VecDeque::new(),
                Some(&previous),
                std::slice::from_ref(&turn),
            )
            .await
            .unwrap();
        let (cancel, _cancelled) = oneshot::channel();
        let (_stopped, stopped) = oneshot::channel();
        let execution = handler.start_local_task_execution("waiting-work".into(), cancel, stopped);
        let completion = ScheduledTurnGuard::new(
            handler.clone(),
            "waiting-work".into(),
            execution,
            Some("automatic-followup".into()),
        );
        handler.register_thread_event_route(
            "original-thread",
            "waiting-work".into(),
            turn.request.clone(),
            true,
        );
        handler.set_interaction_status("waiting-work", Some("awaitingUserReply"));
        assert_eq!(
            handler
                .automatic_input_admission("waiting-work", &turn.request)
                .unwrap()()
            .unwrap_err(),
            crate::agents::AUTOMATIC_INPUT_WAITING_FOR_HUMAN
        );
        handler.set_interaction_status("waiting-work", None);
        assert!(handler
            .defer_automatic_input("waiting-work", &turn.request, execution)
            .await
            .unwrap());
        assert!(!handler.thread_event_routing.lock().unwrap().routes["original-thread"].active,"old publication must retire before redispatch, rather than after the new worker can publish");
        let mut next_request = turn.request.clone();
        next_request.subtask_id = "next-native-turn".into();
        handler.register_thread_event_route(
            "original-thread",
            "waiting-work".into(),
            next_request,
            true,
        );
        completion.transfer();
        drop(completion);
        tokio::task::yield_now().await;
        {
            let routes = handler.thread_event_routing.lock().unwrap();
            assert!(routes.routes["original-thread"].active);
            assert_eq!(
                routes.routes["original-thread"].request.subtask_id,
                "next-native-turn"
            );
        }
        assert!(
            handler
                .turn_scheduler
                .lock()
                .unwrap()
                .active_task_ids
                .contains_key("waiting-work"),
            "the old completion cannot release the new reservation"
        );
        assert!(handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .is_empty());
        handler.restore_startup_semaphore.close();
        tokio::task::yield_now().await;
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn source_input_after_runtime_preparation_requeues_the_same_durable_command() {
        let (mut handler, root) = isolated_runtime_work_handler("source-input-late-question");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.command_journal.lock().unwrap().clear();
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "waiting-work".into(),
            status: "active".into(),
            thread_id: Some("original-thread".into()),
            ..Default::default()
        });
        let event_key = "a".repeat(64);
        let path = handler
            .store
            .index_path()
            .with_file_name("conversation-event-subscriptions.sqlite");
        super::control::connection_events::store::transact(&path,|state| {
            state["operations"]["source"]=json!({"task_id":"waiting-work","operation_id":"automatic-followup","session":{"engine":"Codex","id":"original-thread"},"resource_event_keys":[event_key],"events":[{"id":"original-event"}],"source":{"name":"Review"},"native_event_phase":"injected"});
            Ok(())
        }).unwrap();
        let mut input = automatic_turn();
        input
            .request
            .extra
            .insert("client_user_message_id".into(), json!("automatic-followup"));
        input.send_payload.as_mut().unwrap()["automaticStandIn"] = json!(false);
        input.send_payload.as_mut().unwrap()["resourceEventKeys"] = json!([event_key]);
        apply_runtime_payload_metadata(&mut input.request, input.send_payload.as_ref().unwrap());
        handler.queue_turn(input).await.unwrap();
        let (previous, turn) = {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            let previous = scheduler.clone();
            (previous, scheduler.force_start("waiting-work").unwrap())
        };
        handler
            .persist_turn_queue(
                VecDeque::new(),
                Some(&previous),
                std::slice::from_ref(&turn),
            )
            .await
            .unwrap();
        let (cancel, _cancelled) = oneshot::channel();
        let (_stopped, stopped) = oneshot::channel();
        let execution = handler.start_local_task_execution("waiting-work".into(), cancel, stopped);
        let completion = ScheduledTurnGuard::new(
            handler.clone(),
            "waiting-work".into(),
            execution,
            Some("automatic-followup".into()),
        );
        handler.set_interaction_status("waiting-work", Some("awaitingUserReply"));
        let admit = handler
            .automatic_input_admission("waiting-work", &turn.request)
            .unwrap();
        assert_eq!(
            admit().unwrap_err(),
            crate::agents::AUTOMATIC_INPUT_WAITING_FOR_HUMAN
        );
        assert!(handler
            .defer_automatic_input("waiting-work", &turn.request, execution)
            .await
            .unwrap());
        completion.transfer();
        drop(completion);
        tokio::task::yield_now().await;
        let receipt = handler
            .command_receipt(
                json!({"taskId":"waiting-work","commandId":"automatic-followup","userId":7}),
            )
            .await
            .unwrap();
        assert_eq!(receipt["state"], "queued");
        assert!(receipt["native"].is_null());
        let persisted =
            super::super::turns::read_runtime_turn_state(handler.turn_queue_path.as_ref()).unwrap();
        assert_eq!(persisted.queued_turns.len(), 1);
        assert_eq!(
            persisted.queued_turns[0].request.prompt,
            "Original source input"
        );
        assert_eq!(
            persisted.queued_turns[0].request.extra["resource_event_keys"],
            json!([event_key])
        );
        assert!(!handler.is_current_local_task_execution("waiting-work", execution));
        assert_eq!(
            handler
                .store
                .get_task_summary("waiting-work")
                .unwrap()
                .interaction_status
                .as_deref(),
            Some("awaitingUserReply")
        );
        let phase = super::control::connection_events::store::transact(&path, |state| {
            Ok(state["operations"]["source"]["native_event_phase"].clone())
        })
        .unwrap();
        assert_eq!(
            phase, "injected",
            "parking must preserve the native receipt for a later activation"
        );
        handler.set_interaction_status("waiting-work", None);
        let ready = {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            scheduler.refresh_automatic_waits(&handler.store, None);
            scheduler.take_available()
        };
        assert_eq!(ready.len(), 1);
        assert_eq!(
            ready[0].request.extra["runtime_command_id"],
            "automatic-followup"
        );
        assert!(handler
            .turn_scheduler
            .lock()
            .unwrap()
            .take_available()
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn resource_event_input_uses_the_existing_human_participation_queue() {
        let (handler, root) = isolated_runtime_work_handler("resource-event-question");
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "waiting-work".into(),
            status: "active".into(),
            interaction_status: Some("waitingForApproval".into()),
            ..Default::default()
        });
        let mut event = automatic_turn();
        event.request.extra.remove("standInAutomatic");
        event
            .request
            .extra
            .insert("resource_event_keys".into(), json!(["a".repeat(64)]));
        assert!(handler.automatic_input_waits(&event));
        {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            scheduler.enqueue_queued(event);
            scheduler.refresh_automatic_waits(&handler.store, None);
            assert!(scheduler.force_start("waiting-work").is_none());
            assert!(scheduler.take_available().is_empty());
        }
        handler.set_interaction_status("waiting-work", None);
        {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            scheduler.refresh_automatic_waits(&handler.store, None);
            let ready = scheduler.take_available();
            assert_eq!(ready.len(), 1);
            assert_eq!(ready[0].request.prompt, "Original source input");
            assert_eq!(
                ready[0].request.extra["resource_event_keys"],
                json!(["a".repeat(64)])
            );
            assert!(scheduler.queued_turns.is_empty());
        }
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn automatic_input_queued_before_a_question_stays_queued_after_the_current_turn_finishes()
    {
        let (mut handler, root) = isolated_runtime_work_handler("automatic-queue-question");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.command_journal.lock().unwrap().clear();
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "waiting-work".into(),
            status: "active".into(),
            ..Default::default()
        });
        handler
            .turn_scheduler
            .lock()
            .unwrap()
            .active_task_ids
            .insert("waiting-work".into(), RuntimeTaskKind::Personal);
        handler.queue_turn(automatic_turn()).await.unwrap();
        handler.set_interaction_status("waiting-work", Some("waitingForUserInput"));
        handler.finish_scheduled_turn("waiting-work").await;
        let receipt = handler
            .command_receipt(
                json!({"taskId":"waiting-work","commandId":"automatic-followup","userId":7}),
            )
            .await
            .unwrap();
        assert_eq!(receipt["state"], "queued");
        let persisted =
            super::super::turns::read_runtime_turn_state(handler.turn_queue_path.as_ref()).unwrap();
        assert_eq!(persisted.queued_turns.len(), 1);
        assert_eq!(
            persisted.queued_turns[0].request.prompt,
            json!("Original source input")
        );
        assert!(handler
            .store
            .get_task("waiting-work")
            .unwrap()
            .interaction_status
            .is_some());
        {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            scheduler.refresh_automatic_waits(&handler.store, None);
            assert!(scheduler.force_start("waiting-work").is_none());
            let mut explicit = automatic_turn();
            explicit.request.extra.remove("standInAutomatic");
            explicit.request.extra.remove("runtime_command_id");
            scheduler.enqueue_queued(explicit);
            let ready = scheduler.take_available();
            assert_eq!(ready.len(), 1);
            assert!(!ready[0].request.extra.contains_key("standInAutomatic"));
            assert_eq!(scheduler.queued_turns.len(), 1);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_question_after_dequeue_parks_the_same_command_before_native_launch() {
        let (mut handler, root) = isolated_runtime_work_handler("automatic-launch-question");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.command_journal.lock().unwrap().clear();
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "waiting-work".into(),
            status: "active".into(),
            ..Default::default()
        });
        handler.queue_turn(automatic_turn()).await.unwrap();
        let (previous, turn) = {
            let mut scheduler = handler.turn_scheduler.lock().unwrap();
            let previous = scheduler.clone();
            (previous, scheduler.force_start("waiting-work").unwrap())
        };
        handler
            .persist_turn_queue(
                VecDeque::new(),
                Some(&previous),
                std::slice::from_ref(&turn),
            )
            .await
            .unwrap();
        handler.set_interaction_status("waiting-work", Some("waitingForApproval"));
        handler.start_turn(turn);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let queued = handler
                    .command_journal
                    .lock()
                    .unwrap()
                    .values()
                    .any(|command| {
                        command.id == "automatic-followup"
                            && command.state == super::super::command_journal::CommandState::Queued
                    });
                if queued {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let receipt = handler
            .command_receipt(
                json!({"taskId":"waiting-work","commandId":"automatic-followup","userId":7}),
            )
            .await
            .unwrap();
        assert_eq!(receipt["state"], "queued");
        assert!(receipt["native"].is_null());
        assert_eq!(handler.turn_scheduler.lock().unwrap().queued_turns.len(), 1);
        handler.set_interaction_status("waiting-work", None);
        let mut scheduler = handler.turn_scheduler.lock().unwrap();
        scheduler.refresh_automatic_waits(&handler.store, None);
        assert_eq!(scheduler.take_available().len(), 1);
        drop(scheduler);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn accepted_automatic_input_revalidates_configuration_and_assignment_before_launch() {
        for revoke_configuration in [true, false] {
            let (mut handler, root) = isolated_runtime_work_handler("automatic-launch-revocation");
            handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
            handler.command_journal.lock().unwrap().clear();
            let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
            let project = store
                .create_project(serde_json::from_value(json!({"name":"Authority"})).unwrap())
                .unwrap();
            let mut settings = store.personal_stand_in(7, "device-1").unwrap();
            settings["roles"] = json!([crate::test_env::stand_in_role("device-1")]);
            settings["primary"] = json!({"enabled":true,"prompt":"","preferences":""});
            settings["roles"][0]["enabled"] = json!(true);
            settings["roles"][0]["collaboration"] = json!({"enabled":true,"allProjects":false,"projects":[{"id":project.id,"store":"local"}],"excludedProjects":[],"tags":[],"policy":{"automatic":true,"askBeforeAct":true}});
            store
                .save_personal_stand_in(7, "device-1", settings)
                .unwrap();
            let issue = store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":"Assigned work","assignee_user_id":7}))
                        .unwrap(),
                )
                .unwrap();
            let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","userId":7,"deviceId":"device-1","standInId":"default","cloudProjectId":project.id,"projectStore":"local","loopItemId":issue.id,"humanAssignmentId":format!("{}-1",issue.id)});
            let mut input = automatic_turn();
            input.request.extra.insert("origin".into(), origin.clone());
            handler.upsert_local_task(RuntimeTaskLink {
                local_task_id: "waiting-work".into(),
                status: "active".into(),
                runtime_handle: json!({"origin":origin,"executionRequest":{"user_id":7}}),
                ..Default::default()
            });
            handler.queue_turn(input).await.unwrap();
            let (previous, turn) = {
                let mut scheduler = handler.turn_scheduler.lock().unwrap();
                let previous = scheduler.clone();
                (previous, scheduler.force_start("waiting-work").unwrap())
            };
            handler
                .persist_turn_queue(
                    VecDeque::new(),
                    Some(&previous),
                    std::slice::from_ref(&turn),
                )
                .await
                .unwrap();
            handler.validate_automatic_turn(&turn).await.unwrap();
            if revoke_configuration {
                let mut settings = store.personal_stand_in(7, "device-1").unwrap();
                settings["roles"][0]["enabled"] = json!(false);
                store
                    .save_personal_stand_in(7, "device-1", settings)
                    .unwrap();
            } else {
                store
                    .update_task(
                        &project.id,
                        &issue.id,
                        serde_json::from_value(
                            json!({"version":issue.version,"assignee_user_id":8}),
                        )
                        .unwrap(),
                    )
                    .unwrap();
            }
            handler.start_automatic_turn(turn, None).await;
            let receipt = handler
                .command_receipt(
                    json!({"taskId":"waiting-work","commandId":"automatic-followup","userId":7}),
                )
                .await
                .unwrap();
            assert_eq!(receipt["state"], "failed");
            assert!(receipt["native"].is_null());
            assert_eq!(
                handler.store.get_task("waiting-work").unwrap().status,
                "failed"
            );
            let _ = fs::remove_dir_all(root);
        }
    }
}
