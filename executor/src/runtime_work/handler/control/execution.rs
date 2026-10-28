use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn control_execution_payload(
        &self,
        link: &RuntimeTaskLink,
        message: &str,
        message_id: &str,
    ) -> Result<Value, AppIpcError> {
        let mut request = runtime_event_request_from_link(link);
        if let Some(config) = self.runtime_model_config(&link.local_task_id) {
            request.model_config = config;
        }
        let selection = link
            .runtime_handle
            .get("modelSelection")
            .or_else(|| link.runtime_handle.get("model_selection"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut payload = json!({"taskId":link.local_task_id,"workspacePath":link.workspace_path,
            "runtime":link.runtime,"message":message,"clientUserMessageId":message_id,"modelSelection":selection});
        request.task_id = link.local_task_id.clone();
        request.subtask_id = message_id.to_owned();
        request.prompt = json!(message);
        request.new_session = false;
        request
            .extra
            .insert("client_user_message_id".into(), json!(message_id));
        request.extra.remove("runtimeDeviceId");
        request.extra.remove("runtimeLocalTaskId");
        self.apply_backend_connection(&mut request);
        payload["executionRequest"] = serde_json::to_value(&request).map_err(|_| {
            AppIpcError::new(
                "invalid_configuration",
                "Cannot compile conversation execution",
            )
        })?;
        let model_type = selection["modelType"]
            .as_str()
            .or_else(|| selection["model_type"].as_str())
            .unwrap_or("runtime");
        if ["public", "user", "group"].contains(&model_type) {
            let options = &selection["options"];
            let owner = options["weworkCloudModelResourceUserId"]
                .as_u64()
                .or_else(|| {
                    options["weworkCloudModelResourceUserId"]
                        .as_str()
                        .and_then(|s| s.parse().ok())
                })
                .ok_or_else(|| {
                    AppIpcError::new(
                        "model_configuration_required",
                        "Cloud model owner is missing",
                    )
                })?;
            payload["runnerRouting"] = json!({"model":{"runtime":link.runtime,"source":"cloud","cloud_model":{
                "name":selection.get("modelName").or_else(|| selection.get("model_name")),"type":model_type,
                "namespace":options["weworkCloudModelNamespace"],"resource_user_id":owner}}});
            self.materialize_runner_cloud_models(&mut payload).await?;
        } else if self.runtime_model_config(&link.local_task_id).is_none()
            && request.model_config.get("base_url").is_some()
            && request
                .model_config
                .pointer("/runtime_config/codex/use_user_config")
                != Some(&Value::Bool(true))
        {
            return Err(AppIpcError::new(
                "model_configuration_required",
                "The local model configuration must be refreshed on the owning device",
            ));
        }
        Ok(payload)
    }

    pub(super) async fn control_continue(
        &self,
        context: &ControlContext,
        link: RuntimeTaskLink,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        let gate = self.task_send_gate(&format!("control:{}", link.local_task_id));
        let _guard = gate.lock().await;
        let message = args["message"].as_str().unwrap();
        let key = args["request_key"].as_str().unwrap();
        let queue_if_busy = args["queue_if_busy"].as_bool().unwrap_or(true);
        let operation_id = format!(
            "op_{:x}",
            Sha256::digest(format!("{}\0{}\0{key}", self.device_id, link.local_task_id))
        );
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(json!({"message":message,"queue_if_busy":queue_if_busy}).to_string())
        );
        let path = self
            .store
            .index_path()
            .with_file_name("control-operations.json");
        let existing = workbench_control::journal::transact(&path, |state| {
            if let Some(existing) = state["operations"].get(&operation_id) {
                if existing["fingerprint"] != fingerprint {
                    return Err(AppIpcError::new(
                        "conflict",
                        "request_key was already used with different delivery arguments",
                    ));
                }
                return Ok(Some(existing.clone()));
            }
            Ok(None)
        })?;
        if let Some(receipt) = existing {
            return Ok(json!({"operation":receipt,"duplicate":true}));
        }
        let mut payload = if cloud_bound(&link) {
            // The existing Backend compiler owns project permissions and the current Team profile.
            json!({"modelSelection":link.runtime_handle.get("modelSelection").or_else(|| link.runtime_handle.get("model_selection"))})
        } else {
            self.control_execution_payload(&link, message, &operation_id)
                .await?
        };
        payload["queueIfBusy"] = json!(queue_if_busy);
        let mut receipt = json!({"operation_id":operation_id,"conversation_id":args["conversation_id"],
            "task_id":link.local_task_id,"fingerprint":fingerprint,"delivery_status":"pending","created_at":now_ms()});
        let raced = workbench_control::journal::transact(&path, |state| {
            if let Some(existing) = state["operations"].get(&operation_id) {
                if existing["fingerprint"] != fingerprint {
                    return Err(AppIpcError::new(
                        "conflict",
                        "request_key was already used with different delivery arguments",
                    ));
                }
                return Ok(Some(existing.clone()));
            }
            state["operations"][&operation_id] = receipt.clone();
            Ok(None)
        })?;
        if let Some(existing) = raced {
            return Ok(json!({"operation":existing,"duplicate":true}));
        }
        let result = if cloud_bound(&link) {
            self.control_backend(context, "/runtime-work/send", json!({"address":{
                "deviceId":self.device_id,"taskId":link.local_task_id,"workspacePath":link.workspace_path},
                "message":message,"clientUserMessageId":operation_id,"modelSelection":payload["modelSelection"],"queueIfBusy":payload["queueIfBusy"]})).await
        } else {
            self.send_message(payload).await
        };
        match result {
            Ok(response) => {
                let accepted = response["accepted"] == true;
                receipt["delivery_status"] = json!(if accepted { "accepted" } else { "rejected" });
                receipt["result"] = response;
            }
            Err(error) => {
                // The transport may have failed after acceptance. Preserve uncertainty and never resend blindly.
                receipt["delivery_status"] = json!("needs_attention");
                receipt["error"] = json!({"code":error.code,"message":error.message});
            }
        }
        workbench_control::journal::transact(&path, |state| {
            state["operations"][&operation_id] = receipt.clone();
            Ok(())
        })?;
        Ok(json!({"operation":receipt,"duplicate":false}))
    }

    pub(super) async fn control_get_operation(
        &self,
        context: &ControlContext,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let path = self
            .store
            .index_path()
            .with_file_name("control-operations.json");
        let receipt = workbench_control::journal::transact(&path, |state| {
            state["operations"]
                .get(args["operation_id"].as_str().unwrap())
                .cloned()
                .ok_or_else(|| AppIpcError::new("not_found", "Operation not found"))
        })?;
        let task = receipt["task_id"]
            .as_str()
            .and_then(|task| self.store.get_task(task));
        if let Some(link) = task.as_ref() {
            self.authorize_control_target(context, link).await?;
        }
        Ok(
            json!({"operation":receipt,"current_conversation":task.map(|link| self.control_task_view(link)),"completion":"inspect_original_conversation"}),
        )
    }
}
