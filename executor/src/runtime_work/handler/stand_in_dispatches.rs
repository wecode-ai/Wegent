//! Reconcile accepted dispatch intent with current authority and actual local work.
use super::stand_in::settings_error;
use super::*;

fn retryable_dispatch_error(error: &AppIpcError) -> bool {
    matches!(
        error.code.as_str(),
        "cloud_unavailable"
            | "cloud_request_failed"
            | "cloud_response_invalid"
            | "permission_denied"
            | "stand_in_settings"
            | "stand_in_busy"
    )
}

impl RuntimeWorkRpcHandler {
    pub(super) fn queue_stand_in_dispatches(
        &self,
        configs: &[Value],
        issue: &Value,
    ) -> Result<Vec<String>, AppIpcError> {
        let binding = &issue["human_task_binding"];
        // Invalid hints must reach normal assignment validation, not create intent.
        let manual = configs
            .first()
            .is_some_and(|config| config["manual"] == true);
        if !manual
            && (binding["humanAssignmentId"].as_str().is_none()
                || super::stand_in::issue_assignment_event_id(binding).is_err())
        {
            return Ok(Vec::new());
        }
        let matching = if manual {
            configs.iter().collect()
        } else {
            super::personal_stand_in::automatic_assignment_roles(configs, issue)
        };
        let pending: Vec<&Value> = matching
            .into_iter()
            // Admit new work only on its selected device. Existing reservations
            // remain eligible; a rejected repeat cannot replace an older intent.
            .filter(|config| self.stand_in_issue_runs_here(config, issue))
            .filter(|config| {
                let task_id = self.stand_in_task_id(config, issue);
                !self.stand_in_assignment_is_handled(config, &task_id, binding)
            })
            .collect();
        if pending.is_empty() {
            return Ok(Vec::new());
        }
        let backend = self
            .backend_connection_snapshot()?
            .ok_or_else(|| {
                AppIpcError::new("cloud_unavailable", "Cloud connection is unavailable")
            })?
            .backend_url;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        pending
            .into_iter()
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

    pub(super) fn settle_stand_in_dispatches(&self, ids: &[String], error: Option<&AppIpcError>) {
        if ids.is_empty() {
            return;
        }
        let settle = || -> Result<(), AppIpcError> {
            let store =
                LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
            for id in ids {
                match error {
                    // An initial call may fan out. Its first failure does not
                    // describe the other roles, so retain every unresolved intent.
                    Some(error) => {
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
        };
        // Settlement is maintenance of an already durable intent. A temporary
        // failure must neither erase intent nor replace the original dispatch result.
        if let Err(error) = settle() {
            log_executor_event(
                "Stand-in dispatch settlement deferred",
                &[("code", error.code)],
            );
        }
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
            // This attempt owns one intent and can retire a permanent rejection.
            self.settle_stand_in_dispatches(
                &[id],
                result
                    .as_ref()
                    .err()
                    .filter(|error| retryable_dispatch_error(error)),
            );
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
        if intent["manual"] == true && intent["errorCode"] == "wrong_device" {
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
        if intent["manual"] == true {
            let user = intent["userId"].as_i64().unwrap_or_default();
            let role = intent["roleId"].as_str().unwrap_or_default();
            if !crate::task_runtime::personal_stand_in::stand_in_identities(&settings)
                .iter()
                .any(|identity| identity["id"] == role)
            {
                return Ok(());
            }
            let mut config = store
                .stand_in_settings(project, user, role)
                .map_err(settings_error)?;
            config["projectId"] = intent["projectId"].clone();
            config["projectStore"] = json!("cloud");
            config["userId"] = json!(user);
            config["executionDeviceId"] = json!(self.device_id);
            config["manual"] = json!(true);
            config["recoveringDispatch"] = json!(true);
            let issue = self.read_stand_in_issue(store, user, &json!({
                "projectStore":"cloud", "cloudProjectId":project,"loopItemId":intent["issueId"]
            })).await?;
            let gate = self.task_send_gate(&format!(
                "stand-in-issue:{project}:{}",
                intent["issueId"].as_str().unwrap_or_default()
            ));
            let _guard = gate.lock().await;
            return self.start_manual_stand_in_attempt(&config, &issue).await;
        }
        let Some(mut config) = self
            .stand_in_project_configs(&[settings], project, "cloud")
            .into_iter()
            .find(|config| config["id"] == intent["roleId"])
        else {
            return Ok(());
        };
        if config["enabled"] != true {
            return Err(AppIpcError::new(
                "permission_denied",
                "Stand-in dispatch is paused on this device",
            ));
        }
        if config["handlingPolicy"]["automatic"] == false {
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
        let task_id = self.stand_in_task_id(&config, &issue);
        // Once accepted locally, never replay a model turn (including failed or
        // archived work) just because the process crashed before clearing intent.
        if self.stand_in_assignment_is_handled(&config, &task_id, &intent["binding"]) {
            return self
                .reconcile_accepted_stand_in_binding(&config, &issue, &intent["binding"])
                .await;
        }
        config["intakeRouted"] = intent["intakeRouted"].clone();
        // Recheck inside the normal task gate as well: another dispatcher may
        // accept and fail a task between the observation above and gate acquisition.
        config["recoveringDispatch"] = json!(true);
        // The durable intent was admitted here before the role moved. Current
        // ownership and execution permissions are still revalidated above/below.
        config["executionDeviceId"] = json!(self.device_id);
        self.start_cloud_assignment_attempt(&[config], &issue).await
    }
}

#[cfg(test)]
#[path = "stand_in_dispatches_tests.rs"]
mod tests;
