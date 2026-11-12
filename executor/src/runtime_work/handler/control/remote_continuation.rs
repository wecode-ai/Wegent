//! Continue an addressed remote conversation through the desktop's existing API.
use super::*;
use crate::runtime_work::reader::invalid_response;
use crate::workbench_control::read_budget::ReadBudget;

#[cfg(test)]
mod tests;

impl RuntimeWorkRpcHandler {
    pub(super) async fn control_continue_remote(
        &self,
        context: &ControlContext,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        let (device, task) = workbench_control::conversation_address(
            args["conversation_id"].as_str().unwrap_or_default(),
        )?;
        // Reserve two existing 60-second HTTP calls and connection cleanup inside
        // the 180-second MCP deadline. No mutation runs inside a read timeout.
        let reader = self
            .control_runtime_reader(context, ReadBudget::new(Duration::from_secs(45)))
            .await?;
        let result = reader
            .request(&device, "runtime.tasks.get", json!({"taskId":task}))
            .await;
        reader.close().await;
        let result = result?;
        let mut link = continuation_link(&task, &result["task"])?;
        // Reuse current transcript authorization and its persisted origin rather
        // than trusting model-supplied addresses, execution profiles or bindings.
        let history = self
            .control_backend(
                context,
                "/runtime-work/transcript",
                json!({"deviceId":device,"taskId":task,"workspacePath":link.workspace_path,"limit":1}),
            )
            .await?;
        link.runtime_handle["origin"] = history["origin"].clone();
        validate_continuation_target(&link, &device)?;
        self.control_continue_on_device(context, &device, link, args)
            .await
    }
}

pub(super) fn validate_continuation_target(
    link: &RuntimeTaskLink,
    device: &str,
) -> Result<(), AppIpcError> {
    let origin = &link.runtime_handle["origin"];
    let external = matches!(
        origin["type"].as_str(),
        Some("stand_in_identity" | "connection_work" | "dingtalk_work")
    );
    // Reuse execution startup's grant validation: resuming an assigned Issue
    // retains its role and binding, rather than granting personal control.
    let request = runtime_event_request_from_link(link);
    let bound_context = crate::task_runtime::mcp::has_bound_issue_context(&request);
    if bound_context.is_ok()
        && (!restricted_execution(link) || external || bound_context == Ok(true))
    {
        return Ok(());
    }
    Err(control_target_restriction(
        device,
        &link.local_task_id,
        Some(origin),
    ))
}

fn continuation_link(task_id: &str, target: &Value) -> Result<RuntimeTaskLink, AppIpcError> {
    let workspace = target["workspacePath"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(invalid_response)?;
    if target["taskId"] != task_id {
        return Err(invalid_response());
    }
    let handle = &target["runtimeHandle"];
    let selection = [
        &target["modelSelection"],
        &handle["modelSelection"],
        &handle["model_selection"],
    ]
    .into_iter()
    .find(|value| value.is_object())
    .cloned()
    .unwrap_or(Value::Null);
    if !selection["modelName"]
        .as_str()
        .is_some_and(|name| !name.is_empty())
        && !handle["wegentTeam"]["id"].as_u64().is_some_and(|id| id > 0)
    {
        return Err(AppIpcError::new(
            "model_configuration_required",
            "The target conversation did not provide its model or Team binding",
        ));
    }
    let mut link = RuntimeTaskLink::new_pending_with_runtime(
        task_id.to_owned(),
        workspace.to_owned(),
        target["title"].as_str().unwrap_or_default().to_owned(),
        target["runtime"].as_str().ok_or_else(invalid_response)?,
    );
    link.runtime_handle = json!({"modelSelection":selection,"wegentTeam":handle.get("wegentTeam")});
    redact_execution_profile_secrets(&mut link.runtime_handle);
    Ok(link)
}
