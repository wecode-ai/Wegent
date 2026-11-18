//! Model-armed, device-owned one-shot subscriptions reuse connection collection and turn delivery.
use super::*;
use wegent_protocol::connection_events::matches_event;
mod admission;
mod cloud;
mod conditions;
mod goal_reconciliation;
mod observations;
mod observers;
mod poll_schedule;
mod refresh;
mod resource_delivery;
mod session;

#[cfg(test)]
mod delivery_tests;
#[cfg(test)]
mod tests;

fn invalid(message: &str) -> AppIpcError {
    AppIpcError::new("invalid_event_subscription", message)
}

fn validate_filter(filter: &Value) -> Result<(), AppIpcError> {
    wegent_protocol::connection_events::validate_filter(filter).map_err(invalid)
}

pub(in crate::runtime_work::handler) fn goal_identity(goal: &Value) -> Value {
    json!({"objective":goal["objective"],"createdAt":goal["createdAt"],"tokenBudget":goal["tokenBudget"]})
}

fn event_user_message_presentation(record: &Value) -> Value {
    json!({"content":format!("{} · {}",
        record["source"]["name"].as_str().unwrap_or_default(),
        record["continuation"].as_str().unwrap_or_default()),
        "source":{"source":"connection_event","providerId":record["source"]["providerId"],"sourceName":record["source"]["name"]}})
}

