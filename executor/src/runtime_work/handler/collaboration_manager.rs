// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn launch_fresh_cloud_manager(
        &self,
        command: &CloudCollaborationRoundCommand,
        outcomes: Vec<Value>,
    ) -> Result<(), String> {
        let fresh_task_id = fresh_cloud_manager_task_id(command);
        loop {
            if self
                .local_task_link(&fresh_task_id)
                .is_some_and(|link| fresh_cloud_manager_task_started(&link))
            {
                self.clear_cloud_collaboration_round(&command.manager_runtime_task_id);
                return Ok(());
            }

            if self.local_task_link(&fresh_task_id).is_some() {
                self.store.delete_task(&fresh_task_id);
            }

            let Some(source_link) = self.local_task_link(&command.manager_runtime_task_id) else {
                return Err("Collaboration manager Runtime task was not found".to_owned());
            };
            let payload = self.prepare_fresh_cloud_manager(&source_link, command, &outcomes)?;

            match self.create_task(payload).await {
                Ok(value)
                    if value.get("success").and_then(Value::as_bool) == Some(true)
                        && value.get("accepted").and_then(Value::as_bool) == Some(true) =>
                {
                    self.clear_cloud_collaboration_round(&command.manager_runtime_task_id);
                    log_executor_event(
                        "fresh cloud collaboration manager accepted",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("manager_task_id", fresh_task_id.clone()),
                        ],
                    );
                    return Ok(());
                }
                Ok(value) => {
                    log_executor_event(
                        "fresh cloud collaboration manager launch rejected",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("response", value.to_string()),
                        ],
                    );
                }
                Err(error) => {
                    log_executor_event(
                        "fresh cloud collaboration manager launch failed",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("error", error.message),
                        ],
                    );
                }
            }
            sleep(CLOUD_COLLABORATION_LAUNCH_RETRY_INTERVAL).await;
        }
    }

    pub(super) fn prepare_fresh_cloud_manager(
        &self,
        source: &RuntimeTaskLink,
        command: &CloudCollaborationRoundCommand,
        outcomes: &[Value],
    ) -> Result<Value, String> {
        let (mut request, mut payload) = fresh_cloud_manager_payload(source, command, outcomes)?;
        if let Some(config) = self.runtime_model_config(&source.local_task_id) {
            request.model_config = config;
        } else if !request.model_config.is_null()
            && !request
                .model_config
                .as_object()
                .is_some_and(|config| config.is_empty())
        {
            return Err("Collaboration manager model configuration is unavailable".to_owned());
        }
        // An empty model configuration selects the native Runtime default and
        // needs no in-memory credentials, including after an Executor restart.
        self.apply_backend_connection(&mut request);
        payload["executionRequest"] =
            serde_json::to_value(request).map_err(|error| error.to_string())?;
        Ok(payload)
    }
}

pub(super) fn fresh_cloud_manager_task_id(command: &CloudCollaborationRoundCommand) -> String {
    format!(
        "{}-manager-after-{}",
        command.manager_runtime_task_id, command.round_id
    )
}

pub(super) fn fresh_cloud_manager_task_started(link: &RuntimeTaskLink) -> bool {
    link.thread_id.is_some()
        || link.running
        || link.turn_status.is_some()
        || link
            .runtime_handle
            .get("queuePosition")
            .is_some_and(|value| !value.is_null())
}

pub(super) fn fresh_cloud_manager_payload(
    source_link: &RuntimeTaskLink,
    command: &CloudCollaborationRoundCommand,
    outcomes: &[Value],
) -> Result<(ExecutionRequest, Value), String> {
    let task_id = fresh_cloud_manager_task_id(command);
    let manager_context = source_link
        .runtime_handle
        .get(COLLABORATION_MANAGER_CONTEXT_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Collaboration manager context is unavailable".to_owned())?;
    let prompt = format!(
        "{manager_context}\n\n<collaboration_round_results>\n上一轮任务已经全部结束。请读取以下执行结果，综合判断是否需要分配下一轮任务；如 Issue 已达到待确认或完成条件，请显式调用 update_issue_status。不要直接执行成员工作。\n\n{}\n</collaboration_round_results>",
        serde_json::to_string_pretty(outcomes).unwrap_or_else(|_| "[]".to_owned()),
    );
    let mut request = runtime_event_request_from_link(source_link);
    request.task_id = task_id.clone();
    request.subtask_id = format!("{task_id}-initial");
    request.prompt = Value::String(prompt.clone());
    request.history.clear();
    request.message_id = None;
    request.new_session = true;
    if let Some(origin) = request
        .extra
        .get_mut("origin")
        .and_then(Value::as_object_mut)
    {
        origin.remove("executionId");
        origin.remove("execution_id");
    }

    let mut payload = json!({
        "schemaVersion": 1,
        "taskId": task_id,
        "runtime": source_link.runtime,
        "collaboration_model": "single",
        "title": source_link.title,
        "message": prompt,
        "workspacePath": source_link.workspace_path,
        "executionRequest": request,
        "runtimeHandle": {
            "collaborationManagerContext": manager_context,
            "collaborationDispatchTaskId": source_link
                .runtime_handle
                .get("collaborationDispatchTaskId")
                .cloned()
                .unwrap_or(Value::Null),
            "collaborationMemberRuntimeProfiles": source_link
                .runtime_handle
                .get("collaborationMemberRuntimeProfiles")
                .cloned()
                .unwrap_or_else(|| json!([])),
        },
    });
    if let Some(model_selection) = source_link
        .runtime_handle
        .get("modelSelection")
        .or_else(|| source_link.runtime_handle.get("model_selection"))
    {
        payload["modelSelection"] = model_selection.clone();
    }
    if let Some(origin) = request.extra.get("origin") {
        payload["origin"] = origin.clone();
    }
    Ok((request, payload))
}
