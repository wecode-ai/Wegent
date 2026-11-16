//! Explicit task-owned interfaces received through the authenticated backend RPC.
use super::*;

const BINDING_KEY: &str = "submittedModelBinding";

#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmittedInterfaceIdentity {
    kind: SubmittedInterfaceKind,
    actor_user_id: i64,
    device_id: String,
    task_id: String,
    command_id: String,
}

#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum SubmittedInterfaceKind {
    SubmittedInterface,
}

enum TaskModelBinding {
    RunnerReference,
    SubmittedInterface(SubmittedInterfaceIdentity),
}

pub(super) fn redact_persisted_submitted_interface(turn: &mut SpawnTurnRequest) {
    if turn.request.extra.contains_key(BINDING_KEY) {
        redact_execution_profile_secrets(&mut turn.request.model_config);
        if let Some(payload) = turn.send_payload.as_mut() {
            redact_execution_profile_secrets(payload);
        }
    }
}

impl TaskModelBinding {
    fn from_request(request: &ExecutionRequest) -> Result<Self, AppIpcError> {
        match request.extra.get(BINDING_KEY) {
            None => Ok(Self::RunnerReference),
            Some(metadata) => serde_json::from_value(metadata.clone())
                .map(Self::SubmittedInterface)
                .map_err(|_| binding_error("Invalid submitted interface identity")),
        }
    }
}

#[derive(Clone)]
pub(super) struct SubmittedInterfaceBinding {
    metadata: SubmittedInterfaceIdentity,
    config: Value,
}

fn binding_error(message: &str) -> AppIpcError {
    AppIpcError::new("RUNNER_MODEL_BINDING_INVALID", message)
}

fn binding_key(metadata: &SubmittedInterfaceIdentity) -> String {
    format!("{}\0{}", metadata.task_id, metadata.command_id)
}

impl RuntimeWorkRpcHandler {
    pub(super) fn forget_submitted_interfaces(&self, task_id: &str) {
        self.submitted_model_bindings
            .lock()
            .expect("submitted model bindings lock")
            .retain(|_, binding| binding.metadata.task_id != task_id);
    }

    pub(super) fn bind_submitted_interface(
        &self,
        method: &str,
        payload: &mut Value,
        binding: Option<&Value>,
    ) -> Result<(), AppIpcError> {
        let Some(binding) = binding else {
            return Ok(());
        };
        if !matches!(
            method,
            "runtime.tasks.create"
                | "runtime.tasks.send"
                | "runtime.tasks.rollback"
                | "runtime.tasks.interrupt_and_send"
        ) {
            return Err(binding_error("Submitted interfaces require a task command"));
        }
        let mut metadata = binding.clone();
        metadata
            .as_object_mut()
            .ok_or_else(|| binding_error("Invalid submitted interface binding"))?
            .remove("modelConfig");
        self.validate_submitted_interface(payload, binding)?;
        let config = binding["modelConfig"].clone();
        payload["executionRequest"][BINDING_KEY] = metadata.clone();
        let metadata: SubmittedInterfaceIdentity = serde_json::from_value(metadata)
            .map_err(|_| binding_error("Invalid submitted interface identity"))?;
        let mut bindings = self
            .submitted_model_bindings
            .lock()
            .expect("submitted model bindings lock");
        let key = binding_key(&metadata);
        if let Some(existing) = bindings.get(&key) {
            if existing.metadata != metadata || existing.config != config {
                return Err(binding_error(
                    "An accepted command cannot change its model binding",
                ));
            }
        } else {
            bindings.insert(key, SubmittedInterfaceBinding { metadata, config });
        }
        Ok(())
    }

    fn validate_submitted_interface(
        &self,
        payload: &Value,
        binding: &Value,
    ) -> Result<(), AppIpcError> {
        let request = &payload["executionRequest"];
        let config = &request["model_config"];
        let task_id = runtime_task_id(payload).unwrap_or_default();
        let command_id = payload["commandId"].as_str().unwrap_or_default();
        if binding["kind"] != "submitted_interface"
            || binding["deviceId"] != self.device_id
            || binding["actorUserId"] != request["user_id"]
            || binding["actorUserId"].as_i64().is_none()
            || task_id.is_empty()
            || binding["taskId"] != task_id
            || command_id.is_empty()
            || binding["commandId"] != command_id
            || config["wework_model_kind"] != "model-interface"
            || binding["modelConfig"] != *config
            || config["model_id"].as_str().map_or(true, str::is_empty)
            || config["model_provider"]
                .as_str()
                .map_or(true, str::is_empty)
        {
            return Err(binding_error(
                "Submitted interface actor, device, task, command or configuration does not match",
            ));
        }
        Ok(())
    }

