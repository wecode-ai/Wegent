use super::*;

mod space_binding;

impl RuntimeWorkRpcHandler {
    pub(super) async fn control_create(
        &self,
        context: &ControlContext,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        let mut intent = self.control_creation_intent(context, &args).await?;
        if let Some(selection) = super::super::creation::normalized_selection(&intent)? {
            intent["modelId"] = selection["modelName"].clone();
            intent["modelType"] = selection["modelType"].clone();
            intent["modelOptions"] = selection["options"].clone();
            intent["modelSelection"] = selection;
        }
        let device = intent["deviceId"].as_str().unwrap().to_owned();
        let task = intent["taskId"].as_str().unwrap().to_owned();
        let backend_owned = device != self.device_id
            || intent.get("projectId").is_some()
            || intent["attachmentIds"]
                .as_array()
                .is_some_and(|ids| !ids.is_empty());
        if !backend_owned {
            intent = self.compile_creation_intent(intent).await?;
        }
        let binding = self
            .control_prepare_creation_binding(context, &args, &mut intent)
            .await?;
        let result = if backend_owned {
            intent.as_object_mut().unwrap().remove("executionRequest");
            intent
                .as_object_mut()
                .unwrap()
                .remove("inheritModelConfiguration");
            intent["compileOnDevice"] = json!(true);
            self.control_backend(context, "/runtime-work/create", intent)
                .await
        } else {
            self.create_task(intent).await
        };
        let mut result = match result {
            Ok(result) => result,
            Err(error) => {
                // A transport failure can follow acceptance. Keep the binding inspectable.
                let rejected = (!backend_owned && self.store.get_task(&task).is_none())
                    || error.code == "backend_request_rejected";
                if rejected {
                    self.control_rollback_creation_binding(
                        context,
                        binding.as_ref(),
                        &device,
                        &task,
                    )
                    .await?;
                }
                if !rejected {
                    return Err(AppIpcError::new(error.code, format!(
                        "{}; creation acceptance is unknown for conversation {} (device {}, task {}). Check its state before retrying.",
                        error.message, workbench_control::conversation_id(&device, &task), device, task
                    )));
                }
                return Err(error);
            }
        };
        if result["accepted"] == false || result["success"] == false {
            self.control_rollback_creation_binding(context, binding.as_ref(), &device, &task)
                .await?;
        }
        let fields = result
            .as_object_mut()
            .ok_or_else(|| AppIpcError::new("invalid_response", "Invalid creation response"))?;
        fields.remove("runtimeHandle");
        if result["accepted"] == true && (result["taskId"] != task || result["deviceId"] != device)
        {
            return Err(AppIpcError::new(
                "invalid_response",
                "Runtime created a different conversation from the requested binding",
            ));
        }
        result["conversation_id"] = json!(workbench_control::conversation_id(&device, &task));
        result["device_id"] = json!(device);
        if let Some(binding) = binding {
            result["project_space"] = binding
        }
        Ok(result)
    }

