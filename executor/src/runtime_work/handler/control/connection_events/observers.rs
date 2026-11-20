//! Read-only UI leases share source facts but never acquire conversation event ownership.
use super::*;
use wegent_protocol::connection_events::{canonical_json, observation_identity};
mod cloud;
mod maintenance;
#[cfg(test)]
mod tests;

const TTL_MS: i64 = 90_000;

fn lease_lost() -> AppIpcError {
    AppIpcError::new(
        "observation_observer_lease_lost",
        "Start a new observation activation",
    )
}

fn field<'a>(input: &'a Value, name: &str) -> Result<&'a str, AppIpcError> {
    input[name]
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.len() <= 16_384)
        .ok_or_else(|| invalid(&format!("{name} is required")))
}

fn observer_id(device: &str, key: &str, generation: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(canonical_json(&json!([
            "observer", device, key, generation
        ])))
    )
}

fn projection(record: &Value) -> Value {
    json!({"observer":{"id":record["id"],"consumerKey":record["consumer_key"],"generation":record["generation"],"source":record["source"],"observationId":record["observation_id"],"expiresAt":record["expires_at"],"stopped":record["status"]=="stopped"},
        "observation":{"id":record["observation_id"],"source":record["source"],"lastCollectedAt":record["last_collected_at"],"resourceStates":record["resource_states"],"errorCode":record["error_code"],"refreshPending":record["refresh_pending"]==true}})
}

