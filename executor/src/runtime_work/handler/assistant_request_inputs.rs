//! Native child composers submit durable commands before Runtime queue admission.
use super::*;

fn persisted_input(payload: &Value) -> Value {
    let mut persisted = payload.clone();
    redact_execution_profile_secrets(&mut persisted);
    for path in [
        "/executionRequest/prompt",
        "/executionRequest/history",
        "/execution_request/prompt",
        "/execution_request/history",
        "/userMessagePresentation",
        "/attachments",
    ] {
        if let (Some(value), Some(target)) = (payload.pointer(path), persisted.pointer_mut(path)) {
            *target = value.clone();
        }
    }
    for field in ["executionRequest", "execution_request"] {
        for config in ["mcp_servers", "bot", "validation_params"] {
            if payload[field][config] != persisted[field][config] {
                persisted["assistantInputRequiresCredentials"] = json!(true);
            }
        }
    }
    persisted
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn submit_native_assistant_followup(
        &self,
        mut payload: Value,
        link: &RuntimeTaskLink,
    ) -> Result<Value, AppIpcError> {
        let origin = &link.runtime_handle["origin"];
        self.verify_runtime_user(&json!({"userId":origin["userId"]}))
            .await?;
        let project = origin["cloudProjectId"].as_str().ok_or_else(|| {
            AppIpcError::new("permission_denied", "Missing assistant request project")
        })?;
        let issue = origin["loopItemId"].as_str().ok_or_else(|| {
            AppIpcError::new("permission_denied", "Missing assistant request Issue")
        })?;
        let request = origin["assistantRequestId"].as_str().ok_or_else(|| {
            AppIpcError::new("permission_denied", "Missing assistant request identity")
        })?;
        let execution = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        let mut message = prompt_text(&execution.prompt);
        if message.trim().is_empty() {
            if execution
                .prompt
                .as_array()
                .is_some_and(|parts| !parts.is_empty())
            {
                message = "[Attached input]".into();
            } else {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Assistant followup requires input",
                ));
            }
        }
        let client_id = payload
            .get("clientUserMessageId")
            .or_else(|| payload.pointer("/userMessagePresentation/clientUserMessageId"))
            .or_else(|| payload.get("commandId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if execution.subtask_id.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    execution.subtask_id.clone()
                }
            });
        payload["clientUserMessageId"] = json!(client_id);
        if payload["userMessagePresentation"].is_object() {
            payload["userMessagePresentation"]["clientUserMessageId"] = json!(client_id);
        }
        let original = payload;
        let payload = persisted_input(&original);
        // The source input stays local; the server command carries only its stable key.
        let mut inputs = link.runtime_handle["assistantRequestInputs"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        if inputs
            .get(&client_id)
            .is_some_and(|previous| previous != &payload)
        {
            return Err(AppIpcError::new(
                "command_conflict",
                "This input identity already belongs to another message",
            ));
        }
        inputs.insert(client_id.clone(), payload);
        self.store
            .try_update_task(&link.local_task_id, |link| {
                link.runtime_handle["assistantRequestInputs"] = json!(inputs);
            })
            .map_err(|error| {
                AppIpcError::new("assistant_input_persistence_failed", error.to_string())
            })?
            .ok_or_else(|| {
                AppIpcError::new("not_found", "Assistant request conversation disappeared")
            })?;
        self.assistant_request_inputs
            .lock()
            .map_err(|_| {
                AppIpcError::new("internal_error", "Assistant input cache is unavailable")
            })?
            .entry(command_journal::key(&link.local_task_id, &client_id))
            .or_insert(original);
        use sha2::{Digest, Sha256};
        let key = format!("native-followup:{:x}", Sha256::digest(client_id.as_bytes()));
        let body = json!({"action":"followup","requestId":request,"message":message,
            "idempotencyKey":key,"clientUserMessageId":client_id});
        let accepted = self
            .runtime_http(
                reqwest::Method::POST,
                &format!("/v1/cloud-projects/{project}/loop-items/{issue}/assistant-requests"),
                Some(&body),
            )
            .await?;
        if accepted["requestId"] != request
            || accepted["runtimeTaskId"] != link.local_task_id
            || accepted["ownerUserId"] != origin["userId"]
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Assistant followup owner changed",
            ));
        }
        let state = accepted["state"].as_str().unwrap_or("queued");
        let status = match state {
            "completed" => "done",
            "claimed" | "waiting_runtime" | "accepted" => "queued",
            state => state,
        };
        Ok(
            json!({"success":true,"accepted":true,"status":status,"state":state,
            "taskId":link.local_task_id,"deviceId":self.device_id,
            "requestId":request,"clientUserMessageId":client_id,
            "queuePosition":accepted["queuePosition"]}),
        )
    }

    pub(super) async fn restore_assistant_request_input(
        &self,
        prepared: &mut Value,
        client_id: Option<&str>,
    ) -> Result<(), AppIpcError> {
        let Some(client_id) = client_id else {
            return Ok(());
        };
        let Some(task) = runtime_task_id(prepared) else {
            return Ok(());
        };
        let Some(link) = self.local_task_link(&task) else {
            return Ok(());
        };
        let Some(persisted) = link.runtime_handle["assistantRequestInputs"]
            .get(client_id)
            .filter(|input| input.is_object())
        else {
            return Ok(());
        };
        let cached = self
            .assistant_request_inputs
            .lock()
            .map_err(|_| {
                AppIpcError::new("internal_error", "Assistant input cache is unavailable")
            })?
            .get(&command_journal::key(&task, client_id))
            .cloned();
        if cached.is_none() && persisted["assistantInputRequiresCredentials"] == true {
            return Err(AppIpcError::new("assistant_input_credentials_required", "Resubmit the input on its owning device to restore private execution configuration"));
        }
        let input = cached.as_ref().unwrap_or(persisted);
        let origin = prepared["origin"].clone();
        let command = prepared["commandId"].clone();
        let project = prepared["cloudProjectId"].clone();
        let owner = prepared["executionRequest"]["user_id"].clone();
        let source_command = input["commandId"].clone();
        *prepared = input.clone();
        prepared["taskId"] = json!(task);
        prepared["origin"] = origin.clone();
        prepared["commandId"] = command;
        prepared["cloudProjectId"] = project;
        prepared["clientUserMessageId"] = json!(client_id);
        prepared["executionRequest"]["origin"] = origin;
        prepared["executionRequest"]["user_id"] = owner;
        prepared["executionRequest"]["conversationContext"] = json!("private_discussion");
        prepared["conversationContext"] = json!("private_discussion");
        prepared["automaticStandIn"] = json!(true);
        self.rebind_submitted_interface_command(prepared, &source_command)?;
        self.refresh_persisted_model_credentials(prepared).await?;
        Ok(())
    }

    pub(super) fn forget_assistant_request_input(&self, task: &str, client_id: &str) {
        if let Ok(mut inputs) = self.assistant_request_inputs.lock() {
            inputs.remove(&command_journal::key(task, client_id));
        }
        self.store.update_task(task, |link| {
            if let Some(inputs) = link.runtime_handle["assistantRequestInputs"].as_object_mut() {
                inputs.remove(client_id);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistence_redacts_configuration_and_preserves_opaque_input_and_model_limits() {
        let source = json!({"executionRequest":{
            "auth_token":"SYNTHETIC_AUTH","model_config":{"api_key":"SYNTHETIC_KEY","max_output_tokens":4096,"max_tokens":"SYNTHETIC_INVALID_LIMIT"},
            "mcp_servers":[{"headers":{"X-Auth":"SYNTHETIC_HEADER"},"env":{"CUSTOM_ACCESS":"SYNTHETIC_ENV"}}],
            "prompt":[{"type":"text","text":"A business payload","headers":{"sample":"business data"},"env":{"mode":"example"}}],
            "history":[{"role":"user","content":{"headers":{"sample":"business history"}}}]},
            "modelSelection":{"options":{"weworkCloudModelMaxOutputTokens":"4096"}},
            "userMessagePresentation":{"content":"Business input","metadata":{"env":{"mode":"example"}}}});
        let saved = persisted_input(&source);
        assert!(!saved.to_string().contains("SYNTHETIC_"));
        assert_eq!(
            saved["executionRequest"]["prompt"],
            source["executionRequest"]["prompt"]
        );
        assert_eq!(
            saved["executionRequest"]["history"],
            source["executionRequest"]["history"]
        );
        assert_eq!(
            saved["userMessagePresentation"],
            source["userMessagePresentation"]
        );
        assert_eq!(
            saved["executionRequest"]["model_config"]["max_output_tokens"],
            4096
        );
        assert_eq!(
            saved["modelSelection"]["options"]["weworkCloudModelMaxOutputTokens"],
            "4096"
        );
        assert_eq!(saved["assistantInputRequiresCredentials"], true);
    }
}
