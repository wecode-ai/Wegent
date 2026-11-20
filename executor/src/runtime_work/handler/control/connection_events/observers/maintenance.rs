use super::*;

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) async fn poll_ui_observers(
        &self,
    ) -> Result<(), AppIpcError> {
        event_store::update(
            &self.event_subscription_path(),
            event_store::Scope::Observers,
            |state| {
                validate_observer_map(state)?;
                let Some(rows) = state.get_mut("observers").and_then(Value::as_object_mut) else {
                    return Ok(());
                };
                for record in rows.values_mut().filter(|row| {
                    row["status"] != "stopped"
                        && row["expires_at"].as_i64().unwrap_or_default() <= now_ms()
                }) {
                    record["status"] = json!("stopped");
                    record["cloud_stop_pending"] = json!(record["cloud_registration"].is_object());
                }
                Ok(())
            },
        )?;
        if let Err(error) = self.reclaim_event_observations() {
            log_executor_event("Observation reclamation deferred", &[("code", error.code)]);
        }
        let candidate = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::PendingStops,
            |state| {
                Ok(state["observers"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .next()
                    .cloned())
            },
        )?;
        let Some(id) = candidate else {
            return Ok(());
        };
        // One bounded request per tick keeps failed cleanup from starving collection.
        let gate = self.task_send_gate(&format!("connection-observer:{id}"));
        let _guard = gate.lock().await;
        let mut record = self.read_ui_observer(&id)?;
        if record["cloud_stop_pending"] != true {
            return Ok(());
        }
        record["last_stop_attempt"] = json!(now_ms());
        self.save_ui_observer(&record)?;
        self.stop_cloud_ui_observer(&mut record).await?;
        self.save_ui_observer(&record)
    }
}