    async fn control_creation_intent(
        &self,
        context: &ControlContext,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let source = self.store.get_task(&context.task_id).ok_or_else(|| {
            AppIpcError::new("not_found", "Calling conversation no longer exists")
        })?;
        let mut intent = args.get("options").cloned().unwrap_or(json!({}));
        let explicit_model =
            intent.get("modelSelection").is_some() || intent.get("modelId").is_some();
        let device = string_field(&intent, "deviceId").unwrap_or_else(|| self.device_id.clone());
        let runtime = string_field(&intent, "runtime").unwrap_or_else(|| source.runtime.clone());
        let inherit_model =
            !explicit_model && device == self.device_id && runtime == source.runtime;
        if !inherit_model && !explicit_model {
            return Err(AppIpcError::new(
                "model_configuration_required",
                "Select a model when changing device or runtime",
            ));
        }
        let task = format!("runtime-{}", uuid::Uuid::new_v4());
        intent["schemaVersion"] = json!(2);
        intent["deviceId"] = json!(device);
        intent["runtime"] = json!(runtime);
        intent["taskId"] = json!(task);
        intent["message"] = args["message"].clone();
        intent["title"] = args.get("title").cloned().unwrap_or_else(|| {
            json!(args["message"]
                .as_str()
                .unwrap()
                .lines()
                .next()
                .unwrap()
                .chars()
                .take(80)
                .collect::<String>())
        });
        let mut request = if inherit_model {
            let inherited = self
                .control_execution_payload(
                    &source,
                    args["message"].as_str().unwrap(),
                    &uuid::Uuid::new_v4().to_string(),
                )
                .await?;
            if let Some(selection) = inherited
                .get("modelSelection")
                .filter(|selection| selection.is_object())
            {
                intent["modelSelection"] = selection.clone();
            }
            intent["inheritModelConfiguration"] = json!(true);
            execution_request(&inherited).unwrap()
        } else {
            creation_identity(&context.request)
        };
        for key in [
            "origin",
            "cloudProjectId",
            "cloud_project_id",
            "automation_info",
            "projectId",
            "runtimeDeviceId",
            "runtimeLocalTaskId",
            "deferred_project_environment",
            "deferred_worktree_source_path",
            "workspace",
            "standalone_chat_workspace",
            "standaloneChatWorkspace",
            "attachments",
            "additionalContext",
            "additional_context",
            "additional_skills",
            "preload_skills",
            "user_selected_skills",
            "creation_branch",
        ] {
            request.extra.remove(key);
        }
        request.bot = json!([{"id":0,"shell_type":if runtime == "claude_code" {"ClaudeCode"} else {"Codex"}}]);
        if let Some(path) = args
            .get("workspace_path")
            .or_else(|| intent.pointer("/execution/workspace/path"))
        {
            intent["workspacePath"] = path.clone();
        } else if intent.get("runtimeProjectKey").is_none()
            && intent.get("projectId").is_none()
            && intent["standaloneChatWorkspace"] != true
            && device == self.device_id
        {
            intent["workspacePath"] = json!(source.workspace_path);
        } else if device != self.device_id
            && intent.get("runtimeProjectKey").is_none()
            && intent.get("projectId").is_none()
        {
            intent["standaloneChatWorkspace"] = json!(true);
        }
        if let Some(reference) = args["reference_conversation_id"].as_str() {
            let source = self.control_target(&json!({"conversation_id":reference}))?;
            self.authorize_control_target(context, &source).await?;
            if restricted_execution(&source) {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Delegated conversations cannot be forked into personal executions",
                ));
            }
            if source.runtime != "codex" || runtime != "codex" || device != self.device_id {
                return Err(AppIpcError::new(
                    "unsupported_reference",
                    "Native side conversations require Codex on the source device",
                ));
            }
            intent["sideSource"] = json!({"deviceId":device,"taskId":source.local_task_id,
                "workspacePath":source.workspace_path,"threadId":source.thread_id,
                "threadPath":runtime_thread_path_from_link(&source)});
            if args.get("workspace_path").is_none() {
                intent["workspacePath"] = json!(source.workspace_path)
            }
        }
        request.runtime_project_key = None;
        request.runtime_project_name = None;
        request.runtime_workspace_roots.clear();
        intent["executionRequest"] = serde_json::to_value(request).map_err(|_| {
            AppIpcError::new("invalid_configuration", "Cannot prepare execution identity")
        })?;
        Ok(intent)
    }

    pub(super) async fn control_creation_options(
        &self,
        context: &ControlContext,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        let models = self.runner_catalog().await?;
        let index = CodexGlobalProjectIndex::load();
        let projects = index
            .projects()
            .iter()
            .map(|project| {
                json!({"key":project.key,"name":project.name,
            "workspace_path":project.workspace_path,"roots":project.roots,"active":project.active})
            })
            .collect::<Vec<_>>();
        let catalog = self
            .read_composer_catalog(
                json!({"scope":"workspace","workspacePath":args.get("workspace_path")}),
            )
            .await;
        let mut result = json!({"device_id":self.device_id,"scope":"owning_device",
            "parameters":workbench_control::capabilities().into_iter().find(|capability| capability["name"] == "create_conversation").unwrap()["inputSchema"],
            "models":models,"configured_models":self.creation_profile_catalog(),"projects":projects});
        match catalog {
            Ok(catalog) => {
                result["composer_catalog"] = catalog;
            }
            Err(_) => {
                result["composer_catalog_unavailable"] = json!(true);
            }
        }
        if args["include_remote"] == true {
            result["execution_environments"] = self
                .control_http(
                    context,
                    reqwest::Method::GET,
                    "/v1/resources/execution-environments",
                    None,
                )
                .await?;
            result["cloud_models"] = self.control_http(context, reqwest::Method::GET, "/models/unified?scope=all&include_config=false&model_category_type=llm&client_origin=wework", None).await?;
        }
        Ok(result)
    }
}

fn creation_identity(source: &ExecutionRequest) -> ExecutionRequest {
    ExecutionRequest {
        user_name: source.user_name.clone(),
        backend_url: source.backend_url.clone(),
        auth_token: source.auth_token.clone(),
        runtime_auth_token: source.runtime_auth_token.clone(),
        skill_identity_token: source.skill_identity_token.clone(),
        model_config: json!({}),
        extra: source
            .extra
            .iter()
            .filter(|(key, _)| {
                matches!(
                    key.as_str(),
                    "user" | "user_id" | "team_id" | "team_name" | "team_namespace"
                )
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        ..Default::default()
    }
}