fn public_subscription(record: &Value) -> Value {
    json!({"subscription_key":record["subscription_key"],"source":record["source"],
        "match":record["match"],"continuation":record["continuation"],
        "status":record["status"],"wait_for_event":record["wait_for_event"],"waiting_goal":!record["waiting_goal"].is_null(),
        "error_code":record["error_code"],"operation_id":record["operation_id"],
        "observed_events":record["observed_events"],"last_collected_at":record["last_collected_at"],
        "observation_id":record["observation_id"],"refresh_pending":record["refresh_pending"]==true,"handled_events":record["handled_events"],"resource_events":record["resource_events"],"resource_states":record["resource_states"]})
}

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) fn validate_resource_event_keys(
        &self,
        task: &str,
        keys: &[String],
    ) -> Result<(), AppIpcError> {
        if keys.is_empty() {
            return Ok(());
        }
        let known =
            workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                Ok(resource_delivery::event_facts(state, task))
            })?;
        if keys.iter().any(|key| !known.contains_key(key)) {
            return Err(AppIpcError::new(
                "bad_request",
                "Resource event does not belong to this conversation's authorized observations",
            ));
        }
        Ok(())
    }

    fn event_subscription_path(&self) -> PathBuf {
        self.store
            .index_path()
            .with_file_name("conversation-event-subscriptions.json")
    }

    fn subscription_id(&self, task: &str, key: &str) -> String {
        format!(
            "{:x}",
            Sha256::digest(json!([self.device_id, task, key]).to_string())
        )
    }

    fn save_event_subscription(&self, id: &str, record: &Value) -> Result<(), AppIpcError> {
        let mut persisted = record.clone();
        if record["status"] == "cancelled"
            && (record["cloud_registration"].is_object()
                || record["cloud_subscription"].is_object())
            && record["cloud_cancel_acknowledged"] != true
        {
            persisted["cloud_cancel_pending"] = json!(true);
        }
        let subscriptions =
            workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                if state["operations"][id]["status"] == "cancelled"
                    && record["status"] != "cancelled"
                {
                    return Err(AppIpcError::new(
                        "subscription_cancelled",
                        "The event wait was cancelled before delivery",
                    ));
                }
                if state["operations"][id]["status"] == "pending" && persisted["status"] == "armed"
                {
                    // A shared collector may capture this consumer while its task is reading health.
                    persisted = state["operations"][id].clone();
                }
                state["operations"][id] = persisted;
                Ok(state["operations"]
                    .as_object()
                    .unwrap()
                    .values()
                    .filter(|entry| entry["task_id"] == record["task_id"])
                    .filter(|entry| {
                        matches!(
                            entry["status"].as_str(),
                            Some(
                                "preparing"
                                    | "armed"
                                    | "pending"
                                    | "resuming_goal"
                                    | "needs_attention"
                                    | "error"
                                    | "delivered"
                            )
                        )
                    })
                    .map(public_subscription)
                    .collect::<Vec<_>>())
            })?;
        if let Some(task) = record["task_id"].as_str() {
            let mut changed = false;
            self.store.update_task(task, |link| {
                let next = json!(subscriptions);
                if link.runtime_handle["connectionEventSubscriptions"] != next {
                    link.runtime_handle["connectionEventSubscriptions"] = next;
                    changed = true;
                }
            });
            if changed {
                emit_runtime_work_changed(&self.event_tx, &self.device_id, task);
            }
        }
        Ok(())
    }

    pub(super) async fn control_connection_events(
        &self,
        context: &ControlContext,
        operation: &str,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        if operation == "list_connection_event_providers" {
            return self.connection_call("catalog", None, json!({})).await;
        }
        if operation == "list_connection_event_resources" {
            let input = json!({"kind":args["kind"],"query":args["query"],"cursor":args["cursor"]});
            return self
                .connection_call("listResources", args["provider_id"].as_str(), input)
                .await;
        }
        let task = &context.task_id;
        let link = self
            .store
            .get_task(task)
            .ok_or_else(|| invalid("Conversation not found"))?;
        self.authorize_control_target(context, &link).await?;
        let gate = self.task_send_gate(&format!("connection-events:{task}"));
        let _guard = gate.lock().await;
        let records =
            workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                Ok(state["operations"].as_object().unwrap().clone())
            })?;
        if operation == "list_connection_event_subscriptions" {
            return Ok(
                json!({"items":records.values().filter(|r| r["task_id"] == *task).map(public_subscription).collect::<Vec<_>>()}),
            );
        }
        let key = args["subscription_key"].as_str().unwrap();
        if key.len() > 256 {
            return Err(invalid("subscription_key exceeds 256 bytes"));
        }
        let id = self.subscription_id(task, key);
        if operation == "cancel_connection_event_subscription" {
            let mut record = records
                .get(&id)
                .cloned()
                .ok_or_else(|| invalid("Subscription not found in this conversation"))?;
            record["status"] = json!("cancelled");
            self.save_event_subscription(&id, &record)?;
            // Local cancellation is durable even while the cloud is unavailable.
            let _ = self
                .finish_cloud_connection_cancellation(&id, &mut record)
                .await;
            return Ok(json!({"subscription":public_subscription(&record)}));
        }
        let filter = conditions::resolve(&args)?;
        validate_filter(&filter)?;
        let intent = json!({"source":args["source"],"match":filter,
            "continuation":args["continuation"],"wait_for_event":args["wait_for_event"].as_bool().unwrap_or(false)});
        if let Some(record) = records.get(&id) {
            if record["intent"] != intent {
                return Err(invalid(
                    "subscription_key already belongs to different subscription arguments",
                ));
            }
            session::validate(record, &link)?;
            return Ok(json!({"subscription":public_subscription(record)}));
        }
        if args["continuation"].as_str().unwrap().len() > 16_384 {
            return Err(invalid("Continuation exceeds 16384 bytes"));
        }
        let session = session::binding(&link)?;
        let mut source = args["source"].clone();
        for field in ["providerId", "profile", "kind", "id", "name"] {
            if source[field].as_str().map_or(true, |v| v.trim().is_empty()) {
                return Err(invalid(
                    "Use an exact discovered connection resource as source",
                ));
            }
        }
        source["enabledAfter"] = json!(chrono::Utc::now().to_rfc3339());
        source["policy"] = json!({"automatic":false,"askBeforeAct":true});
        let provider = source["providerId"].as_str().unwrap().to_owned();
        self.connection_call("validate", Some(&provider), source.clone())
            .await?;
        let (observation_id, after_sequence, initial_checkpoint) =
            self.attach_event_observation(&mut source).await?;
        let goal = if intent["wait_for_event"] == true {
            let response = self.get_task_goal(json!({"taskId":task})).await?;
            if response["accepted"] != true {
                return Err(invalid("Cannot read the current Goal"));
            }
            response["goal"].clone()
        } else {
            Value::Null
        };
        let identity = goal_identity(&goal);
        let already_waiting = goal["status"] == "blocked"
            && records.values().any(|record| {
                record["task_id"] == *task
                    && record["waiting_goal"] == identity
                    && matches!(
                        record["status"].as_str(),
                        Some("preparing" | "armed" | "pending")
                    )
            });
        let waiting_goal = (goal["status"] == "active" || already_waiting).then_some(identity);
        let mut record = json!({"subscription_key":key,"task_id":task,"device_id":self.device_id,"session":session,
            "intent":intent,"source":source,"match":intent["match"],"continuation":intent["continuation"],
            "wait_for_event":intent["wait_for_event"],"observation_id":observation_id,"after_sequence":after_sequence,"initial_sequence":after_sequence,"status":if waiting_goal.is_some() { "preparing" } else { "armed" },
            "waiting_goal":waiting_goal});
        if self.cloud_connection_observations.load(Ordering::Acquire) {
            let owner = self
                .runtime_http(reqwest::Method::GET, "/users/me", None)
                .await?;
            if owner["id"].as_i64().map_or(true, |id| id <= 0) {
                return Err(invalid("Connected account is unavailable"));
            }
            let device = self.cloud_device_id()?;
            let cloud_id = format!(
                "{:x}",
                Sha256::digest(wegent_protocol::connection_events::canonical_json(&json!(
                    [device, task, key]
                )))
            );
            record["cloud_registration"] = json!({"owner_id":owner["id"],"device_id":device,"subscription_id":cloud_id,"initial_checkpoint":initial_checkpoint});
            record["status"] = json!("preparing");
        }
        self.save_event_subscription(&id, &record)?;
        if record["status"] == "preparing" {
            if let Err(error) = self.prepare_event_subscription(&id, &mut record).await {
                record["error_code"] = json!(error.code);
                self.save_event_subscription(&id, &record)?;
                return Err(error);
            }
        }
        // Capture the activation window before returning, without another collection.
        if record["status"] == "armed" && record["cloud_subscription"].is_null() {
            record =
                workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                    let stored = &state["observations"][&observation_id];
                    let observation =
                        json!({"sequence":stored["sequence"],"events":stored["events"]});
                    observations::capture_consumers(state, &observation_id, &observation);
                    Ok(state["operations"][&id].clone())
                })?;
            self.save_event_subscription(&id, &record)?;
            if record["status"] == "pending" {
                self.connection_observation_wakeup.notify_one();
            }
        }
        Ok(json!({"subscription":public_subscription(&record)}))
    }

    async fn prepare_event_subscription(
        &self,
        id: &str,
        record: &mut Value,
    ) -> Result<(), AppIpcError> {
        if record["cloud_registration"].is_object() && record["cloud_subscription"].is_null() {
            self.register_cloud_connection_subscription(id, record)
                .await?;
        }
        if record["status"] != "preparing" {
            return Ok(());
        }
        if record["cloud_refresh_pending"] == true && record["cloud_subscription"].is_object() {
            self.submit_cloud_observation_refresh(record).await?;
            self.save_event_subscription(id, record)?;
        }
        if !record["waiting_goal"].is_null() {
            return self.prepare_event_goal_wait(id, record).await;
        }
        record["status"] = json!("armed");
        record["error_code"] = Value::Null;
        self.save_event_subscription(id, record)
    }

    pub(in crate::runtime_work::handler) async fn poll_conversation_connection_events(
        &self,
        maintenance: bool,
    ) -> Result<(), AppIpcError> {
        let cycle = uuid::Uuid::new_v4().to_string();
        let records =
            workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                Ok(state["operations"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .filter(|(_, record)| {
                        if maintenance {
                            return true;
                        }
                        if record["status"] == "pending"
                            && record["pending_wakeup"] == true
                            && record["cloud_subscription"].is_null()
                        {
                            return true;
                        }
                        if record["status"] != "armed" || record["cloud_subscription"].is_object() {
                            return false;
                        }
                        let source = record["observation_id"]
                            .as_str()
                            .and_then(|id| state["observations"].get(id));
                        source.is_some_and(|source| {
                            source["next_poll_at"].as_i64().unwrap_or_default() <= now_ms()
                                || source["last_collected_at"] != record["last_collected_at"]
                        })
                    })
                    .map(|(id, record)| (id.clone(), record.clone()))
                    .collect::<serde_json::Map<String, Value>>())
            })?;
        for (id, snapshot) in records {
            let cancelling =
                snapshot["status"] == "cancelled" && snapshot["cloud_cancel_pending"] == true;
            let refreshing = snapshot["cloud_refresh_pending"] == true
                && matches!(
                    snapshot["status"].as_str(),
                    Some("preparing" | "armed" | "pending")
                );
            if snapshot["cloud_subscription"].is_object()
                && !cancelling
                && !refreshing
                && !matches!(
                    snapshot["status"].as_str(),
                    Some("preparing" | "resuming_goal")
                )
            {
                continue;
            }
            if !matches!(
                snapshot["status"].as_str(),
                Some("preparing" | "armed" | "pending" | "resuming_goal")
            ) && !cancelling
            {
                continue;
            }
            let task = snapshot["task_id"].as_str().unwrap_or_default();
            let gate = self.task_send_gate(&format!("connection-events:{task}"));
            let _guard = gate.lock().await;
            // A model may cancel or replace a subscription while collection was scheduled.
            let mut record =
                workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                    Ok(state["operations"][&id].clone())
                })?;
            let advanced = ["intent", "source", "waiting_goal", "task_id", "device_id"]
                .iter()
                .all(|field| record[field] == snapshot[field])
                && matches!(snapshot["status"].as_str(), Some("armed" | "pending"))
                && matches!(record["status"].as_str(), Some("armed" | "pending"));
            if record != snapshot && !advanced {
                continue;
            }
            if record["pending_wakeup"] == true {
                record["pending_wakeup"] = json!(false);
                self.save_event_subscription(&id, &record)?;
            }
            if cancelling {
                let mut record = record;
                if let Err(error) = self
                    .finish_cloud_connection_cancellation(&id, &mut record)
                    .await
                {
                    log_executor_event(
                        "Cloud event-wait cancellation deferred",
                        &[("code", error.code)],
                    );
                }
                continue;
            }
            if refreshing && record["cloud_subscription"].is_object() {
                let mut record = record;
                if let Err(error) = self.submit_cloud_observation_refresh(&mut record).await {
                    record["error_code"] = json!(error.code);
                }
                self.save_event_subscription(&id, &record)?;
                continue;
            }
            if let Err(error) = self
                .collect_conversation_subscription(&id, record.clone(), &cycle)
                .await
            {
                let mut record = workbench_control::journal::transact(
                    &self.event_subscription_path(),
                    |state| Ok(state["operations"][&id].clone()),
                )?;
                record["error_code"] = json!(error.code);
                self.save_event_subscription(&id, &record)?;
            }
        }
        Ok(())
    }

    async fn collect_conversation_subscription(
        &self,
        id: &str,
        mut record: Value,
        cycle: &str,
    ) -> Result<(), AppIpcError> {
        let task = record["task_id"].as_str().unwrap().to_owned();
        let Some(link) = self
            .store
            .get_task(&task)
            .filter(|link| link.status != "archived" && !self.archived_link_is_deleted(link))
        else {
            record["status"] = json!("cancelled");
            return self.save_event_subscription(id, &record);
        };
        if let Err(error) = session::validate(&record, &link) {
            if error.code != "native_session_changed" {
                return Err(error);
            }
            record["status"] = json!("cancelled");
            record["error_code"] = json!(error.code);
            return self.save_event_subscription(id, &record);
        }
        let mut request = runtime_event_request_from_link(&link);
        crate::runtime_work::api_context::inject_current_session(
            &mut request,
            &self.device_id,
            &task,
        );
        let context = ControlContext::from_request(&request)
            .ok_or_else(|| invalid("Conversation no longer permits personal control"))?;
        self.validate_control_context(&context)?;
        self.authorize_control_target(&context, &link).await?;
        if record["status"] == "preparing" {
            self.prepare_event_subscription(id, &mut record).await?;
            if record["status"] == "cancelled" {
                return Ok(());
            }
        }
        let gate = self.task_send_gate(&format!("goal-status:{task}"));
        let guard = gate.lock().await;
        record = workbench_control::journal::transact(&self.event_subscription_path(), |state| {
            Ok(state["operations"][id].clone())
        })?;
        if record["status"] == "resuming_goal" {
            return self.resume_event_goal(id, &mut record).await;
        }
        if !matches!(record["status"].as_str(), Some("armed" | "pending")) {
            return Ok(());
        }
        if !record["waiting_goal"].is_null() {
            let current = self.read_event_goal(&task).await?;
            if current["status"] != "blocked" || goal_identity(&current) != record["waiting_goal"] {
                record["status"] = json!("cancelled");
                return self.save_event_subscription(id, &record);
            }
        }
        drop(guard);
        if record["cloud_subscription"].is_null()
            && record["operation_id"].is_null()
            && matches!(record["status"].as_str(), Some("armed" | "pending"))
        {
            let observation = self.read_event_observation(&record, cycle, false).await?;
            record =
                workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                    state["operations"]
                        .get(id)
                        .cloned()
                        .ok_or_else(|| invalid("Subscription no longer exists"))
                })?;
            if record["status"] == "cancelled" {
                return Ok(());
            }
            record["last_collected_at"] = observation["last_collected_at"].clone();
            record["resource_states"] = observation["resource_states"].clone();
            record["observed_events"] = json!(observation["sequence"]
                .as_u64()
                .unwrap_or_default()
                .saturating_sub(record["initial_sequence"].as_u64().unwrap_or_default()));
            if record["error_code"] != "observation_history_gap" {
                record["error_code"] = observation["error_code"].clone();
            }
            if !record["error_code"].is_null() && record["status"] == "armed" {
                return self.save_event_subscription(id, &record);
            }
            let retained = observation["events"]
                .as_array()
                .ok_or_else(|| invalid("Missing observation events"))?;
            record["resource_events"] = json!(retained.iter().rev().filter(|entry| resource_delivery::active_observed_event(&record, entry)).take(64).map(|entry| { let event=&entry["event"]; json!({"key":entry["key"],"topicId":event["topicId"],"external":{"headSha":event["external"]["headSha"],"objectKind":event["external"]["objectKind"],"conclusion":event["external"]["payload"]["conclusion"],"status":event["external"]["payload"]["status"]}}) }).collect::<Vec<_>>());
            if record["pending_wakeup"] == true {
                record["pending_wakeup"] = json!(false);
            }
            self.save_event_subscription(id, &record)?;
        }
        if record["status"] != "pending" || link.interaction_status.is_some() {
            return Ok(());
        }
        // Serialize the final Goal check and durable send acceptance with user
        // pause/clear actions. Events accepted first may run; a pause accepted
        // first cancels the wait and can never be overwritten by collection.
        let goal_gate = self.task_send_gate(&format!("goal-status:{task}"));
        let goal_guard = goal_gate.lock().await;
        record = workbench_control::journal::transact(&self.event_subscription_path(), |state| {
            Ok(state["operations"][id].clone())
        })?;
        if record["status"] != "pending" {
            return Ok(());
        }
        let waiting_goal = record["waiting_goal"].clone();
        if !waiting_goal.is_null() {
            let current = self.get_task_goal(json!({"taskId":task})).await?;
            if current["accepted"] != true {
                return Err(invalid("Cannot revalidate waiting Goal"));
            }
            if current["goal"]["status"] != "blocked"
                || goal_identity(&current["goal"]) != waiting_goal
            {
                record["status"] = json!("cancelled");
                return self.save_event_subscription(id, &record);
            }
        }
        // This transaction orders cloud cancellation/lease expiry against the
        // durable continuation intent, after local permission and Goal checks.
        self.admit_cloud_connection_delivery(id, &record).await?;
        let request_key = format!("connection-event:{id}");
        // Persist the source-to-command authority before send_message can commit
        // a durable turn. The Goal gate orders this handoff with human controls.
        record["operation_id"] = json!(super::execution::continuation_operation_id(
            &self.device_id,
            &task,
            &request_key
        ));
        self.save_event_subscription(id, &record)?;
        let message = record["continuation"].as_str().unwrap().to_owned();
        let result = self
            .control_continue(
                &context,
                link,
                json!({"conversation_id":workbench_control::conversation_id(&self.device_id,&task),
            "request_key":request_key,"message":message,"queue_if_busy":true,"resource_event_keys":record["resource_event_keys"],
            "user_message_presentation":event_user_message_presentation(&record)}),
            )
            .await?;
        record["operation_id"] = result["operation"]["operation_id"].clone();
        if result["operation"]["delivery_status"] == "accepted" {
            record["handled_events"] = json!(record["events"].as_array().into_iter().flatten().map(|event| json!({"topicId":event["topicId"],"version":event["version"],"external":{"headSha":event["external"]["headSha"],"objectKind":event["external"]["objectKind"],"eventType":event["external"]["eventType"],"conclusion":event["external"]["payload"]["conclusion"],"status":event["external"]["payload"]["status"]}})).collect::<Vec<_>>());
        }
        record["status"] = json!(if result["operation"]["delivery_status"] == "accepted" {
            if waiting_goal.is_null() {
                "delivered"
            } else {
                "resuming_goal"
            }
        } else {
            "needs_attention"
        });
        self.save_event_subscription(id, &record)?;
        drop(goal_guard);
        if record["status"] == "resuming_goal" {
            return self.resume_event_goal(id, &mut record).await;
        }
        Ok(())
    }

    async fn read_event_goal(&self, task: &str) -> Result<Value, AppIpcError> {
        let result = self.get_task_goal(json!({"taskId":task})).await?;
        if result["accepted"] != true {
            return Err(invalid("Cannot read the waiting Goal"));
        }
        Ok(result["goal"].clone())
    }

    async fn prepare_event_goal_wait(
        &self,
        id: &str,
        record: &mut Value,
    ) -> Result<(), AppIpcError> {
        let task = record["task_id"].as_str().unwrap();
        let current = self.read_event_goal(task).await?;
        if goal_identity(&current) != record["waiting_goal"]
            || !matches!(current["status"].as_str(), Some("active" | "blocked"))
        {
            record["status"] = json!("cancelled");
            return self.save_event_subscription(id, record);
        }
        if current["status"] == "active" {
            let result = self
                .set_task_goal(
                    json!({"taskId":task,"status":"blocked","eventGoalExpected":current}),
                )
                .await?;
            if result["accepted"] != true {
                return Err(invalid("Cannot suspend Goal continuation; wait preparation will be retried by the host"));
            }
        }
        record["status"] = json!("armed");
        record["error_code"] = Value::Null;
        self.save_event_subscription(id, record)
    }

    async fn resume_event_goal(&self, id: &str, record: &mut Value) -> Result<(), AppIpcError> {
        // Acceptance can precede actual worker capacity. Only that worker may
        // inject the source input and activate accounting; collection never
        // restarts a Goal whose event turn may already have finished.
        let current =
            workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                Ok(state["operations"][id].clone())
            })?;
        *record = current;
        Ok(())
    }

    pub(in crate::runtime_work::handler) fn cancel_connection_goal_waits(
        &self,
        task: &str,
        status: Option<&str>,
    ) {
        if status == Some("blocked") {
            return;
        }
        let result =
            workbench_control::journal::transact(&self.event_subscription_path(), |state| {
                Ok(state["operations"].as_object().unwrap().clone())
            })
            .and_then(|records| {
                for (id, mut record) in records {
                    if record["task_id"] != task || record["waiting_goal"].is_null() {
                        continue;
                    }
                    let phase = record["status"].as_str().unwrap_or_default();
                    if !matches!(phase, "preparing" | "armed" | "pending" | "resuming_goal") {
                        continue;
                    }
                    if status == Some("active") && matches!(phase, "preparing" | "resuming_goal") {
                        continue;
                    }
                    record["status"] = json!("cancelled");
                    self.save_event_subscription(&id, &record)?;
                }
                Ok(())
            });
        if let Err(error) = result {
            log_executor_event(
                "Goal event-wait cancellation failed",
                &[("code", error.code)],
            );
        }
    }
}
