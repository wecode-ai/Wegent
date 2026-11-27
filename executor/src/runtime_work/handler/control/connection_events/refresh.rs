//! Manual refresh requests collection; it never schedules a model continuation.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) async fn refresh_connection_observation(
        &self,
        input: Value,
    ) -> Result<Value, AppIpcError> {
        let (context, key) = self.connection_subscription_ui_context(&input)?;
        let task = context.task_id.as_str();
        let link = self
            .store
            .get_task(task)
            .ok_or_else(|| invalid("Conversation not found"))?;
        self.authorize_control_target(&context, &link).await?;
        let gate = self.task_send_gate(&format!("connection-events:{task}"));
        let _guard = gate.lock().await;
        let id = self.subscription_id(task, &key);
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
        if record["device_id"] != self.device_id
            || record["task_id"] != task
            || !matches!(
                record["status"].as_str(),
                Some("preparing" | "armed" | "pending")
            )
        {
            return Err(invalid("This observation is no longer active"));
        }
        if record["cloud_registration"].is_object() || record["cloud_subscription"].is_object() {
            record["cloud_refresh_pending"] = json!(true);
            record["refresh_pending"] = json!(true);
            self.save_event_subscription(&id, &record)?;
            if record["cloud_subscription"].is_object() {
                self.submit_cloud_observation_refresh(&mut record).await?;
            }
        } else {
            let observation = self
                .read_event_observation(&record, &format!("manual:{}", uuid::Uuid::new_v4()), true)
                .await?;
            record = event_store::read(
                &self.event_subscription_path(),
                event_store::Scope::Row("operations", &id),
                |state| Ok(state["operations"][&id].clone()),
            )?;
            record["last_collected_at"] = observation["last_collected_at"].clone();
            record["resource_states"] = observation["resource_states"].clone();
            if record["error_code"] != "observation_history_gap" {
                record["error_code"] = observation["error_code"].clone();
            }
            record["refresh_pending"] = json!(false);
        }
        self.save_event_subscription(&id, &record)?;
        Ok(json!({"subscription":public_subscription(&record)}))
    }

    fn connection_subscription_ui_context(
        &self,
        input: &Value,
    ) -> Result<(ControlContext, String), AppIpcError> {
        let task = input["taskId"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("Conversation is required"))?;
        let key = input["subscriptionKey"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .ok_or_else(|| invalid("Subscription is required"))?;
        let link = self
            .store
            .get_task(task)
            .filter(|link| link.status != "archived" && !self.archived_link_is_deleted(link))
            .ok_or_else(|| invalid("Conversation not found"))?;
        let mut request = runtime_event_request_from_link(&link);
        crate::runtime_work::api_context::inject_current_session(
            &mut request,
            &self.device_id,
            task,
        );
        let mut context = ControlContext::from_request(&request)
            .ok_or_else(|| invalid("Conversation no longer permits personal control"))?;
        context.use_runtime_backend = true;
        self.validate_control_context(&context)?;
        Ok((context, key.to_owned()))
    }

    pub(in crate::runtime_work::handler) async fn cancel_connection_subscription_from_ui(
        &self,
        input: Value,
    ) -> Result<Value, AppIpcError> {
        let (context, key) = self.connection_subscription_ui_context(&input)?;
        self.control_connection_events(
            &context,
            "cancel_connection_event_subscription",
            json!({"subscription_key":key}),
        )
        .await
    }

    pub(super) async fn submit_cloud_observation_refresh(
        &self,
        record: &mut Value,
    ) -> Result<(), AppIpcError> {
        let response = self.runtime_http(reqwest::Method::POST, "/runtime-observations/command", Some(&json!({
            "action":"refresh","expectedOwnerId":record["cloud_subscription"]["owner_id"],"observationId":record["observation_id"],
        }))).await?;
        if response["ownerId"] != record["cloud_subscription"]["owner_id"]
            || response["observation"]["id"] != record["observation_id"]
        {
            return Err(invalid("Observation owner or source changed"));
        }
        record["cloud_refresh_pending"] = json!(false);
        record["refresh_pending"] = json!(true);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
