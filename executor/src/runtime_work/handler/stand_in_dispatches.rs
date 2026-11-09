//! Reconcile accepted dispatch intent with current authority and actual local work.
use super::stand_in::settings_error;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn queue_stand_in_dispatches(
        &self,
        configs: &[Value],
        issue: &Value,
    ) -> Result<Vec<String>, AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let backend = self
            .backend_connection_snapshot()?
            .map(|connection| connection.backend_url);
        configs
            .iter()
            .filter(|config| {
                let task_id = self.stand_in_task_id(config, &issue["human_task_binding"]);
                self.local_task_link(&task_id).is_none()
                    && !self.store.is_deleted_archived_task_id(&task_id)
            })
            .map(|config| {
                store.queue_stand_in_dispatch(&json!({
            "backendUrl":backend,"deviceId":self.device_id,"userId":config["userId"],
            "projectId":config["projectId"],"issueId":issue["id"],"roleId":config["id"],
            "manual":config["manual"] == true,"intakeRouted":config["intakeRouted"] == true,
            "binding":issue["human_task_binding"]
        })).map_err(settings_error)
            })
            .collect()
    }

    pub(super) fn settle_stand_in_dispatches(
        &self,
        ids: &[String],
        error: Option<&AppIpcError>,
    ) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for id in ids {
            match error {
                Some(error)
                    if matches!(
                        error.code.as_str(),
                        "cloud_unavailable"
                            | "cloud_request_failed"
                            | "cloud_response_invalid"
                            | "permission_denied"
                    ) =>
                {
                    store
                        .defer_stand_in_dispatch(id, &error.code)
                        .map_err(settings_error)?;
                }
                _ => store
                    .complete_stand_in_dispatch(id)
                    .map_err(settings_error)?,
            }
        }
        Ok(())
    }

    pub(super) async fn flush_stand_in_dispatches(&self) -> Result<(), AppIpcError> {
        self.flush_stand_in_dispatches_at(chrono::Utc::now().timestamp())
            .await
    }

    async fn flush_stand_in_dispatches_at(&self, now: i64) -> Result<(), AppIpcError> {
        let gate = self.task_send_gate("stand-in-dispatch-reconciliation");
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for (id, intent) in store
            .pending_stand_in_dispatches()
            .map_err(settings_error)?
        {
            let attempts = intent["retryCount"].as_u64().unwrap_or_default();
            let delay = (5i64 * (1i64 << attempts.saturating_sub(1).min(10))).min(3600);
            if intent["lastAttemptAt"]
                .as_i64()
                .is_some_and(|at| at + delay > now)
            {
                continue;
            }
            let result = self.reconcile_stand_in_dispatch(&store, &intent).await;
            log_executor_event(
                "stand-in dispatch reconciliation",
                &[
                    ("intent_id", id.clone()),
                    (
                        "code",
                        result
                            .as_ref()
                            .err()
                            .map(|error| error.code.clone())
                            .unwrap_or_else(|| "completed".into()),
                    ),
                ],
            );
            self.settle_stand_in_dispatches(&[id], result.as_ref().err())?;
        }
        Ok(())
    }

    async fn reconcile_stand_in_dispatch(
        &self,
        store: &LocalTaskStore,
        intent: &Value,
    ) -> Result<(), AppIpcError> {
        if intent["deviceId"] != self.device_id {
            return Ok(());
        }
        let connection = self.backend_connection_snapshot()?;
        if connection
            .as_ref()
            .map(|connection| connection.backend_url.as_str())
            != intent["backendUrl"].as_str()
        {
            return Err(AppIpcError::new(
                "cloud_unavailable",
                "Dispatch belongs to another backend",
            ));
        }
        self.verify_runtime_user(intent).await?;
        if intent["notification"].is_object() {
            return Box::pin(self.process_stand_in_assignment(intent["notification"].clone()))
                .await;
        }
        let project = intent["projectId"].as_str().unwrap_or_default();
        let settings = store
            .personal_stand_in(
                intent["userId"].as_i64().unwrap_or_default(),
                &self.device_id,
            )
            .map_err(settings_error)?;
        if !settings["lifecycle"]["status"].is_null() {
            return Ok(());
        }
        let Some(mut config) = self
            .stand_in_project_configs(&[settings], project, "cloud")
            .into_iter()
            .find(|config| config["id"] == intent["roleId"])
        else {
            return Ok(());
        };
        if config["enabled"] != true || config["executionDeviceId"] != self.device_id {
            return Err(AppIpcError::new(
                "permission_denied",
                "Stand-in dispatch is paused on this device",
            ));
        }
        if intent["manual"] != true && config["handlingPolicy"]["automatic"] == false {
            return Ok(());
        }
        let issue_id = intent["issueId"].as_str().unwrap_or_default();
        let issue = self
            .runtime_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}"),
                None,
            )
            .await?;
        if issue["cloud_project_id"] != intent["projectId"]
            || issue["assignee_user_id"] != intent["userId"]
            || issue["human_task_binding"] != intent["binding"]
        {
            return Ok(());
        }
        let task_id = self.stand_in_task_id(&config, &intent["binding"]);
        // Once accepted locally, never replay a model turn (including failed or
        // archived work) just because the process crashed before clearing intent.
        if self.local_task_link(&task_id).is_some()
            || self.store.is_deleted_archived_task_id(&task_id)
        {
            return Ok(());
        }
        config["manual"] = intent["manual"].clone();
        config["intakeRouted"] = intent["intakeRouted"].clone();
        // Recheck inside the normal task gate as well: another dispatcher may
        // accept and fail a task between the observation above and gate acquisition.
        config["recoveringDispatch"] = json!(true);
        self.start_cloud_stand_in_attempt(&[config], &issue).await
    }
}

#[cfg(test)]
#[path = "stand_in_dispatches_tests.rs"]
mod tests;