    pub(super) fn resolve_submitted_interface(
        &self,
        request: &mut ExecutionRequest,
        task_id: &str,
    ) -> Result<bool, AppIpcError> {
        let TaskModelBinding::SubmittedInterface(metadata) =
            TaskModelBinding::from_request(request)?
        else {
            return Ok(false);
        };
        if metadata.task_id != task_id
            || metadata.device_id != self.device_id
            || request.extra.get("user_id").and_then(Value::as_i64) != Some(metadata.actor_user_id)
            || request
                .extra
                .get("runtime_command_id")
                .is_some_and(|command| command.as_str() != Some(metadata.command_id.as_str()))
        {
            return Err(binding_error(
                "The submitted interface does not belong to this execution",
            ));
        }
        let bindings = self
            .submitted_model_bindings
            .lock()
            .expect("submitted model bindings lock");
        let binding = bindings
            .get(&binding_key(&metadata))
            .filter(|binding| binding.metadata == metadata)
            .ok_or_else(|| {
                AppIpcError::new(
                    "RUNNER_MODEL_UNAVAILABLE",
                    "Reselect the task's submitted model interface to restore its credentials",
                )
            })?;
        // The binding supplies this command's exact interface; target registry entries
        // with the same display identity must neither replace nor authorize it.
        request.model_config = binding.config.clone();
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Value, Value) {
        let config = json!({"wework_model_kind":"model-interface", "model_id":"upstream",
            "model_provider":"local-source", "api_key":"task-secret", "base_url":"https://model.invalid"});
        let payload = json!({"taskId":"remote-task", "commandId":"command-1", "executionRequest":{
            "user_id":7,"model_config":config}});
        let binding = json!({"kind":"submitted_interface","actorUserId":7,"deviceId":"target",
            "taskId":"remote-task","commandId":"command-1","modelConfig":config});
        (payload, binding)
    }

    fn bind(handler: &RuntimeWorkRpcHandler) -> ExecutionRequest {
        let (mut payload, binding) = fixture();
        handler
            .bind_submitted_interface("runtime.tasks.create", &mut payload, Some(&binding))
            .unwrap();
        serde_json::from_value(payload["executionRequest"].clone()).unwrap()
    }

    #[test]
    fn submitted_interface_rejects_every_binding_identity_mismatch() {
        let handler = RuntimeWorkRpcHandler::new("target", "unused");
        for (key, value) in [
            ("actorUserId", json!(8)),
            ("deviceId", json!("foreign")),
            ("taskId", json!("other")),
            ("commandId", json!("other")),
            ("modelConfig", json!({})),
        ] {
            let (mut payload, mut binding) = fixture();
            binding[key] = value;
            assert_eq!(
                handler
                    .bind_submitted_interface("runtime.tasks.create", &mut payload, Some(&binding))
                    .unwrap_err()
                    .code,
                "RUNNER_MODEL_BINDING_INVALID"
            );
        }
        assert!(handler.submitted_model_bindings.lock().unwrap().is_empty());
    }

    #[test]
    fn submitted_interface_metadata_alone_never_authorizes_credentials() {
        let handler = RuntimeWorkRpcHandler::new("target", "unused");
        let (_, mut metadata) = fixture();
        metadata.as_object_mut().unwrap().remove("modelConfig");
        let mut request = ExecutionRequest::default();
        request.extra.insert("user_id".into(), json!(7));
        request.extra.insert(BINDING_KEY.into(), metadata);
        assert_eq!(
            handler
                .resolve_local_model_reference(&mut request, "remote-task")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_UNAVAILABLE"
        );
    }

