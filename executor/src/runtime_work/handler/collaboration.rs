// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::{
    collaboration_member_profile_instructions, collaboration_member_system_prompt,
    mcp::{
        CloudCollaborationRoundCommand, CloudCollaborationRoundDispatcher,
        CollaborationManagerTurnCompleter,
    },
    mcp_http::{
        register_cloud_collaboration_dispatcher, register_collaboration_manager_turn_completer,
    },
};

const CLOUD_COLLABORATION_ROUND_KEY: &str = "cloudCollaborationRound";
const TERMINAL_EXECUTION_STATUSES: &[&str] = &["completed", "failed", "cancelled"];
const CLOUD_COLLABORATION_POLL_INTERVAL: Duration = Duration::from_secs(2);
const CLOUD_COLLABORATION_LAUNCH_RETRY_INTERVAL: Duration = Duration::from_secs(1);

impl RuntimeWorkRpcHandler {
    pub(super) fn register_cloud_collaboration_dispatcher(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log_executor_event(
                "cloud collaboration dispatcher registration skipped",
                &[("reason", "tokio runtime is unavailable".to_owned())],
            );
            return;
        };
        let handler = self.clone();
        let dispatcher = CloudCollaborationRoundDispatcher::new(move |command| {
            handler.persist_cloud_collaboration_round(&command)?;
            let handler = handler.clone();
            runtime.spawn(async move {
                handler.monitor_cloud_collaboration_round(command).await;
            });
            Ok(())
        });
        if let Err(error) = register_cloud_collaboration_dispatcher(dispatcher) {
            log_executor_event(
                "cloud collaboration dispatcher registration failed",
                &[("error", error)],
            );
        }
        let handler = self.clone();
        let completer = CollaborationManagerTurnCompleter::new(move |manager_runtime_task_id| {
            handler.complete_collaboration_manager_turn(manager_runtime_task_id)
        });
        if let Err(error) = register_collaboration_manager_turn_completer(completer) {
            log_executor_event(
                "collaboration manager lifecycle registration failed",
                &[("error", error)],
            );
        }
    }

    fn complete_collaboration_manager_turn(
        &self,
        manager_runtime_task_id: &str,
    ) -> Result<(), String> {
        let link = self
            .local_task_link(manager_runtime_task_id)
            .ok_or_else(|| "Collaboration manager Runtime task was not found".to_owned())?;
        self.persist_and_clear_active_codex_transcript(manager_runtime_task_id, "completed");
        if self.is_active_local_task(manager_runtime_task_id) {
            self.force_settle_local_task_execution(
                manager_runtime_task_id,
                link.thread_id,
                "done",
                "collaboration_round_dispatched",
            );
        } else {
            self.store.update_task(manager_runtime_task_id, |task| {
                task.running = false;
                task.status = "done".to_owned();
                task.thread_status = "idle".to_owned();
                task.turn_status = Some("completed".to_owned());
                task.updated_at = now_ms();
                task.completed_at = Some(task.updated_at);
            });
        }
        Ok(())
    }

    pub(super) fn resume_cloud_collaboration_rounds(&self) {
        for link in self.local_task_links(false) {
            let Some(command) = link
                .runtime_handle
                .get(CLOUD_COLLABORATION_ROUND_KEY)
                .cloned()
                .and_then(|value| {
                    serde_json::from_value::<CloudCollaborationRoundCommand>(value).ok()
                })
            else {
                continue;
            };
            let handler = self.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    handler.monitor_cloud_collaboration_round(command).await;
                });
            }
        }
    }

    fn persist_cloud_collaboration_round(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<(), String> {
        if self
            .local_task_link(&command.manager_runtime_task_id)
            .is_none()
        {
            return Err("Collaboration manager Runtime task was not found".to_owned());
        }
        let encoded = serde_json::to_value(command).map_err(|error| error.to_string())?;
        self.store
            .update_task(&command.manager_runtime_task_id, |link| {
                if !link.runtime_handle.is_object() {
                    link.runtime_handle = json!({});
                }
                link.runtime_handle
                    .as_object_mut()
                    .expect("Runtime handle was normalized")
                    .insert(CLOUD_COLLABORATION_ROUND_KEY.to_owned(), encoded);
            });
        Ok(())
    }

    fn clear_cloud_collaboration_round(&self, manager_runtime_task_id: &str) {
        self.store.update_task(manager_runtime_task_id, |link| {
            if let Some(handle) = link.runtime_handle.as_object_mut() {
                handle.remove(CLOUD_COLLABORATION_ROUND_KEY);
            }
        });
    }

    async fn monitor_cloud_collaboration_round(&self, command: CloudCollaborationRoundCommand) {
        let key = format!("{}:{}", command.manager_runtime_task_id, command.round_id);
        {
            let mut active = self
                .active_collaboration_rounds
                .lock()
                .expect("collaboration round registry lock should not be poisoned");
            if !active.insert(key.clone()) {
                return;
            }
        }

        let result = match self.launch_cloud_collaboration_assignments(&command).await {
            Ok(()) => self.wait_for_cloud_collaboration_round(&command).await,
            Err(error) => Err(error),
        };
        let result = match result {
            Ok(outcomes) => self.launch_fresh_cloud_manager(&command, outcomes).await,
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            log_executor_event(
                "cloud collaboration round failed",
                &[
                    ("dispatch_id", command.dispatch_id.clone()),
                    ("round_id", command.round_id.clone()),
                    ("error", error),
                ],
            );
        }
        self.active_collaboration_rounds
            .lock()
            .expect("collaboration round registry lock should not be poisoned")
            .remove(&key);
    }

    async fn launch_cloud_collaboration_assignments(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<(), String> {
        let dispatch_task_id = self.collaboration_dispatch_task_id(command)?;
        let profiles = self
            .local_task_link(&command.manager_runtime_task_id)
            .and_then(|link| {
                link.runtime_handle
                    .get("collaborationMemberRuntimeProfiles")
                    .and_then(Value::as_array)
                    .cloned()
            })
            .ok_or_else(|| {
                format!(
                    "Collaboration member profiles for dispatch {dispatch_task_id} are unavailable"
                )
            })?;
        for assignment in command.assignments.iter().filter(|assignment| {
            assignment.get("assignee_type").and_then(Value::as_str) == Some("agent")
        }) {
            let runtime_task_id =
                collaboration_member_task_id(&dispatch_task_id, command, assignment)?;
            if self.local_task_link(&runtime_task_id).is_some() {
                continue;
            }
            let assignee_id = required_assignment_string(assignment, "assignee_id")
                .or_else(|_| required_assignment_string(assignment, "agent_id"))?;
            let profile = profiles
                .iter()
                .find(|profile| {
                    profile
                        .get("memberIds")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .any(|member_id| member_id == assignee_id)
                })
                .ok_or_else(|| {
                    format!(
                        "Collaboration assignment target '{assignee_id}' has no local Runtime profile"
                    )
                })?;
            let mut payload = profile
                .get("runtimePayload")
                .cloned()
                .filter(Value::is_object)
                .ok_or_else(|| {
                    format!(
                        "Collaboration assignment target '{assignee_id}' has an invalid Runtime profile"
                    )
                })?;
            materialize_collaboration_member_payload(
                &mut payload,
                &runtime_task_id,
                command,
                assignment,
            )?;
            let response = self
                .create_task(payload)
                .await
                .map_err(|error| error.message)?;
            if response.get("success").and_then(Value::as_bool) != Some(true)
                || response.get("accepted").and_then(Value::as_bool) != Some(true)
            {
                return Err(format!(
                    "Collaboration member Runtime rejected task {runtime_task_id}: {response}"
                ));
            }
            self.report_cloud_collaboration_assignment(
                command,
                assignment,
                &runtime_task_id,
                "running",
                "",
                "",
            )
            .await?;
        }
        Ok(())
    }

    async fn wait_for_cloud_collaboration_round(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<Vec<Value>, String> {
        loop {
            let mut outcomes = self.local_collaboration_outcomes(command)?;
            for outcome in &outcomes {
                let status = outcome
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("running");
                if TERMINAL_EXECUTION_STATUSES.contains(&status) {
                    let assignment_id = outcome
                        .get("assignment_id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            "Collaboration member outcome has no assignment identity".to_owned()
                        })?;
                    let assignment = command
                        .assignments
                        .iter()
                        .find(|value| {
                            value.get("assignment_id").and_then(Value::as_str)
                                == Some(assignment_id)
                        })
                        .ok_or_else(|| {
                            format!("Collaboration assignment {assignment_id} is unavailable")
                        })?;
                    self.report_cloud_collaboration_assignment(
                        command,
                        assignment,
                        outcome
                            .get("runtime_task_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        status,
                        outcome
                            .get("result")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        outcome
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )
                    .await?;
                }
            }
            outcomes.extend(self.human_collaboration_outcomes(command).await?);
            if outcomes.iter().all(|outcome| {
                outcome
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| TERMINAL_EXECUTION_STATUSES.contains(&status))
            }) {
                return Ok(outcomes);
            }
            sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
        }
    }

    async fn report_cloud_collaboration_assignment(
        &self,
        command: &CloudCollaborationRoundCommand,
        assignment: &Value,
        runtime_task_id: &str,
        status: &str,
        result: &str,
        error: &str,
    ) -> Result<(), String> {
        let connection = self
            .backend_connection_snapshot()
            .map_err(|value| value.message)?
            .filter(|value| {
                !value.backend_url.trim().is_empty() && !value.auth_token.trim().is_empty()
            })
            .ok_or_else(|| "Backend connection is unavailable".to_owned())?;
        let response = reqwest::Client::new()
            .post(format!(
                "{}/api/v1/cloud-projects/{}/executions/assignment-status",
                connection.backend_url.trim_end_matches('/'),
                command.project_id
            ))
            .bearer_auth(&connection.auth_token)
            .json(&json!({
                "loop_item_id": command.item_id,
                "dispatch_id": command.dispatch_id,
                "round_id": command.round_id,
                "assignment_id": required_assignment_string(assignment, "assignment_id")?,
                "runtime_device_id": self.device_id,
                "runtime_task_id": runtime_task_id,
                "status": status,
                "result": truncate_utf8(result, 100_000),
                "error": truncate_utf8(error, 2_000),
            }))
            .send()
            .await
            .map_err(|value| value.to_string())?;
        let response_status = response.status();
        if response_status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(format!(
            "Collaboration assignment status report failed ({response_status}): {body}"
        ))
    }

    fn local_collaboration_outcomes(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<Vec<Value>, String> {
        let dispatch_task_id = self.collaboration_dispatch_task_id(command)?;
        command
            .assignments
            .iter()
            .filter(|assignment| {
                assignment.get("assignee_type").and_then(Value::as_str) == Some("agent")
            })
            .map(|assignment| {
                let runtime_task_id =
                    collaboration_member_task_id(&dispatch_task_id, command, assignment)?;
                let link = self.local_task_link(&runtime_task_id).ok_or_else(|| {
                    format!("Collaboration member Runtime task {runtime_task_id} is unavailable")
                })?;
                let status = collaboration_member_status(&link);
                Ok(json!({
                    "assignee_type": "agent",
                    "work_id": assignment.get("work_id"),
                    "runtime_task_id": runtime_task_id,
                    "assignment_id": assignment.get("assignment_id"),
                    "task_title": assignment.get("task_title"),
                    "agent_id": assignment.get("agent_id"),
                    "agent_name": assignment.get("agent_name"),
                    "status": status,
                    "result": collaboration_member_result(&link),
                    "error": link.runtime_handle
                        .get("lastError")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                }))
            })
            .collect()
    }

    fn collaboration_dispatch_task_id(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<String, String> {
        self.local_task_link(&command.manager_runtime_task_id)
            .and_then(|link| {
                link.runtime_handle
                    .get("collaborationDispatchTaskId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .ok_or_else(|| "Collaboration dispatch Runtime identity is unavailable".to_owned())
    }

    async fn human_collaboration_outcomes(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<Vec<Value>, String> {
        if command.human_assignment_ids.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self
            .backend_connection_snapshot()
            .map_err(|error| error.message)?
            .filter(|value| {
                !value.backend_url.trim().is_empty() && !value.auth_token.trim().is_empty()
            })
            .ok_or_else(|| "Backend connection is unavailable".to_owned())?;
        let response = reqwest::Client::new()
            .post(format!(
                "{}/api/v1/cloud-projects/{}/executions/statuses",
                connection.backend_url.trim_end_matches('/'),
                command.project_id
            ))
            .bearer_auth(&connection.auth_token)
            .json(&json!({
                "loop_item_id": command.item_id,
                "human_assignment_ids": command.human_assignment_ids,
            }))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "Collaboration human assignment status request failed ({status})"
            ));
        }
        response
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "Collaboration human assignment response is invalid".to_owned())
    }

    async fn launch_fresh_cloud_manager(
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
            let (mut request, payload) =
                fresh_cloud_manager_payload(&source_link, command, &outcomes)?;
            request.model_config = self
                .runtime_model_config(&command.manager_runtime_task_id)
                .ok_or_else(|| {
                    "Collaboration manager model configuration is unavailable".to_owned()
                })?;
            self.apply_backend_connection(&mut request);
            let mut payload = payload;
            payload["executionRequest"] =
                serde_json::to_value(request).unwrap_or_else(|_| json!({}));

            match self.create_task(payload).await {
                Ok(value)
                    if value.get("success").and_then(Value::as_bool) == Some(true)
                        && value.get("accepted").and_then(Value::as_bool) == Some(true) =>
                {
                    self.clear_cloud_collaboration_round(&command.manager_runtime_task_id);
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
}

fn fresh_cloud_manager_task_id(command: &CloudCollaborationRoundCommand) -> String {
    format!(
        "{}-manager-after-{}",
        command.manager_runtime_task_id, command.round_id
    )
}

fn required_assignment_string<'a>(assignment: &'a Value, key: &str) -> Result<&'a str, String> {
    assignment
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Collaboration assignment {key} is required"))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn collaboration_member_task_id(
    dispatch_task_id: &str,
    command: &CloudCollaborationRoundCommand,
    assignment: &Value,
) -> Result<String, String> {
    Ok(format!(
        "{dispatch_task_id}-member-{}-{}",
        command.round_id,
        required_assignment_string(assignment, "assignment_id")?
    ))
}

fn materialize_collaboration_member_payload(
    payload: &mut Value,
    runtime_task_id: &str,
    command: &CloudCollaborationRoundCommand,
    assignment: &Value,
) -> Result<(), String> {
    let title = required_assignment_string(assignment, "task_title")?;
    let instructions = required_assignment_string(assignment, "instructions")?;
    let prompt = format!("任务标题：{title}\n\n执行要求：{instructions}");
    let assignment_id = required_assignment_string(assignment, "assignment_id")?;
    let system_prompt = collaboration_member_profile_instructions(payload);
    let root = payload
        .as_object_mut()
        .ok_or_else(|| "Collaboration member Runtime profile must be an object".to_owned())?;
    root.insert(
        "taskId".to_owned(),
        Value::String(runtime_task_id.to_owned()),
    );
    root.insert(
        "localTaskId".to_owned(),
        Value::String(runtime_task_id.to_owned()),
    );
    root.insert("title".to_owned(), Value::String(title.to_owned()));
    root.insert("message".to_owned(), Value::String(prompt.clone()));
    let origin = root.entry("origin").or_insert_with(|| json!({}));
    update_collaboration_member_origin(origin, command, assignment, assignment_id, title);
    let execution_request = if root.contains_key("executionRequest") {
        root.get_mut("executionRequest")
    } else {
        root.get_mut("execution_request")
    }
    .and_then(Value::as_object_mut)
    .ok_or_else(|| "Collaboration member Runtime profile has no execution request".to_owned())?;
    execution_request.insert(
        "system_prompt".to_owned(),
        Value::String(collaboration_member_system_prompt(&system_prompt)),
    );
    execution_request.remove("systemPrompt");
    execution_request.insert(
        "task_id".to_owned(),
        Value::String(runtime_task_id.to_owned()),
    );
    execution_request.insert(
        "subtask_id".to_owned(),
        Value::String(format!("{runtime_task_id}-initial")),
    );
    execution_request.insert("prompt".to_owned(), Value::String(prompt));
    let extra = execution_request
        .entry("extra")
        .or_insert_with(|| json!({}));
    let extra = extra
        .as_object_mut()
        .ok_or_else(|| "Collaboration member Runtime extra must be an object".to_owned())?;
    let request_origin = extra.entry("origin").or_insert_with(|| json!({}));
    update_collaboration_member_origin(request_origin, command, assignment, assignment_id, title);
    Ok(())
}

fn update_collaboration_member_origin(
    origin: &mut Value,
    command: &CloudCollaborationRoundCommand,
    assignment: &Value,
    assignment_id: &str,
    title: &str,
) {
    if !origin.is_object() {
        *origin = json!({});
    }
    let origin = origin
        .as_object_mut()
        .expect("collaboration member origin was normalized");
    origin.remove("executionId");
    origin.remove("execution_id");
    origin.insert(
        "dispatchId".to_owned(),
        Value::String(command.dispatch_id.clone()),
    );
    origin.insert(
        "dispatchRole".to_owned(),
        Value::String("member".to_owned()),
    );
    origin.insert(
        "managerRuntimeTaskId".to_owned(),
        Value::String(command.manager_runtime_task_id.clone()),
    );
    origin.insert(
        "coordinationRoundId".to_owned(),
        Value::String(command.round_id.clone()),
    );
    origin.insert(
        "assignmentId".to_owned(),
        Value::String(assignment_id.to_owned()),
    );
    origin.insert(
        "workflowTaskTitle".to_owned(),
        Value::String(title.to_owned()),
    );
    if let Some(stage_id) = assignment
        .get("workflow_stage_id")
        .filter(|value| !value.is_null())
    {
        origin.insert("workflowStageId".to_owned(), stage_id.clone());
    }
}

fn collaboration_member_status(link: &RuntimeTaskLink) -> &'static str {
    if link.status == "cancelled"
        || link.turn_status.as_deref() == Some("cancelled")
        || link.interaction_status.as_deref() == Some("cancelled")
    {
        "cancelled"
    } else if link.status == "failed"
        || link.turn_status.as_deref() == Some("failed")
        || link.runtime_handle.get("lastError").is_some()
    {
        "failed"
    } else if link.completed_at.is_some()
        || matches!(link.turn_status.as_deref(), Some("completed" | "done"))
    {
        "completed"
    } else {
        "running"
    }
}

fn collaboration_member_result(link: &RuntimeTaskLink) -> String {
    completed_transcript_messages(link)
        .into_iter()
        .rev()
        .find(|message| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
        })
        .and_then(|message| {
            message
                .get("content")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default()
}

fn fresh_cloud_manager_task_started(link: &RuntimeTaskLink) -> bool {
    link.thread_id.is_some()
        || link.running
        || link.turn_status.is_some()
        || link
            .runtime_handle
            .get("queuePosition")
            .is_some_and(|value| !value.is_null())
}

fn fresh_cloud_manager_payload(
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

    let mut payload = json!({
        "schemaVersion": 1,
        "taskId": task_id,
        "runtime": source_link.runtime,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> CloudCollaborationRoundCommand {
        CloudCollaborationRoundCommand {
            manager_runtime_task_id: "manager-task-1".to_owned(),
            project_id: "7".to_owned(),
            item_id: "issue-1".to_owned(),
            dispatch_id: "dispatch-1".to_owned(),
            round_id: "round-1".to_owned(),
            assignments: vec![json!({
                "assignee_type": "agent",
                "assignment_id": "member-1",
                "assignee_id": "agent-2",
                "agent_id": "agent-2",
                "task_title": "Collect evidence",
                "instructions": "Collect CPU evidence",
            })],
            human_assignment_ids: vec!["human-assignment-1".to_owned()],
        }
    }

    fn source_link() -> RuntimeTaskLink {
        let mut link = RuntimeTaskLink::new_pending_with_runtime(
            "manager-task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Issue manager".to_owned(),
            "codex",
        );
        link.runtime_handle = json!({
            "collaborationManagerContext": "Issue: 根 Issue 标题\n\n项目协作规则：每轮独立验收。",
            "collaborationDispatchTaskId": "dispatch-task-1",
            "modelSelection": {
                "modelName": "gpt-6-sol",
                "modelType": "runtime",
            },
            "collaborationMemberRuntimeProfiles": [{
                "memberIds": ["agent-2"],
                "runtimePayload": {
                    "taskId": "member-template",
                    "runtime": "codex"
                }
            }],
            "executionRequest": {
                "system_prompt": "manager system instructions",
                "mcp_servers": [{"name": "wework_space"}],
                "extra": {
                    "origin": {
                        "cloudProjectId": 7,
                        "loopItemId": "issue-1",
                        "dispatchId": "dispatch-1",
                        "dispatchRole": "manager",
                        "managerAgentId": "agent-1"
                    }
                }
            },
            "origin": {
                "cloudProjectId": 7,
                "loopItemId": "issue-1",
                "dispatchId": "dispatch-1",
                "dispatchRole": "manager",
                "managerAgentId": "agent-1"
            }
        });
        link
    }

    #[test]
    fn fresh_cloud_manager_payload_starts_new_session() {
        let command = command();
        let source = source_link();
        let outcomes = vec![json!({
            "execution_id": "execution-1",
            "status": "completed",
            "result": "done",
        })];

        let (request, payload) = fresh_cloud_manager_payload(&source, &command, &outcomes).unwrap();

        assert_eq!(request.task_id, "manager-task-1-manager-after-round-1");
        assert_eq!(
            request.subtask_id,
            "manager-task-1-manager-after-round-1-initial"
        );
        assert!(request.new_session);
        assert!(request.history.is_empty());
        assert_eq!(request.message_id, None);
        assert_eq!(request.system_prompt, "manager system instructions");
        assert_eq!(request.mcp_servers, vec![json!({"name": "wework_space"})]);
        assert_eq!(
            request.extra["origin"]["dispatchRole"],
            Value::String("manager".to_owned())
        );
        assert!(request
            .prompt
            .as_str()
            .is_some_and(|prompt| prompt.contains("Issue: 根 Issue 标题")
                && prompt.contains("项目协作规则：每轮独立验收。")
                && prompt.contains("\"result\": \"done\"")));
        assert_eq!(payload["runtime"], "codex");
        assert_eq!(payload["workspacePath"], "/tmp/project");
        assert_eq!(
            payload["modelSelection"]["modelName"],
            Value::String("gpt-6-sol".to_owned())
        );
        assert_eq!(
            payload["origin"]["managerAgentId"],
            Value::String("agent-1".to_owned())
        );
        assert_eq!(
            payload["runtimeHandle"]["collaborationDispatchTaskId"],
            "dispatch-task-1"
        );
        assert_eq!(
            payload["runtimeHandle"]["collaborationMemberRuntimeProfiles"],
            source.runtime_handle["collaborationMemberRuntimeProfiles"]
        );
    }

    #[test]
    fn executor_materializes_member_task_from_root_profile() {
        let command = command();
        let assignment = &command.assignments[0];
        let mut payload = json!({
            "taskId": "root-member-profile",
            "title": "placeholder",
            "message": "placeholder",
            "projectInstructions": "member system instructions",
            "origin": {
                "executionId": 91,
                "dispatchRole": "member"
            },
            "executionRequest": {
                "task_id": "root-member-profile",
                "subtask_id": "root-member-profile-initial",
                "system_prompt": "manager system instructions",
                "prompt": "placeholder",
                "extra": {
                    "origin": {
                        "executionId": 91,
                        "dispatchRole": "member"
                    }
                }
            }
        });

        materialize_collaboration_member_payload(
            &mut payload,
            "dispatch-task-1-member-round-1-member-1",
            &command,
            assignment,
        )
        .unwrap();

        assert_eq!(payload["taskId"], "dispatch-task-1-member-round-1-member-1");
        assert_eq!(payload["title"], "Collect evidence");
        assert_eq!(
            payload["message"],
            "任务标题：Collect evidence\n\n执行要求：Collect CPU evidence"
        );
        assert!(payload["origin"].get("executionId").is_none());
        assert_eq!(payload["origin"]["assignmentId"], "member-1");
        assert_eq!(
            payload["executionRequest"]["extra"]["origin"]["coordinationRoundId"],
            "round-1"
        );
        let system_prompt = payload["executionRequest"]["system_prompt"]
            .as_str()
            .expect("member system prompt");
        assert!(system_prompt.starts_with("member system instructions"));
        assert!(!system_prompt.contains("manager system instructions"));
        assert!(system_prompt.contains("Executor 自动记录到当前 Issue 动态"));
        assert!(system_prompt.contains("不要调用 add_board_item_comment"));
        assert!(system_prompt.contains("必须调用 upload_item_attachment"));
    }

    #[test]
    fn fresh_cloud_manager_reuses_the_in_memory_runtime_model_config() {
        let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
        let source = source_link();
        let command = command();
        let model_config = json!({
            "model_id": "cloud-model",
            "base_url": "https://models.example.com/v1",
            "api_key": "runtime-secret",
        });
        handler.retain_runtime_model_config(&source.local_task_id, &model_config);

        let (mut request, _) = fresh_cloud_manager_payload(&source, &command, &[]).unwrap();
        request.model_config = handler
            .runtime_model_config(&source.local_task_id)
            .expect("source Runtime model config should stay available in memory");

        assert_eq!(request.model_config, model_config);
        assert!(source.runtime_handle["executionRequest"]["model_config"].is_null());
    }

    #[test]
    fn fresh_cloud_manager_identity_is_stable_per_round() {
        let command = command();

        assert_eq!(
            fresh_cloud_manager_task_id(&command),
            fresh_cloud_manager_task_id(&command)
        );
        assert_ne!(
            fresh_cloud_manager_task_id(&command),
            command.manager_runtime_task_id
        );
    }

    #[test]
    fn fresh_cloud_manager_is_started_only_after_runtime_acceptance() {
        let pending = RuntimeTaskLink::new_pending(
            "manager-task-1-manager-after-round-1".to_owned(),
            "/tmp/project".to_owned(),
            "Issue manager".to_owned(),
        );
        assert!(!fresh_cloud_manager_task_started(&pending));

        let mut started = pending;
        started.thread_id = Some("thread-1".to_owned());
        assert!(fresh_cloud_manager_task_started(&started));
    }
}
