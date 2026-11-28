//! Stop intake before cancelling every identity conversation and delegated task.
use super::stand_in::settings_error;
use super::*;

fn stand_in_owner(origin: &Value) -> Option<i64> {
    (origin["initiatedBy"] == "stand_in"
        || matches!(
            origin["type"].as_str(),
            Some("stand_in_identity" | "stand_in_coordinator")
        ))
    .then(|| origin["userId"].as_i64())
    .flatten()
}

impl RuntimeWorkRpcHandler {
    fn stand_in_binding_instance(&self) -> Option<&str> {
        (std::env::var("WEWORK_DEVELOPMENT_ISOLATED").as_deref() == Ok("1"))
            .then_some(self.device_id.as_str())
    }

    pub(super) fn stand_in_binding(&self, payload: Value) -> Result<Value, AppIpcError> {
        let operation = payload["operation"].as_str().unwrap_or("get");
        LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(settings_error)?
            .stand_in_binding(
                self.stand_in_binding_instance(),
                operation,
                payload["version"].as_i64().unwrap_or(-1),
                payload["target"].clone(),
            )
            .map_err(settings_error)
    }

    pub(super) fn validate_stand_in_lifecycle(
        &self,
        request: &ExecutionRequest,
        task_id: &str,
    ) -> Result<(), AppIpcError> {
        let user = request
            .extra
            .get("origin")
            .and_then(stand_in_owner)
            .or_else(|| {
                self.local_task_link(task_id)
                    .and_then(|link| stand_in_owner(&link.runtime_handle["origin"]))
            });
        let Some(user) = user else {
            return Ok(());
        };
        let settings = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(settings_error)?
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        if settings["lifecycle"]["status"].is_null() {
            Ok(())
        } else {
            Err(AppIpcError::new(
                "stand_in_stopped",
                "The entire stand-in is stopped; bind it again before starting work",
            ))
        }
    }

    pub(super) async fn personal_stand_in_lifecycle(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        self.personal_stand_in_lifecycle_with_timeout(payload, Duration::from_secs(10))
            .await
    }

