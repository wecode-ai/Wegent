//! One durable collector per exact provider/account/resource, with independent consumers.
use super::*;
use futures_util::{stream, StreamExt};
use wegent_protocol::connection_events::{canonical_json, event_identity, observation_identity};

pub(super) fn capture_consumers(state: &mut Value, id: &str, observation: &Value) -> bool {
    let mut wakeup = false;
    let retained = observation["events"].as_array().unwrap();
    for record in state["operations"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .filter(|record| {
            record["observation_id"] == id
                && record["status"] == "armed"
                && record["cloud_subscription"].is_null()
        })
    {
        let after = record["after_sequence"].as_u64().unwrap_or_default();
        if retained
            .first()
            .and_then(|entry| entry["sequence"].as_u64())
            .is_some_and(|first| after.saturating_add(1) < first)
        {
            record["error_code"] = json!("observation_history_gap");
            continue;
        }
        let matching: Vec<_> = retained
            .iter()
            .filter(|entry| entry["sequence"].as_u64().unwrap_or_default() > after)
            .filter(|entry| resource_delivery::active_observed_event(record, entry))
            .filter(|entry| matches_event(&record["match"], &entry["event"]))
            .take(1000)
            .collect();
        let events: Vec<_> = matching
            .iter()
            .map(|entry| entry["event"].clone())
            .collect();
        let keys: Vec<_> = matching.iter().map(|entry| entry["key"].clone()).collect();
        record["after_sequence"] = observation["sequence"].clone();
        if !events.is_empty() {
            record["events"] = json!(events);
            record["resource_event_keys"] = json!(keys);
            record["status"] = json!("pending");
            record["pending_wakeup"] = json!(true);
            wakeup = true;
        }
    }
    wakeup
}

impl RuntimeWorkRpcHandler {
    pub(super) fn reclaim_event_observations(&self) -> Result<(), AppIpcError> {
        let Ok(_activation) = self.connection_observation_activations.try_write() else {
            return Ok(());
        };
        for id in event_store::unreferenced(&self.event_subscription_path())? {
            let source_gate = self.task_send_gate(&format!("connection-observation:{id}"));
            let Ok(_source) = source_gate.try_lock() else {
                continue;
            };
            event_store::remove_unreferenced(&self.event_subscription_path(), &id)?;
        }
        Ok(())
    }

    pub(super) async fn attach_event_observation(
        &self,
        source: &mut Value,
    ) -> Result<(String, u64, Value), AppIpcError> {
        source
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid observation source"))?
            .remove("boundary");
        let initialized = self
            .connection_call(
                "initializeObservation",
                source["providerId"].as_str(),
                source.clone(),
            )
            .await?;
        let checkpoint = &initialized["checkpoint"];
        let expected = wegent_protocol::connection_events::initialized_source(source, &initialized)
            .map_err(|_| invalid("Provider returned an invalid observation activation"))?;
        *source = expected;
        let id = format!(
            "{:x}",
            Sha256::digest(canonical_json(&observation_identity(source)))
        );
        let gate = self.task_send_gate(&format!("connection-observation:{id}"));
        let _guard = gate.lock().await;
        let existing = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("observations", &id),
            |state| Ok(state["observations"][&id].clone()),
        )?;
        if existing.is_object() {
            if !existing["events"].is_array() || existing["sequence"].as_u64().is_none() {
                return Err(AppIpcError::new(
                    "control_storage_failed",
                    "Invalid observation source journal",
                ));
            }
            return Ok((
                id,
                wegent_protocol::connection_events::activation_sequence(
                    source,
                    &existing,
                    |value| {
                        chrono::DateTime::parse_from_rfc3339(value.as_str()?)
                            .ok()
                            .map(|time| time.timestamp_millis())
                    },
                ),
                checkpoint.clone(),
            ));
        }
        event_store::update(
            &self.event_subscription_path(),
            event_store::Scope::Row("observations", &id),
            |state| {
                if !state["observations"].is_object() {
                    state["observations"] = json!({});
                }
                state["observations"][&id] =
                    json!({"source":source,"checkpoint":checkpoint,"sequence":0,"events":[]});
                Ok(())
            },
        )?;
        Ok((id, 0, checkpoint.clone()))
    }

    pub(in crate::runtime_work::handler) async fn poll_connection_observation_sources(
        &self,
    ) -> Result<(), AppIpcError> {
        let sources = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Active,
            |state| {
                let now = now_ms();
                let sidebar = state["observers"]
                    .as_object()
                    .into_iter()
                    .flat_map(|rows| rows.values())
                    .filter(|row| {
                        row["status"] == "observing"
                            && row["cloud_registration"].is_null()
                            && row["expires_at"].as_i64().unwrap_or_default() > now
                    });
                let conversations = state["operations"]
                    .as_object()
                    .into_iter()
                    .flat_map(|rows| rows.values())
                    .filter(|row| {
                        matches!(row["status"].as_str(), Some("armed" | "pending"))
                            && row["operation_id"].is_null()
                            && row["cloud_subscription"].is_null()
                            && row["cloud_registration"].is_null()
                    });
                Ok(sidebar
                    .chain(conversations)
                    .filter_map(|row| row["observation_id"].as_str().map(str::to_owned))
                    .filter(|id| {
                        state["observations"][id]["next_poll_at"]
                            .as_i64()
                            .unwrap_or_default()
                            <= now
                    })
                    .collect::<std::collections::BTreeSet<_>>())
            },
        )?;
        let cycle = uuid::Uuid::new_v4().to_string();
        let mut collection = stream::iter(sources)
            .map(|source| {
                let cycle = cycle.clone();
                async move {
                    self.read_event_observation(&json!({"observation_id":source}), &cycle, false)
                        .await
                }
            })
            .buffer_unordered(4);
        while let Some(result) = collection.next().await {
            if let Err(error) = result {
                log_executor_event(
                    "Connection observation source deferred",
                    &[("code", error.code)],
                );
            }
        }
        Ok(())
    }

    pub(super) fn stored_event_observation(&self, id: &str) -> Result<Value, AppIpcError> {
        let observation = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("observations", id),
            |state| Ok(state["observations"][id].clone()),
        )?;
        if !observation.is_object()
            || !observation["source"].is_object()
            || !observation["checkpoint"].is_object()
            || !observation["events"].is_array()
            || observation["sequence"].as_u64().is_none()
        {
            return Err(AppIpcError::new(
                "control_storage_failed",
                "Invalid observation source journal",
            ));
        }
        Ok(observation)
    }

    pub(super) async fn read_event_observation(
        &self,
        record: &Value,
        tick: &str,
        force: bool,
    ) -> Result<Value, AppIpcError> {
        let id = record["observation_id"]
            .as_str()
            .ok_or_else(|| invalid("Missing observation identity"))?;
        let gate = self.task_send_gate(&format!("connection-observation:{id}"));
        let _guard = gate.lock().await;
        let mut observation = self.stored_event_observation(id)?;
        if observation["collection_cycle"] != tick
            && (force || observation["next_poll_at"].as_i64().unwrap_or_default() <= now_ms())
        {
            let source = observation["source"].clone();
            let previous_error = observation["error_code"].as_str().map(str::to_owned);
            let result = self
                .connection_call(
                    "collectObservation",
                    source["providerId"].as_str(),
                    json!({"source":source,"checkpoint":observation["checkpoint"],"force":force}),
                )
                .await
                .and_then(|page| {
                    if !page["events"].is_array() || !page["nextCheckpoint"].is_object() {
                        return Err(invalid("Provider returned an invalid observation page"));
                    }
                    Ok(page)
                });
            observation["attempted_at"] = json!(now_ms());
            observation["next_poll_at"] = json!(now_ms() + super::poll_schedule::INTERVAL_MS);
            observation["collection_cycle"] = json!(tick);
            let collected = result.is_ok();
            match result {
                Ok(page) => {
                    let events = page["events"].as_array().unwrap();
                    let mut retained = observation["events"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let mut seen: HashSet<_> = retained
                        .iter()
                        .map(|entry| canonical_json(&event_identity(&source, &entry["event"])))
                        .collect();
                    let mut sequence = observation["sequence"].as_u64().unwrap_or_default();
                    for event in events {
                        let identity = canonical_json(&event_identity(&source, event));
                        if !seen.insert(identity.clone()) {
                            continue;
                        }
                        sequence += 1;
                        let key = format!("{:x}", Sha256::digest(identity));
                        retained.push(json!({"sequence":sequence,"key":key,"event":event}));
                    }
                    observation["events"] = json!(retained);
                    observation["sequence"] = json!(sequence);
                    observation["checkpoint"] = page["nextCheckpoint"].clone();
                    if page["resourceStates"].is_array() {
                        observation["resource_states"] = page["resourceStates"].clone();
                    }
                    observation["last_collected_at"] = json!(now_ms());
                    observation["error_code"] =
                        page.get("errorCode").cloned().unwrap_or(Value::Null);
                }
                Err(error) => observation["error_code"] = json!(error.code),
            }
            let wakeup = event_store::update(
                &self.event_subscription_path(),
                event_store::Scope::Source(id),
                |state| {
                    let mut wakeup = false;
                    if collected {
                        // Capture every consumer before compacting shared history in this commit.
                        wakeup = capture_consumers(state, id, &observation);
                        let retained = observation["events"].as_array_mut().unwrap();
                        if retained.len() > 1000 {
                            retained.drain(..retained.len() - 1000);
                        }
                    }
                    state["observations"][id] = observation.clone();
                    Ok(wakeup)
                },
            )?;
            let error = observation["error_code"].as_str();
            if error != previous_error.as_deref() {
                log_executor_event(
                    "Connection observation health changed",
                    &[
                        ("observation_id", id.to_owned()),
                        (
                            "provider",
                            source["providerId"].as_str().unwrap_or_default().to_owned(),
                        ),
                        ("previous_code", previous_error.unwrap_or_default()),
                        ("code", error.unwrap_or_default().to_owned()),
                    ],
                );
            }
            if wakeup {
                self.connection_observation_wakeup.notify_one();
            }
        }
        Ok(observation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod merge_readiness;

    #[test]
    fn retained_completion_inside_activation_window_is_captured_once() {
        let source = json!({"providerId":"github","enabledAfter":"2026-11-15T00:00:00Z"});
        let observation = json!({"sequence":2,"events":[{"sequence":1,"key":"old","event":{"id":"old","at":"2026-11-14T00:00:00Z","state":"completed"}},{"sequence":2,"key":"completion","event":{"id":"completion","at":"2026-11-15T00:00:01Z","state":"completed"}}]});
        let baseline =
            wegent_protocol::connection_events::activation_sequence(&source, &observation, |v| {
                chrono::DateTime::parse_from_rfc3339(v.as_str()?)
                    .ok()
                    .map(|v| v.timestamp_millis())
            });
        let record = json!({"observation_id":"shared","source":source,"status":"armed","initial_sequence":baseline,"after_sequence":baseline,"match":{"/state":"completed"}});
        let mut state = json!({"operations":{"waiting":record}});
        assert!(capture_consumers(&mut state, "shared", &observation));
        assert_eq!(
            state["operations"]["waiting"]["resource_event_keys"],
            json!(["completion"])
        );
        assert_eq!(state["operations"]["waiting"]["status"], "pending");
        let captured = state.clone();
        assert!(!capture_consumers(&mut state, "shared", &observation));
        assert_eq!(state, captured);
    }

    #[test]
    fn every_consumer_captures_before_shared_history_is_compacted() {
        let source = json!({"providerId":"documents","enabledAfter":"2026-11-15T00:00:00Z"});
        let record = json!({"observation_id":"shared","status":"armed","source":source,"after_sequence":0,"initial_sequence":0,"match":{"/version":1}});
        let mut state = json!({"operations":{"first":record,"second":record,"cancelled":record,"pending":record,"other":record,"cloud":record}});
        state["operations"]["cancelled"]["status"] = json!("cancelled");
        state["operations"]["pending"]["status"] = json!("pending");
        state["operations"]["pending"]["events"] = json!([{"id":"original"}]);
        state["operations"]["other"]["observation_id"] = json!("other-source");
        state["operations"]["cloud"]["cloud_subscription"] = json!({"id":"cloud"});
        let protected: Vec<_> = ["cancelled", "pending", "other", "cloud"]
            .iter()
            .map(|id| state["operations"][id].clone())
            .collect();
        let events: Vec<_> = (1..=1001).map(|sequence| json!({"sequence":sequence,"key":format!("key-{sequence}"),"event":{"id":format!("event-{sequence}"),"version":sequence,"at":"2026-11-15T00:00:01Z"}})).collect();
        let mut observation = json!({"sequence":1001,"events":events});
        capture_consumers(&mut state, "shared", &observation);
        observation["events"].as_array_mut().unwrap().remove(0);
        assert_eq!(observation["events"].as_array().unwrap().len(), 1000);
        for id in ["first", "second"] {
            assert_eq!(state["operations"][id]["status"], "pending");
            assert_eq!(state["operations"][id]["events"][0]["id"], "event-1");
            assert_eq!(
                state["operations"][id]["resource_event_keys"],
                json!(["key-1"])
            );
            assert_eq!(state["operations"][id]["after_sequence"], 1001);
        }
        for (id, original) in ["cancelled", "pending", "other", "cloud"]
            .iter()
            .zip(protected)
        {
            assert_eq!(state["operations"][id], original);
        }
        let captured = state.clone();
        capture_consumers(&mut state, "shared", &observation);
        assert_eq!(state, captured);
    }

    #[test]
    fn stale_health_save_cannot_replace_a_captured_batch() {
        use crate::runtime_work::handler::control::tests::EnvGuard;
        let _guard = crate::test_env::lock();
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
        let armed = json!({"status":"armed","task_id":"task","after_sequence":0});
        handler.save_event_subscription("consumer", &armed).unwrap();
        let mut pending = armed.clone();
        pending["status"] = json!("pending");
        pending["events"] = json!([{"id":"captured"}]);
        pending["after_sequence"] = json!(1001);
        handler
            .save_event_subscription("consumer", &pending)
            .unwrap();
        handler.save_event_subscription("consumer", &armed).unwrap();
        let read = || {
            event_store::transact(&handler.event_subscription_path(), |state| {
                Ok(state["operations"]["consumer"].clone())
            })
            .unwrap()
        };
        assert_eq!(read(), pending);
        let mut cancelled = pending;
        cancelled["status"] = json!("cancelled");
        handler
            .save_event_subscription("consumer", &cancelled)
            .unwrap();
        assert!(handler.save_event_subscription("consumer", &armed).is_err());
        assert_eq!(read()["status"], "cancelled");
    }
}
