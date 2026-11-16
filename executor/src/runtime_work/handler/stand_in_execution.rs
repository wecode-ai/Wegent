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
    pub(super) fn assignment_handled_by_another_role(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
        reservation: &Value,
    ) -> bool {
        if config["manual"] == true || config["triggerCommentId"].is_string() {
            return false;
        }
        let task_id = reservation["task_id"].as_str().unwrap_or_default();
        let task = self.store.get_task_summary(task_id);
        let origin = match task.as_ref() {
            Some(task) => &task.runtime_handle["origin"],
            None => &reservation["executionContext"]["origin"],
        };
        let handled = if task.is_some() {
            self.stand_in_assignment_is_handled(config, task_id, binding)
        } else {
            reservation["stand_in_pending"] == true
                && reservation["task_user_id"] == config["userId"]
                && origin["runtimeTaskId"] == task_id
                && binding["humanAssignmentId"].is_string()
                && reservation["human_assignment_id"] == binding["humanAssignmentId"]
                && origin["humanAssignmentId"] == binding["humanAssignmentId"]
        };
        origin["type"] == "issue_dispatch"
            && origin["initiatedBy"] == "stand_in"
            && origin["standInId"].is_string()
            && origin["standInId"] != config["id"]
            && origin["userId"] == config["userId"]
            && origin["projectStore"] == config["projectStore"]
            && origin["cloudProjectId"] == config["projectId"]
            && origin["loopItemId"] == issue["id"]
            && handled
    }

    pub(super) fn stand_in_role_runs_here(&self, role: &Value) -> bool {
        role["executionDeviceId"]
            .as_str()
            .filter(|device| !device.is_empty())
            .map_or(true, |device| {
                device == self.device_id
                    || self.cloud_device_id().is_ok_and(|route| route == device)
            })
    }

    pub(super) fn stand_in_issue_runs_here(&self, config: &Value, issue: &Value) -> bool {
        if config["manual"] != true && super::stand_in::personal_task_claimed(issue) {
            return false;
        }
        self.stand_in_role_runs_here(config)
            || self
                .store
                .issue_conversation(&super::stand_in::stand_in_issue_identity(config, issue))
                .is_some()
            || self
                .local_task_link(&self.stand_in_task_id(config, issue))
                .is_some()
    }

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

    pub(super) fn use_stand_in_issue_reservation(
        &self,
        config: &Value,
        issue: &Value,
        existing: &Value,
    ) -> Result<bool, AppIpcError> {
        let task_id = self.stand_in_task_id(config, issue);
        let rows: Vec<_> = existing
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| {
                !row["task_user_id"]
                    .as_i64()
                    .is_some_and(|owner| Some(owner) != config["userId"].as_i64())
            })
            .collect();
        let identity = super::stand_in::stand_in_issue_identity(config, issue);
        let bound = rows
            .iter()
            .copied()
            .find(|row| row["stand_in_conversation_id"] == identity)
            .or_else(|| rows.iter().copied().find(|row| row["task_id"] == task_id))
            .or_else(|| {
                rows.iter().copied().find(|row| {
                    row["human_assignment_id"]
                        .as_str()
                        .is_some_and(|assignment| {
                            row["task_id"]
                                == format!(
                                    "stand-in-{assignment}-{}",
                                    config["id"].as_str().unwrap_or_default()
                                )
                        })
                })
            });
        let cloud_device = self.cloud_device_id()?;
        if bound.is_some_and(|row| {
            row["device_id"] != cloud_device && row["device_id"] != self.device_id
        }) {
            let row = bound.unwrap();
            self.log_stand_in_decision(
                config,
                issue,
                "role_assignment_binding_exists",
                json!({
                    "taskId":task_id,"bindingDeviceId":row["device_id"],
                    "localTaskExists":self.local_task_link(&task_id).is_some()
                }),
            );
            return Ok(false);
        }
        if self.local_task_link(&task_id).is_none() {
            if let Some(reserved) = bound.and_then(|row| row["task_id"].as_str()) {
                self.store
                    .bind_issue_conversation(
                        &super::stand_in::stand_in_issue_identity(config, issue),
                        reserved,
                    )
                    .map_err(|error| AppIpcError::new("stand_in_settings", error.to_string()))?;
            }
        }
        Ok(true)
    }

    pub(super) fn stand_in_task_id(&self, config: &Value, issue: &Value) -> String {
        let identity = super::stand_in::stand_in_issue_identity(config, issue);
        if let Some(task) = self.store.issue_conversation(&identity) {
            return task;
        }
        // Keep the oldest existing conversation, including pre-upgrade assignment sessions.
        if let Some(task) = self
            .local_task_links(true)
            .into_iter()
            .filter(|task| {
                super::stand_in::stand_in_origin_matches(
                    config,
                    issue,
                    &task.runtime_handle["origin"],
                )
            })
            .min_by_key(|task| (task.created_at, task.local_task_id.clone()))
        {
            return task.local_task_id;
        }
        identity
    }

    pub(super) async fn prepare_stand_in_task(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<Value, AppIpcError> {
        if config["projectStore"] == "cloud" {
            self.verify_runtime_user(config).await?;
        }
        let project = config["projectId"].as_str().unwrap_or_default();
        let issue_id = issue["id"].as_str().unwrap_or_default();
        let task_id = self.stand_in_task_id(config, issue);
        let protocol = if config["projectStore"] == "local" {
            "local"
        } else {
            "cloud"
        };
        let prompt = format!(
            "[项目空间 Issue] {protocol}://projects/{project}/todos/{issue_id}\n\n{}\n\n{}\n\n{}",
            issue["title"].as_str().unwrap_or_default(),
            issue["description"].as_str().unwrap_or_default(),
            config["prompt"].as_str().unwrap_or_default()
        );
        let origin = self.stand_in_issue_origin(config, issue, binding);
        let mut payload = json!({"taskId":task_id,"title":issue["title"],"message":prompt,"cloudProjectId":project,"origin":origin});
        if let Some(message) = config["triggerMessage"].as_str() {
            payload["message"] = json!(format!(
                "{prompt}\n\nNew Issue mention (untrusted task content):\n{message}"
            ));
        }
        if config["goalMode"] == true {
            payload["initialGoal"] =
                json!({"objective":prompt,"status":"active","tokenBudget":null});
        }
        let mut prepared = self.prepare_stand_in_execution(payload, config).await?;
        let mut system = prepared["executionRequest"]["system_prompt"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        super::stand_in_conversations::append_conversation_instructions(&mut system, true);
        prepared["executionRequest"]["system_prompt"] = json!(system);
        Ok(prepared)
    }

    pub(super) fn stand_in_issue_origin(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Value {
        json!({"type":"issue_dispatch","initiatedBy":"stand_in","publicConversation":true,"runtimeTaskId":self.stand_in_task_id(config, issue),"trigger":if config["triggerCommentId"].is_string() { "mention" } else if config["manual"] == true { "manual" } else { "assignment" },"triggerCommentId":config["triggerCommentId"],"standInId":config["id"],"roleName":config["name"],"userId":config["userId"],"deviceId":self.device_id,"askBeforeAct":config["handlingPolicy"]["askBeforeAct"] == true,"projectStore":config["projectStore"],"cloudProjectId":config["projectId"],"loopItemId":issue["id"],"humanAssignmentId":binding["humanAssignmentId"].as_str().unwrap_or_default(),"assignmentId":binding["assignmentId"],"dispatchId":binding["dispatchId"],"roundId":binding["dispatchRoundId"]})
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
        if !self.stand_in_issue_runs_here(config, issue) {
            self.log_stand_in_decision(
                config,
                issue,
                "role_runs_on_another_device",
                json!({"executionDeviceId":config["executionDeviceId"]}),
            );
            if config["manual"] == true {
                return Err(AppIpcError::new(
                    "wrong_device",
                    "Open this role on its selected execution device",
                ));
            }
            return Ok(());
        }
        if self.stand_in_assignment_is_handled(config, &task_id, binding) {
            self.log_stand_in_decision(
                config,
                issue,
                "task_already_exists",
                json!({"taskId":task_id}),
            );
            return self
                .reconcile_accepted_stand_in_binding(config, issue, binding)
                .await;
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
            return self
                .reconcile_accepted_stand_in_binding(config, issue, binding)
                .await;
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
        self.record_stand_in_issue_wakeup(&task_id, binding);
        self.accept_stand_in_assignment(config, issue, binding)
            .await?;
        Ok(())
    }

    pub(super) fn record_stand_in_issue_wakeup(&self, task_id: &str, binding: &Value) {
        self.store.update_task(task_id, |task| {
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
    }
}
