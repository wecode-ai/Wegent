use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn control_schedule(
        &self,
        context: &ControlContext,
        operation: &str,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        let payload = json!({"automationId":args["automation_id"],"enabled":args["enabled"]});
        let result = match operation {
            "list_automations" => self.list_automations().await,
            "get_automation" => self.get_automation(payload).await,
            "delete_automation" => self.delete_automation(payload).await,
            "toggle_automation" => self.toggle_automation(payload).await,
            "run_automation" => self.run_automation_now(payload).await,
            "list_automation_runs" => self.list_automation_runs(payload).await,
            "create_automation" => {
                let source = if let Some(conversation) = args.get("conversation_id") {
                    self.control_target(&json!({"conversation_id":conversation}))?
                } else {
                    self.store.get_task(&context.task_id).ok_or_else(|| {
                        AppIpcError::new("not_found", "Source conversation not found")
                    })?
                };
                self.authorize_control_target(context, &source).await?;
                if cloud_bound(&source) || restricted_execution(&source) {
                    return Err(AppIpcError::new(
                        "project_automation_required",
                        "Personal automation requires an unrestricted personal source conversation",
                    ));
                }
                self.create_automation(json!({"id":"","version":0,"name":args["name"],"prompt":args["prompt"],
                    "schedule":args["schedule"],"timezone":args["timezone"],"enabled":args.get("enabled").cloned().unwrap_or(json!(true)),
                    "conversationMode":args.get("conversation_mode").cloned().unwrap_or(json!("independent")),
                    "taskRequest":{"type":"wework_control","sourceTaskId":source.local_task_id},"taskPayload":{},"createdAt":chrono::Utc::now(),"updatedAt":chrono::Utc::now()})).await
            }
            "update_automation" => {
                let id = args["automation_id"].as_str().unwrap();
                let automation = self
                    .automation_store
                    .get(id)
                    .ok_or_else(|| AppIpcError::new("not_found", "Automation not found"))?;
                let mut value = serde_json::to_value(automation)
                    .map_err(|_| AppIpcError::new("invalid_configuration", "Invalid automation"))?;
                value["version"] = args["version"].clone();
                for key in ["name", "prompt", "schedule", "timezone", "enabled"] {
                    if let Some(field) = args.get(key) {
                        value[key] = field.clone();
                    }
                }
                self.update_automation(value).await
            }
            _ => Err(AppIpcError::new(
                "not_found",
                "Unknown automation operation",
            )),
        }?;
        Ok(public_automation_result(result))
    }

    pub(in crate::runtime_work::handler) async fn control_automation_payload(
        &self,
        automation: &crate::runtime_work::automations::Automation,
    ) -> Result<Value, AppIpcError> {
        let task = automation.task_request["sourceTaskId"]
            .as_str()
            .ok_or_else(|| {
                AppIpcError::new(
                    "invalid_configuration",
                    "Automation source conversation is missing",
                )
            })?;
        let link = self.store.get_task(task).ok_or_else(|| {
            AppIpcError::new(
                "not_found",
                "Automation source conversation no longer exists",
            )
        })?;
        if cloud_bound(&link) || restricted_execution(&link) {
            return Err(AppIpcError::new(
                "permission_denied",
                "Personal automation cannot inherit restricted execution authority",
            ));
        }
        let mut payload = self
            .control_execution_payload(&link, &automation.prompt, &uuid::Uuid::new_v4().to_string())
            .await?;
        payload["title"] = json!(automation.name);
        Ok(payload)
    }
}

fn public_automation_result(mut value: Value) -> Value {
    fn sanitize(value: &mut Value) {
        match value {
            Value::Object(object) => {
                for key in ["taskPayload", "continuationPayload", "taskRequest"] {
                    object.remove(key);
                }
                for child in object.values_mut() {
                    sanitize(child);
                }
            }
            Value::Array(items) => {
                for child in items {
                    sanitize(child);
                }
            }
            _ => {}
        }
    }
    sanitize(&mut value);
    value
}
