//! Prepare the same authoritative Issue binding as the composer before dispatch.
use super::*;
use crate::task_runtime::{RuntimeTaskAddress, TaskRuntime};

impl RuntimeWorkRpcHandler {
    pub(super) async fn control_prepare_creation_binding(
        &self,
        context: &ControlContext,
        args: &Value,
        intent: &mut Value,
    ) -> Result<Option<Value>, AppIpcError> {
        let Some(space) = args.get("project_space") else {
            return Ok(None);
        };
        let project = space["space_id"].as_str().unwrap();
        let item = space["item_id"].as_str();
        let address = json!({"deviceId":intent["deviceId"],"taskId":intent["taskId"],
            "taskTitle":intent["title"],"modelSelection":intent.get("modelSelection"),
            "executionContext":{"runtime":intent["runtime"],"workspacePath":intent.get("workspacePath")}});
        if space["store"] == "local" {
            if intent["deviceId"] != self.device_id {
                return Err(AppIpcError::new(
                    "invalid_creation_options",
                    "Local project spaces require their local executor",
                ));
            }
            let store =
                LocalTaskStore::open(self.task_store_path.as_ref()).map_err(binding_error)?;
            let runtime = TaskRuntime::new(store).map_err(binding_error)?;
            if let Some(item) = item {
                runtime
                    .get_task(project, item)
                    .await
                    .map_err(binding_error)?;
            }
            runtime
                .bind_task(
                    project,
                    item,
                    serde_json::from_value::<RuntimeTaskAddress>(address).map_err(|_| {
                        AppIpcError::new("invalid_creation_options", "Invalid Issue binding")
                    })?,
                    None,
                )
                .await
                .map_err(binding_error)?;
        } else {
            let path = if let Some(item) = item {
                let path = format!("/v1/loop-items/{}", segment(item));
                let issue = self
                    .control_http(context, reqwest::Method::GET, &path, None)
                    .await?;
                if issue["cloud_project_id"].as_str() != Some(project)
                    && issue["cloud_project_id"].to_string() != project
                {
                    return Err(AppIpcError::new(
                        "permission_denied",
                        "Issue does not belong to the selected project space",
                    ));
                }
                format!("{path}/tasks")
            } else {
                format!("/v1/cloud-projects/{}/tasks", segment(project))
            };
            self.control_backend(context, &path, address).await?;
        }
        intent["cloudProjectId"] = json!(project);
        intent["origin"] = json!({"type":if item.is_some() {"board_task"} else {"project_task"},"projectStore":space["store"],"cloudProjectId":project});
        if let Some(item) = item {
            intent["origin"]["loopItemId"] = json!(item)
        }
        Ok(Some(space.clone()))
    }

    pub(super) async fn control_rollback_creation_binding(
        &self,
        context: &ControlContext,
        binding: Option<&Value>,
        device: &str,
        task: &str,
    ) -> Result<(), AppIpcError> {
        let Some(binding) = binding else {
            return Ok(());
        };
        let item = binding["item_id"].as_str();
        if binding["store"] == "local" {
            LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(binding_error)?
                .unbind_task(device, task, item)
                .map_err(binding_error)?;
        } else {
            self.control_http(
                context,
                reqwest::Method::DELETE,
                &item
                    .map(|item| format!("/v1/loop-items/{}/tasks", segment(item)))
                    .unwrap_or_else(|| "/v1/runtime-tasks/cloud-context".into()),
                Some(json!({"deviceId":device,"taskId":task})),
            )
            .await?;
        }
        Ok(())
    }
}

fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn binding_error(error: crate::task_runtime::TaskRuntimeError) -> AppIpcError {
    AppIpcError::new("project_binding_failed", error.to_string())
}
