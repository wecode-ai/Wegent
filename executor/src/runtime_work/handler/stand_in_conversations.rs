//! Persistent identity conversations share the ordinary Runtime task lifecycle.
use super::stand_in::settings_error;
use super::*;

pub(super) fn conversation_task_id(user: i64, role: Option<&str>) -> String {
    format!(
        "stand-in-chat-{user}-{}",
        role.map(|id| format!("role-{id}"))
            .unwrap_or_else(|| "primary".into())
    )
}

impl RuntimeWorkRpcHandler {
    pub(super) fn stand_in_proposal(
        &self,
        payload: Value,
        resolve: bool,
    ) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        if resolve {
            let id = payload["proposalId"]
                .as_str()
                .ok_or_else(|| AppIpcError::new("bad_request", "proposalId is required"))?;
            let accept = payload["accept"]
                .as_bool()
                .ok_or_else(|| AppIpcError::new("bad_request", "accept is required"))?;
            store
                .resolve_stand_in_proposal(user, &self.device_id, id, accept)
                .map_err(settings_error)
        } else {
            store
                .stand_in_proposal(user, payload["roleId"].as_str())
                .map_err(settings_error)
        }
    }
    pub(super) async fn stand_in_conversation(&self, payload: Value) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let message = string_field(&payload, "message")
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| AppIpcError::new("bad_request", "message is required"))?;
        let role_id = payload["roleId"].as_str();
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let personal = store
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        let role = role_id
            .map(|id| {
                personal["roles"]
                    .as_array()
                    .and_then(|roles| roles.iter().find(|role| role["id"] == id))
                    .ok_or_else(|| AppIpcError::new("not_found", "Stand-in role no longer exists"))
            })
            .transpose()?;
        let task_id = conversation_task_id(user, role_id);
        // Serialize creation, not individual turns; ordinary Runtime owns turn queuing.
        let gate = self.task_send_gate(&format!("stand-in-conversation:{task_id}"));
        let _guard = gate.lock().await;
        let title = role
            .and_then(|role| role["name"].as_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("我的分身");
        let instructions = "You are the user's persistent personal stand-in. Keep this conversation for communication, clarification, responsibilities and progress; each concrete work item has its own Runtime conversation. Use the available Wework capabilities to carry out authorized work. When speaking as the primary stand-in, use list_tasks/read_task before creating or continuing concrete AI work with create_task/continue_task; preserve existing tasks when appropriate. Use wework_stand_in to inspect current responsibilities and propose configuration changes. Proposals are drafts: do not claim configuration is saved until the user confirms it in Wework. Ask follow-up questions when scope is ambiguous. Never grant broader access than requested. Read current state with tools instead of relying on stale conversation context.";
        let origin = json!({"runtimeTaskId":task_id,"type":"stand_in_identity","initiatedBy":"stand_in_identity","userId":user,"standInId":role_id,"deviceId":self.device_id,"askBeforeAct":true});
        let mut config = role
            .cloned()
            .or_else(|| {
                personal
                    .get("primary")
                    .filter(|value| value.is_object())
                    .cloned()
            })
            .unwrap_or_else(|| json!({}));
        config["userId"] = json!(user);
        config["handlingPolicy"] = json!({"automatic":false,"askBeforeAct":true});
        if payload["options"]["modelOptions"].is_object() {
            config["modelOptions"] = payload["options"]["modelOptions"].clone();
        }
        if let Some(model_id) = payload["options"]["modelId"].as_str() {
            if matches!(
                payload["options"]["modelType"].as_str(),
                Some("public" | "user" | "group")
            ) {
                let namespace = payload["options"]["modelOptions"]["weworkCloudModelNamespace"]
                    .as_str()
                    .ok_or_else(|| {
                        AppIpcError::new("model_unavailable", "Cloud model namespace is required")
                    })?;
                let owner = payload["options"]["modelOptions"]["weworkCloudModelResourceUserId"]
                    .as_str()
                    .and_then(|id| id.parse::<u64>().ok())
                    .ok_or_else(|| {
                        AppIpcError::new("model_unavailable", "Cloud model owner is required")
                    })?;
                config["model"] = json!({"runtime":"codex","provider":"cloud_gateway","model_id":model_id,"source":"cloud","cloud_model":{"name":model_id,"type":payload["options"]["modelType"],"namespace":namespace,"resource_user_id":owner}});
            } else {
                let catalog = self.runner_catalog().await?;
                let provider = payload["options"]["modelOptions"]["codexProviderId"].as_str();
                let models = catalog["models"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|model| {
                        model["runtime"] == "codex"
                            && (model["local_model_id"] == model_id
                                || model["model_id"] == model_id)
                            && provider.map_or(true, |provider| model["provider"] == provider)
                    })
                    .collect::<Vec<_>>();
                if models.len() != 1 {
                    return Err(AppIpcError::new(
                        "model_unavailable",
                        "Select an available Codex model for this conversation",
                    ));
                }
                config["model"] = models[0].clone();
            }
        }
        let mut prepared=self.prepare_stand_in_execution(json!({"taskId":task_id,"title":title,"message":message,"origin":origin,"attachments":payload["options"]["attachments"],"clientUserMessageId":payload["options"]["clientUserMessageId"]}),&config).await?;
        if payload["options"]["modelType"] == "runtime" && payload["options"]["modelId"].is_string()
        {
            // Identity chats start from the desktop model selector, just like their follow-ups.
            // Runner catalog identities alone intentionally use the direct provider path.
            prepared["executionRequest"]["model_config"]["runtime_config"] =
                json!({"codex":{"use_user_config":true,"configured":true}});
            prepared["modelConfig"] = prepared["executionRequest"]["model_config"].clone();
            prepared["modelSelection"] = json!({"modelName":payload["options"]["modelId"],"modelType":"runtime","options":payload["options"]["modelOptions"]});
        }
        let system = prepared["executionRequest"]["system_prompt"]
            .as_str()
            .unwrap_or_default();
        prepared["executionRequest"]["system_prompt"] =
            json!(format!("{system}\n\n{instructions}"));
        let result = if self.local_task_link(&task_id).is_some() {
            prepared["queueIfBusy"] = json!(true);
            self.send_message(prepared).await?
        } else {
            self.create_task(prepared).await?
        };
        if result["success"] == false {
            return Err(AppIpcError::new(
                "stand_in_start_failed",
                result["error"]
                    .as_str()
                    .unwrap_or("Conversation was not accepted"),
            ));
        }
        Ok(json!({"deviceId":self.device_id,"taskId":task_id}))
    }
}
