//! Native admission is recovered from host intent, never from model-supplied flags.
use super::*;

struct GoalClaim {
    id: String,
    record: Value,
    operation: String,
    guard: tokio::sync::OwnedMutexGuard<()>,
}

impl RuntimeWorkRpcHandler {
    async fn claim_event_goal(
        &self,
        task: &str,
        request: &ExecutionRequest,
    ) -> Result<Option<GoalClaim>, String> {
        let Some(operation) = request
            .extra
            .get("client_user_message_id")
            .or_else(|| request.extra.get("clientUserMessageId"))
            .and_then(Value::as_str)
        else {
            return Ok(None);
        };
        let guard = self
            .task_send_gate(&format!("goal-status:{task}"))
            .lock_owned()
            .await;
        let found = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Task(task),
            |state| {
                let mut matches = state["operations"]
                    .as_object()
                    .into_iter()
                    .flat_map(|values| values.iter())
                    .filter(|(_, record)| {
                        record["task_id"] == task
                            && record["operation_id"] == operation
                            && !record["waiting_goal"].is_null()
                    });
                let found = matches
                    .next()
                    .map(|(id, record)| (id.clone(), record.clone()));
                if matches.next().is_some() {
                    return Err(invalid("Event operation has multiple waiting Goals"));
                }
                if found.is_none()
                    && state["operations"]
                        .as_object()
                        .into_iter()
                        .flat_map(|values| values.iter())
                        .any(|(id, record)| {
                            record["task_id"] == task
                                && !record["waiting_goal"].is_null()
                                && super::super::execution::continuation_operation_id(
                                    &self.device_id,
                                    task,
                                    &format!("connection-event:{id}"),
                                ) == operation
                        })
                {
                    return Err(invalid("Event turn has no durable host admission binding"));
                }
                Ok(found)
            },
        )
        .map_err(|error| error.message)?;
        let Some((id, mut record)) = found else {
            return Ok(None);
        };
        if record["status"] == "cancelled" {
            return Err(CODEX_APP_SERVER_TURN_CANCELLED.into());
        }
        if record["status"] == "delivered"
            && record["native_event_phase"] == "activated"
            && (request.extra.contains_key(quota_recovery::MARKER)
                || request.extra.get(RESUME_GOAL_ONLY_MARKER) == Some(&Value::Bool(true)))
        {
            return Ok(None);
        }
        if !matches!(record["status"].as_str(), Some("pending" | "resuming_goal")) {
            return Err("The event Goal wait is no longer pending execution".into());
        }
        let input = request
            .extra
            .get("runtime_command_input")
            .ok_or("Event command input is missing")?;
        if request.extra.get("runtime_command_id") != Some(&json!(operation))
            || input["prompt"] != record["continuation"]
            || input["message"] != event_user_message_presentation(&record)["content"]
            || input["resourceEventKeys"] != record["resource_event_keys"]
        {
            return Err("Event execution differs from its accepted host intent".into());
        }
        let link = self
            .store
            .get_task(task)
            .ok_or("Original event conversation no longer exists")?;
        self.validate_event_input_session(task, Some(operation), &link)
            .map_err(|error| error.message)?;
        if self
            .store
            .read_task(task, |link| link.goal_status.as_deref() == Some("active"))
            == Some(true)
        {
            let current = self
                .read_event_goal(task)
                .await
                .map_err(|error| error.message)?;
            if current["status"] == "active" && goal_identity(&current) == record["waiting_goal"] {
                record["status"] = json!("resuming_goal");
                record["native_event_phase"] = json!("joining_active_goal");
                self.save_event_subscription(&id, &record)
                    .map_err(|error| error.message)?;
                return Ok(None);
            }
        }
        if record["status"] == "pending" {
            record["status"] = json!("resuming_goal");
            self.save_event_subscription(&id, &record)
                .map_err(|error| error.message)?;
        }
        Ok(Some(GoalClaim {
            id,
            record,
            operation: operation.into(),
            guard,
        }))
    }

    pub(in crate::runtime_work::handler) async fn event_goal_admission(
        &self,
        task: &str,
        request: &ExecutionRequest,
    ) -> Result<Option<crate::agents::EventGoalAdmission>, String> {
        let Some(GoalClaim {
            id,
            mut record,
            operation,
            guard,
        }) = self.claim_event_goal(task, request).await?
        else {
            return Ok(None);
        };
        let link = self
            .store
            .get_task(task)
            .ok_or("Original event conversation no longer exists")?;
        let thread = codex_thread_id_from_link(&link)
            .ok_or("Original event native session is unavailable")?;
        if record["native_event_input"].is_null() {
            record["native_event_input"] = request.prompt.clone();
            self.save_event_subscription(&id, &record)
                .map_err(|error| error.message)?;
        }
        let handler = self.clone();
        let bound_operation = operation.clone();
        Ok(Some(crate::agents::EventGoalAdmission::new(
            thread,
            record["waiting_goal"].clone(),
            operation,
            record["native_event_input"].clone(),
            record["native_event_phase"].as_str().map(str::to_owned),
            guard,
            Box::new(move |phase| {
                handler
                    .update_event_goal_phase(&id, &bound_operation, phase)
                    .map_err(|error| {
                        if error.code == "user_input_pending" {
                            crate::agents::AUTOMATIC_INPUT_WAITING_FOR_HUMAN.into()
                        } else {
                            error.message
                        }
                    })
            }),
        )))
    }

    pub(in crate::runtime_work::handler) async fn admit_claude_event_goal(
        &self,
        task: &str,
        request: &ExecutionRequest,
    ) -> Result<(), String> {
        let Some(claim) = self.claim_event_goal(task, request).await? else {
            return Ok(());
        };
        let link = self
            .store
            .get_task(task)
            .ok_or("Original event conversation no longer exists")?;
        let goal = self
            .get_claude_goal(&link)
            .ok_or("Original waiting Goal is unavailable")?;
        if !is_claude_runtime(&link.runtime)
            || goal["status"] != "blocked"
            || goal_identity(&goal) != claim.record["waiting_goal"]
        {
            return Err("The original waiting Goal changed before event execution".into());
        }
        if !claim.record["native_event_phase"].is_null() {
            return Err("Event activation has an uncertain receipt; it cannot be repeated".into());
        }
        self.update_event_goal_phase(&claim.id, &claim.operation, "activation_requested")
            .map_err(|error| {
                if error.code == "user_input_pending" {
                    crate::agents::AUTOMATIC_INPUT_WAITING_FOR_HUMAN.into()
                } else {
                    error.message
                }
            })?;
        self.set_claude_goal(&link, &json!({"status":"active"}));
        self.update_event_goal_phase(&claim.id, &claim.operation, "activated")
            .map_err(|error| error.message)?;
        Ok(())
    }

    fn update_event_goal_phase(
        &self,
        id: &str,
        operation: &str,
        phase: &str,
    ) -> Result<(), AppIpcError> {
        let _guard = self
            .stand_in_lifecycle_gate
            .lock()
            .expect("turn lifecycle gate poisoned");
        let mut record = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("operations", id),
            |state| Ok(state["operations"][id].clone()),
        )?;
        if record["operation_id"] != operation || record["status"] == "cancelled" {
            return Err(invalid(
                "The event wait was cancelled before native admission",
            ));
        }
        if matches!(phase, "injection_requested" | "activation_requested")
            && self
                .store
                .get_task_summary(
                    record["task_id"]
                        .as_str()
                        .ok_or_else(|| invalid("Event conversation is missing"))?,
                )
                .is_none_or(|link| {
                    link.interaction_status
                        .as_deref()
                        .is_some_and(|status| !status.is_empty())
                })
        {
            return Err(AppIpcError::new(
                "user_input_pending",
                "Event input is waiting for the conversation's human participation",
            ));
        }
        record["native_event_phase"] = json!(phase);
        if phase == "activated" {
            record["status"] = json!("delivered");
        }
        self.save_event_subscription(id, &record)
    }

    pub(in crate::runtime_work::handler) fn event_goal_turn_started(
        &self,
        task: &str,
        request: &ExecutionRequest,
    ) {
        let Some(operation) = request
            .extra
            .get("client_user_message_id")
            .or_else(|| request.extra.get("clientUserMessageId"))
            .and_then(Value::as_str)
        else {
            return;
        };
        let result = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Task(task),
            |state| {
                Ok(state["operations"]
                    .as_object()
                    .into_iter()
                    .flat_map(|records| records.iter())
                    .filter(|(_, record)| {
                        record["task_id"] == task
                            && record["operation_id"] == operation
                            && matches!(
                                record["native_event_phase"].as_str(),
                                Some("activation_requested" | "joining_active_goal")
                            )
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>())
            },
        )
        .and_then(|ids| {
            for id in ids {
                self.update_event_goal_phase(&id, operation, "activated")?;
            }
            Ok(())
        });
        if let Err(error) = result {
            log_executor_event(
                "connection event native receipt persistence failed",
                &[("task_id", task.into()), ("error_code", error.code)],
            );
        }
    }

    pub(in crate::runtime_work::handler) fn event_goal_admission_failed(
        &self,
        task: &str,
        request: &ExecutionRequest,
    ) {
        let Some(operation) = request
            .extra
            .get("client_user_message_id")
            .or_else(|| request.extra.get("clientUserMessageId"))
            .and_then(Value::as_str)
        else {
            return;
        };
        let result = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Task(task),
            |state| {
                Ok(state["operations"]
                    .as_object()
                    .into_iter()
                    .flat_map(|records| records.iter())
                    .filter(|(_, record)| {
                        record["task_id"] == task
                            && record["operation_id"] == operation
                            && record["status"] == "resuming_goal"
                    })
                    .map(|(id, record)| (id.clone(), record.clone()))
                    .collect::<Vec<_>>())
            },
        )
        .and_then(|records| {
            for (id, mut record) in records {
                record["status"] = json!("needs_attention");
                record["error_code"] = json!("event_admission_failed");
                self.save_event_subscription(&id, &record)?;
            }
            Ok(())
        });
        if let Err(error) = result {
            log_executor_event(
                "connection event admission failure persistence failed",
                &[("task_id", task.into()), ("error_code", error.code)],
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work::handler::control::tests::{seed, EnvGuard};

    #[test]
    fn native_goal_admission_accepts_the_canonical_source_message_presentation() {
        let _lock = crate::test_env::lock();
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            let mut link = seed(&handler, "caller");
            link.thread_id = Some("11111111-1111-4111-8111-111111111111".into());
            handler.store.upsert_task(link.clone());
            let record = json!({"task_id":"caller","status":"resuming_goal","operation_id":"event-operation",
                "session":session::binding(&link).unwrap(),"continuation":"Process the review","resource_event_keys":["a".repeat(64)],
                "waiting_goal":{"objective":"Finish work","createdAt":1,"tokenBudget":500},
                "source":{"name":"Review"},"events":[{"id":"new-review","text":"Untrusted review facts"}]});
            handler.save_event_subscription("review", &record).unwrap();
            let mut payload = json!({"commandId":"event-operation","clientUserMessageId":"event-operation",
                "message":"Process the review","resourceEventKeys":record["resource_event_keys"],
                "userMessagePresentation":{"content":"Review · Process the review","source":{"source":"connection_event"}}});
            normalize_user_message_presentation(&mut payload).unwrap();
            assert_eq!(payload["message"], "Review · Process the review");
            let mut request = ExecutionRequest {prompt:record["continuation"].clone(), ..Default::default()};
            request.extra.insert("client_user_message_id".into(), json!("event-operation"));
            apply_runtime_payload_metadata(&mut request, &payload);
            handler.prepare_resource_event_request("caller", &mut request).unwrap();
            assert_eq!(request.extra["runtime_command_input"]["prompt"], "Process the review");
            assert!(request.prompt.as_str().unwrap().contains("Untrusted review facts"));
            for (field, value) in [
                ("prompt", json!("Unrelated execution")),
                ("message", json!("Forged source · Process the review")),
                ("resourceEventKeys", json!(["b".repeat(64)])),
            ] {
                let mut changed = request.clone();
                changed.extra.get_mut("runtime_command_input").unwrap()[field] = value;
                assert!(handler.event_goal_admission("caller", &changed).await.is_err(), "{field} must retain its distinct accepted identity");
            }
            drop(handler.event_goal_admission("caller", &request).await.unwrap().unwrap());
        });
    }

    #[test]
    fn deferred_event_pins_the_original_input_across_fresh_runtime_context() {
        let _lock = crate::test_env::lock();
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let root=tempfile::tempdir().unwrap();
            let _env=EnvGuard::home(root.path().to_str().unwrap());
            let handler=RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
            let mut link=seed(&handler,"caller");
            link.thread_id=Some("11111111-1111-4111-8111-111111111111".into());
            handler.store.upsert_task(link.clone());
            let mut record=json!({"task_id":"caller","status":"resuming_goal","operation_id":"event-operation","continuation":"Process the event","resource_event_keys":["a".repeat(64)],"waiting_goal":{"objective":"Finish work","createdAt":1,"tokenBudget":500},"source":{"name":"Review"}});
            record["session"]=session::binding(&link).unwrap();
            handler.save_event_subscription("review",&record).unwrap();
            let mut request=ExecutionRequest{prompt:record["continuation"].clone(),..Default::default()};
            request.extra.insert("client_user_message_id".into(),json!("event-operation"));
            apply_runtime_payload_metadata(&mut request,&json!({"commandId":"event-operation","message":event_user_message_presentation(&record)["content"],"resourceEventKeys":record["resource_event_keys"]}));
            request.prompt=json!("Process the event. Original source facts and recalled context.");
            drop(handler.event_goal_admission("caller",&request).await.unwrap().unwrap());
            record=event_store::transact(&handler.event_subscription_path(),|state|Ok(state["operations"]["review"].clone())).unwrap();
            let original=record["native_event_input"].clone();
            record["native_event_phase"]=json!("injected");
            handler.save_event_subscription("review",&record).unwrap();
            request.prompt=json!("Process the event. Original source facts and newer recalled context.");
            drop(handler.event_goal_admission("caller",&request).await.unwrap().unwrap());
            let saved=event_store::transact(&handler.event_subscription_path(),|state|Ok(state["operations"]["review"].clone())).unwrap();
            assert_eq!(saved["native_event_input"],original);
            assert_eq!(saved["native_event_phase"],"injected");
        });
    }

    #[test]
    fn source_admission_preserves_questions_during_runtime_preparation() {
        let _lock = crate::test_env::lock();
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        let link = seed(&handler, "caller");
        handler.save_event_subscription("review",&json!({"task_id":"caller","status":"resuming_goal","operation_id":"event-operation","source":{"name":"Review"}})).unwrap();
        let mut event = ExecutionRequest::default();
        event
            .extra
            .insert("resource_event_keys".into(), json!(["a".repeat(64)]));
        // A question can arrive after the last scheduler check but before the
        // running projection is committed. Automatic input must not clear it.
        handler.set_interaction_status("caller", Some("waitingForApproval"));
        handler.mark_task_running_for_send(
            "caller",
            link.thread_id.as_deref().unwrap(),
            &link.workspace_path,
            &event,
            &json!({}),
        );
        assert_eq!(
            handler
                .store
                .get_task_summary("caller")
                .unwrap()
                .interaction_status
                .as_deref(),
            Some("waitingForApproval")
        );
        assert_eq!(
            handler
                .update_event_goal_phase("review", "event-operation", "injection_requested")
                .unwrap_err()
                .code,
            "user_input_pending"
        );
        handler.set_interaction_status("caller", None);
        handler
            .update_event_goal_phase("review", "event-operation", "injection_requested")
            .unwrap();
        handler
            .update_event_goal_phase("review", "event-operation", "injected")
            .unwrap();
        handler.set_interaction_status("caller", Some("awaitingUserReply"));
        assert_eq!(
            handler
                .update_event_goal_phase("review", "event-operation", "activation_requested")
                .unwrap_err()
                .code,
            "user_input_pending"
        );
        let saved = event_store::transact(&handler.event_subscription_path(), |state| {
            Ok(state["operations"]["review"].clone())
        })
        .unwrap();
        assert_eq!(saved["native_event_phase"], "injected");
        // An explicit owner reply retains the ordinary path for answering it.
        handler.mark_task_running_for_send(
            "caller",
            link.thread_id.as_deref().unwrap(),
            &link.workspace_path,
            &ExecutionRequest::default(),
            &json!({}),
        );
        assert!(handler
            .store
            .get_task_summary("caller")
            .unwrap()
            .interaction_status
            .is_none());
    }
}
