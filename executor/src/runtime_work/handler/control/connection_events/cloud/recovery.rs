//! Rebuild only subscription facts; current task authority still gates execution.
use super::*;
use wegent_protocol::connection_events::matches_subscription_request;

fn recovered_record(
    snapshot: &Value,
    device: &str,
    cloud_device: &str,
) -> Result<Value, AppIpcError> {
    let subscription = &snapshot["subscription"];
    let intent = &subscription["intent"];
    let target = &intent["target"];
    let key = subscription["subscriptionKey"]
        .as_str()
        .filter(|key| !key.is_empty() && key.len() <= 256)
        .ok_or_else(delivery_error)?;
    let task = target["taskId"]
        .as_str()
        .filter(|task| !task.is_empty())
        .ok_or_else(delivery_error)?;
    let cloud_id = format!(
        "{:x}",
        Sha256::digest(canonical_json(&json!([cloud_device, task, key])))
    );
    if snapshot["ownerId"].as_i64().is_none_or(|owner| owner <= 0)
        || target["deviceId"] != cloud_device
        || subscription["id"] != cloud_id
        || observation_identity(&subscription["activation"]) != intent["source"]
        || validate_filter(&intent["match"]).is_err()
        || !matches_subscription_request(
            &subscription["requestIntent"],
            intent,
            &subscription["waitForEvent"],
        )
        || !matches!(
            subscription["status"].as_str(),
            Some("armed" | "pending" | "delivered" | "cancelled")
        )
        || subscription["afterSequence"].as_u64().is_none()
    {
        return Err(delivery_error());
    }
    Ok(
        json!({"subscription_key":key,"task_id":task,"device_id":device,"session":target["session"],
        "intent":subscription["requestIntent"],"source":subscription["activation"],
        "match":intent["match"],"continuation":intent["continuation"],
        "wait_for_event":subscription["waitForEvent"],"waiting_goal":intent["goalIdentity"],
        "observation_id":subscription["observationId"],"after_sequence":subscription["afterSequence"],
        "initial_sequence":subscription["afterSequence"],
        "status":if subscription["status"]=="pending" {"armed"} else {subscription["status"].as_str().unwrap()},
        "cloud_subscription":{"id":cloud_id,"owner_id":snapshot["ownerId"],"intent":intent}}),
    )
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn recover_cloud_subscription(
        &self,
        snapshot: &Value,
        signal: &Value,
    ) -> Result<(String, Value), AppIpcError> {
        if !self.cloud_connection_observations.load(Ordering::Acquire) {
            return Err(delivery_error());
        }
        let record = recovered_record(snapshot, &self.device_id, &self.cloud_device_id()?)?;
        let task = record["task_id"].as_str().ok_or_else(delivery_error)?;
        let link = self
            .store
            .get_task(task)
            .filter(|link| link.status != "archived" && !self.archived_link_is_deleted(link))
            .ok_or_else(delivery_error)?;
        session::validate(&record, &link)?;
        let mut request = runtime_event_request_from_link(&link);
        crate::runtime_work::api_context::inject_current_session(
            &mut request,
            &self.device_id,
            task,
        );
        let context = ControlContext::from_request(&request).ok_or_else(delivery_error)?;
        self.validate_control_context(&context)?;
        self.authorize_control_target(&context, &link).await?;
        self.verify_runtime_user(&json!({"userId":snapshot["ownerId"]}))
            .await?;
        let id = self.subscription_id(task, record["subscription_key"].as_str().unwrap());
        let record = merge_snapshot(&record, snapshot, signal, now_ms())?;
        Ok((id, record))
    }

    pub(super) fn guard_cloud_admission(
        &self,
        id: &str,
        record: &mut Value,
        snapshot: &Value,
    ) -> Result<(), AppIpcError> {
        if snapshot["delivery"]["admission"].is_object()
            && snapshot["subscription"]["status"] == "pending"
            && matches!(record["status"].as_str(), Some("armed" | "pending"))
        {
            let task = record["task_id"].as_str().ok_or_else(delivery_error)?;
            let operation = format!(
                "op_{:x}",
                Sha256::digest(format!("{}\0{task}\0connection-event:{id}", self.device_id))
            );
            if snapshot["delivery"]["admission"]["operationId"] != operation {
                return Err(delivery_error());
            }
            let receipt = workbench_control::journal::transact(
                &self
                    .store
                    .index_path()
                    .with_file_name("control-operations.json"),
                |state| Ok(state["operations"][&operation].clone()),
            )?;
            if receipt["operation_id"] != operation
                || receipt["device_id"] != self.device_id
                || receipt["task_id"] != task
            {
                // Admission may precede a lost native acceptance. Never guess that it did not execute.
                record["status"] = json!("needs_attention");
                record["error_code"] = json!("command_recovery_required");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