    #[test]
    fn submitted_interface_is_not_reusable_by_another_task_actor_or_command() {
        let handler = RuntimeWorkRpcHandler::new("target", "unused");
        let original = bind(&handler);
        let mut request = original.clone();
        assert_eq!(
            handler
                .resolve_local_model_reference(&mut request, "other-task")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_BINDING_INVALID"
        );
        request = original.clone();
        request
            .extra
            .insert("runtime_command_id".into(), json!("different-command"));
        assert_eq!(
            handler
                .resolve_local_model_reference(&mut request, "remote-task")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_BINDING_INVALID"
        );
        request = original.clone();
        request.extra.insert("user_id".into(), json!(8));
        assert_eq!(
            handler
                .resolve_local_model_reference(&mut request, "remote-task")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_BINDING_INVALID"
        );
        request = original;
        request.extra.get_mut(BINDING_KEY).unwrap()["commandId"] = json!("other-command");
        assert_eq!(
            handler
                .resolve_local_model_reference(&mut request, "remote-task")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_UNAVAILABLE"
        );
    }

    #[test]
    fn submitted_interface_snapshot_has_no_credentials_and_restart_requires_restore() {
        let handler = RuntimeWorkRpcHandler::new("target", "unused");
        let request = bind(&handler);
        let mut handle = json!({});
        store_runtime_execution_request(&mut handle, &request);
        assert!(!handle.to_string().contains("task-secret"));
        assert_eq!(
            handle["executionRequest"][BINDING_KEY]["commandId"],
            "command-1"
        );
        let restarted = RuntimeWorkRpcHandler::new("target", "unused");
        let mut restored = serde_json::from_value(handle["executionRequest"].clone()).unwrap();
        assert_eq!(
            restarted
                .resolve_local_model_reference(&mut restored, "remote-task")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_UNAVAILABLE"
        );
    }

    #[test]
    fn submitted_interface_command_binding_is_immutable_and_task_cleanup_removes_secrets() {
        let handler = RuntimeWorkRpcHandler::new("target", "unused");
        let mut request = bind(&handler);
        let (mut payload, mut binding) = fixture();
        payload["executionRequest"]["model_config"]["api_key"] = json!("different-secret");
        binding["modelConfig"] = payload["executionRequest"]["model_config"].clone();
        assert_eq!(
            handler
                .bind_submitted_interface("runtime.tasks.send", &mut payload, Some(&binding))
                .unwrap_err()
                .code,
            "RUNNER_MODEL_BINDING_INVALID"
        );
        handler
            .resolve_local_model_reference(&mut request, "remote-task")
            .unwrap();
        assert_eq!(request.model_config["api_key"], "task-secret");
        handler.forget_runtime_model_config("remote-task");
        assert!(handler.submitted_model_bindings.lock().unwrap().is_empty());
        assert_eq!(
            handler
                .resolve_local_model_reference(&mut request, "remote-task")
                .unwrap_err()
                .code,
            "RUNNER_MODEL_UNAVAILABLE"
        );
    }
    #[test]
    fn submitted_interface_encrypted_queue_also_contains_no_model_credentials() {
        let root = tempfile::tempdir().unwrap();
        let handler = RuntimeWorkRpcHandler::new("target", "unused");
        let request = bind(&handler);
        let turn = SpawnTurnRequest {
            task_kind: None,
            local_task_id: "remote-task".into(),
            runtime: "codex".into(),
            request,
            send_payload: Some(fixture().0),
            direct_thread_id: None,
            fork_thread_id: None,
            fork_thread_path: None,
            resume_thread_id: None,
            initial_thread_goal: None,
        };
        let queue = VecDeque::from([turn]);
        let path = root.path().join("queue.json");
        turns::write_runtime_turn_queue(&path, &queue).unwrap();
        let restored = turns::read_runtime_turn_state(&path).unwrap();
        let saved = restored.queued_turns.front().unwrap();
        assert!(!serde_json::to_string(saved)
            .unwrap()
            .contains("task-secret"));
        assert_eq!(saved.request.extra[BINDING_KEY]["commandId"], "command-1");
        assert_eq!(queue[0].request.model_config["api_key"], "task-secret");
        let mut continued = saved.request.clone();
        handler
            .resolve_local_model_reference(&mut continued, "remote-task")
            .unwrap();
        assert_eq!(continued.model_config["api_key"], "task-secret");
    }
}
