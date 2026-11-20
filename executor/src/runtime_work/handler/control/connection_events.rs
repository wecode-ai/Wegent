//! Model-armed, device-owned one-shot subscriptions reuse connection collection and turn delivery.
use super::*;
use wegent_protocol::connection_events::matches_event;
mod admission;
mod cloud;
mod conditions;
mod goal_reconciliation;
mod guidance;
mod observations;
mod observers;
mod poll_schedule;
mod refresh;
mod resource_delivery;
mod session;
pub(in crate::runtime_work::handler) mod store;
use self::store as event_store;

pub(in crate::runtime_work::handler) const OWNER_INPUT: &str =
    "resume_event_goal_after_owner_input";

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

fn mark_cloud_cancellation(record: &mut Value) {
    if record["status"] == "cancelled"
        && (record["cloud_registration"].is_object() || record["cloud_subscription"].is_object())
        && record["cloud_cancel_acknowledged"] != true
    {
        record["cloud_cancel_pending"] = json!(true);
    }
}

fn event_can_continue_goal(record: &Value, goal: &Value) -> bool {
    record["waiting_goal"] == goal_identity(goal)
        && (goal["status"] == "blocked"
            || (goal["status"] == "active" && record["status"] == "pending"))
}

fn handled_event_summaries(record: &Value) -> Value {
    json!(record["events"].as_array().into_iter().flatten().map(|event| json!({
        "topicId":event["topicId"],"version":event["version"],"external":{
            "headSha":event["external"]["headSha"],"objectKind":event["external"]["objectKind"],
            "eventType":event["external"]["eventType"],"conclusion":event["external"]["payload"]["conclusion"],
            "status":event["external"]["payload"]["status"],
            "mergeable":event["external"]["payload"]["mergeable"],
            "mergeStateStatus":event["external"]["payload"]["mergeStateStatus"],
        },
    })).collect::<Vec<_>>())
}

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) async fn append_connection_event_context(
        &self,
        task: &str,
        thread: &str,
        request: &mut ExecutionRequest,
    ) {
        let change_requests = self
            .store
            .read_task(task, |link| {
                link.runtime_handle["changeRequests"]
                    .as_array()
                    .map(|urls| {
                        urls.iter()
                            .filter_map(Value::as_str)
                            .filter_map(|url| canonical_pr(url).ok())
                            .collect::<Vec<_>>()
                    })
            })
            .flatten();
        let path = self.event_subscription_path();
        let task = task.to_owned();
        let thread = thread.to_owned();
        let snapshot = tokio::task::spawn_blocking(move || {
            event_store::read(&path, event_store::Scope::AwaitingEvent(&task), |state| {
                let subscriptions = state["operations"]
                    .as_object()
                    .into_iter()
                    .flat_map(|records| records.values())
                    .filter(|record| {
                        record["session"]["engine"] == "Codex" && record["session"]["id"] == thread
                    })
                    .map(|record| {
                        let source = &record["source"];
                        json!({
                            "subscription_key": record["subscription_key"],
                            "source": {"providerId": source["providerId"], "kind": source["kind"], "id": source["id"]},
                            "status": record["status"],
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!(subscriptions).to_string())
            })
        })
        .await;
        let unavailable = "Waiting subscription state is unavailable. Query list_connection_event_subscriptions if needed.";
        let value = match snapshot {
            Ok(Ok(value)) => value.replace('<', "\\u003c").replace('>', "\\u003e"),
            Ok(Err(error)) => {
                log_executor_event(
                    "runtime waiting subscription snapshot unavailable",
                    &[("code", error.code)],
                );
                unavailable.to_owned()
            }
            Err(_) => {
                log_executor_event("runtime waiting subscription worker failed", &[]);
                unavailable.to_owned()
            }
        };
        let key = if request.extra.contains_key("additionalContext")
            || !request.extra.contains_key("additional_context")
        {
            "additionalContext"
        } else {
            "additional_context"
        };
        if let Some(context) = request
            .extra
            .entry(key)
            .or_insert_with(|| json!({}))
            .as_object_mut()
        {
            context.insert(
                "wework.connection-events.waiting".into(),
                json!({"kind": "untrusted", "value": value}),
            );
            if let Some(urls) = change_requests {
                let value = if urls.is_empty() {
                    "[]".to_owned()
                } else {
                    format!(
                        "Change requests bound to this conversation: {}\nTo wait for a PR/MR, verify current status, then use a single merge wait for CI results and conflicts. Reuse it across head changes. If no matching wait exists, discover the exact PR/MR and call subscribe_connection_events with git_wait:merge and wait_for_event:true. Provide the exact head SHA for checks or workflow runs. After arming, recheck once and yield the turn if still waiting. Do not sleep or poll.",
                        json!(urls)
                    )
                };
                context.insert(
                    "wework.connection-events.change-requests".into(),
                    json!({"kind": "application", "value": value}),
                );
            }
        }
    }

    pub(in crate::runtime_work::handler) fn validate_resource_event_keys(
        &self,
        task: &str,
        keys: &[String],
    ) -> Result<(), AppIpcError> {
        self.load_resource_event_facts(task, keys).map(|_| ())
    }

    fn load_resource_event_facts(
        &self,
        task: &str,
        keys: &[String],
    ) -> Result<std::collections::BTreeMap<String, (Value, Value)>, AppIpcError> {
        if keys.is_empty() {
            return Ok(Default::default());
        }
        let requested = keys.iter().map(String::as_str).collect::<HashSet<_>>();
        let known = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::TaskEvents(task),
            |state| Ok(resource_delivery::event_facts(state, task, &requested)),
        )?;
        if known.len() != requested.len() {
            return Err(AppIpcError::new(
                "bad_request",
                "Resource event does not belong to this conversation's authorized observations",
            ));
        }
        Ok(known)
    }

    fn event_subscription_path(&self) -> PathBuf {
        self.store
            .index_path()
            .with_file_name("conversation-event-subscriptions.sqlite")
    }

    async fn remove_queued_event_continuation(&self, record: &Value) -> Result<(), AppIpcError> {
        if let (Some(task), Some(operation)) =
            (record["task_id"].as_str(), record["operation_id"].as_str())
        {
            self.remove_queued_turn_for_command(task, Some(operation))
                .await?;
        }
        Ok(())
    }

    fn subscription_id(&self, task: &str, key: &str) -> String {
        format!(
            "{:x}",
            Sha256::digest(json!([self.device_id, task, key]).to_string())
        )
    }

    fn save_event_subscription(&self, id: &str, record: &Value) -> Result<(), AppIpcError> {
        self.save_event_subscription_replacing(id, record, &[])
    }

    fn save_event_subscription_replacing(
        &self,
        id: &str,
        record: &Value,
        superseded: &[&str],
    ) -> Result<(), AppIpcError> {
        let mut persisted = record.clone();
        let task = record["task_id"].as_str().unwrap_or_default();
        mark_cloud_cancellation(&mut persisted);
        let scope = if superseded.is_empty() {
            event_store::Scope::Row("operations", id)
        } else {
            event_store::Scope::Task(task)
        };
        let mut projected = event_store::update_and_read(
            &self.event_subscription_path(),
            scope,
            |state| {
                for old_id in superseded {
                    let old = &mut state["operations"][*old_id];
                    old["status"] = json!("cancelled");
                    mark_cloud_cancellation(old);
                }
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
                Ok(())
            },
            event_store::Scope::TaskProjection(task),
        )?;
        let Value::Object(operations) = projected["operations"].take() else {
            unreachable!("event subscription projection always contains operations");
        };
        let subscriptions = Value::Array(operations.into_values().collect());
        if let Some(task) = record["task_id"].as_str() {
            let mut changed = false;
            self.store.update_task_without_snapshot(task, |link| {
                if link.runtime_handle["connectionEventSubscriptions"] != subscriptions {
                    link.runtime_handle["connectionEventSubscriptions"] = subscriptions;
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
        let records = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Task(task),
            |state| Ok(state["operations"].as_object().unwrap().clone()),
        )?;
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
            let goal_gate = self.task_send_gate(&format!("goal-status:{task}"));
            let goal_guard = goal_gate.lock().await;
            let mut record = event_store::read(
                &self.event_subscription_path(),
                event_store::Scope::Row("operations", &id),
                |state| {
                    state["operations"]
                        .get(&id)
                        .cloned()
                        .ok_or_else(|| invalid("Subscription not found in this conversation"))
                },
            )?;
            record["status"] = json!("cancelled");
            self.save_event_subscription(&id, &record)?;
            self.remove_queued_event_continuation(&record).await?;
            drop(goal_guard);
            // Local cancellation is durable even while the cloud is unavailable.
            let _ = self
                .finish_cloud_connection_cancellation(&id, &mut record)
                .await;
            return Ok(json!({"subscription":public_subscription(&record)}));
        }
        let filter = conditions::resolve(&args)?;
        let subscription = self
            .arm_event_subscription(&link, &records, &args, key, filter)
            .await?;
        Ok(json!({"subscription":subscription}))
    }

    async fn arm_event_subscription(
        &self,
        link: &RuntimeTaskLink,
        records: &serde_json::Map<String, Value>,
        args: &Value,
        key: &str,
        filter: Value,
    ) -> Result<Value, AppIpcError> {
        let task = &link.local_task_id;
        let id = self.subscription_id(task, key);
        validate_filter(&filter)?;
        let mut intent = json!({"source":args["source"],"match":filter,
            "continuation":args["continuation"],"wait_for_event":args["wait_for_event"].as_bool().unwrap_or(false)});
        let previous_intent = intent.clone();
        if matches!(args["git_wait"].as_str(), Some("checks" | "merge")) {
            intent["source"]["observeCurrentStatus"] = json!(true);
        } else if intent["source"].get("observeCurrentStatus").is_some() {
            return Err(invalid("Current Git status observation requires git_wait"));
        }
        let mut migrated_key = None;
        let merge = args["git_wait"] == "merge";
        if let Some(record) = records.get(&id) {
            if record["intent"] == intent || record["intent"] == previous_intent {
                session::validate(record, link)?;
                return Ok(public_subscription(record));
            }
            if !merge
                || !conditions::legacy_merge_retry(&record["intent"], &intent, &previous_intent)
            {
                return Err(invalid(
                    "subscription_key already belongs to different subscription arguments",
                ));
            }
            session::validate(record, link)?;
            // Cloud registrations are immutable and keyed by the subscription key.
            let replacement = format!("merge-wait-v2:{id}");
            if let Some(migrated) = records.get(&self.subscription_id(task, &replacement)) {
                if migrated["intent"] != intent {
                    return Err(invalid("Merge wait replacement key already exists"));
                }
                session::validate(migrated, link)?;
                return Ok(public_subscription(migrated));
            }
            if !conditions::same_merge_wait(record, &intent, &record["session"]) {
                return Ok(public_subscription(record));
            }
            migrated_key = Some(replacement);
        }
        let key = migrated_key.as_deref().unwrap_or(key);
        let id = self.subscription_id(task, key);
        if args["continuation"].as_str().unwrap().len() > 16_384 {
            return Err(invalid("Continuation exceeds 16384 bytes"));
        }
        let session = session::binding(link)?;
        let mut source = intent["source"].clone();
        for field in ["providerId", "profile", "kind", "id", "name"] {
            if source[field].as_str().map_or(true, |v| v.trim().is_empty()) {
                return Err(invalid(
                    "Use an exact discovered connection resource as source",
                ));
            }
        }
        let merge_waits: Vec<_> = records
            .iter()
            .filter(|(_, record)| merge && conditions::same_merge_wait(record, &intent, &session))
            .collect();
        let wants_goal_wait = intent["wait_for_event"] == true;
        let goal = if wants_goal_wait
            || merge_waits
                .iter()
                .any(|(_, record)| !record["waiting_goal"].is_null())
        {
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
            && event_store::read(
                &self.event_subscription_path(),
                event_store::Scope::Waiting(task),
                |state| {
                    Ok(state["operations"]
                        .as_object()
                        .unwrap()
                        .values()
                        .any(|record| {
                            record["task_id"] == *task
                                && record["waiting_goal"] == identity
                                && matches!(
                                    record["status"].as_str(),
                                    Some("preparing" | "armed" | "pending")
                                )
                        }))
                },
            )?;
        let inherits_goal_wait = already_waiting
            && merge_waits
                .iter()
                .any(|(_, record)| record["waiting_goal"] == identity);
        let waiting_goal = (inherits_goal_wait
            || (wants_goal_wait && (goal["status"] == "active" || already_waiting)))
            .then_some(identity);
        let mut superseded = Vec::new();
        for (old_id, record) in merge_waits {
            if migrated_key.is_none()
                && record["match"] == intent["match"]
                && record["continuation"] == intent["continuation"]
                && record["waiting_goal"] == json!(waiting_goal)
                && (!wants_goal_wait || record["wait_for_event"] == true)
            {
                return Ok(public_subscription(record));
            }
            superseded.push(old_id.as_str());
        }
        source["enabledAfter"] = json!(chrono::Utc::now().to_rfc3339());
        source["policy"] = json!({"automatic":false,"askBeforeAct":true});
        let provider = source["providerId"].as_str().unwrap().to_owned();
        self.connection_call("validate", Some(&provider), source.clone())
            .await?;
        // Publish a consumer before maintenance may reclaim its new collector.
        let _activation = self.connection_observation_activations.read().await;
        let (observation_id, after_sequence, initial_checkpoint) =
            self.attach_event_observation(&mut source).await?;
        let mut record = json!({"subscription_key":key,"task_id":task,"device_id":self.device_id,"session":session,
            "intent":intent,"source":source,"match":intent["match"],"continuation":intent["continuation"],
            "wait_for_event":intent["wait_for_event"],"observation_id":observation_id,"after_sequence":after_sequence,"initial_sequence":after_sequence,"status":if waiting_goal.is_some() { "preparing" } else { "armed" },
            "waiting_goal":waiting_goal});
        if self.cloud_connection_observations.load(Ordering::Acquire) {
            let owner = Self::local_connection_user(&self.require_runtime_connection()?)?;
            let device = self.cloud_device_id()?;
            let cloud_id = format!(
                "{:x}",
                Sha256::digest(wegent_protocol::connection_events::canonical_json(&json!(
                    [device, task, key]
                )))
            );
            record["cloud_registration"] = json!({"owner_id":owner,"device_id":device,"subscription_id":cloud_id,"initial_checkpoint":initial_checkpoint});
            record["status"] = json!("preparing");
        }
        self.save_event_subscription_replacing(&id, &record, &superseded)?;
        for old_id in superseded {
            self.remove_queued_event_continuation(&records[old_id])
                .await?;
        }
        if record["status"] == "preparing" {
            if let Err(error) = self.prepare_event_subscription(&id, &mut record).await {
                record["error_code"] = json!(error.code);
                self.save_event_subscription(&id, &record)?;
                return Err(error);
            }
        }
        // Capture the activation window before returning, without another collection.
        if record["status"] == "armed" && record["cloud_subscription"].is_null() {
            record = event_store::update(
                &self.event_subscription_path(),
                event_store::Scope::Activation(&observation_id, &id),
                |state| {
                    let stored = &state["observations"][&observation_id];
                    let observation =
                        json!({"sequence":stored["sequence"],"events":stored["events"]});
                    observations::capture_consumers(state, &observation_id, &observation);
                    state["operations"]
                        .get(&id)
                        .cloned()
                        .ok_or_else(|| invalid("Subscription no longer exists"))
                },
            )?;
            self.save_event_subscription(&id, &record)?;
            if record["status"] == "pending" {
                self.connection_observation_wakeup.notify_one();
            }
        }
        Ok(public_subscription(&record))
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

    #[cfg(test)]
    async fn poll_conversation_connection_events(
        &self,
        maintenance: bool,
    ) -> Result<(), AppIpcError> {
        self.poll_connection_observation_sources().await?;
        self.dispatch_conversation_connection_events(maintenance, true)
            .await
    }

    pub(in crate::runtime_work::handler) async fn dispatch_conversation_connection_events(
        &self,
        maintenance: bool,
        collect: bool,
    ) -> Result<(), AppIpcError> {
        let records = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Active,
            |state| {
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
                        if !collect
                            || record["status"] != "armed"
                            || record["cloud_subscription"].is_object()
                        {
                            return false;
                        }
                        let source = record["observation_id"]
                            .as_str()
                            .and_then(|id| state["observations"].get(id));
                        source.is_some_and(|source| {
                            source["last_collected_at"] != record["last_collected_at"]
                                || source["error_code"] != record["error_code"]
                        })
                    })
                    .map(|(id, record)| (id.clone(), record.clone()))
                    .collect::<serde_json::Map<String, Value>>())
            },
        )?;
        let mut by_task = std::collections::BTreeMap::<String, Vec<_>>::new();
        for (id, snapshot) in records {
            let task = snapshot["task_id"].as_str().unwrap_or_default().to_owned();
            by_task.entry(task).or_default().push((id, snapshot));
        }
        let mut workers = stream::iter(by_task.into_values())
            .map(|records| async move {
                for (id, snapshot) in records {
                    if let Err(error) = self.poll_conversation_subscription(&id, snapshot).await {
                        log_executor_event(
                            "Conversation event processing deferred",
                            &[("code", error.code)],
                        );
                    }
                }
            })
            .buffer_unordered(4);
        while workers.next().await.is_some() {}
        Ok(())
    }

    async fn poll_conversation_subscription(
        &self,
        id: &str,
        snapshot: Value,
    ) -> Result<(), AppIpcError> {
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
            return Ok(());
        }
        if !matches!(
            snapshot["status"].as_str(),
            Some("preparing" | "armed" | "pending" | "resuming_goal")
        ) && !cancelling
        {
            return Ok(());
        }
        let task = snapshot["task_id"].as_str().unwrap_or_default();
        let gate = self.task_send_gate(&format!("connection-events:{task}"));
        let _guard = gate.lock().await;
        // A model may cancel or replace a subscription while collection was scheduled.
        let mut record = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("operations", id),
            |state| Ok(state["operations"][id].clone()),
        )?;
        let advanced = ["intent", "source", "waiting_goal", "task_id", "device_id"]
            .iter()
            .all(|field| record[field] == snapshot[field])
            && matches!(snapshot["status"].as_str(), Some("armed" | "pending"))
            && matches!(record["status"].as_str(), Some("armed" | "pending"));
        if record != snapshot && !advanced {
            return Ok(());
        }
        if record["pending_wakeup"] == true {
            record["pending_wakeup"] = json!(false);
            self.save_event_subscription(id, &record)?;
        }
        if cancelling {
            let mut record = record;
            if let Err(error) = self
                .finish_cloud_connection_cancellation(id, &mut record)
                .await
            {
                log_executor_event(
                    "Cloud event-wait cancellation deferred",
                    &[("code", error.code)],
                );
            }
            return Ok(());
        }
        if refreshing && record["cloud_subscription"].is_object() {
            let mut record = record;
            if let Err(error) = self.submit_cloud_observation_refresh(&mut record).await {
                record["error_code"] = json!(error.code);
            }
            return self.save_event_subscription(id, &record);
        }
        if let Err(error) = self.collect_conversation_subscription(id, record).await {
            let mut record = event_store::read(
                &self.event_subscription_path(),
                event_store::Scope::Row("operations", id),
                |state| Ok(state["operations"][id].clone()),
            )?;
            record["error_code"] = json!(error.code);
            self.save_event_subscription(id, &record)?;
        }
        Ok(())
    }

    async fn collect_conversation_subscription(
        &self,
        id: &str,
        mut record: Value,
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
        if record["status"] == "preparing" {
            self.prepare_event_subscription(id, &mut record).await?;
            if record["status"] == "cancelled" {
                return Ok(());
            }
        }
        let gate = self.task_send_gate(&format!("goal-status:{task}"));
        let guard = gate.lock().await;
        record = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("operations", id),
            |state| Ok(state["operations"][id].clone()),
        )?;
        if record["status"] == "resuming_goal" {
            drop(guard);
            return self.resume_event_goal(id, &mut record).await;
        }
        if !matches!(record["status"].as_str(), Some("armed" | "pending")) {
            return Ok(());
        }
        if !record["waiting_goal"].is_null() {
            let current = self.read_event_goal(&task).await?;
            if !event_can_continue_goal(&record, &current) {
                record["status"] = json!("cancelled");
                return self.save_event_subscription(id, &record);
            }
        }
        drop(guard);
        if record["cloud_subscription"].is_null()
            && record["operation_id"].is_null()
            && matches!(record["status"].as_str(), Some("armed" | "pending"))
        {
            let observation = self.stored_event_observation(
                record["observation_id"]
                    .as_str()
                    .ok_or_else(|| invalid("Missing observation identity"))?,
            )?;
            record = event_store::read(
                &self.event_subscription_path(),
                event_store::Scope::Row("operations", id),
                |state| {
                    state["operations"]
                        .get(id)
                        .cloned()
                        .ok_or_else(|| invalid("Subscription no longer exists"))
                },
            )?;
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
        record = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("operations", id),
            |state| Ok(state["operations"][id].clone()),
        )?;
        if record["status"] != "pending" {
            return Ok(());
        }
        let waiting_goal = record["waiting_goal"].clone();
        if !waiting_goal.is_null() {
            let current = self.get_task_goal(json!({"taskId":task})).await?;
            if current["accepted"] != true {
                return Err(invalid("Cannot revalidate waiting Goal"));
            }
            if !event_can_continue_goal(&record, &current["goal"]) {
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
        if self
            .steer_connection_event(id, &mut record, &link, &context)
            .await?
        {
            drop(goal_guard);
            if record["status"] == "resuming_goal" {
                self.resume_event_goal(id, &mut record).await?;
            }
            return Ok(());
        }
        let message = record["continuation"].as_str().unwrap().to_owned();
        let result = self
            .control_continue_from_event(
                &context,
                link,
                json!({"conversation_id":workbench_control::conversation_id(&self.device_id,&task),
            "request_key":request_key,"message":message,"queue_if_busy":true,"resource_event_keys":record["resource_event_keys"],
            "user_message_presentation":event_user_message_presentation(&record)}),
            )
            .await?;
        record["operation_id"] = result["operation"]["operation_id"].clone();
        if result["operation"]["delivery_status"] == "accepted" {
            record["handled_events"] = handled_event_summaries(&record);
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
        // Queued event turns activate their own Goals at native input admission.
        if record["native_guidance"] != "accepted" {
            return Ok(());
        }
        *record = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("operations", id),
            |state| Ok(state["operations"][id].clone()),
        )?;
        if record["status"] != "resuming_goal" {
            return Ok(());
        }
        let task = record["task_id"].as_str().unwrap();
        let current = self.read_event_goal(task).await?;
        if current["status"] == "blocked"
            && current["threadId"] == record["session"]["id"]
            && goal_identity(&current) == record["waiting_goal"]
        {
            let result = self
                .set_task_goal(
                    json!({"taskId": task, "status": "active", "eventGoalExpected": current}),
                )
                .await?;
            if result["accepted"] != true {
                return Err(invalid("Cannot resume the Goal after event guidance"));
            }
        }
        record["status"] = json!("delivered");
        self.save_event_subscription(id, record)?;
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
        let result = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Waiting(task),
            |state| Ok(state["operations"].as_object().unwrap().clone()),
        )
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
