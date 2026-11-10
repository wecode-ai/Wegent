//! Shared task lifecycle decisions for automatic and explicit Stand-in dispatch.
use super::*;

pub(super) fn accepted_stand_in_result(result: Value) -> Result<Value, AppIpcError> {
    if result["success"] == false || result["accepted"] == false {
        return Err(AppIpcError::new(
            result["code"].as_str().unwrap_or("stand_in_start_failed"),
            result["error"]
                .as_str()
                .unwrap_or("Stand-in execution was not accepted"),
        ));
    }
    Ok(result)
}

impl RuntimeWorkRpcHandler {
    pub(super) fn stand_in_assignment_is_handled(
        &self,
        config: &Value,
        task_id: &str,
        binding: &Value,
    ) -> bool {
        let wake = binding["humanAssignmentId"].as_str().unwrap_or_default();
        let deleted_wakeup = self.store.deleted_issue_wakeup(task_id, wake);
        if deleted_wakeup == Some(true) {
            return true;
        }
        let legacy = format!(
            "stand-in-{}-{}",
            binding["humanAssignmentId"].as_str().unwrap_or_default(),
            config["id"].as_str().unwrap_or_default()
        );
        if self.store.is_deleted_archived_task_id(&legacy) {
            return true;
        }
        let task = self.local_task_link(task_id);
        if self.store.is_deleted_archived_task_id(task_id)
            || task
                .as_ref()
                .is_some_and(|task| self.archived_link_is_deleted(task))
        {
            return deleted_wakeup.is_none();
        }
        let Some(task) = task else { return false };
        if config["manual"] == true
            && config["recoveringDispatch"] != true
            && matches!(task.status.as_str(), "failed" | "archived")
        {
            return false;
        }
        match task.runtime_handle["standInIssueWakeups"].as_array() {
            Some(accepted) => accepted.contains(&binding["humanAssignmentId"]),
            None => {
                task.runtime_handle["origin"]["humanAssignmentId"].is_null()
                    || task.runtime_handle["origin"]["humanAssignmentId"]
                        == binding["humanAssignmentId"]
            }
        }
    }

    pub(super) async fn dispatch_stand_in_task(
        &self,
        payload: Value,
        retry: bool,
    ) -> Result<Value, AppIpcError> {
        // These large futures must not inflate every enclosing stand-in state
        // machine and exhaust Windows worker stacks during nested polling.
        if retry {
            let task_id = runtime_task_id(&payload)
                .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
            if self
                .local_task_link(&task_id)
                .is_some_and(|task| task.status == "archived")
            {
                let restored = Box::pin(self.unarchive_task(json!({"taskId":task_id}))).await?;
                if restored["success"] == false {
                    return Err(AppIpcError::new(
                        "stand_in_start_failed",
                        restored["error"]
                            .as_str()
                            .unwrap_or("Cannot restore Stand-in task"),
                    ));
                }
            }
        }
        Box::pin(self.dispatch_stand_in_conversation(payload, false)).await
    }

