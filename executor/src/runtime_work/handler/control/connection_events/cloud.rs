//! Backend notifications carry identifiers; canonical facts are fetched with runtime auth.
use super::*;
use wegent_protocol::connection_events::{
    canonical_json, event_identity, matches_activation, observation_identity,
};
mod recovery;

fn event_time(value: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn delivery_error() -> AppIpcError {
    AppIpcError::new(
        "cloud_event_delivery_invalid",
        "Cloud event delivery no longer matches the armed conversation",
    )
}

fn registration_input(record: &Value, action: &str) -> Value {
    let registration = &record["cloud_registration"];
    // Never send runtime execution profiles, model arguments or credentials.
    json!({"action":action,"expectedOwnerId":registration["owner_id"],"initialCheckpoint":registration["initial_checkpoint"],"subscription":{
        "subscription_key":record["subscription_key"],"device_id":registration["device_id"],"task_id":record["task_id"],"session":record["session"],"source":record["source"],"match":record["match"],"continuation":record["continuation"],"wait_for_event":record["wait_for_event"].as_bool().unwrap_or(false),"waiting_goal":record["waiting_goal"],"request_intent":record["intent"]}})
}

fn merge_snapshot(
    record: &Value,
    snapshot: &Value,
    signal: &Value,
    now: i64,
) -> Result<Value, AppIpcError> {
    let cloud = &record["cloud_subscription"];
    let subscription = &snapshot["subscription"];
    if !cloud.is_object()
        || cloud["owner_id"].as_i64().map_or(true, |owner| owner <= 0)
        || snapshot["ownerId"] != cloud["owner_id"]
        || subscription["id"] != cloud["id"]
        || subscription["intent"] != cloud["intent"]
        || subscription["activation"] != record["source"]
        || signal["subscriptionId"] != cloud["id"]
        || cloud["intent"]["source"] != observation_identity(&record["source"])
        || cloud["intent"]["target"]["taskId"] != record["task_id"]
        || cloud["intent"]["target"]["session"] != record["session"]
        || cloud["intent"]["match"] != record["match"]
        || cloud["intent"]["continuation"] != record["continuation"]
        || cloud["intent"]["goalIdentity"] != record["waiting_goal"]
    {
        return Err(delivery_error());
    }
    let mut next = record.clone();
    if matches!(
        record["status"].as_str(),
        Some("cancelled" | "delivered" | "resuming_goal")
    ) {
        return Ok(next);
    }
    if subscription["status"] == "cancelled" {
        next["status"] = json!("cancelled");
        return Ok(next);
    }
    if record["status"] == "needs_attention" {
        return Ok(next);
    }
    next["last_collected_at"] = snapshot["observation"]["lastCollectedAt"].clone();
    next["resource_states"] = snapshot["observation"]["resourceStates"].clone();
    next["error_code"] = snapshot["observation"]["errorCode"].clone();
    next["refresh_pending"] = json!(
        record["cloud_refresh_pending"] == true
            || snapshot["observation"]["refreshPending"] == true
    );
    if signal["deliveryId"].is_null() {
        return Ok(next);
    }
    let delivery = &snapshot["delivery"];
    if subscription["status"] != "pending"
        || subscription["deliveryId"] != delivery["id"]
        || delivery["id"] != signal["deliveryId"]
        || delivery["subscriptionId"] != cloud["id"]
        || delivery["intent"] != cloud["intent"]
        || delivery["source"] != record["source"]
        || delivery["status"] != "pending"
        || delivery["lease"]["id"].as_str().map_or(true, str::is_empty)
        || delivery["lease"]["id"] != signal["leaseId"]
        || delivery["lease"]["expiresAt"].as_i64().unwrap_or_default() <= now
    {
        return Err(delivery_error());
    }
    let events = delivery["events"]
        .as_array()
        .filter(|events| !events.is_empty() && events.len() <= 1000)
        .ok_or_else(delivery_error)?;
    let keys = delivery["eventKeys"]
        .as_array()
        .filter(|keys| keys.len() == events.len())
        .ok_or_else(delivery_error)?;
    let mut seen = HashSet::new();
    for (event, key) in events.iter().zip(keys) {
        let expected = format!(
            "{:x}",
            Sha256::digest(canonical_json(&event_identity(&record["source"], event)))
        );
        if key.as_str() != Some(expected.as_str())
            || !seen.insert(expected)
            || !matches_activation(&record["source"], event, event_time)
            || !matches_event(&record["match"], event)
        {
            return Err(delivery_error());
        }
    }
    if record["cloud_delivery_id"].is_string()
        && (record["cloud_delivery_id"] != delivery["id"]
            || record["events"] != delivery["events"]
            || record["resource_event_keys"] != delivery["eventKeys"])
    {
        return Err(delivery_error());
    }
    // Goal preparation is owned by the existing local recovery path.
    if record["status"] != "preparing" {
        next["cloud_delivery_id"] = delivery["id"].clone();
        next["cloud_delivery_lease"] = delivery["lease"]["id"].clone();
        next["events"] = delivery["events"].clone();
        next["resource_event_keys"] = delivery["eventKeys"].clone();
        next["observed_events"] = json!(events.len());
        next["status"] = json!("pending");
    }
    Ok(next)
}

impl RuntimeWorkRpcHandler {
    fn cloud_subscription_record(
        &self,
        cloud_id: &str,
    ) -> Result<Option<(String, Value)>, AppIpcError> {
        event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Cloud(cloud_id),
            |state| {
                Ok(state["operations"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .find(|(_, record)| {
                        record["cloud_subscription"]["id"] == cloud_id
                            || record["cloud_registration"]["subscription_id"] == cloud_id
                    })
                    .map(|(id, record)| (id.clone(), record.clone())))
            },
        )
    }

    async fn cloud_subscription_snapshot(&self, cloud_id: &str) -> Result<Value, AppIpcError> {
        let snapshot = self
            .runtime_http(
                reqwest::Method::POST,
                "/runtime-observations/command",
                Some(&json!({"action":"get_subscription","subscriptionId":cloud_id})),
            )
            .await?;
        if snapshot["subscription"]["id"] != cloud_id {
            return Err(delivery_error());
        }
        Ok(snapshot)
    }

    pub(in crate::runtime_work::handler) async fn collect_cloud_connection_observation(
        &self,
        signal: Value,
    ) -> Result<Value, AppIpcError> {
        let owner = signal["expectedOwnerId"]
            .as_i64()
            .filter(|owner| *owner > 0)
            .ok_or_else(delivery_error)?;
        let token = signal["collectorToken"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 16_384)
            .ok_or_else(delivery_error)?;
        let connection = self
            .backend_connection_snapshot()?
            .filter(|value| !value.backend_url.is_empty())
            .ok_or_else(|| {
                AppIpcError::new(
                    "cloud_unavailable",
                    "Connect this Runtime to the source account",
                )
            })?;
        self.verify_runtime_user(&json!({"userId":owner})).await?;
        if self.backend_connection_snapshot()?.as_ref() != Some(&connection) {
            return Err(delivery_error());
        }
        self.connection_call(
            "collectCloudObservation",
            None,
            json!({"backendUrl":connection.backend_url,"collectorToken":token,"expectedOwnerId":owner}),
        )
        .await
    }

    pub(super) async fn register_cloud_connection_subscription(
        &self,
        id: &str,
        record: &mut Value,
    ) -> Result<(), AppIpcError> {
        let registration = &record["cloud_registration"];
        let target = &registration["device_id"];
        if *target != self.cloud_device_id()? {
            return Err(delivery_error());
        }
        let intent = json!({"source":observation_identity(&record["source"]),"target":{"deviceId":target,"taskId":record["task_id"],"session":record["session"]},"match":record["match"],"continuation":record["continuation"],"goalIdentity":record["waiting_goal"]});
        let response = self
            .runtime_http(
                reqwest::Method::POST,
                "/runtime-observations/command",
                Some(&registration_input(record, "attach")),
            )
            .await?;
        let attached = &response["subscription"];
        if response["ownerId"] != registration["owner_id"]
            || response["subscriptionId"] != registration["subscription_id"]
            || attached["id"] != registration["subscription_id"]
            || attached["intent"] != intent
            || attached["activation"] != record["source"]
            || !matches!(
                attached["status"].as_str(),
                Some("armed" | "pending" | "cancelled")
            )
        {
            return Err(delivery_error());
        }
        record["cloud_subscription"] =
            json!({"id":attached["id"],"owner_id":response["ownerId"],"intent":intent});
        if attached["status"] == "cancelled" {
            record["status"] = json!("cancelled");
        }
        self.save_event_subscription(id, record)
    }

    pub(super) async fn finish_cloud_connection_cancellation(
        &self,
        id: &str,
        record: &mut Value,
    ) -> Result<(), AppIpcError> {
        let registration = &record["cloud_registration"];
        let cloud = &record["cloud_subscription"];
        if !registration.is_object() && !cloud.is_object() {
            return Ok(());
        }
        let input = if registration.is_object() {
            registration_input(record, "cancel_registration")
        } else {
            json!({"action":"cancel","expectedOwnerId":cloud["owner_id"],"subscriptionId":cloud["id"]})
        };
        let owner = input["expectedOwnerId"].clone();
        let subscription_id = if registration.is_object() {
            registration["subscription_id"].clone()
        } else {
            cloud["id"].clone()
        };
        // Atomically retain the cancelled intent even if attach has not arrived yet.
        let response = self
            .runtime_http(
                reqwest::Method::POST,
                "/runtime-observations/command",
                Some(&input),
            )
            .await?;
        if response["ownerId"] != owner
            || response["subscription"]["status"] != "cancelled"
            || response["subscription"]["id"] != subscription_id
        {
            return Err(delivery_error());
        }
        self.runtime_http(reqwest::Method::POST, "/runtime-observations/command", Some(&json!({"action":"ack_projection","expectedOwnerId":owner,"subscriptionId":subscription_id}))).await?;
        record["cloud_cancel_acknowledged"] = json!(true);
        record["cloud_cancel_pending"] = json!(false);
        self.save_event_subscription(id, record)
    }

    pub(super) async fn admit_cloud_connection_delivery(
        &self,
        id: &str,
        record: &Value,
    ) -> Result<(), AppIpcError> {
        if record["cloud_subscription"].is_null() {
            return Ok(());
        }
        let task = record["task_id"].as_str().ok_or_else(delivery_error)?;
        let request_key = format!("connection-event:{id}");
        let operation = format!(
            "op_{:x}",
            Sha256::digest(format!("{}\0{task}\0{request_key}", self.device_id))
        );
        let response = self.runtime_http(reqwest::Method::POST, "/runtime-observations/command", Some(&json!({
            "action":"admit_delivery","expectedOwnerId":record["cloud_subscription"]["owner_id"],"subscriptionId":record["cloud_subscription"]["id"],
            "deliveryId":record["cloud_delivery_id"],"leaseId":record["cloud_delivery_lease"],
            "deviceId":self.cloud_device_id()?,"taskId":task,"operationId":operation,
        }))).await?;
        if response["ownerId"] != record["cloud_subscription"]["owner_id"]
            || response["admitted"] != true
            || response["admission"]["operationId"] != operation
        {
            return Err(delivery_error());
        }
        Ok(())
    }

    pub(in crate::runtime_work::handler) async fn sync_cloud_connection_subscription(
        &self,
        signal: Value,
    ) -> Result<Value, AppIpcError> {
        let rejected = |stage: &str, error: AppIpcError| {
            log_executor_event(
                "Cloud event subscription sync rejected",
                &[("stage", stage.to_owned()), ("code", error.code.clone())],
            );
            error
        };
        let cloud_id = signal["subscriptionId"]
            .as_str()
            .filter(|id| id.len() == 64)
            .ok_or_else(delivery_error)?;
        let initial = self.cloud_subscription_record(cloud_id)?;
        let prefetched = if initial.is_none() {
            Some(
                self.cloud_subscription_snapshot(cloud_id)
                    .await
                    .map_err(|error| rejected("snapshot", error))?,
            )
        } else {
            None
        };
        let task = initial
            .as_ref()
            .map(|(_, record)| &record["task_id"])
            .or_else(|| {
                prefetched
                    .as_ref()
                    .map(|snapshot| &snapshot["subscription"]["intent"]["target"]["taskId"])
            })
            .and_then(Value::as_str)
            .ok_or_else(delivery_error)?
            .to_owned();
        let gate = self.task_send_gate(&format!("connection-events:{task}"));
        let _guard = gate.lock().await;
        let found = self.cloud_subscription_record(cloud_id)?;
        if let Some((id, record)) = &found {
            if record["device_id"] == self.device_id
                && record["status"] == "cancelled"
                && record["cloud_subscription"].is_null()
            {
                self.finish_cloud_connection_cancellation(id, &mut record.clone())
                    .await?;
                return Ok(json!({"accepted":false,"status":"cancelled"}));
            }
        }
        let snapshot = match prefetched {
            Some(snapshot) => snapshot,
            None => self
                .cloud_subscription_snapshot(cloud_id)
                .await
                .map_err(|error| rejected("snapshot", error))?,
        };
        if snapshot["subscription"]["intent"]["target"]["taskId"] != task {
            return Err(rejected("identity", delivery_error()));
        }
        let (id, record) = match found {
            Some(found) => found,
            None => self
                .recover_cloud_subscription(&snapshot, &signal)
                .await
                .map_err(|error| rejected("recover", error))?,
        };
        if record["device_id"] != self.device_id
            || record["cloud_subscription"]["intent"]["target"]["deviceId"]
                != self.cloud_device_id()?
        {
            return Err(rejected("identity", delivery_error()));
        }
        let mut record = merge_snapshot(&record, &snapshot, &signal, now_ms())
            .map_err(|error| rejected("merge", error))?;
        self.guard_cloud_admission(&id, &mut record, &snapshot)
            .map_err(|error| rejected("admission", error))?;
        self.save_event_subscription(&id, &record)?;
        if record["status"] == "cancelled" {
            self.remove_queued_event_continuation(&record).await?;
        }
        if record["status"] == "cancelled" && snapshot["subscription"]["status"] != "cancelled" {
            self.finish_cloud_connection_cancellation(&id, &mut record)
                .await?;
        }
        if snapshot["subscription"]["status"] == "cancelled" {
            self.runtime_http(
                reqwest::Method::POST,
                "/runtime-observations/command",
                Some(&json!({"action":"ack_projection","expectedOwnerId":record["cloud_subscription"]["owner_id"],"subscriptionId":cloud_id})),
            )
            .await?;
            record["cloud_cancel_acknowledged"] = json!(true);
            record["cloud_cancel_pending"] = json!(false);
            self.save_event_subscription(&id, &record)?;
        }
        if !signal["deliveryId"].is_null()
            && matches!(record["status"].as_str(), Some("pending" | "resuming_goal"))
        {
            self.collect_conversation_subscription(&id, record).await?;
        }
        let record = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Row("operations", &id),
            |state| Ok(state["operations"][&id].clone()),
        )?;
        let accepted = record["cloud_delivery_id"] == signal["deliveryId"]
            && record["cloud_delivery_id"].is_string()
            && matches!(
                record["status"].as_str(),
                Some("delivered" | "resuming_goal")
            )
            && record["operation_id"].is_string();
        log_executor_event(
            "Cloud event subscription sync finished",
            &[
                (
                    "status",
                    record["status"].as_str().unwrap_or("unknown").to_owned(),
                ),
                (
                    "delivery_present",
                    signal["deliveryId"].is_string().to_string(),
                ),
                ("accepted", accepted.to_string()),
            ],
        );
        Ok(
            json!({"accepted":accepted,"operationId":record["operation_id"],"status":record["status"]}),
        )
    }
}

#[cfg(test)]
mod tests;
