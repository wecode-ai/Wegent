//! Explicit child requests reuse the default assistant's consent and Runtime queue.
use super::*;

fn request_path(project: &str, issue: &str) -> String {
    format!("/v1/cloud-projects/{project}/loop-items/{issue}/assistant-requests")
}

fn executable(request: &Value) -> bool {
    matches!(
        request["state"].as_str(),
        Some(
            "accepted"
                | "queued"
                | "waiting_device"
                | "waiting_runtime"
                | "claimed"
                | "running"
                | "waiting_user"
        )
    )
}

fn request_identity(request: &Value, user: i64, device: &str, local: &str) -> bool {
    let Some(id) = request["requestId"].as_str().filter(|id| !id.is_empty()) else {
        return false;
    };
    request["ownerUserId"] == user
        && (request["deviceId"] == device || request["deviceId"] == local)
        && request["runtimeTaskId"] == format!("assistant-request-{id}")
        && request["conversationId"] == request["runtimeTaskId"]
        && request["executionId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
}

fn identity_diagnostic(request: &Value, user: i64, device: &str, local: &str) -> Value {
    let identifier = |value: &Value| {
        value
            .as_str()
            .filter(|value| {
                value.len() <= 128
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:@".contains(&byte))
            })
            .map_or(Value::Null, |value| json!(value))
    };
    let mut fields = serde_json::Map::new();
    for field in [
        "requestId",
        "deviceId",
        "runtimeTaskId",
        "conversationId",
        "executionId",
        "state",
    ] {
        fields.insert(field.into(), identifier(&request[field]));
    }
    fields.insert("ownerUserId".into(), json!(request["ownerUserId"].as_i64()));
    json!({"request":fields,"expectedOwnerUserId":user,
        "backendDeviceId":identifier(&json!(device)),"localDeviceId":identifier(&json!(local))})
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn recover_issue_assistant_requests(
        &self,
        config: &Value,
        issue: &Value,
    ) -> Result<(), AppIpcError> {
        if config["id"] != "@primary" {
            return Ok(());
        }
        let project = config["projectId"].as_str().unwrap_or_default();
        let issue_id = issue["id"].as_str().unwrap_or_default();
        let page = self
            .runtime_http(reqwest::Method::GET, &request_path(project, issue_id), None)
            .await?;
        for request in page["requests"].as_array().into_iter().flatten() {
            if let Err(error) = self
                .recover_issue_assistant_request(config, issue, request)
                .await
            {
                log_executor_event(
                    "Assistant child request recovery failed",
                    &[
                        ("request_id", request["requestId"].to_string()),
                        ("code", error.code),
                        ("error", error.message),
                    ],
                );
            }
        }
        Ok(())
    }

    async fn recover_issue_assistant_request(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
    ) -> Result<(), AppIpcError> {
        let user = config["userId"].as_i64().ok_or_else(|| {
            AppIpcError::new("permission_denied", "Missing assistant request owner")
        })?;
        let device = self.cloud_device_id()?;
        if !request_identity(request, user, &device, &self.device_id) {
            log_executor_event(
                "Assistant child request identity did not match this Runtime",
                &[(
                    "identity",
                    identity_diagnostic(request, user, &device, &self.device_id).to_string(),
                )],
            );
            return Ok(());
        }
        let task = request["runtimeTaskId"].as_str().unwrap();
        let gate = self.task_send_gate(&format!("assistant-request:{task}"));
        let _guard = gate.lock().await;
        if matches!(
            request["state"].as_str(),
            Some("cancelling" | "cancel_requested" | "cancelled")
        ) {
            if self.is_busy_local_task(task) {
                self.cancel_task(json!({"taskId":task})).await?;
            }
            self.report_running_request_worktree(config, issue, request)
                .await?;
            return Ok(());
        }
        if !executable(request) {
            self.reconcile_assistant_request_merge(config, issue, request)
                .await?;
            return Ok(());
        }
        self.validate_async_request_consent(config, issue).await?;
        if let Err(error) = self
            .start_issue_assistant_request(config, issue, request)
            .await
        {
            if !matches!(
                error.code.as_str(),
                "cloud_request_failed"
                    | "cloud_unavailable"
                    | "stale_context"
                    | "assistant_request_busy"
            ) {
                self.report_assistant_execution_failure(
                    config,
                    request["executionId"].as_str().unwrap(),
                    &error,
                )
                .await;
            }
            return Err(error);
        }
        self.report_running_request_worktree(config, issue, request)
            .await?;
        for command in request["commands"].as_array().into_iter().flatten() {
            if command["acknowledged"] != true
                && command["action"] == "followup"
                && command["executionId"] == request["executionId"]
            {
                self.continue_issue_assistant_request(config, issue, request, command)
                    .await?;
            }
        }
        Ok(())
    }

    async fn report_running_request_worktree(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
    ) -> Result<(), AppIpcError> {
        let task = request["runtimeTaskId"].as_str().unwrap();
        let Some(link) = self.local_task_link(task).filter(|link| {
            link.runtime_handle["executionRequest"]["workspace_source"] == "git_worktree"
                && Path::new(&link.workspace_path).is_dir()
        }) else {
            return Ok(());
        };
        let owner = crate::runtime_work::worktrees::RequestWorktreeOwner::from_origin(
            Some(&link.runtime_handle["origin"]),
            task,
            &self.device_id,
        )
        .map_err(|error| AppIpcError::new("worktree_request_invalid", error))?
        .ok_or_else(|| {
            AppIpcError::new("worktree_request_invalid", "Missing request worktree owner")
        })?;
        let manager = self.worktrees.clone();
        let path = PathBuf::from(&link.workspace_path);
        let record = tokio::task::spawn_blocking(move || manager.request_worktree(&path, &owner))
            .await
            .map_err(|error| AppIpcError::new("worktree_request_invalid", error.to_string()))?
            .map_err(|error| AppIpcError::new("worktree_request_invalid", error))?;
        let value = json!(record);
        if link.runtime_handle["assistantWorktreeReported"] != value {
            self.report_assistant_request_event(config, issue, request, None, Some(value.clone()))
                .await?;
            self.store.update_task(task, |link| {
                link.runtime_handle["assistantWorktreeReported"] = value;
            });
        }
        Ok(())
    }

    async fn report_assistant_request_event(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
        command: Option<&str>,
        worktree: Option<Value>,
    ) -> Result<(), AppIpcError> {
        self.report_assistant_request_outcome(config, issue, request, command, worktree, None)
            .await
    }

    async fn report_assistant_request_outcome(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
        command: Option<&str>,
        worktree: Option<Value>,
        command_error: Option<&str>,
    ) -> Result<(), AppIpcError> {
        let body = json!({"deviceId":self.cloud_device_id()?,
            "runtimeTaskId":request["runtimeTaskId"],"executionId":request["executionId"],
            "commandId":command,"worktree":worktree,"commandError":command_error});
        self.runtime_http(
            reqwest::Method::POST,
            &format!(
                "{}/{}/events",
                request_path(
                    config["projectId"].as_str().unwrap(),
                    issue["id"].as_str().unwrap()
                ),
                request["requestId"].as_str().unwrap()
            ),
            Some(&body),
        )
        .await?;
        Ok(())
    }

    async fn reconcile_assistant_request_merge(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
    ) -> Result<(), AppIpcError> {
        let task = request["runtimeTaskId"].as_str().unwrap();
        let Some(link) = self.local_task_link(task).filter(|link| {
            link.runtime_handle["origin"]["assistantRequestId"] == request["requestId"]
                && link.runtime_handle["origin"]["executionId"] == request["executionId"]
                && link.runtime_handle["executionRequest"]["workspace_source"] == "git_worktree"
                && !self.is_busy_local_task(task)
        }) else {
            return Ok(());
        };
        if request["state"] != "completed" {
            return Ok(());
        }
        self.report_running_request_worktree(config, issue, request)
            .await?;
        let owner = crate::runtime_work::worktrees::RequestWorktreeOwner::from_origin(
            Some(&link.runtime_handle["origin"]),
            task,
            &self.device_id,
        )
        .map_err(|error| AppIpcError::new("worktree_request_invalid", error))?
        .ok_or_else(|| {
            AppIpcError::new("worktree_request_invalid", "Missing request worktree owner")
        })?;
        if link.runtime_handle["assistantMergePrepared"] != request["executionId"] {
            self.prepare_and_report_assistant_merge(config, issue, request, None, &link, &owner)
                .await?;
            self.store.update_task(task, |link| {
                link.runtime_handle["assistantMergePrepared"] = request["executionId"].clone();
            });
        }
        for command in request["commands"].as_array().into_iter().flatten() {
            if command["acknowledged"] == true || command["executionId"] != request["executionId"] {
                continue;
            }
            match command["action"].as_str() {
                Some("merge") => {
                    self.publish_approved_assistant_merge(
                        config, issue, request, command, &link, &owner,
                    )
                    .await?
                }
                Some("prepare_merge") => {
                    self.prepare_and_report_assistant_merge(
                        config,
                        issue,
                        request,
                        command["id"].as_str(),
                        &link,
                        &owner,
                    )
                    .await?
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn prepare_and_report_assistant_merge(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
        command: Option<&str>,
        link: &RuntimeTaskLink,
        owner: &crate::runtime_work::worktrees::RequestWorktreeOwner,
    ) -> Result<(), AppIpcError> {
        let manager = self.worktrees.clone();
        let path = PathBuf::from(&link.workspace_path);
        let owner = owner.clone();
        let outcome =
            tokio::task::spawn_blocking(move || manager.prepare_request_merge(&path, &owner, None))
                .await
                .map_err(|error| AppIpcError::new("worktree_merge_failed", error.to_string()))?;
        match outcome {
            Ok(record) => {
                self.report_assistant_request_event(
                    config,
                    issue,
                    request,
                    command,
                    Some(json!(record)),
                )
                .await
            }
            Err(_) => {
                self.report_assistant_request_outcome(
                    config,
                    issue,
                    request,
                    command,
                    None,
                    Some("worktree_merge_preparation_failed"),
                )
                .await
            }
        }
    }

    async fn publish_approved_assistant_merge(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
        command: &Value,
        link: &RuntimeTaskLink,
        owner: &crate::runtime_work::worktrees::RequestWorktreeOwner,
    ) -> Result<(), AppIpcError> {
        if command["approvedByUserId"] != config["userId"] {
            return Err(AppIpcError::new(
                "permission_denied",
                "Merge needs the owner's authenticated confirmation",
            ));
        }
        self.validate_async_request_consent(config, issue).await?;
        let target = command["targetRevision"]
            .as_str()
            .ok_or_else(|| AppIpcError::new("bad_request", "Missing merge target revision"))?
            .to_owned();
        let candidate = command["candidateRevision"]
            .as_str()
            .ok_or_else(|| AppIpcError::new("bad_request", "Missing merge candidate revision"))?
            .to_owned();
        let id = command["id"]
            .as_str()
            .ok_or_else(|| AppIpcError::new("bad_request", "Missing merge approval identity"))?;
        let manager = self.worktrees.clone();
        let path = PathBuf::from(&link.workspace_path);
        let publish_owner = owner.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            manager.publish_request_merge(&path, &publish_owner, &target, &candidate, true)
        })
        .await
        .map_err(|error| AppIpcError::new("worktree_merge_failed", error.to_string()))?;
        match outcome {
            Ok(record) => {
                let reason = record
                    .merge
                    .as_ref()
                    .filter(|merge| merge.state == "escalated")
                    .and_then(|merge| merge.reason_code.as_deref());
                self.report_assistant_request_outcome(
                    config,
                    issue,
                    request,
                    Some(id),
                    Some(json!(&record)),
                    reason,
                )
                .await
            }
            Err(error) => {
                let reason = error
                    .split(':')
                    .next()
                    .filter(|code| {
                        !code.is_empty()
                            && code.len() <= 128
                            && code
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    })
                    .unwrap_or("worktree_merge_failed");
                let manager = self.worktrees.clone();
                let path = PathBuf::from(&link.workspace_path);
                let owner = owner.clone();
                let refreshed = tokio::task::spawn_blocking(move || {
                    manager.prepare_request_merge(&path, &owner, None)
                })
                .await
                .map_err(|error| AppIpcError::new("worktree_merge_failed", error.to_string()))?;
                self.report_assistant_request_outcome(
                    config,
                    issue,
                    request,
                    Some(id),
                    refreshed.ok().map(|record| json!(record)),
                    Some(reason),
                )
                .await
            }
        }
    }

    async fn validate_async_request_consent(
        &self,
        config: &Value,
        issue: &Value,
    ) -> Result<(), AppIpcError> {
        self.verify_runtime_user(config).await?;
        if issue["permissions"]["execute"] != true
            || issue["assignee_user_id"] != config["userId"]
            || issue["cloud_project_id"] != config["projectId"]
            || !self.stand_in_role_runs_here(config)
            || super::personal_stand_in::matching_personal_roles(
                std::slice::from_ref(config),
                issue,
            )
            .is_empty()
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Assistant request consent is no longer current",
            ));
        }
        Ok(())
    }

    fn assistant_request_origin(&self, config: &Value, issue: &Value, request: &Value) -> Value {
        let mut origin = self.stand_in_issue_origin(config, issue, &issue["human_task_binding"]);
        origin["trigger"] = json!("assistant_request");
        origin["runtimeTaskId"] = request["runtimeTaskId"].clone();
        origin["publicConversation"] = json!(false);
        origin["humanAssistantDispatchId"] = request["parentDispatchId"].clone();
        origin["executionId"] = request["executionId"].clone();
        origin["assistantRequestId"] = request["requestId"].clone();
        origin["assistantRequest"] = json!({
            "requestId":request["requestId"],"ownerUserId":config["userId"],
            "conversationId":request["runtimeTaskId"],"deviceId":self.device_id
        });
        origin
    }

    async fn prepare_assistant_request_turn(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
        command: &str,
        message: &str,
    ) -> Result<Value, AppIpcError> {
        let mut isolated = config.clone();
        if isolated["workspace"].is_object() {
            isolated["workspace"]["executionMode"] = json!("git_worktree");
        }
        let mut origin = self.assistant_request_origin(config, issue, request);
        origin["assistantRequestCommandId"] = json!(command);
        let mut prepared = self
            .prepare_stand_in_execution(
                json!({
                    "taskId":request["runtimeTaskId"],"title":issue["title"],"message":message,
                    "cloudProjectId":config["projectId"],"origin":origin,
                    "commandId":command,"clientUserMessageId":command,
                    "userMessagePresentation":{"content":message,"clientUserMessageId":command}
                }),
                &isolated,
            )
            .await?;
        prepared["executionRequest"]["conversationContext"] = json!("private_discussion");
        prepared["conversationContext"] = json!("private_discussion");
        prepared["automaticStandIn"] = json!(true);
        Ok(prepared)
    }

    async fn start_issue_assistant_request(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
    ) -> Result<(), AppIpcError> {
        let task = request["runtimeTaskId"].as_str().unwrap();
        let command = request["attemptCommandId"].as_str().ok_or_else(|| {
            AppIpcError::new("bad_request", "Missing assistant request attempt command")
        })?;
        let client_id = request["attemptClientUserMessageId"]
            .as_str()
            .unwrap_or(command);
        if let Some(link) = self.local_task_link(task) {
            if link.runtime_handle["origin"]["assistantRequestId"] != request["requestId"]
                || link.runtime_handle["origin"]["userId"] != config["userId"]
            {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Assistant request task is owned by another conversation",
                ));
            }
            if self
                .command_journal
                .lock()
                .map_err(|_| AppIpcError::new("internal_error", "Command journal is unavailable"))?
                .contains_key(&command_journal::key(task, command))
            {
                return Ok(());
            }
            if self.is_busy_local_task(task) {
                return Err(AppIpcError::new(
                    "assistant_request_busy",
                    "Previous request attempt is still stopping",
                ));
            }
        }
        let message = request["attemptMessage"].as_str().ok_or_else(|| {
            AppIpcError::new("bad_request", "Assistant request message is unavailable")
        })?;
        let mut prepared = self
            .prepare_assistant_request_turn(config, issue, request, command, message)
            .await?;
        self.restore_assistant_request_input(&mut prepared, Some(client_id))
            .await?;
        self.bind_assistant_request(config, issue, request, &prepared["origin"])
            .await?;
        let origin = prepared["origin"].clone();
        self.store.update_task(task, |link| {
            link.runtime_handle["origin"] = origin.clone();
            link.runtime_handle["executionRequest"]["origin"] = origin;
        });
        self.dispatch_stand_in_conversation(prepared, false).await?;
        self.forget_assistant_request_input(task, client_id);
        Ok(())
    }

    async fn bind_assistant_request(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
        origin: &Value,
    ) -> Result<(), AppIpcError> {
        let mut binding = issue["human_task_binding"].clone();
        binding["deviceId"] = json!(self.cloud_device_id()?);
        binding["taskId"] = request["runtimeTaskId"].clone();
        binding["taskTitle"] = issue["title"].clone();
        binding["standInConversationId"] = request["conversationId"].clone();
        binding["standInPending"] = json!(self
            .local_task_link(request["runtimeTaskId"].as_str().unwrap())
            .is_none());
        binding["assistantRequestId"] = request["requestId"].clone();
        binding["humanAssistantDispatchId"] = origin["humanAssistantDispatchId"].clone();
        binding["executionContext"] = json!({"origin":origin});
        self.verify_runtime_user(config).await?;
        let response = self
            .runtime_http(
                reqwest::Method::POST,
                &format!("/v1/loop-items/{}/tasks", issue["id"].as_str().unwrap()),
                Some(&binding),
            )
            .await?;
        if response["execution_id"] != request["executionId"] {
            return Err(AppIpcError::new(
                "stale_context",
                "Assistant request attempt changed before admission",
            ));
        }
        Ok(())
    }

    async fn continue_issue_assistant_request(
        &self,
        config: &Value,
        issue: &Value,
        request: &Value,
        command: &Value,
    ) -> Result<(), AppIpcError> {
        let id = command["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AppIpcError::new("bad_request", "Missing assistant command identity"))?;
        let message = command["message"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| AppIpcError::new("bad_request", "Missing assistant followup"))?;
        let mut prepared = self
            .prepare_assistant_request_turn(config, issue, request, id, message)
            .await?;
        self.restore_assistant_request_input(
            &mut prepared,
            command["clientUserMessageId"].as_str(),
        )
        .await?;
        self.dispatch_stand_in_conversation(prepared, false).await?;
        self.report_assistant_request_event(config, issue, request, Some(id), None)
            .await?;
        if let Some(client) = command["clientUserMessageId"].as_str() {
            self.forget_assistant_request_input(request["runtimeTaskId"].as_str().unwrap(), client);
        }
        Ok(())
    }

    pub(super) async fn validate_current_assistant_request(
        &self,
        origin: &Value,
    ) -> Result<(), String> {
        let page = self
            .runtime_http(
                reqwest::Method::GET,
                &request_path(
                    origin["cloudProjectId"]
                        .as_str()
                        .ok_or("Missing request project")?,
                    origin["loopItemId"]
                        .as_str()
                        .ok_or("Missing request Issue")?,
                ),
                None,
            )
            .await
            .map_err(|error| error.message)?;
        let route = self.cloud_device_id().map_err(|error| error.message)?;
        let current = page["requests"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|request| request["requestId"] == origin["assistantRequestId"]);
        if !current.is_some_and(|request| {
            executable(request)
                && request_identity(
                    request,
                    origin["userId"].as_i64().unwrap_or(-1),
                    &route,
                    &self.device_id,
                )
                && request["runtimeTaskId"] == origin["runtimeTaskId"]
                && request["executionId"] == origin["executionId"]
        }) {
            return Err("Assistant request is no longer current".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_identity_binds_owner_device_and_exact_conversation() {
        let request = json!({"requestId":"a","ownerUserId":7,"deviceId":"mac","runtimeTaskId":"assistant-request-a","conversationId":"assistant-request-a","executionId":"42"});
        assert!(request_identity(&request, 7, "cloud-mac", "mac"));
        assert!(!request_identity(&request, 8, "cloud-mac", "mac"));
        assert!(!request_identity(&request, 7, "cloud-other", "other"));
        let mut reused = request;
        reused["runtimeTaskId"] = json!("assistant-request-b");
        assert!(!request_identity(&reused, 7, "cloud-mac", "mac"));
    }

    #[test]
    fn terminal_or_cancelling_requests_never_start_another_turn() {
        for state in [
            "completed",
            "failed",
            "cancelled",
            "preserved",
            "cancelling",
            "blocked_policy",
        ] {
            assert!(!executable(&json!({"state":state})));
        }
        for state in ["accepted", "queued", "running", "waiting_device"] {
            assert!(executable(&json!({"state":state})));
        }
    }

    #[test]
    fn identity_diagnostics_exclude_private_payloads_and_bound_identifier_fields() {
        let request = json!({"requestId":"a","ownerUserId":7,"deviceId":"device-mac",
            "runtimeTaskId":"assistant-request-a","conversationId":"assistant-request-a",
            "executionId":"42","state":"queued","message":"private request body",
            "token":"secret credential","worktree":{"path":"/private/worktree"}});
        let diagnostic = identity_diagnostic(&request, 7, "app-record-78", "mac");
        assert_eq!(diagnostic["request"]["deviceId"], "device-mac");
        assert_eq!(diagnostic["backendDeviceId"], "app-record-78");
        assert_eq!(diagnostic["request"].as_object().unwrap().len(), 7);
        let serialized = diagnostic.to_string();
        for private in [
            "private request body",
            "secret credential",
            "/private/worktree",
        ] {
            assert!(!serialized.contains(private));
        }
        for value in [
            "/private/path".into(),
            "x".repeat(129),
            "line\nbreak".into(),
        ] {
            let mut malformed = request.clone();
            malformed["deviceId"] = json!(value);
            assert!(
                identity_diagnostic(&malformed, 7, "route", "mac")["request"]["deviceId"].is_null()
            );
        }
        assert!(!request_identity(&request, 7, "app-record-78", "mac"));
    }
}
