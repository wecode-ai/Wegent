use super::*;
use futures_util::{stream, StreamExt};

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) async fn poll_ui_observer_sources(
        &self,
    ) -> Result<(), AppIpcError> {
        let sources = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Active,
            |state| {
                validate_observer_map(state)?;
                Ok(state["observers"]
                    .as_object()
                    .into_iter()
                    .flat_map(|rows| rows.values())
                    .filter(|row| {
                        row["status"] == "observing"
                            && row["cloud_registration"].is_null()
                            && row["expires_at"].as_i64().unwrap_or_default() > now_ms()
                    })
                    .filter_map(|row| row["observation_id"].as_str().map(str::to_owned))
                    .filter(|id| {
                        state["observations"][id]["next_poll_at"]
                            .as_i64()
                            .unwrap_or_default()
                            <= now_ms()
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
                log_executor_event("UI observation source deferred", &[("code", error.code)]);
            }
        }
        Ok(())
    }

    pub(in crate::runtime_work::handler) async fn poll_ui_observers(
        &self,
    ) -> Result<(), AppIpcError> {
        let candidate = event_store::update(
            &self.event_subscription_path(),
            event_store::Scope::Observers,
            |state| {
                validate_observer_map(state)?;
                let Some(rows) = state.get_mut("observers").and_then(Value::as_object_mut) else {
                    return Ok(None);
                };
                for record in rows.values_mut().filter(|row| {
                    row["status"] != "stopped"
                        && row["expires_at"].as_i64().unwrap_or_default() <= now_ms()
                }) {
                    record["status"] = json!("stopped");
                    record["cloud_stop_pending"] = json!(record["cloud_registration"].is_object());
                }
                Ok(rows
                    .iter()
                    .filter(|(_, record)| record["cloud_stop_pending"] == true)
                    .min_by_key(|(_, record)| {
                        record["last_stop_attempt"].as_i64().unwrap_or_default()
                    })
                    .map(|(id, _)| id.clone()))
            },
        )?;
        self.reclaim_event_observations()?;
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
