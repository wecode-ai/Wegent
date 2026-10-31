// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::lifecycle::{native_execution_state, NativeExecutionPhase};
use crate::task_runtime::{
    collaboration_member_profile_instructions, collaboration_member_system_prompt,
    mcp::{CloudCollaborationRoundCommand, CloudCollaborationRoundDispatcher},
    mcp_http::register_cloud_collaboration_dispatcher,
};

#[path = "collaboration_manager.rs"]
mod manager;
#[cfg(test)]
use manager::{
    fresh_cloud_manager_payload, fresh_cloud_manager_task_id, fresh_cloud_manager_task_started,
};

const CLOUD_COLLABORATION_ROUND_KEY: &str = "cloudCollaborationRound";
const TERMINAL_EXECUTION_STATUSES: &[&str] = &["completed", "failed", "cancelled"];
const CLOUD_COLLABORATION_POLL_INTERVAL: Duration = Duration::from_secs(2);
const CLOUD_COLLABORATION_LAUNCH_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const CLOUD_COLLABORATION_LAUNCH_MAX_ATTEMPTS: u32 = 5;

#[derive(Debug)]
struct CollaborationReportError {
    message: String,
    retryable: bool,
}

impl From<String> for CollaborationReportError {
    fn from(message: String) -> Self {
        Self {
            message,
            retryable: true,
        }
    }
}

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
    }

    pub(super) fn resume_cloud_collaboration_rounds(&self) {
        for link in self.local_task_links(false) {
            if link
                .runtime_handle
                .get(CLOUD_COLLABORATION_ROUND_KEY)
                .is_some_and(|round| round.get("report_error").is_some())
            {
                continue;
            }
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

        log_executor_event(
            "cloud collaboration round monitoring started",
            &[
                ("dispatch_id", command.dispatch_id.clone()),
                ("round_id", command.round_id.clone()),
                ("manager_task_id", command.manager_runtime_task_id.clone()),
            ],
        );
        // A manager evaluates verified terminal outcomes. Missing human status
        // is not delivery, so keep the persisted round until its barrier closes.
        let unstarted_outcomes = match self
            .launch_cloud_collaboration_assignments_with_retry(&command)
            .await
        {
            Ok(()) => Vec::new(),
            Err(error) => {
                log_executor_event(
                    "cloud collaboration round launch failed",
                    &[
                        ("dispatch_id", command.dispatch_id.clone()),
                        ("round_id", command.round_id.clone()),
                        ("error", error.clone()),
                    ],
                );
                self.fail_unstarted_collaboration_assignments(&command, &error)
                    .await
            }
        };
        match self
            .wait_for_cloud_collaboration_round(&command, &unstarted_outcomes)
            .await
        {
            Ok(outcomes) => {
                log_executor_event(
                    "cloud collaboration round outcomes ready",
                    &[
                        ("round_id", command.round_id.clone()),
                        ("outcome_count", outcomes.len().to_string()),
                    ],
                );
                if let Err(error) = self.launch_fresh_cloud_manager(&command, outcomes).await {
                    log_executor_event(
                        "fresh cloud collaboration manager launch failed",
                        &[
                            ("dispatch_id", command.dispatch_id.clone()),
                            ("round_id", command.round_id.clone()),
                            ("error", error),
                        ],
                    );
                }
            }
            Err(error) => {
                log_executor_event(
                    "cloud collaboration round wait failed",
                    &[
                        ("dispatch_id", command.dispatch_id.clone()),
                        ("round_id", command.round_id.clone()),
                        ("error", error),
                    ],
                );
            }
        }
        self.active_collaboration_rounds
            .lock()
            .expect("collaboration round registry lock should not be poisoned")
            .remove(&key);
    }

    /// Retry the member launch so a transient Backend or Runtime failure does
    /// not abandon the round before every member has started.
    async fn launch_cloud_collaboration_assignments_with_retry(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<(), String> {
        let mut last_error = String::new();
        for attempt in 1..=CLOUD_COLLABORATION_LAUNCH_MAX_ATTEMPTS {
            match self.launch_cloud_collaboration_assignments(command).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration assignment launch attempt failed",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("attempt", attempt.to_string()),
                            ("error", error.clone()),
                        ],
                    );
                    last_error = error;
                }
            }
            if attempt < CLOUD_COLLABORATION_LAUNCH_MAX_ATTEMPTS {
                sleep(CLOUD_COLLABORATION_LAUNCH_RETRY_INTERVAL).await;
            }
        }
        Err(last_error)
    }

    /// Report every member that never started so the Backend activity reflects
    /// reality, and hand the resumed manager a matching failed outcome.
    async fn fail_unstarted_collaboration_assignments(
        &self,
        command: &CloudCollaborationRoundCommand,
        error: &str,
    ) -> Vec<Value> {
        let Ok(dispatch_task_id) = self.collaboration_dispatch_task_id(command) else {
            return Vec::new();
        };
        let mut outcomes = Vec::new();
        for assignment in command.assignments.iter().filter(|assignment| {
            assignment.get("assignee_type").and_then(Value::as_str) == Some("agent")
        }) {
            let Ok(runtime_task_id) =
                collaboration_member_task_id(&dispatch_task_id, command, assignment)
            else {
                continue;
            };
            if self.local_task_link(&runtime_task_id).is_some() {
                continue;
            }
            self.report_cloud_collaboration_assignment_best_effort(
                command,
                assignment,
                &runtime_task_id,
                "failed",
                "",
                error,
            )
            .await;
            outcomes.push(json!({
                "assignee_type": "agent",
                "work_id": assignment.get("work_id"),
                "runtime_task_id": runtime_task_id,
                "assignment_id": assignment.get("assignment_id"),
                "task_title": assignment.get("task_title"),
                "agent_id": assignment.get("agent_id"),
                "agent_name": assignment.get("agent_name"),
                "status": "failed",
                "result": "",
                "error": error,
            }));
        }
        outcomes
    }

    async fn launch_cloud_collaboration_assignments(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<(), String> {
        let dispatch_task_id = self.collaboration_dispatch_task_id(command)?;
        for assignment in command.assignments.iter().filter(|assignment| {
            assignment.get("assignee_type").and_then(Value::as_str) == Some("agent")
        }) {
            let runtime_task_id =
                collaboration_member_task_id(&dispatch_task_id, command, assignment)?;
            if self.local_task_link(&runtime_task_id).is_some() {
                continue;
            }
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
            // Member progress reporting is a display side channel: a Backend
            // blip must not abort a round whose member has already started.
            self.report_cloud_collaboration_assignment_best_effort(
                command,
                assignment,
                &runtime_task_id,
                "running",
                "",
                "",
            )
            .await;
        }
        Ok(())
    }

    async fn wait_for_cloud_collaboration_round(
        &self,
        command: &CloudCollaborationRoundCommand,
        unstarted_outcomes: &[Value],
    ) -> Result<Vec<Value>, String> {
        loop {
            let mut outcomes = self.local_collaboration_outcomes(command)?;
            for failure in unstarted_outcomes {
                if !outcomes
                    .iter()
                    .any(|outcome| outcome.get("assignment_id") == failure.get("assignment_id"))
                {
                    outcomes.push(failure.clone());
                }
            }
            let mut all_reported = true;
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
                    if let Err(error) = self
                        .report_cloud_collaboration_assignment(
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
                        .await
                    {
                        if !error.retryable {
                            self.store
                                .update_task(&command.manager_runtime_task_id, |link| {
                                    if let Some(round) = link
                                        .runtime_handle
                                        .get_mut(CLOUD_COLLABORATION_ROUND_KEY)
                                        .and_then(Value::as_object_mut)
                                    {
                                        round.insert(
                                            "report_error".to_owned(),
                                            json!(error.message),
                                        );
                                    }
                                    link.runtime_handle["lastError"] = json!(error.message);
                                });
                            return Err(error.message);
                        }
                        all_reported = false;
                        log_executor_event(
                            "cloud collaboration terminal report failed",
                            &[
                                ("round_id", command.round_id.clone()),
                                ("error", error.message),
                            ],
                        );
                    }
                }
            }
            let human_outcomes = match self.human_collaboration_outcomes(command).await {
                Ok(outcomes) => outcomes,
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration human status unavailable",
                        &[
                            ("dispatch_id", command.dispatch_id.clone()),
                            ("round_id", command.round_id.clone()),
                            ("error", error),
                        ],
                    );
                    sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                    continue;
                }
            };
            outcomes.extend(human_outcomes);
            if all_reported && cloud_collaboration_round_is_complete(command, &outcomes) {
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
    ) -> Result<(), CollaborationReportError> {
        let connection = self
            .backend_connection_snapshot()
            .map_err(|value| value.message)?
            .filter(|value| {
                !value.backend_url.trim().is_empty() && !value.auth_token.trim().is_empty()
            })
            .ok_or_else(|| "Backend connection is unavailable".to_owned())?;
        let response = crate::agents::backend_url::backend_http_client()?
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
        Err(CollaborationReportError {
            message: format!(
                "Collaboration assignment status report failed ({response_status}): {body}"
            ),
            retryable: !response_status.is_client_error()
                || matches!(response_status.as_u16(), 408 | 429),
        })
    }

    async fn report_cloud_collaboration_assignment_best_effort(
        &self,
        command: &CloudCollaborationRoundCommand,
        assignment: &Value,
        runtime_task_id: &str,
        status: &str,
        result: &str,
        error: &str,
    ) {
        if let Err(report_error) = self
            .report_cloud_collaboration_assignment(
                command,
                assignment,
                runtime_task_id,
                status,
                result,
                error,
            )
            .await
        {
            log_executor_event(
                "cloud collaboration assignment report failed",
                &[
                    ("round_id", command.round_id.clone()),
                    ("status", status.to_owned()),
                    ("error", report_error.message),
                ],
            );
        }
    }

    fn local_collaboration_outcomes(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<Vec<Value>, String> {
        let dispatch_task_id = self.collaboration_dispatch_task_id(command)?;
        let mut outcomes = Vec::new();
        for assignment in command.assignments.iter().filter(|assignment| {
            assignment.get("assignee_type").and_then(Value::as_str) == Some("agent")
        }) {
            let runtime_task_id =
                collaboration_member_task_id(&dispatch_task_id, command, assignment)?;
            // A member that never started is reported as failed by the launch
            // failure path and excluded here, so the barrier always converges
            // instead of aborting the round.
            let Some(link) = self.local_task_link(&runtime_task_id) else {
                continue;
            };
            let status = collaboration_member_status(&link);
            outcomes.push(json!({
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
            }));
        }
        Ok(outcomes)
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
        let response = crate::agents::backend_url::backend_http_client()?
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
}

fn cloud_collaboration_round_is_complete(
    command: &CloudCollaborationRoundCommand,
    outcomes: &[Value],
) -> bool {
    outcomes.iter().all(|outcome| {
        outcome
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| TERMINAL_EXECUTION_STATUSES.contains(&status))
    }) && command
        .assignments
        .iter()
        .filter(|assignment| {
            assignment.get("assignee_type").and_then(Value::as_str) == Some("agent")
        })
        .all(|assignment| {
            required_assignment_string(assignment, "assignment_id").is_ok_and(|id| {
                outcomes.iter().any(|outcome| {
                    outcome.get("assignee_type").and_then(Value::as_str) == Some("agent")
                        && outcome.get("assignment_id").and_then(Value::as_str) == Some(id)
                })
            })
        })
        && command.human_assignment_ids.iter().all(|id| {
            outcomes.iter().any(|outcome| {
                outcome.get("assignee_type").and_then(Value::as_str) == Some("human")
                    && outcome.get("human_assignment_id").and_then(Value::as_str)
                        == Some(id.as_str())
            })
        })
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
    // A completed native turn is not completion of a starting or continuing request.
    if native_execution_state(link).is_some_and(|state| state.phase != NativeExecutionPhase::Idle) {
        return "running";
    }
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

#[cfg(test)]
#[path = "collaboration_tests.rs"]
mod tests;