    async fn personal_stand_in_lifecycle_with_timeout(
        &self,
        payload: Value,
        stop_timeout: Duration,
    ) -> Result<Value, AppIpcError> {
        let user = super::runtime_owner::runtime_user(&payload)?;
        let requested_operation = payload["operation"].as_str().unwrap_or_default();
        let (operation, expected_version) = match requested_operation {
            // A separate operation makes older Executors reject a conditional
            // stop rather than ignore its version and stop a newer instance.
            "stopIfVersion" | "startIfVersion" => (
                if requested_operation == "stopIfVersion" { "stop" } else { "start" },
                Some(
                    payload["expectedVersion"]
                        .as_i64()
                        .filter(|version| *version >= 0)
                        .ok_or_else(|| {
                            AppIpcError::new(
                                "bad_request",
                                "expectedVersion must be a nonnegative integer for a conditional lifecycle operation",
                            )
                        })?,
                ),
            ),
            "start" | "stop" if payload.get("expectedVersion").is_none() => {
                (requested_operation, None)
            }
            _ => {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Unknown or invalid lifecycle operation",
                ));
            }
        };
        let lifecycle = self.task_send_gate(&format!("stand-in-lifecycle:{user}"));
        let _lifecycle = lifecycle.lock().await;
        let processing = self.task_send_gate(&format!("stand-in-processing:{user}"));
        let _processing = processing.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let tasks = {
            let _guard = self
                .stand_in_lifecycle_gate
                .lock()
                .expect("stand-in lifecycle gate poisoned");
            let settings = store
                .transition_personal_stand_in_with_version(
                    user,
                    &self.device_id,
                    operation,
                    expected_version,
                    self.stand_in_binding_instance(),
                )
                .map_err(settings_error)?;
            if operation == "start" || settings["lifecycle"]["status"] == "stopped" {
                return Ok(settings);
            }
            let tasks = self
                .store
                .list_task_summaries(true)
                .into_iter()
                .filter(|link| stand_in_owner(&link.runtime_handle["origin"]) == Some(user))
                .filter(|link| {
                    self.is_busy_local_task(&link.local_task_id)
                        || matches!(link.status.as_str(), "active" | "running" | "pending")
                })
                .map(|link| link.local_task_id)
                .collect::<Vec<_>>();
            let settings = store
                .remember_stand_in_stop_tasks(user, &self.device_id, &tasks)
                .map_err(settings_error)?;
            settings["lifecycle"]["tasks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|task| task.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        };
        // A cancelled tool may need the processing gate to finish cleanup. The
        // durable stopping state already rejects intake, edits and new turns.
        drop(_processing);
        // Cancellation uses the normal Runtime path, including queued turns and approvals.
        let results = stream::iter(tasks.into_iter().map(|task| async move {
            let result = self
                .cancel_task_with_stop_policy(json!({"taskId":task}), stop_timeout, true, None)
                .await;
            (task, result)
        }))
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
        for (task, result) in results {
            let result = result?;
            if result["cleanupPending"] == true || self.is_busy_local_task(&task) {
                return Err(AppIpcError::new(
                    "stand_in_stop_incomplete",
                    "Task cancellation is not complete; retry stopping before rebinding",
                ));
            }
        }
        store
            .transition_personal_stand_in(user, &self.device_id, "stopped")
            .map_err(settings_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> (RuntimeWorkRpcHandler, LocalTaskStore) {
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
        handler.turn_queue_path = Arc::new(root.join("turn-queue.json"));
        handler.turn_scheduler.lock().unwrap().queued_turns.clear();
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        (handler, store)
    }

    #[tokio::test]
    async fn whole_profile_stop_cancels_primary_roles_and_workers_but_not_other_work() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store) = fixture(root.path());
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"] = json!([crate::test_env::stand_in_role("mac")]);
        settings["roles"][0]["enabled"] = json!(true);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let origins = [
            ("primary", json!({"type":"stand_in_identity","userId":7})),
            (
                "role",
                json!({"type":"stand_in_identity","userId":7,"standInId":"default"}),
            ),
            (
                "worker",
                json!({"type":"stand_in_task","initiatedBy":"stand_in","userId":7}),
            ),
            (
                "other-account",
                json!({"type":"stand_in_identity","userId":8}),
            ),
            ("ordinary", json!({"type":"personal","userId":7})),
        ];
        let mut acknowledgements = Vec::new();
        let mut unrelated = Vec::new();
        for (id, origin) in origins {
            handler.upsert_local_task(RuntimeTaskLink {
                local_task_id: id.into(),
                runtime: "claudecode".into(),
                status: "active".into(),
                runtime_handle: json!({"origin":origin}),
                ..Default::default()
            });
            let (cancel, cancelled) = oneshot::channel();
            let (stopped, stop) = oneshot::channel();
            handler.start_local_task_execution(id.into(), cancel, stop);
            if matches!(id, "ordinary" | "other-account") {
                unrelated.push((id, cancelled, stopped));
            } else {
                let processing = handler.task_send_gate("stand-in-processing:7");
                acknowledgements.push(tokio::spawn(async move {
                    cancelled.await.unwrap();
                    let _cleanup = processing.lock().await;
                    stopped.send(()).unwrap();
                }));
            }
        }
        let result = handler
            .personal_stand_in_lifecycle(json!({"userId":7,"operation":"stop"}))
            .await
            .unwrap();
        assert_eq!(result["lifecycle"]["status"], "stopped");
        assert_eq!(result["primary"]["enabled"], false);
        assert_eq!(result["roles"][0]["enabled"], false);
        for id in ["primary", "role", "worker"] {
            assert!(!handler.is_busy_local_task(id));
        }
        for (id, mut cancelled, _) in unrelated {
            assert!(handler.is_busy_local_task(id));
            assert!(matches!(
                cancelled.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
        }
        for acknowledgement in acknowledgements {
            acknowledgement.await.unwrap();
        }
    }

    #[test]
    fn stopped_profiles_reject_direct_and_replayed_turns_without_blocking_ordinary_work() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store) = fixture(root.path());
        store
            .transition_personal_stand_in(7, "mac", "stop")
            .unwrap();
        let mut request = ExecutionRequest::default();
        request.extra.insert(
            "origin".into(),
            json!({"type":"stand_in_identity","userId":7}),
        );
        assert_eq!(
            handler
                .validate_stand_in_lifecycle(&request, "identity")
                .unwrap_err()
                .code,
            "stand_in_stopped"
        );
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "worker".into(),
            runtime_handle: json!({"origin":{"initiatedBy":"stand_in","userId":7}}),
            ..Default::default()
        });
        let plain = ExecutionRequest::default();
        assert!(handler
            .validate_stand_in_lifecycle(&plain, "worker")
            .is_err());
        assert!(handler
            .validate_stand_in_lifecycle(&plain, "ordinary")
            .is_ok());
    }

    #[tokio::test]
    async fn stop_cancels_all_queued_followups_and_the_active_turn_of_the_same_task() {
        let root = tempfile::tempdir().unwrap();
        let (handler, _) = fixture(root.path());
        let origin = json!({"initiatedBy":"stand_in","userId":7,"type":"stand_in_task"});
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "worker".into(),
            runtime: "claudecode".into(),
            status: "active".into(),
            runtime_handle: json!({"origin":origin}),
            ..Default::default()
        });
        for _ in 0..2 {
            let mut request = ExecutionRequest::default();
            request.extra.insert("origin".into(), origin.clone());
            handler
                .turn_scheduler
                .lock()
                .unwrap()
                .queued_turns
                .push_back(SpawnTurnRequest {
                    task_kind: None,
                    local_task_id: "worker".into(),
                    runtime: "claudecode".into(),
                    request,
                    send_payload: None,
                    direct_thread_id: None,
                    fork_thread_id: None,
                    fork_thread_path: None,
                    resume_thread_id: None,
                    initial_thread_goal: None,
                });
        }
        let (cancel, cancelled) = oneshot::channel();
        let (stopped, stop) = oneshot::channel();
        handler.start_local_task_execution("worker".into(), cancel, stop);
        let acknowledgement = tokio::spawn(async move {
            cancelled.await.unwrap();
            stopped.send(()).unwrap();
        });
        handler
            .personal_stand_in_lifecycle(json!({"userId":7,"operation":"stop"}))
            .await
            .unwrap();
        acknowledgement.await.unwrap();
        assert!(!handler.is_busy_local_task("worker"));
        assert!(handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .is_empty());
        assert!(
            super::super::turns::read_runtime_turn_queue(&handler.turn_queue_path)
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn stopping_is_idempotent_and_does_not_erase_configuration() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store) = fixture(root.path());
        let first = handler
            .personal_stand_in_lifecycle(json!({"userId":7,"operation":"stop"}))
            .await
            .unwrap();
        let second = handler
            .personal_stand_in_lifecycle(json!({"userId":7,"operation":"stop"}))
            .await
            .unwrap();
        assert_eq!(first, second);
        let mut forged = second.clone();
        forged.as_object_mut().unwrap().remove("lifecycle");
        forged["primary"]["enabled"] = json!(true);
        assert!(store.save_personal_stand_in(7, "mac", forged).is_err());
        assert!(handler
            .personal_stand_in_lifecycle(json!({"userId":7,"operation":"start"}))
            .await
            .unwrap()["lifecycle"]
            .is_null());
    }

    #[tokio::test]
    async fn stale_stop_version_cannot_stop_restarted_assistant() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store) = fixture(root.path());
        let initial = store.personal_stand_in(7, "mac").unwrap();
        let stop =
            json!({"userId":7,"operation":"stopIfVersion","expectedVersion":initial["version"]});
        let stopped = handler
            .personal_stand_in_lifecycle(stop.clone())
            .await
            .unwrap();
        assert_eq!(stopped["lifecycle"]["status"], "stopped");
        assert_eq!(
            handler.personal_stand_in_lifecycle(json!({"userId":7,"operation":"startIfVersion","expectedVersion":initial["version"]}))
                .await.unwrap_err().code,
            "version_conflict"
        );
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), stopped);
        let start =
            json!({"userId":7,"operation":"startIfVersion","expectedVersion":stopped["version"]});
        let target = json!({"userId":7,"deviceId":"mac"});
        let marked = handler
            .stand_in_binding(json!({"operation":"markStoppingWithGeneration","target":target}))
            .unwrap();
        assert_eq!(
            handler
                .personal_stand_in_lifecycle(start.clone())
                .await
                .unwrap_err()
                .code,
            "version_conflict"
        );
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), stopped);
        handler
            .stand_in_binding(json!({
                "operation":"clearStoppingIfGeneration", "target":target,
                "version":marked["stoppingTargetGenerations"]["7:mac"],
            }))
            .unwrap();
        let restarted = handler.personal_stand_in_lifecycle(start).await.unwrap();
        assert!(restarted["lifecycle"].is_null());
        assert_eq!(
            handler
                .personal_stand_in_lifecycle(stop)
                .await
                .unwrap_err()
                .code,
            "version_conflict"
        );
        for payload in [
            json!({"userId":7,"operation":"stopIfVersion"}),
            json!({"userId":7,"operation":"stopIfVersion","expectedVersion":-1}),
            json!({"userId":7,"operation":"stopIfVersion","expectedVersion":"1"}),
            json!({"userId":7,"operation":"startIfVersion"}),
            json!({"userId":7,"operation":"stop","expectedVersion":0}),
            json!({"userId":7,"operation":"start","expectedVersion":0}),
        ] {
            assert_eq!(
                handler
                    .personal_stand_in_lifecycle(payload)
                    .await
                    .unwrap_err()
                    .code,
                "bad_request"
            );
        }
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), restarted);
    }

    #[tokio::test]
    async fn cancellation_timeout_keeps_the_real_execution_locked_until_acknowledged() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store) = fixture(root.path());
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "worker".into(),
            runtime: "claudecode".into(),
            status: "active".into(),
            runtime_handle: json!({"origin":{"initiatedBy":"stand_in","userId":7}}),
            ..Default::default()
        });
        let (cancel, cancelled) = oneshot::channel();
        let (stopped, stop) = oneshot::channel();
        handler.start_local_task_execution("worker".into(), cancel, stop);
        let payload = json!({"userId":7,"operation":"stop"});
        let error = handler
            .personal_stand_in_lifecycle_with_timeout(payload.clone(), Duration::from_millis(20))
            .await
            .unwrap_err();
        assert_eq!(error.code, "stand_in_stop_incomplete");
        assert!(handler.is_active_local_task("worker"));
        cancelled.await.unwrap();
        let settings = store.personal_stand_in(7, "mac").unwrap();
        assert_eq!(settings["lifecycle"]["status"], "stopping");
        assert_eq!(settings["lifecycle"]["tasks"], json!(["worker"]));
        assert!(store
            .transition_personal_stand_in(7, "mac", "start")
            .is_err());
        stopped.send(()).unwrap();
        let result = handler
            .personal_stand_in_lifecycle_with_timeout(payload, Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(result["lifecycle"]["status"], "stopped");
        assert!(!handler.is_active_local_task("worker"));
    }
}