impl RuntimeWorkRpcHandler {
    fn read_ui_observer(&self, id: &str) -> Result<Value, AppIpcError> {
        event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("observers", id),
            |state| {
                validate_observer_map(state)?;
                Ok(state["observers"][id].clone())
            },
        )
    }

    fn save_ui_observer(&self, record: &Value) -> Result<(), AppIpcError> {
        let id = field(record, "id")?;
        event_store::update(
            &self.event_subscription_path(),
            event_store::Scope::Row("observers", id),
            |state| {
                validate_observer_map(state)?;
                if state["observers"][id]["status"] == "stopped" && record["status"] != "stopped" {
                    return Err(lease_lost());
                }
                state["observers"][id] = record.clone();
                Ok(())
            },
        )
    }

    pub(in crate::runtime_work::handler) async fn connection_observer_operation(
        &self,
        operation: &str,
        input: Value,
    ) -> Result<Value, AppIpcError> {
        let key = field(&input, "consumerKey")?;
        let generation = field(&input, "generation")?;
        let id = observer_id(&self.device_id, key, generation);
        let gate = self.task_send_gate(&format!("connection-observer:{id}"));
        let _guard = gate.lock().await;
        let mut record = self.read_ui_observer(&id)?;
        if operation == "stop" {
            if record.is_null() {
                record = json!({"id":id,"consumer_key":key,"generation":generation,"device_id":self.device_id});
            }
            record["status"] = json!("stopped");
            record["cloud_stop_pending"] = json!(record["cloud_registration"].is_object());
            self.save_ui_observer(&record)?;
            self.stop_cloud_ui_observer(&mut record).await?;
            self.save_ui_observer(&record)?;
            return Ok(json!({"stopped":true}));
        }
        if record.is_null() {
            if operation != "start" {
                return Err(lease_lost());
            }
            record = self
                .prepare_ui_observer(&id, key, generation, &input)
                .await?;
        } else {
            if record["device_id"] != self.device_id
                || record["consumer_key"] != key
                || record["generation"] != generation
                || record["status"] == "stopped"
                || record["expires_at"].as_i64().unwrap_or_default() <= now_ms()
            {
                return Err(lease_lost());
            }
            if operation == "start" && record["intent"] != observer_intent(&input) {
                return Err(invalid(
                    "Observation activation already belongs to another resource",
                ));
            }
        }
        if record["cloud_registration"].is_object() {
            self.read_cloud_ui_observer(&mut record, operation == "refresh")
                .await?;
        } else {
            let cached = event_store::read(
                &self.event_subscription_path(),
                event_store::Scope::Row("observations", field(&record, "observation_id")?),
                |state| Ok(state["observations"][field(&record, "observation_id")?].clone()),
            )?;
            if !cached.is_object()
                || !cached["source"].is_object()
                || !cached["checkpoint"].is_object()
                || !cached["events"].is_array()
                || cached["sequence"].as_u64().is_none()
                || observation_identity(&cached["source"])
                    != observation_identity(&record["source"])
            {
                return Err(AppIpcError::new(
                    "control_storage_failed",
                    "Invalid observation source journal",
                ));
            }
            let observed = if operation == "refresh"
                || (cached["last_collected_at"].is_null() && cached["error_code"].is_null())
            {
                self.read_event_observation(
                    &json!({"observation_id":record["observation_id"]}),
                    &format!("observer:{}", uuid::Uuid::new_v4()),
                    operation == "refresh",
                )
                .await?
            } else {
                cached
            };
            record["last_collected_at"] = observed["last_collected_at"].clone();
            record["resource_states"] = observed["resource_states"].clone();
            record["error_code"] = observed["error_code"].clone();
            record["refresh_pending"] = json!(false);
        }
        record["status"] = json!("observing");
        record["expires_at"] = json!(now_ms() + TTL_MS);
        self.save_ui_observer(&record)?;
        Ok(projection(&record))
    }

    async fn prepare_ui_observer(
        &self,
        id: &str,
        key: &str,
        generation: &str,
        input: &Value,
    ) -> Result<Value, AppIpcError> {
        let _activation = self.connection_observation_activations.read().await;
        let mut source = if input["source"].is_object() {
            input["source"].clone()
        } else {
            let discovery = &input["discovery"];
            let provider = field(discovery, "providerId")?;
            let resources = self
                .connection_call("listResources", Some(provider), discovery.clone())
                .await?;
            if resources["availability"]["status"] == "auth_required" {
                return Err(AppIpcError::new(
                    "connector_auth_required",
                    "Authorize this connection before observing the resource",
                ));
            }
            let items = resources["items"]
                .as_array()
                .filter(|items| items.len() == 1)
                .ok_or_else(|| invalid("Choose one exact discovered connection resource"))?;
            items[0].clone()
        };
        for name in ["providerId", "profile", "kind", "id", "name"] {
            field(&source, name)?;
        }
        source["enabledAfter"] = json!(chrono::Utc::now().to_rfc3339());
        source["policy"] = json!({"automatic":false,"askBeforeAct":true});
        self.connection_call("validate", source["providerId"].as_str(), source.clone())
            .await?;
        let (observation, _, checkpoint) = self.attach_event_observation(&mut source).await?;
        let mut record = json!({"id":id,"consumer_key":key,"generation":generation,"device_id":self.device_id,"intent":observer_intent(input),"source":source,"observation_id":observation,"initial_checkpoint":checkpoint,"status":"preparing","expires_at":now_ms()+TTL_MS});
        if self.cloud_connection_observations.load(Ordering::Acquire) {
            let connection = self
                .backend_connection_snapshot()?
                .ok_or_else(|| invalid("Connect this Runtime to its cloud account"))?;
            let owner = Self::local_connection_user(&connection)?;
            record["cloud_registration"] = json!({"owner_id":owner,"device_id":self.cloud_device_id()?,"backend_url":connection.backend_url});
        }
        self.save_ui_observer(&record)?;
        Ok(record)
    }
}

fn validate_observer_map(state: &Value) -> Result<(), AppIpcError> {
    if state.get("observers").is_some_and(|value| {
        !value.is_object()
            || value
                .as_object()
                .is_some_and(|rows| rows.values().any(|row| !row.is_object()))
    }) {
        return Err(AppIpcError::new(
            "control_storage_failed",
            "Invalid observation lease journal",
        ));
    }
    Ok(())
}

fn observer_intent(input: &Value) -> Value {
    if input["source"].is_object() {
        json!({"source":observation_identity(&input["source"])})
    } else {
        json!({"discovery":input["discovery"]})
    }
}
