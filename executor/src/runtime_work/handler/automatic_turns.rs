//! Automatic input stays in the native durable queue until human participation ends.
use super::*;

impl RuntimeWorkRpcHandler {
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

    async fn validate_automatic_turn(&self, turn: &SpawnTurnRequest) -> Result<(), AppIpcError> {
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
        if settings["primary"]["enabled"] == false {
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
        let link = self
            .local_task_link(&turn.local_task_id)
            .ok_or_else(|| AppIpcError::new("not_found", "Automatic work no longer exists"))?;
        if link.runtime_handle["executionRequest"]["user_id"] != user
            && link.runtime_handle["origin"]["userId"] != user
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Automatic work belongs to another user",
            ));
        }
        self.validate_primary_task_followup(user, &link).await
    }

    pub(super) fn automatic_stand_in_waits(&self, turn: &SpawnTurnRequest) -> bool {
        turn.request.extra.get("standInAutomatic") == Some(&Value::Bool(true))
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
        let operation = self.turn_queue_operation.lock().await;
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
            log_executor_event(
                "Automatic input queue persistence failed",
                &[("task_id", turn.local_task_id), ("code", error.code)],
            );
            return;
        }
        self.preparing_turns
            .lock()
            .expect("preparation map poisoned")
            .remove(&turn.local_task_id);
        for next in &ready {
            self.reserve_turn_preparation(next);
        }
        drop(operation);
        for next in ready {
            self.start_queued_turn(next);
        }
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