    pub(super) async fn execute_stand_in_task(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<(), AppIpcError> {
        let task_id = self.stand_in_task_id(config, issue);
        if self.stand_in_assignment_is_handled(config, &task_id, binding) {
            self.log_stand_in_decision(
                config,
                issue,
                "task_already_exists",
                json!({"taskId":task_id}),
            );
            return Ok(());
        }
        if config["manual"] != true
            && config["intakeRouted"] != true
            && !crate::task_runtime::personal_stand_in::immediate_policy(&config["handlingPolicy"])
        {
            let store = LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(super::stand_in::settings_error)?;
            let user = config["userId"]
                .as_i64()
                .ok_or_else(|| AppIpcError::new("permission_denied", "Missing assignment owner"))?;
            let assignment = if config["projectStore"] == "local" {
                &binding["humanAssignmentId"]
            } else {
                &binding["assignmentId"]
            };
            self.accept_stand_in_assignment(config, issue, binding)
                .await?;
            store.enqueue_stand_in_event(user, json!(["assignment",config["projectStore"],config["projectId"],issue["id"],assignment,config["id"]]), json!({
                "kind":"assignment","roleScoped":true,"roleIds":[config["id"]],
                "projectId":config["projectId"],"projectStore":config["projectStore"],
                "issueId":issue["id"],"assignmentId":assignment,"issue":issue,
                "source":{"providerId":"project","id":config["projectId"],"name":issue["title"]}
            })).map_err(super::stand_in::settings_error)?;
            return Ok(());
        }
        let result = async {
            let payload = self.prepare_stand_in_task(config, issue, binding).await?;
            self.create_stand_in_task(config, issue, binding, payload)
                .await
        }
        .await;
        let reason = if result.is_ok() {
            "dispatch_completed"
        } else {
            "dispatch_failed"
        };
        self.log_stand_in_decision(
            config,
            issue,
            reason,
            json!({"taskId":task_id,"errorCode":result.as_ref().err().map(|error| &error.code)}),
        );
        self.record_stand_in_dispatch(config, &result);
        result
    }
}

#[cfg(test)]
#[path = "stand_in_execution_tests.rs"]
mod tests;

impl RuntimeWorkRpcHandler {
    pub(super) async fn create_stand_in_task(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
        mut payload: Value,
    ) -> Result<(), AppIpcError> {
        let task_id = self.stand_in_task_id(config, issue);
        let gate = self.task_send_gate(&format!("stand-in-start:{task_id}"));
        let _guard = gate.lock().await;
        let existing = self.local_task_link(&task_id);
        if self.stand_in_assignment_is_handled(config, &task_id, binding) {
            self.log_stand_in_decision(
                config,
                issue,
                "task_already_exists",
                json!({"taskId":task_id,"status":existing.as_ref().map(|task| &task.status)}),
            );
            return Ok(());
        }
        if self.store.is_deleted_archived_task_id(&task_id) {
            self.store
                .reopen_deleted_issue_conversation(&task_id)
                .map_err(|error| {
                    AppIpcError::new(
                        if error.kind() == std::io::ErrorKind::WouldBlock {
                            "stand_in_busy"
                        } else {
                            "stand_in_settings"
                        },
                        error.to_string(),
                    )
                })?;
        }
        let retry = existing.is_some();
        self.store
            .bind_issue_conversation(
                &super::stand_in::stand_in_issue_identity(config, issue),
                &task_id,
            )
            .map_err(|error| AppIpcError::new("stand_in_settings", error.to_string()))?;
        if retry && self.is_busy_local_task(&task_id) {
            return Err(AppIpcError::new(
                "stand_in_busy",
                "The previous Issue turn is still running",
            ));
        }
        self.accept_stand_in_assignment(config, issue, binding)
            .await?;
        self.log_stand_in_decision(
            config,
            issue,
            "task_binding_created",
            json!({"taskId":task_id,"retry":retry}),
        );
        use sha2::{Digest, Sha256};
        let explicit_retry = config["manual"] == true
            && existing
                .as_ref()
                .is_some_and(|task| matches!(task.status.as_str(), "failed" | "archived"));
        if !explicit_retry {
            payload["commandId"] = json!(format!(
                "stand-in-wake:{:x}",
                Sha256::digest(
                    json!([task_id, binding["humanAssignmentId"]])
                        .to_string()
                        .as_bytes()
                )
            ));
        }
        if let Some(existing) = &existing {
            let origin = payload["origin"].clone();
            self.store.update_task(&task_id, |task| {
                if !task.runtime_handle["standInIssueWakeups"].is_array() {
                    task.runtime_handle["standInIssueWakeups"] =
                        json!([existing.runtime_handle["origin"]["humanAssignmentId"]]);
                }
                task.runtime_handle["origin"] = origin.clone();
                task.runtime_handle["executionRequest"]["origin"] = origin;
            });
        }
        if config["manual"] != true {
            payload["automaticStandIn"] = json!(true);
        }
        // A binding reserves ownership, not completion. Keep it on failure so
        // reconciliation can resume the same task without a compensating DELETE.
        self.dispatch_stand_in_task(payload, retry).await?;
        self.store.update_task(&task_id, |task| {
            if !task.runtime_handle["standInIssueWakeups"].is_array() {
                task.runtime_handle["standInIssueWakeups"] = json!([]);
            }
            let accepted = task.runtime_handle["standInIssueWakeups"]
                .as_array_mut()
                .unwrap();
            if !accepted.contains(&binding["humanAssignmentId"]) {
                accepted.push(binding["humanAssignmentId"].clone());
            }
        });
        Ok(())
    }
}
