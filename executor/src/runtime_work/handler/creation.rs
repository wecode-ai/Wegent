//! Compile versioned composer intent on its owning device, independently of the UI.
use super::*;

mod cloud_options;
mod models;
#[cfg(test)]
mod tests;

impl RuntimeWorkRpcHandler {
    pub(super) async fn compile_creation_intent(
        &self,
        mut payload: Value,
    ) -> Result<Value, AppIpcError> {
        crate::runtime_work::task_create_contract::validate_runtime_task_create_v2(&payload)
            .map_err(|error| AppIpcError::new("invalid_request", error))?;
        if string_field(&payload, "deviceId").is_some_and(|device| device != self.device_id) {
            return Err(creation_error("Creation intent belongs to another device"));
        }
        let runtime = payload["runtime"].as_str().unwrap().to_owned();
        if let Some(workspace) = payload.pointer("/execution/workspace") {
            if !matches!(
                workspace["source"].as_str(),
                Some("local_path" | "git_worktree")
            ) {
                return Err(creation_error("Unsupported workspace execution mode"));
            }
            if workspace["createBranch"] == true && workspace["source"] != "local_path" {
                return Err(creation_error(
                    "Create a new branch in local_path mode; Worktree selects an existing base ref",
                ));
            }
        }
        if runtime == "claude_code" && payload.get("initialSupervisor").is_some() {
            return Err(creation_error("Conversation supervision requires Codex"));
        }
        let mut request = execution_request(&payload)
            .ok_or_else(|| creation_error("Trusted execution identity is required"))?;
        request.task_id = payload["taskId"].as_str().unwrap_or_default().to_owned();
        request.subtask_id = uuid::Uuid::new_v4().to_string();
        request.new_session = true;
        request.history.clear();
        request.fork_runtime = None;
        request.inherited_sessions.clear();
        request.device_id = Some(self.device_id.clone());
        request.message_id = None;
        request.ephemeral = bool_field(&payload, "ephemeral").unwrap_or(false);
        request.prompt = payload["message"].clone();
        request.project_workspace_path = string_field(&payload, "workspacePath");
        request.workspace_source = payload
            .pointer("/execution/workspace/source")
            .and_then(Value::as_str)
            .map(str::to_owned);
        request.runtime_project_key = string_field(&payload, "runtimeProjectKey");
        request.runtime_project_name = string_field(&payload, "runtimeProjectName");
        request.runtime_workspace_roots = payload["runtimeWorkspaceRoots"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        request.extra.remove("runtimeDeviceId");
        request.extra.remove("runtimeLocalTaskId");
        if let Some(instructions) = payload["projectInstructions"].as_str() {
            request.system_prompt = instructions.trim().to_owned();
        }
        self.apply_creation_project(&mut payload, &mut request)?;
        let proxy_policy = payload.get("creationProxyPolicy").cloned();
        let selection = normalized_selection(&payload)?;
        if let Some(selection) = &selection {
            if payload["inheritModelConfiguration"] != true {
                let config = self
                    .creation_model_config(&runtime, selection, &request.model_config)
                    .await?;
                request.model_config = config;
            }
            payload["modelId"] = selection["modelName"].clone();
            payload["modelType"] = selection["modelType"].clone();
            payload["modelOptions"] = selection.get("options").cloned().unwrap_or(json!({}));
            payload["modelSelection"] = selection.clone();
        }
        apply_creation_options(&mut request, &payload)?;
        apply_creation_proxy_policy(&mut request.model_config, proxy_policy.as_ref());
        apply_runtime_payload_metadata(&mut request, &payload);
        if let Some(supervisor) = payload.get_mut("initialSupervisor") {
            supervisor["modelSelection"] =
                normalized_selection(&json!({"modelSelection":supervisor["modelSelection"]}))?
                    .unwrap();
            let previous = supervisor
                .get("modelConfig")
                .cloned()
                .unwrap_or(Value::Null);
            let config = self
                .creation_model_config("codex", &supervisor["modelSelection"], &previous)
                .await?;
            let mut supervisor_request = ExecutionRequest {
                model_config: config,
                ..Default::default()
            };
            apply_creation_options(
                &mut supervisor_request,
                &json!({"runtime":"codex","modelSelection":supervisor["modelSelection"],"modelOptions":supervisor["modelSelection"]["options"]}),
            )?;
            apply_creation_proxy_policy(
                &mut supervisor_request.model_config,
                proxy_policy.as_ref(),
            );
            supervisor["modelConfig"] = supervisor_request.model_config;
        }
        self.apply_backend_connection(&mut request);
        payload["executionRequest"] = serde_json::to_value(request)
            .map_err(|_| creation_error("Cannot serialize creation request"))?;
        Ok(payload)
    }

    fn apply_creation_project(
        &self,
        payload: &mut Value,
        request: &mut ExecutionRequest,
    ) -> Result<(), AppIpcError> {
        let Some(key) = string_field(payload, "runtimeProjectKey") else {
            return Ok(());
        };
        let index = CodexGlobalProjectIndex::load();
        let project = index
            .project_for_key(&key)
            .ok_or_else(|| creation_error("Code project is unavailable on the selected device"))?;
        let path = string_field(payload, "workspacePath")
            .unwrap_or_else(|| project.workspace_path.clone());
        if !project
            .roots
            .iter()
            .any(|root| Path::new(&path).starts_with(root))
        {
            return Err(creation_error(
                "Workspace does not belong to the selected code project",
            ));
        }
        if !project.active {
            activate_codex_global_project(&key, &path, project.remote_host_id.as_deref())
                .map_err(|_| creation_error("Cannot activate the selected code project"))?;
        }
        payload["workspacePath"] = json!(path);
        payload["runtimeProjectName"] = json!(project.name);
        payload["runtimeWorkspaceRoots"] = json!(project.roots);
        request.project_workspace_path = Some(path);
        request.runtime_project_name = Some(project.name.clone());
        request.runtime_workspace_roots = project.roots.clone();
        if let Some(settings) = &project.ai_settings {
            if payload.get("projectInstructions").is_none() {
                request.system_prompt = settings["instructions"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
            }
            if payload.get("projectPlugins").is_none() {
                payload["projectPlugins"] = settings["plugins"]
                    .as_array()
                    .map(|rows| json!(rows))
                    .unwrap_or(json!([]));
            }
        }
        Ok(())
    }

    pub(super) async fn prepare_creation_branch(
        &self,
        request: &mut ExecutionRequest,
    ) -> Result<(), AppIpcError> {
        let Some(selection) = request.extra.get("creation_branch") else {
            return Ok(());
        };
        let branch = selection["branch"].as_str().unwrap();
        let workspace = request
            .cwd()
            .ok_or_else(|| creation_error("A Git workspace is required"))?;
        let env = std::env::vars().collect::<HashMap<_, _>>();
        let run = |args: Vec<String>| {
            let env = &env;
            async move {
                crate::local::native_git::run_git_capture(
                    &args,
                    Some(Path::new(workspace)),
                    env,
                    Duration::from_secs(30),
                    8192,
                )
                .await
            }
        };
        let validation = run(vec![
            "check-ref-format".into(),
            "--branch".into(),
            branch.into(),
        ])
        .await
        .map_err(|_| creation_error("Cannot validate requested Git branch"))?;
        if !validation.success {
            return Err(creation_error("Invalid Git branch name"));
        }
        let mut args = vec!["switch".into(), "--no-guess".into()];
        if selection["createBranch"] == true {
            args.push("--create".into());
        } else {
            args.push("--".into());
        }
        args.push(branch.into());
        let switched = run(args)
            .await
            .map_err(|_| creation_error("Cannot switch requested Git branch"))?;
        if !switched.success {
            return Err(AppIpcError::new("branch_checkout_failed", switched.stderr));
        }
        request.extra.remove("creation_branch");
        Ok(())
    }
}

pub(super) fn normalized_selection(payload: &Value) -> Result<Option<Value>, AppIpcError> {
    let mut selection = payload.get("modelSelection").filter(|value| !value.is_null()).cloned()
        .or_else(|| payload.get("modelId").map(|name| json!({"modelName":name,"modelType":payload.get("modelType").cloned().unwrap_or(json!("runtime")),"options":payload.get("modelOptions").cloned().unwrap_or(json!({}))})));
    if let Some(selection) = selection.as_mut() {
        if selection["modelType"].is_null() {
            selection["modelType"] = payload
                .get("modelType")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(json!("runtime"));
        }
        if payload
            .get("modelId")
            .is_some_and(|id| id != &selection["modelName"])
            || payload
                .get("modelType")
                .is_some_and(|kind| !kind.is_null() && kind != &selection["modelType"])
        {
            return Err(creation_error("Conflicting model identity fields"));
        }
        let mut options = normalized_model_options(&selection["options"]);
        options.extend(normalized_model_options(&payload["modelOptions"]));
        selection["options"] = json!(options);
    }
    Ok(selection)
}

fn normalized_model_options(value: &Value) -> serde_json::Map<String, Value> {
    let mut options = value.as_object().cloned().unwrap_or_default();
    for (alias, canonical) in [
        ("reasoningEffort", "reasoning"),
        ("serviceTier", "speed"),
        ("service_tier", "speed"),
        ("permission_mode", "permissionMode"),
        ("collaboration_mode", "collaborationMode"),
    ] {
        if let Some(value) = options.remove(alias) {
            options.entry(canonical).or_insert(value);
        }
    }
    options
}

fn apply_creation_options(
    request: &mut ExecutionRequest,
    payload: &Value,
) -> Result<(), AppIpcError> {
    if let Some(workspace) = payload.pointer("/execution/workspace") {
        if workspace["source"] == "local_path" && workspace.get("branch").is_some() {
            request
                .extra
                .insert("creation_branch".into(), workspace.clone());
        }
    }
    let options = payload.get("modelOptions").unwrap_or(&Value::Null);
    let effort = options
        .get("reasoningEffort")
        .or_else(|| options.get("reasoning"));
    if let Some(effort) = effort {
        if !matches!(
            effort.as_str(),
            Some("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")
        ) {
            return Err(creation_error("Unsupported reasoning effort"));
        }
        request.model_config["reasoning"]["effort"] = effort.clone();
        request.extra.insert(
            "reasoning_config".into(),
            request.model_config["reasoning"].clone(),
        );
    }
    if let Some(summary) = options.get("summary") {
        if !matches!(summary.as_str(), Some("auto" | "concise" | "detailed")) {
            return Err(creation_error("Unsupported reasoning summary"));
        }
        request.model_config["reasoning"]["summary"] = summary.clone();
        request.extra.insert(
            "reasoning_config".into(),
            request.model_config["reasoning"].clone(),
        );
    }
    if let Some(tier) = options
        .get("speed")
        .or_else(|| options.get("serviceTier"))
        .or_else(|| options.get("service_tier"))
    {
        if !matches!(
            tier.as_str(),
            Some("auto" | "default" | "flex" | "priority" | "fast" | "standard")
        ) {
            return Err(creation_error("Unsupported service tier"));
        }
        request.model_config["service_tier"] = tier.clone();
    }
    if let Some(mode) = options
        .get("permissionMode")
        .or_else(|| options.get("permission_mode"))
    {
        let profile = match mode.as_str() {
            Some("read-only") => CODEX_READ_ONLY_PERMISSION_PROFILE,
            Some("workspace-write") => CODEX_WORKSPACE_PERMISSION_PROFILE,
            Some("full-access") => CODEX_DANGER_FULL_ACCESS_PERMISSION_PROFILE,
            _ => return Err(creation_error("Unsupported permission mode")),
        };
        request
            .extra
            .insert("runtime_permission_profile".into(), json!(profile));
    }
    if let Some(mode) = payload.get("runtimePermissionMode") {
        request
            .extra
            .insert("claude_permission_mode".into(), mode.clone());
    }
    if let Some(mode) = options
        .get("collaborationMode")
        .or_else(|| options.get("collaboration_mode"))
    {
        if !matches!(mode.as_str(), Some("plan" | "default")) {
            return Err(creation_error("Unsupported collaboration mode"));
        }
    }
    if matches!(
        payload
            .pointer("/modelSelection/modelType")
            .and_then(Value::as_str),
        Some("public" | "user" | "group")
    ) {
        cloud_options::apply(
            &mut request.model_config,
            options,
            payload["runtime"].as_str().unwrap_or("codex"),
        )?;
    }
    if let Some(path) = payload.get("runtimeExecutablePath") {
        request
            .extra
            .insert("runtime_executable_path".into(), path.clone());
    }
    if let Some(standalone) = payload.get("standaloneChatWorkspace") {
        request
            .extra
            .insert("standalone_chat_workspace".into(), standalone.clone());
    }
    if let Some(plugins) = payload["projectPlugins"].as_array() {
        request.extra.insert(
            "project_plugin_ids".into(),
            json!(plugins
                .iter()
                .filter_map(|plugin| plugin["id"].as_str())
                .collect::<Vec<_>>()),
        );
    }
    // Codex receives typed context directly; Claude receives the same trust markers in its prompt.
    if payload["runtime"] == "claude_code" {
        if let Some(context) = payload["additionalContext"].as_object() {
            let context = context
                .iter()
                .map(|(name, entry)| {
                    format!(
                        "[{}:{}]\n{}",
                        entry["kind"].as_str().unwrap_or("untrusted"),
                        name,
                        entry["value"].as_str().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            request.prompt = json!(format!(
                "<application_context>\n{context}\n</application_context>\n\n{}",
                payload["message"].as_str().unwrap_or_default()
            ));
        }
    }
    Ok(())
}

fn creation_error(message: &str) -> AppIpcError {
    AppIpcError::new("invalid_creation_options", message)
}

fn apply_creation_proxy_policy(config: &mut Value, policy: Option<&Value>) {
    let Some(policy) = policy else { return };
    // Gateway traffic is direct; provider traffic uses the account's remote-device policy.
    let cloud = config["wework_model_kind"] == "cloud"
        || config
            .pointer("/default_headers/X-Wegent-Model-Type")
            .is_some();
    let proxy = if cloud {
        Value::Null
    } else {
        policy["url"].clone()
    };
    config.as_object_mut().unwrap().remove("proxy");
    if proxy.is_string() {
        config["proxy"] = json!({"url":proxy});
    }
    if let Some(sidecar) = config
        .get_mut("vision_sidecar")
        .filter(|value| value.is_object())
    {
        let sidecar_proxy = if sidecar
            .pointer("/default_headers/X-Wegent-Model-Type")
            .is_some()
        {
            Value::Null
        } else {
            proxy.clone()
        };
        sidecar["proxy"] = json!({"url":sidecar_proxy});
    }
    for key in ["use_proxy", "proxy_configured"] {
        config["runtime_config"]["codex"][key] = json!(proxy.is_string());
    }
}
